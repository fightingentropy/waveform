import { create } from "zustand";
import { patchLikeApiCache } from "@/lib/api";
import { canonicalOf, expandLikedSet, onIdMapChange } from "@/lib/canonical-ids";
import { promoteStagedSong } from "@/lib/discover-keep";
import {
  OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT,
  OFFLINE_MUTATION_REPLAY_APPLIED_EVENT,
  OFFLINE_MUTATION_REPLAY_EXHAUSTED_EVENT,
  on,
} from "@/lib/events";
import { impactLight } from "@/lib/haptics";
import { apiFetchWithTimeout } from "@/lib/http";
import {
  applyQueuedLikeIntents,
  protectLikeBaselines,
  updateAuthoritativeLikedIds,
} from "@/lib/like-intent-overlay";
import { storage } from "@/lib/storage";
import {
  getOfflineAccountScope,
  getOfflineAccountIdentity,
  getQueuedLikeOutboxState,
  hasPersistedLikeMutation,
  isOfflineAccountIdentityCurrent,
  queueOfflineMutation,
  useOfflineStore,
} from "@/store/offline";
import type { OfflineMutation } from "@/lib/offline-mutation-policy";
import type { PlayerSong } from "@/types/player";

// Ported from src/store/likes.ts. Changes: relative fetch("/api/likes") →
// apiFetch (origin + cookie); Capacitor haptics → expo-haptics shim; localStorage
// → MMKV storage shim. The optimistic toggle + pending map + rollback, the staged
// Discover promote-before-like flow, local-song likes, the offline-mutation-queue
// fallback, auto-download-on-like, and API-cache patching are all preserved.

type LikeToggleResult = {
  ok: boolean;
  status: number;
  error?: string;
};

type LikesState = {
  likedSongIds: Record<string, true>;
  pending: Record<string, true>;
  hydrated: boolean;
  // The raw (un-expanded) server liked set from the last merge, so we can
  // re-expand it the moment the canonical id-map loads or changes.
  rawRemoteLiked: string[];
  mergeInitial: (ids: string[]) => void;
  reexpand: () => void;
  resetRemote: () => void;
  toggleLike: (songId: string, nextLiked: boolean, song?: PlayerSong) => Promise<LikeToggleResult>;
};

const LOCAL_LIKED_SONG_IDS_KEY = "spotify_local_liked_song_ids";

function removeKey(source: Record<string, true>, key: string): Record<string, true> {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return source;
  const next = { ...source };
  delete next[key];
  return next;
}

function isLocalSongId(songId: string): boolean {
  return songId.startsWith("browser-local:") || songId.startsWith("picked-file:");
}

function relatedLikeIds(songId: string): string[] {
  const canonical = canonicalOf(songId);
  return Array.from(new Set([songId, canonical, ...expandLikedSet([canonical])]));
}

function hasRelatedPersistedLikeMutation(songId: string, scope: string): boolean {
  return relatedLikeIds(songId).some((id) => hasPersistedLikeMutation(id, scope));
}

// Fire-and-forget: pin/unpin must never block or fail the like toggle itself.
function syncAutoDownloadLiked(songId: string, nextLiked: boolean, song?: PlayerSong): void {
  const offline = useOfflineStore.getState();
  if (!offline.autoDownloadLiked) return;
  if (nextLiked) {
    if (song) void offline.queueDownloads([song], "liked");
  } else {
    void offline.unpinScope(songId, "liked");
  }
}

function readLocalLikedSongIds(): Record<string, true> {
  try {
    const stored = storage.getItem(LOCAL_LIKED_SONG_IDS_KEY);
    const ids = stored ? JSON.parse(stored) : [];
    if (!Array.isArray(ids)) return {};

    const liked: Record<string, true> = {};
    for (const id of ids) {
      if (typeof id === "string" && isLocalSongId(id)) liked[id] = true;
    }
    return liked;
  } catch {
    return {};
  }
}

function writeLocalLikedSongIds(likedSongIds: Record<string, true>): void {
  try {
    const ids = Object.keys(likedSongIds).filter(isLocalSongId);
    storage.setItem(LOCAL_LIKED_SONG_IDS_KEY, JSON.stringify(ids));
  } catch {}
}

export const useLikesStore = create<LikesState>((set, get) => ({
  likedSongIds: readLocalLikedSongIds(),
  pending: {},
  hydrated: false,
  rawRemoteLiked: [],
  mergeInitial: (ids) => {
    const incomingRaw = Array.isArray(ids) ? ids : [];
    const outbox = getQueuedLikeOutboxState(getOfflineAccountScope());
    // A GET can return the optimistic API-cache snapshot while an offline write
    // is queued. Keep the persisted pre-write direction as the authoritative
    // baseline until replay confirms or exhausts the mutation.
    const raw = protectLikeBaselines(
      incomingRaw,
      get().rawRemoteLiked,
      outbox,
      canonicalOf,
    );
    // Canonical like-once: also light every retired copy id of each liked
    // (anchor) song. Identity while the id-map is empty (flag off / not loaded).
    const list = expandLikedSet(raw);
    const current = get().likedSongIds;
    const pending = get().pending;
    let next: Record<string, true> = {};

    for (const id of Object.keys(current)) {
      if (isLocalSongId(id)) next[id] = true;
    }

    for (const id of list) {
      if (typeof id !== "string" || id.length === 0) continue;
      next[id] = true;
    }

    // Persisted active intents survive relaunch and sit above any stale GET.
    // Exhausted rows remain baseline locks but are deliberately absent here,
    // which rolls the visible heart back to its pre-mutation direction.
    next = applyQueuedLikeIntents(next, outbox.intents, relatedLikeIds);

    // Preserve in-flight optimistic likes: a pending id reflects an
    // optimistic toggle the server list may not know about yet. Apply the
    // optimistic direction (present in `current`) over the incoming list so
    // the merge doesn't clobber a like/unlike that's still being saved.
    for (const id of Object.keys(pending)) {
      for (const relatedId of relatedLikeIds(id)) {
        if (current[id]) next[relatedId] = true;
        else delete next[relatedId];
      }
    }

    const currentKeys = Object.keys(current);
    const nextKeys = Object.keys(next);
    const changed = currentKeys.length !== nextKeys.length || nextKeys.some((id) => !current[id]);

    if (changed) set({ likedSongIds: next, hydrated: true, rawRemoteLiked: raw });
    else if (!get().hydrated || get().rawRemoteLiked !== raw) set({ hydrated: true, rawRemoteLiked: raw });
  },
  reexpand: () => {
    get().mergeInitial(get().rawRemoteLiked);
  },
  resetRemote: () => {
    const current = get().likedSongIds;
    const next: Record<string, true> = {};
    for (const id of Object.keys(current)) {
      if (isLocalSongId(id)) next[id] = true;
    }
    writeLocalLikedSongIds(next);
    set({ likedSongIds: next, pending: {}, hydrated: true, rawRemoteLiked: [] });
    get().mergeInitial([]);
  },
  toggleLike: async (songId, nextLiked, song) => {
    if (typeof songId !== "string" || songId.length === 0) {
      return { ok: false, status: 400, error: "Invalid song id" };
    }

    const pendingMap = get().pending;
    if (relatedLikeIds(songId).some((id) => pendingMap[id])) {
      return { ok: false, status: 0, error: "Like is still updating" };
    }

    const prevLiked = !!get().likedSongIds[songId];
    if (prevLiked === nextLiked) {
      return { ok: true, status: 200 };
    }

    void impactLight();

    if (isLocalSongId(songId)) {
      const current = get().likedSongIds;
      const likedSongIds: Record<string, true> = nextLiked
        ? { ...current, [songId]: true as const }
        : removeKey(current, songId);
      set({ likedSongIds, hydrated: true });
      writeLocalLikedSongIds(likedSongIds);
      return { ok: true, status: 200 };
    }

    // Capture before promotion (the first possible await). If auth changes while
    // promotion is running, its old-account intent must never continue into a
    // like request or be queued under the newly active account.
    const accountIdentity = getOfflineAccountIdentity();
    const accountScope = accountIdentity.scope;
    const accountStillCurrent = () =>
      isOfflineAccountIdentityCurrent(accountIdentity);

    // Optimistically reflect the like immediately so the heart responds on tap,
    // even while a staged Discover track is being promoted (a round-trip that can
    // take a moment). Reverted below if the promote or the save fails.
    set((state) => ({
      likedSongIds: nextLiked ? { ...state.likedSongIds, [songId]: true } : removeKey(state.likedSongIds, songId),
      pending: { ...state.pending, [songId]: true },
      hydrated: true,
    }));

    // Keep a Discover track: promote it into the library first (you can't like a
    // song that isn't in the library yet). Promotion is idempotent and usually
    // keeps the same id; if it differs, move the optimistic like onto the new id.
    if (nextLiked && song?.discoverTrackId) {
      const promoted = await promoteStagedSong(song, (previous, replacement) => {
        if (!accountStillCurrent() || previous.id === replacement.id) return;
        set((state) => {
          const wasLiked = !!state.likedSongIds[previous.id];
          const wasPending = !!state.pending[previous.id];
          if (!wasLiked && !wasPending) return state;
          return {
            likedSongIds: wasLiked
              ? { ...removeKey(state.likedSongIds, previous.id), [replacement.id]: true }
              : state.likedSongIds,
            pending: wasPending
              ? { ...removeKey(state.pending, previous.id), [replacement.id]: true }
              : state.pending,
            hydrated: true,
          };
        });
        if (songId === previous.id) songId = replacement.id;
      });
      if (!accountStillCurrent()) {
        return { ok: false, status: 409, error: "Account changed while saving" };
      }
      if (!promoted) {
        set((state) => ({
          likedSongIds: prevLiked
            ? { ...state.likedSongIds, [songId]: true }
            : removeKey(state.likedSongIds, songId),
          pending: removeKey(state.pending, songId),
          hydrated: true,
        }));
        return { ok: false, status: 502, error: "Couldn't save this track" };
      }
      if (promoted.id !== songId) {
        const previousId = songId;
        set((state) => ({
          likedSongIds: { ...removeKey(state.likedSongIds, previousId), [promoted.id]: true },
          pending: { ...removeKey(state.pending, previousId), [promoted.id]: true },
          hydrated: true,
        }));
      }
      song = promoted;
      songId = promoted.id;
    }

    // Once this song has any persisted outbox row, keep all later directions in
    // that same FIFO. Sending a newer unlike immediately while an older like is
    // queued would let the older row replay last and invert the user's intent.
    if (hasRelatedPersistedLikeMutation(songId, accountScope)) {
      try {
        await queueOfflineMutation(
          {
            type: "like",
            payload: {
              songId,
              logicalSongId: canonicalOf(songId),
              nextLiked,
              previousLiked: prevLiked,
              song,
            },
          },
          accountScope,
        );
        if (accountStillCurrent()) {
          set((state) => ({
            pending: removeKey(state.pending, songId),
            hydrated: true,
          }));
          syncAutoDownloadLiked(songId, nextLiked, song);
        }
        patchLikeApiCache(songId, nextLiked, song, accountScope);
        void useOfflineStore.getState().syncOfflineMutations();
        return { ok: true, status: 202 };
      } catch (error) {
        if (accountStillCurrent()) {
          set((state) => ({
            likedSongIds: prevLiked
              ? { ...state.likedSongIds, [songId]: true }
              : removeKey(state.likedSongIds, songId),
            pending: removeKey(state.pending, songId),
            hydrated: true,
          }));
        }
        return {
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : "Failed to save offline change",
        };
      }
    }

    try {
      const response = await apiFetchWithTimeout("/api/likes", {
        method: nextLiked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId }),
        cache: "no-store",
      });

      if (!response.ok) {
        if (accountStillCurrent()) {
          set((state) => ({
            likedSongIds: prevLiked
              ? { ...state.likedSongIds, [songId]: true }
              : removeKey(state.likedSongIds, songId),
            pending: removeKey(state.pending, songId),
            hydrated: true,
          }));
        }

        let message: string | undefined;
        try {
          const data = (await response.json()) as { error?: unknown } | null;
          if (data && typeof data.error === "string") message = data.error;
        } catch {
          // ignore parse issues
        }

        return { ok: false, status: response.status, error: message };
      }

      if (accountStillCurrent()) {
        set((state) => ({
          pending: removeKey(state.pending, songId),
          hydrated: true,
        }));
        confirmAuthoritativeLike(songId, nextLiked);
        syncAutoDownloadLiked(songId, nextLiked, song);
      }
      patchLikeApiCache(songId, nextLiked, song, accountScope);

      return { ok: true, status: response.status };
    } catch (error) {
      try {
        await queueOfflineMutation(
          {
            type: "like",
            payload: {
              songId,
              logicalSongId: canonicalOf(songId),
              nextLiked,
              previousLiked: prevLiked,
              song,
            },
          },
          accountScope,
        );
        if (accountStillCurrent()) {
          set((state) => ({
            pending: removeKey(state.pending, songId),
            hydrated: true,
          }));
          syncAutoDownloadLiked(songId, nextLiked, song);
        }
        patchLikeApiCache(songId, nextLiked, song, accountScope);
        return { ok: true, status: 202 };
      } catch {}

      if (accountStillCurrent()) {
        set((state) => ({
          likedSongIds: prevLiked
            ? { ...state.likedSongIds, [songId]: true }
            : removeKey(state.likedSongIds, songId),
          pending: removeKey(state.pending, songId),
          hydrated: true,
        }));
      }

      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : "Failed to update like",
      };
    }
  },
}));

function confirmAuthoritativeLike(songId: string, nextLiked: boolean): void {
  const state = useLikesStore.getState();
  const raw = updateAuthoritativeLikedIds(
    state.rawRemoteLiked,
    songId,
    nextLiked,
    canonicalOf(songId),
    canonicalOf,
  );
  useLikesStore.setState({ rawRemoteLiked: raw });
  useLikesStore.getState().mergeInitial(raw);
}

type LikeOfflineMutation = Extract<OfflineMutation, { type: "like" }>;

type OfflineMutationEventDetail = {
  scope: string;
  mutation: LikeOfflineMutation;
  error?: string;
};

function likeMutationEvent(detail: unknown): OfflineMutationEventDetail | null {
  if (!detail || typeof detail !== "object") return null;
  const candidate = detail as {
    scope?: unknown;
    mutation?: unknown;
    error?: unknown;
  };
  const mutation = candidate.mutation as Partial<LikeOfflineMutation> | undefined;
  if (
    typeof candidate.scope !== "string" ||
    !mutation ||
    mutation.type !== "like"
  ) {
    return null;
  }
  const payload = mutation.payload;
  if (
    typeof payload?.songId !== "string" ||
    typeof payload?.nextLiked !== "boolean"
  ) {
    return null;
  }
  return {
    scope: candidate.scope,
    mutation: mutation as LikeOfflineMutation,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
  };
}

on(OFFLINE_MUTATION_REPLAY_APPLIED_EVENT, (detail) => {
  const event = likeMutationEvent(detail);
  if (!event || event.scope !== getOfflineAccountScope()) return;
  const { songId, nextLiked, song } = event.mutation.payload;
  confirmAuthoritativeLike(songId, nextLiked);
  patchLikeApiCache(songId, nextLiked, song, event.scope);
  syncAutoDownloadLiked(songId, nextLiked, song);
});

on(OFFLINE_MUTATION_REPLAY_EXHAUSTED_EVENT, (detail) => {
  const event = likeMutationEvent(detail);
  if (!event || event.scope !== getOfflineAccountScope()) return;
  const { songId, song } = event.mutation.payload;
  const state = useLikesStore.getState();
  state.mergeInitial(state.rawRemoteLiked);
  const resolvedLiked = relatedLikeIds(songId).some(
    (id) => !!useLikesStore.getState().likedSongIds[id],
  );
  patchLikeApiCache(songId, resolvedLiked, song, event.scope);
  syncAutoDownloadLiked(songId, resolvedLiked, song);
});

on(OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT, (detail) => {
  const scope =
    detail && typeof detail === "object" && "scope" in detail
      ? (detail as { scope?: unknown }).scope
      : undefined;
  if (scope !== getOfflineAccountScope()) return;
  useLikesStore.getState().reexpand();
});

// Canonical ids arrive asynchronously. Re-expand the raw server set as soon as
// the map changes so every retired copy reflects the same liked state.
onIdMapChange(() => useLikesStore.getState().reexpand());
