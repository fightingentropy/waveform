"use client";

import { create } from "zustand";
import { getAccountScope, patchLikeApiCache } from "@/client/api";
import { promoteStagedSong } from "@/client/discover-keep";
import type { PlayerSong } from "@/types/player";

type LikeToggleResult = {
  ok: boolean;
  status: number;
  error?: string;
};

type LikesState = {
  likedSongIds: Record<string, true>;
  pending: Record<string, true>;
  hydrated: boolean;
  mergeInitial: (ids: string[]) => void;
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

function readLocalLikedSongIds(): Record<string, true> {
  if (typeof window === "undefined") return {};

  try {
    const stored = localStorage.getItem(LOCAL_LIKED_SONG_IDS_KEY);
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
  if (typeof window === "undefined") return;

  try {
    const ids = Object.keys(likedSongIds).filter(isLocalSongId);
    localStorage.setItem(LOCAL_LIKED_SONG_IDS_KEY, JSON.stringify(ids));
  } catch {}
}

export const useLikesStore = create<LikesState>((set, get) => ({
  likedSongIds: readLocalLikedSongIds(),
  pending: {},
  hydrated: false,
  mergeInitial: (ids) => {
    const list = Array.isArray(ids) ? ids : [];
    const current = get().likedSongIds;
    const pending = get().pending;
    const next: Record<string, true> = {};

    for (const id of Object.keys(current)) {
      if (isLocalSongId(id)) next[id] = true;
    }

    for (const id of list) {
      if (typeof id !== "string" || id.length === 0) continue;
      next[id] = true;
    }

    // Preserve in-flight optimistic likes: a pending id reflects an
    // optimistic toggle the server list may not know about yet. Apply the
    // optimistic direction (present in `current`) over the incoming list so
    // the merge doesn't clobber a like/unlike that's still being saved.
    for (const id of Object.keys(pending)) {
      if (current[id]) next[id] = true;
      else delete next[id];
    }

    const currentKeys = Object.keys(current);
    const nextKeys = Object.keys(next);
    const changed =
      currentKeys.length !== nextKeys.length ||
      nextKeys.some((id) => !current[id]);

    if (changed) set({ likedSongIds: next, hydrated: true });
    else if (!get().hydrated) set({ hydrated: true });
  },
  resetRemote: () => {
    const current = get().likedSongIds;
    const next: Record<string, true> = {};
    for (const id of Object.keys(current)) {
      if (isLocalSongId(id)) next[id] = true;
    }
    writeLocalLikedSongIds(next);
    set({ likedSongIds: next, pending: {}, hydrated: true });
  },
  toggleLike: async (songId, nextLiked, song) => {
    if (typeof songId !== "string" || songId.length === 0) {
      return { ok: false, status: 400, error: "Invalid song id" };
    }

    const pendingMap = get().pending;
    if (pendingMap[songId]) {
      return { ok: false, status: 0, error: "Like is still updating" };
    }

    const prevLiked = !!get().likedSongIds[songId];
    if (prevLiked === nextLiked) {
      return { ok: true, status: 200 };
    }

    if (isLocalSongId(songId)) {
      const current = get().likedSongIds;
      const likedSongIds: Record<string, true> = nextLiked
        ? { ...current, [songId]: true as const }
        : removeKey(current, songId);
      set({ likedSongIds, hydrated: true });
      writeLocalLikedSongIds(likedSongIds);
      return { ok: true, status: 200 };
    }

    // Capture before promotion (the first possible await) so a later auth
    // transition can never redirect this mutation's cache patch to a new user.
    const accountScope = getAccountScope();
    let optimisticCachePatched = false;
    const patchOptimisticCache = () => {
      patchLikeApiCache(songId, nextLiked, song, accountScope);
      optimisticCachePatched = true;
    };
    const rollbackOptimisticCache = () => {
      if (optimisticCachePatched) {
        patchLikeApiCache(songId, prevLiked, song, accountScope);
      }
    };

    // Optimistically reflect the like immediately so the heart responds on tap,
    // even while a staged Discover track is being promoted (a round-trip that can
    // take a moment). Reverted below if the promote or the save fails.
    set((state) => ({
      likedSongIds: nextLiked ? { ...state.likedSongIds, [songId]: true } : removeKey(state.likedSongIds, songId),
      pending: { ...state.pending, [songId]: true },
      hydrated: true,
    }));
    if (!(nextLiked && song?.discoverTrackId)) patchOptimisticCache();

    // Keep a Discover track: promote it into the library first (you can't like a
    // song that isn't in the library yet). Promotion is idempotent and usually
    // keeps the same id; if it differs, move the optimistic like onto the new id.
    if (nextLiked && song?.discoverTrackId) {
      const promoted = await promoteStagedSong(song);
      if (!promoted) {
        set((state) => ({
          likedSongIds: prevLiked
            ? { ...state.likedSongIds, [songId]: true }
            : removeKey(state.likedSongIds, songId),
          pending: removeKey(state.pending, songId),
          hydrated: true,
        }));
        rollbackOptimisticCache();
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
      patchOptimisticCache();
    }

    try {
      const response = await fetch("/api/likes", {
        method: nextLiked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId }),
        credentials: "include",
        cache: "no-store",
      });

      if (!response.ok) {
        set((state) => ({
          likedSongIds: prevLiked
            ? { ...state.likedSongIds, [songId]: true }
            : removeKey(state.likedSongIds, songId),
          pending: removeKey(state.pending, songId),
          hydrated: true,
        }));
        rollbackOptimisticCache();

        let message: string | undefined;
        try {
          const data = (await response.json()) as { error?: unknown } | null;
          if (data && typeof data.error === "string") message = data.error;
        } catch {
          // ignore parse issues
        }

        return { ok: false, status: response.status, error: message };
      }

      set((state) => ({
        pending: removeKey(state.pending, songId),
        hydrated: true,
      }));
      patchLikeApiCache(songId, nextLiked, song, accountScope);

      return { ok: true, status: response.status };
    } catch (error) {
      set((state) => ({
        likedSongIds: prevLiked
          ? { ...state.likedSongIds, [songId]: true }
          : removeKey(state.likedSongIds, songId),
        pending: removeKey(state.pending, songId),
        hydrated: true,
      }));
      rollbackOptimisticCache();

      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : "Failed to update like",
      };
    }
  },
}));
