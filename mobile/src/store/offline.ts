import { useMemo } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";
import { toAbsoluteApiUrl } from "@/lib/config";
import {
  applyBackgroundDownloadTransportState,
  createBackgroundDownloadTransportJob,
  createDownloadTransferToken,
  isTerminalBackgroundDownloadState,
  restoreRecordFromBackgroundDownloadState,
  type BackgroundDownloadTransportState,
} from "@/lib/background-download-policy";
import {
  dbAllRows,
  dbDeleteRow,
  dbDeleteRows,
  dbUpsertRow,
  dbUpsertRows,
  readAllDownloadedRecords,
  resolveMediaPath,
  toMediaRelativePath,
  verifyOrRepairRecord,
  type DownloadRow,
} from "@/lib/offline-db";
import { createJsOfflineDownloadPump } from "@/lib/offline-download-pump";
import {
  type DownloadScope,
  type DownloadStatus,
  type OfflineDownloadRecord,
  PLAYBACK_CACHE_SCOPE,
  offlineDownloadKey,
  planQueuedDownloads,
  planUnpinScopeFromSongs,
} from "@/lib/offline-download-queue";
import {
  type LikeOutboxState,
  type OfflineMutation,
  type StoredOfflineMutation,
  OFFLINE_MUTATION_MAX_ATTEMPTS,
  OFFLINE_MUTATION_TIMEOUT_MS,
  createStoredOfflineMutation,
  deriveLikeOutboxState,
  offlineMutationCounts,
  offlineMutationScope,
  isOfflineMutationReplayCurrent,
  pendingOfflineMutations,
  planOfflineMutationFailure,
  resetExhaustedOfflineMutations,
  replayMutationsFifo,
  shouldPublishOfflineMutationCounts,
  settleAppliedOfflineMutation,
} from "@/lib/offline-mutation-policy";
import { apiFetchWithTimeout } from "@/lib/http";
import { getIsOnline, subscribeOnline } from "@/lib/connectivity";
import { canonicalOf } from "@/lib/canonical-ids";
import {
  OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT,
  OFFLINE_MUTATION_REPLAY_APPLIED_EVENT,
  OFFLINE_MUTATION_REPLAY_EXHAUSTED_EVENT,
  emit,
} from "@/lib/events";
import { planOfflineAccountDeletion } from "@/lib/account-deletion-policy";
import { NativeDownloadRevisionGate, nativeTransferIdentity } from "@/lib/offline-native-revision";
import { portablePlaybackSong, preferDownloadedPlaybackSong } from "@/lib/offline-playback";
import { resetPlaybackEngaged } from "@/audio/publish-gate";
import { storage } from "@/lib/storage";
import type { PlayerSong } from "@/types/player";
import {
  acknowledgeNativeBackgroundDownloads,
  addNativeBackgroundDownloadListener,
  cancelNativeBackgroundDownloadAccount,
  cancelNativeBackgroundDownloads,
  enqueueNativeBackgroundDownloads,
  getNativeBackgroundDownloadSnapshot,
  protectNativeOfflineMediaStorage,
  setNativeBackgroundDownloadAccount,
  supportsNativeBackgroundDownloads,
  type NativeBackgroundDownloadState,
} from "../../modules/background-downloads";

// Offline downloads. Ports the model from src/client/offline.ts to RN: files →
// expo-file-system (file:// in documentDirectory), records → expo-sqlite,
// reference-counted scopes, account scoping, a serial download pump, and offline
// playback resolution. The blob: materialization is gone — RN plays file://
// directly with Range support (§6/§8).

export { PLAYBACK_CACHE_SCOPE };
export type { DownloadScope, DownloadStatus, OfflineDownloadRecord };
export type { OfflineMutation };

// Mirrors the web store's OfflineSyncStatus / OfflineVerificationStatus so the
// management UI reads the same state machine (see src/client/offline.ts).
export type OfflineSyncStatus = "idle" | "syncing" | "failed" | "auth-required";
export type OfflineVerificationStatus = "idle" | "checking" | "ok" | "repair-needed" | "failed";

const OFFLINE_DIR = `${FileSystem.documentDirectory ?? ""}offline-media/`;
const DOWNLOAD_RECORD_DB_CHUNK_SIZE = 32;
let hydrationPromise: Promise<void> | null = null;
const nativeBackgroundDownloads = supportsNativeBackgroundDownloads();
let nativeDownloadListenerInitialized = false;
let nativeDownloadSubscription: ReturnType<
  typeof addNativeBackgroundDownloadListener
> = null;
let bufferedNativeDownloadStates: NativeBackgroundDownloadState[] = [];
let nativeStateApplyTail: Promise<void> = Promise.resolve();
const nativeRevisionGate = new NativeDownloadRevisionGate();

// --- Account scope -----------------------------------------------------------
let accountScope = "anonymous";
let accountGeneration = 0;
export type OfflineAccountIdentity = {
  scope: string;
  generation: number;
};
export function getOfflineAccountScope(): string {
  return accountScope;
}
export function getOfflineAccountIdentity(): OfflineAccountIdentity {
  return { scope: accountScope, generation: accountGeneration };
}
export function isOfflineAccountIdentityCurrent(
  identity: OfflineAccountIdentity,
): boolean {
  return isOfflineMutationReplayCurrent(
    identity.scope,
    identity.generation,
    accountScope,
    accountGeneration,
  );
}
export function setOfflineAccountScope(scope: string | null | undefined): void {
  const next = scope?.trim() || "anonymous";
  if (next === accountScope) return;
  accountScope = next;
  accountGeneration += 1;
  const counts = currentMutationCounts(next);
  useOfflineStore.setState({
    pendingMutations: counts.pending,
    failedMutations: counts.failed,
    syncStatus: counts.failed > 0 ? "failed" : "idle",
    syncError: counts.failed > 0 ? "Some offline changes need attention" : null,
  });
  // A different account is now active: drop the "user engaged" flag so a stale
  // restore for the new scope can't publish over the previous account's state.
  resetPlaybackEngaged();
  if (nativeBackgroundDownloads) {
    void setNativeBackgroundDownloadAccount(next)
      .then(async () => {
        if (next !== accountScope) {
          // An older account switch resolved after a newer one. Restore the
          // current account immediately instead of leaving its tasks suspended.
          await setNativeBackgroundDownloadAccount(accountScope);
          return;
        }
        await reconcileNativeBackgroundDownloads(next);
      })
      .catch(() => {});
  }
}

export function keyFor(scope: string, songId: string): string {
  return offlineDownloadKey(scope, songId);
}
function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

// --- Offline mutation outbox -------------------------------------------------
const MUTATION_QUEUE_KEY = "spotify_offline_mutations";
const MAX_MUTATION_ATTEMPTS = OFFLINE_MUTATION_MAX_ATTEMPTS;

// On-disk shape of a queued mutation. queueOfflineMutation has always stamped
// `scope` + `queuedAt`; `attempts` is added lazily by the replay so the existing
// persisted queue (items written before this field existed) stays readable.
type StoredMutation = StoredOfflineMutation;

function readMutationQueue(): StoredMutation[] {
  try {
    const raw = storage.getItem(MUTATION_QUEUE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as StoredMutation[]) : [];
  } catch {
    return [];
  }
}

function writeMutationQueue(list: StoredMutation[]): boolean {
  try {
    storage.setItem(MUTATION_QUEUE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function discardOfflineMutationsForScope(scope: string): void {
  const normalized = scope.trim();
  if (!normalized) return;
  // Scope-less rows are from the pre-account-scoping format. During account
  // deletion they necessarily belong to the account whose queue is being
  // retired, because every current writer stamps an explicit scope.
  const retained = readMutationQueue().filter((item) => (item.scope ?? normalized) !== normalized);
  writeMutationQueue(retained);
}

export async function queueOfflineMutation(
  mutation: OfflineMutation,
  scopeOverride = accountScope,
): Promise<void> {
  const scope = scopeOverride.trim() || "anonymous";
  const list = readMutationQueue();
  list.push(createStoredOfflineMutation(mutation, scope));
  if (!writeMutationQueue(list)) throw new Error("Couldn't save offline change");
  const counts = offlineMutationCounts(list, scope, MAX_MUTATION_ATTEMPTS);
  if (shouldPublishOfflineMutationCounts(scope, accountScope)) {
    useOfflineStore.setState({
      pendingMutations: counts.pending,
      failedMutations: counts.failed,
    });
  }
  emit(OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT, { scope });
}

// Replay one queued mutation against the same endpoints the live stores use.
// `like` matches store/likes.ts exactly (POST/DELETE /api/likes with { songId }).
// Throws with a `.status` on a non-OK response so the caller can branch on 401/403.
async function performMutation(mutation: OfflineMutation): Promise<void> {
  if (mutation.type === "like") {
    const res = await apiFetchWithTimeout(
      "/api/likes",
      {
        method: mutation.payload.nextLiked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId: mutation.payload.songId }),
        cache: "no-store",
      },
      OFFLINE_MUTATION_TIMEOUT_MS,
    );
    if (!res.ok) throw Object.assign(new Error(`Request failed with ${res.status}`), { status: res.status });
    return;
  }
  if (mutation.type === "playlist-reorder") {
    const res = await apiFetchWithTimeout(
      `/api/playlist/${encodeURIComponent(mutation.payload.playlistId)}/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songIds: mutation.payload.songIds }),
        cache: "no-store",
      },
      OFFLINE_MUTATION_TIMEOUT_MS,
    );
    if (!res.ok) throw Object.assign(new Error(`Request failed with ${res.status}`), { status: res.status });
    return;
  }
  // song-edit: the RN outbox stores an opaque field bag; forward the id as the
  // path and the rest as the PATCH body, matching the web performMutation shape.
  const payload = mutation.payload as Record<string, unknown>;
  const songId = typeof payload.songId === "string" ? payload.songId : "";
  if (!songId) return; // nothing actionable; treat as a no-op success
  const res = await apiFetchWithTimeout(
    `/api/songs/${encodeURIComponent(songId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    },
    OFFLINE_MUTATION_TIMEOUT_MS,
  );
  if (!res.ok) throw Object.assign(new Error(`Request failed with ${res.status}`), { status: res.status });
}

function mutationErrorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

// Stable identity for a queued mutation across JSON re-parses (the items have no
// id). queuedAt + type + payload uniquely identifies an entry for splice/bump.
function mutationSignature(item: StoredMutation): string {
  return `${item.queuedAt ?? 0}|${item.type}|${JSON.stringify(item.payload)}`;
}

function currentMutationCounts(scope = accountScope): { pending: number; failed: number } {
  return offlineMutationCounts(readMutationQueue(), scope, MAX_MUTATION_ATTEMPTS);
}

export function getQueuedLikeOutboxState(scope = accountScope): LikeOutboxState {
  return deriveLikeOutboxState(
    readMutationQueue(),
    scope,
    MAX_MUTATION_ATTEMPTS,
    canonicalOf,
  );
}

export function hasPersistedLikeMutation(songId: string, scope = accountScope): boolean {
  return getQueuedLikeOutboxState(scope).lockedSongIds.includes(canonicalOf(songId));
}

// --- Store -------------------------------------------------------------------
const AUTO_DOWNLOAD_KEY = "spotify_auto_download_liked";

type OfflineState = {
  autoDownloadLiked: boolean;
  records: Record<string, OfflineDownloadRecord>;
  hydrated: boolean;
  // Mutation-outbox replay state.
  syncStatus: OfflineSyncStatus;
  pendingMutations: number;
  failedMutations: number;
  syncError: string | null;
  // Download verification state.
  verificationStatus: OfflineVerificationStatus;
  verificationCheckedAt: number | null;
  verifiedDownloads: number;
  missingDownloads: number;
  verificationError: string | null;
  // Bytes occupied by ready downloads (refreshed by verifyDownloads/refreshStorage).
  storageBytes: number;
  // Live download fraction (0..1) per record key, only while status is
  // "downloading". Ephemeral + high-frequency — never written to SQLite. Drives
  // the Spotify-style fill ring on the download buttons.
  progress: Record<string, number>;
  setAutoDownloadLiked: (enabled: boolean) => void;
  queueDownloads: (songs: PlayerSong[], scope: DownloadScope) => Promise<void>;
  // Maintain a hidden, bounded queue-ahead cache. Unlike a user download, this
  // scope is replaced as playback advances and is not shown as "Downloaded".
  syncPlaybackCache: (songs: PlayerSong[]) => Promise<void>;
  unpinScope: (songId: string, scope: DownloadScope) => Promise<void>;
  unpinScopeFromSongs: (
    songIds: string[],
    scope: DownloadScope,
  ) => Promise<void>;
  isDownloaded: (songId: string) => boolean;
  hydrate: () => Promise<void>;
  verifyDownloads: () => Promise<void>;
  retryFailedDownloads: () => Promise<void>;
  syncOfflineMutations: () => Promise<void>;
  retryFailedMutations: () => Promise<void>;
  clearDownloads: () => Promise<void>;
  refreshStorage: () => Promise<void>;
  // Pause the legacy Expo transfer. The native iOS queue deliberately ignores
  // this because URLSession owns its background/suspension lifecycle.
  pauseActiveDownload: () => Promise<void>;
};

function recordToRow(record: OfflineDownloadRecord): DownloadRow {
  return {
    key: keyFor(record.accountScope, record.songId),
    accountScope: record.accountScope,
    songId: record.songId,
    scopes: JSON.stringify(record.scopes),
    status: record.status,
    song: JSON.stringify(record.song),
    audioPath: record.audioPath ?? null,
    coverPath: record.coverPath ?? null,
    lyricsPath: record.lyricsPath ?? null,
    transferToken: record.transferToken ?? null,
    updatedAt: record.updatedAt,
  };
}

function rowToRecord(row: DownloadRow): OfflineDownloadRecord {
  return {
    songId: row.songId,
    accountScope: row.accountScope,
    scopes: JSON.parse(row.scopes) as DownloadScope[],
    status: row.status as DownloadStatus,
    song: JSON.parse(row.song) as PlayerSong,
    audioPath: row.audioPath ?? undefined,
    coverPath: row.coverPath ?? undefined,
    lyricsPath: row.lyricsPath ?? undefined,
    transferToken: row.transferToken ?? undefined,
    updatedAt: row.updatedAt,
  };
}

function nativeDownloadReference(record: OfflineDownloadRecord): {
  key: string;
  transferToken: string;
} | null {
  if (!record.transferToken) return null;
  return {
    key: keyFor(record.accountScope, record.songId),
    transferToken: record.transferToken,
  };
}

async function enqueueRecordsWithNativeBackgroundDownloader(
  records: readonly OfflineDownloadRecord[],
): Promise<void> {
  if (!nativeBackgroundDownloads) return;
  const jobs = records
    .filter(
      (record) =>
        record.status === "queued" || record.status === "downloading",
    )
    .map((record) =>
      createBackgroundDownloadTransportJob(
        record,
        keyFor(record.accountScope, record.songId),
        toAbsoluteApiUrl,
      ),
    )
    .filter((job): job is NonNullable<typeof job> => job !== null);
  await enqueueNativeBackgroundDownloads(jobs);
}

export const useOfflineStore = create<OfflineState>((set, get) => {
  // Persist a record to memory + SQLite.
  const persist = (record: OfflineDownloadRecord) => {
    set((s) => ({ records: { ...s.records, [keyFor(record.accountScope, record.songId)]: record } }));
    void dbUpsertRow(recordToRow(record)).catch(() => {});
  };

  // Live progress (0..1) for the fill ring. Throttled to ~2% steps (plus a
  // guaranteed emit at 1.0) so a multi-MB download triggers ~50 re-renders, not
  // thousands. Kept in a plain closure map so the throttle survives re-renders.
  const lastEmit: Record<string, number> = {};
  const setProgress = (key: string, frac: number) => {
    const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const prev = lastEmit[key];
    if (clamped !== 1 && prev !== undefined && Math.abs(clamped - prev) < 0.02) return;
    lastEmit[key] = clamped;
    set((s) => ({ progress: { ...s.progress, [key]: clamped } }));
  };
  const clearProgress = (key: string) => {
    delete lastEmit[key];
    set((s) => {
      if (!(key in s.progress)) return {} as Partial<OfflineState>;
      const next = { ...s.progress };
      delete next[key];
      return { progress: next };
    });
  };

  const { runPump, pauseActiveDownload, isActiveDownloadKey } = createJsOfflineDownloadPump({
    getAccountScope: () => accountScope,
    nativeBackgroundDownloads,
    offlineDir: OFFLINE_DIR,
    getRecords: () => get().records,
    persist,
    setProgress,
    clearProgress,
    keyFor,
  });

  const removeRecord = async (record: OfflineDownloadRecord) => {
    const key = keyFor(record.accountScope, record.songId);
    const nativeReference = nativeDownloadReference(record);
    const transferIdentity = nativeReference
      ? nativeTransferIdentity(
          nativeReference.key,
          nativeReference.transferToken,
        )
      : null;
    if (transferIdentity) nativeRevisionGate.tombstone(transferIdentity);
    // Remove the exact generation synchronously so a delayed batch-persistence
    // pass cannot enqueue it after the native cancellation check.
    let removed = false;
    set((state) => {
      if (state.records[key] !== record) return {};
      const records = { ...state.records };
      const progress = { ...state.progress };
      delete records[key];
      delete progress[key];
      removed = true;
      return { records, progress };
    });
    if (!removed) {
      if (transferIdentity) nativeRevisionGate.clearTombstone(transferIdentity);
      return;
    }
    delete lastEmit[key];

    if (nativeBackgroundDownloads && nativeReference) {
      // Native writes its cancellation tombstone before cancelling URLSession,
      // so a late completion can never recreate this just-unpinned song.
      try {
        await cancelNativeBackgroundDownloads([nativeReference]);
      } catch (error) {
        nativeRevisionGate.clearTombstone(transferIdentity!);
        set((state) =>
          state.records[key]
            ? {}
            : { records: { ...state.records, [key]: record } },
        );
        throw error;
      }
    } else if (isActiveDownloadKey(key)) {
      // Queue-ahead targets are unpinned as playback moves. Cancel that native
      // transfer before removing its directory so it cannot keep consuming data
      // or recreate an orphan after the deletion.
      await pauseActiveDownload();
    }
    await dbDeleteRow(key);
    // best-effort file cleanup
    const stillReferenced = Object.values(get().records).some(
      (candidate) => candidate.songId === record.songId,
    );
    if (!stillReferenced) {
      try {
        await FileSystem.deleteAsync(`${OFFLINE_DIR}${safeName(record.songId)}/`, { idempotent: true });
      } catch {}
    }
  };

  // Guards the mutation-outbox drain so overlapping AppState/foreground events
  // (and the Sync-now button) can't run two drains concurrently.
  let syncRunning = false;

  const persistQueuedRecordBatch = async (records: readonly OfflineDownloadRecord[]) => {
    if (nativeBackgroundDownloads && records.length === 0) {
      await enqueueRecordsWithNativeBackgroundDownloader(
        Object.values(get().records).filter(
          (record) => record.accountScope === accountScope,
        ),
      ).catch(() => {});
      return;
    }

    let pumpStarted = false;
    try {
      if (nativeBackgroundDownloads && records.length > 0) {
        // Submit the complete manifest immediately. The native ledger embeds the
        // full record metadata, so it can safely be the first durable write and
        // reconstruct SQLite if iOS suspends JavaScript after this await.
        const liveRecords = records.filter(
          (record) =>
            get().records[keyFor(record.accountScope, record.songId)] ===
            record,
        );
        await enqueueRecordsWithNativeBackgroundDownloader(liveRecords).catch(
          (error) => {
            for (const record of liveRecords) {
              const latest =
                get().records[keyFor(record.accountScope, record.songId)];
              if (
                latest?.transferToken === record.transferToken &&
                latest.status !== "ready"
              ) {
                persist({
                  ...latest,
                  status: "error",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Couldn't start background download",
                  updatedAt: Date.now(),
                });
              }
            }
          },
        );
      }

      for (let offset = 0; offset < records.length; offset += DOWNLOAD_RECORD_DB_CHUNK_SIZE) {
        const chunk = records.slice(offset, offset + DOWNLOAD_RECORD_DB_CHUNK_SIZE);
        // A cancel, scope change, or pump transition replaces/removes the exact
        // object stored in memory. Skip that stale queued snapshot so a delayed
        // chunk cannot resurrect a cancellation or overwrite "downloading".
        const current = chunk.filter(
          (record) => get().records[keyFor(record.accountScope, record.songId)] === record,
        );
        if (current.length > 0) {
          await dbUpsertRows(current.map(recordToRow)).catch(() => {});
        }
        if (!nativeBackgroundDownloads && !pumpStarted) {
          pumpStarted = true;
          void runPump();
        }
        if (offset + DOWNLOAD_RECORD_DB_CHUNK_SIZE < records.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } finally {
      // Preserve queueDownloads' old guarantee that even an empty/no-op call
      // re-kicks a previously-paused in-memory queue.
      if (!nativeBackgroundDownloads && !pumpStarted) void runPump();
    }
  };

  // Recompute total downloaded bytes + pending-mutation count into store state.
  // Lives in the closure so verifyDownloads / clearDownloads / the pump can all
  // refresh the management UI's numbers without re-statting via the component.
  const refreshStorage = async () => {
    try {
      const { getDiskUsage } = await import("@/lib/disk-usage");
      const usage = await getDiskUsage();
      set({ storageBytes: usage.usedByDownloads });
    } catch {}
    const counts = currentMutationCounts();
    set({ pendingMutations: counts.pending, failedMutations: counts.failed });
  };

  const initialMutationCounts = currentMutationCounts();

  return {
    autoDownloadLiked: storage.getItem(AUTO_DOWNLOAD_KEY) === "1",
    records: {},
    progress: {},
    hydrated: false,
    syncStatus: initialMutationCounts.failed > 0 ? "failed" : "idle",
    pendingMutations: initialMutationCounts.pending,
    failedMutations: initialMutationCounts.failed,
    syncError: initialMutationCounts.failed > 0 ? "Some offline changes need attention" : null,
    verificationStatus: "idle",
    verificationCheckedAt: null,
    verifiedDownloads: 0,
    missingDownloads: 0,
    verificationError: null,
    storageBytes: 0,

    setAutoDownloadLiked: (enabled) => {
      try {
        storage.setItem(AUTO_DOWNLOAD_KEY, enabled ? "1" : "0");
      } catch {}
      set({ autoDownloadLiked: enabled });
      if (enabled) void backfillLikedDownloads();
    },

    queueDownloads: async (songs, scope) => {
      const planned = planQueuedDownloads(
        get().records,
        songs,
        scope,
        accountScope,
        Date.now,
        nativeBackgroundDownloads
          ? () => createDownloadTransferToken()
          : undefined,
      );
      if (planned.changedRecords.length > 0) {
        // One clone + one subscriber notification for the whole batch, rather
        // than N increasingly-large clones and N React render notifications.
        set({ records: planned.records });
      }
      // The native manifest is durably handed to URLSession before this promise
      // reaches its first suspension point. SQLite follows in bounded chunks;
      // if the app is killed between them, hydration can rebuild a missing row
      // from the native job's embedded metadata.
      await persistQueuedRecordBatch(planned.changedRecords);
    },

    syncPlaybackCache: async (songs) => {
      if (!get().hydrated) return;
      const targets = new Map<string, PlayerSong>();
      for (const song of songs) {
        if (song?.id && song.audioUrl) targets.set(song.id, song);
      }

      const cached = Object.values(get().records).filter(
        (record) =>
          record.accountScope === accountScope &&
          record.scopes.includes(PLAYBACK_CACHE_SCOPE),
      );
      for (const record of cached) {
        if (!targets.has(record.songId)) {
          await get().unpinScope(record.songId, PLAYBACK_CACHE_SCOPE);
        }
      }
      for (const song of targets.values()) {
        await get().queueDownloads([song], PLAYBACK_CACHE_SCOPE);
      }
    },

    unpinScope: async (songId, scope) => {
      const record = get().records[keyFor(accountScope, songId)];
      if (!record) return;
      const scopes = record.scopes.filter((s) => s !== scope);
      if (scopes.length === 0) {
        await removeRecord(record);
      } else {
        const updated = { ...record, scopes, updatedAt: Date.now() };
        persist(updated);
        if (
          nativeBackgroundDownloads &&
          (updated.status === "queued" || updated.status === "downloading")
        ) {
          await enqueueRecordsWithNativeBackgroundDownloader([updated]).catch(
            () => {},
          );
        }
      }
    },

    unpinScopeFromSongs: async (songIds, scope) => {
      const targetAccount = accountScope;
      const sourceRecords = get().records;
      const planned = planUnpinScopeFromSongs(
        sourceRecords,
        songIds,
        scope,
        targetAccount,
      );
      if (
        planned.removedRecords.length === 0 &&
        planned.updatedRecords.length === 0
      ) {
        return;
      }

      const references = planned.removedRecords.flatMap((record) => {
        const reference = nativeDownloadReference(record);
        return reference ? [reference] : [];
      });
      const transferIdentities = references.map((reference) =>
        nativeTransferIdentity(reference.key, reference.transferToken),
      );
      for (const identity of transferIdentities) {
        nativeRevisionGate.tombstone(identity);
      }

      // Publish the targeted removals synchronously. A still-running
      // persistQueuedRecordBatch compares object identity, so it now skips these
      // generations instead of submitting them after cancellation.
      set((state) => {
        const records = { ...state.records };
        const progress = { ...state.progress };
        for (const record of planned.removedRecords) {
          const key = keyFor(record.accountScope, record.songId);
          delete records[key];
          delete progress[key];
          delete lastEmit[key];
        }
        for (const record of planned.updatedRecords) {
          records[keyFor(record.accountScope, record.songId)] = record;
        }
        return { records, progress };
      });

      if (nativeBackgroundDownloads && references.length > 0) {
        try {
          // One native bridge call writes every cancellation tombstone before
          // any SQLite row or song folder is removed.
          await cancelNativeBackgroundDownloads(references);
        } catch (error) {
          // Restore only entries still carrying this action's result. Anything
          // changed by a newer user action wins and is left untouched.
          set((state) => {
            const records = { ...state.records };
            for (const record of planned.removedRecords) {
              const key = keyFor(record.accountScope, record.songId);
              if (!records[key]) records[key] = record;
            }
            for (const record of planned.updatedRecords) {
              const key = keyFor(record.accountScope, record.songId);
              if (records[key] === record) records[key] = sourceRecords[key];
            }
            return { records };
          });
          for (const identity of transferIdentities) {
            nativeRevisionGate.clearTombstone(identity);
          }
          const restored = planned.removedRecords.filter((record) => {
            const current =
              get().records[keyFor(record.accountScope, record.songId)];
            return (
              current === record &&
              (record.status === "queued" ||
                record.status === "downloading")
            );
          });
          await enqueueRecordsWithNativeBackgroundDownloader(restored).catch(
            () => {},
          );
          throw error;
        }
      }

      await dbDeleteRows(
        planned.removedRecords.map((record) =>
          keyFor(record.accountScope, record.songId),
        ),
      );
      for (
        let offset = 0;
        offset < planned.updatedRecords.length;
        offset += DOWNLOAD_RECORD_DB_CHUNK_SIZE
      ) {
        await dbUpsertRows(
          planned.updatedRecords
            .slice(offset, offset + DOWNLOAD_RECORD_DB_CHUNK_SIZE)
            .map(recordToRow),
        );
      }

      const stillActive = planned.updatedRecords.filter(
        (record) =>
          record.status === "queued" || record.status === "downloading",
      );
      if (nativeBackgroundDownloads && stillActive.length > 0) {
        await enqueueRecordsWithNativeBackgroundDownloader(stillActive).catch(
          () => {},
        );
      }

      await Promise.all(
        planned.removedRecords
          .filter(
            (record) =>
              !Object.values(get().records).some(
                (candidate) => candidate.songId === record.songId,
              ),
          )
          .map((record) =>
            FileSystem.deleteAsync(
              `${OFFLINE_DIR}${safeName(record.songId)}/`,
              { idempotent: true },
            ).catch(() => {}),
          ),
      );
      void refreshStorage();
    },

    isDownloaded: (songId) => get().records[keyFor(accountScope, songId)]?.status === "ready",

    hydrate: async () => {
      if (get().hydrated) return;
      if (!hydrationPromise) {
        // Several launch paths ask for offline state (audio bootstrap, settings,
        // download buttons). Share one pass so they cannot concurrently load DB
        // snapshots, purge folders, and start competing pump decisions.
        hydrationPromise = (async () => {
          try {
            const hydrationScope = accountScope;
            const rows = await dbAllRows();
            let nativeStates: NativeBackgroundDownloadState[] = [];
            let nativeSnapshotAvailable = false;
            if (nativeBackgroundDownloads) {
              initializeNativeBackgroundDownloadListener();
              await setNativeBackgroundDownloadAccount(hydrationScope).catch(
                () => {},
              );
              try {
                nativeStates =
                  await getNativeBackgroundDownloadSnapshot(hydrationScope);
                nativeSnapshotAvailable = true;
              } catch {
                // A transient native bridge/session failure must never turn a
                // populated SQLite library into an empty in-memory one. Keep
                // its generations and submit them idempotently below.
              }
            }
            const nativeByKey = new Map(
              nativeStates.map((state) => [state.key, state]),
            );
            const records: Record<string, OfflineDownloadRecord> = {};
            for (const row of rows) {
              let record = rowToRecord(row);
              if (
                nativeBackgroundDownloads &&
                nativeSnapshotAvailable &&
                record.accountScope === hydrationScope
              ) {
                const nativeState = nativeByKey.get(row.key);
                const merged = nativeState
                  ? applyBackgroundDownloadTransportState(
                      record,
                      nativeState as BackgroundDownloadTransportState,
                    )
                  : null;
                if (merged) {
                  record = merged;
                } else if (record.status === "downloading") {
                  // No matching native generation owns this row anymore (for
                  // example after a force-quit). Requeue it under a fresh token.
                  record = {
                    ...record,
                    status: "queued",
                    transferToken: createDownloadTransferToken(),
                    updatedAt: Date.now(),
                  };
                } else if (
                  record.status === "queued" &&
                  !record.transferToken
                ) {
                  record = {
                    ...record,
                    transferToken: createDownloadTransferToken(),
                    updatedAt: Date.now(),
                  };
                }
              } else if (
                nativeBackgroundDownloads &&
                record.accountScope === hydrationScope &&
                (record.status === "queued" ||
                  record.status === "downloading") &&
                !record.transferToken
              ) {
                record = {
                  ...record,
                  transferToken: createDownloadTransferToken(),
                  updatedAt: Date.now(),
                };
              } else if (!nativeBackgroundDownloads && record.status === "downloading") {
                // The legacy Expo resumable keeps resume state in-process only.
                record.status = "queued";
              }
              records[row.key] = record;
            }

            // The native ledger is a completion outbox as well as a transport
            // queue. If the app was system-terminated before later SQLite chunks
            // landed, rebuild those rows from the durable native job metadata.
            if (nativeBackgroundDownloads) {
              for (const nativeState of nativeStates) {
                if (records[nativeState.key]) continue;
                const restored = restoreRecordFromBackgroundDownloadState(
                  nativeState as BackgroundDownloadTransportState,
                );
                if (restored) records[nativeState.key] = restored;
              }
            }
            set({ records });

            if (nativeBackgroundDownloads) {
              const allRecords = Object.values(records);
              for (
                let offset = 0;
                offset < allRecords.length;
                offset += DOWNLOAD_RECORD_DB_CHUNK_SIZE
              ) {
                await dbUpsertRows(
                  allRecords
                    .slice(offset, offset + DOWNLOAD_RECORD_DB_CHUNK_SIZE)
                    .map(recordToRow),
                );
              }
            }

            // Validate/re-root trusted completed records before publishing
            // `hydrated=true`, so source selection can never observe a stale
            // ready row. Queued/interrupted files are deliberately NOT promoted.
            await reconcileDownloadedFiles();
            await purgeOrphanedDownloadArtifacts();
            if (nativeBackgroundDownloads) {
              // Imported/restored downloads bypass the native move step that
              // normally applies file protection and iCloud-backup exclusion.
              // Normalize the complete tree before exposing it as hydrated.
              await protectNativeOfflineMediaStorage().catch(() => {});
            }

            if (nativeBackgroundDownloads) {
              // A terminal native item is removed only after SQLite contains the
              // same validated state. Until this ack, a completion cannot be lost.
              const acknowledgements = nativeStates.flatMap((state) => {
                const record = get().records[state.key];
                if (
                  !record ||
                  record.transferToken !== state.transferToken ||
                  record.status !== state.status ||
                  !isTerminalBackgroundDownloadState(
                    state as BackgroundDownloadTransportState,
                  )
                ) {
                  return [];
                }
                return [
                  {
                    key: state.key,
                    transferToken: state.transferToken,
                    revision: state.revision,
                  },
                ];
              });
              await acknowledgeNativeBackgroundDownloads(
                acknowledgements,
              ).catch(() => {});
            }

            set({ hydrated: true });

            if (nativeBackgroundDownloads) {
              const queued = Object.values(get().records).filter(
                (record) =>
                  record.accountScope === accountScope &&
                  (record.status === "queued" ||
                    record.status === "downloading"),
              );
              const withTokens = queued.map((record) =>
                record.transferToken
                  ? record
                  : {
                      ...record,
                      transferToken: createDownloadTransferToken(),
                      updatedAt: Date.now(),
                    },
              );
              if (withTokens.some((record, index) => record !== queued[index])) {
                set((state) => ({
                  records: {
                    ...state.records,
                    ...Object.fromEntries(
                      withTokens.map((record) => [
                        keyFor(record.accountScope, record.songId),
                        record,
                      ]),
                    ),
                  },
                }));
                await dbUpsertRows(withTokens.map(recordToRow));
              }
              await enqueueRecordsWithNativeBackgroundDownloader(withTokens);
              flushBufferedNativeDownloadStates();
              await reconcileNativeBackgroundDownloads(accountScope);
            } else if (
              Object.values(get().records).some(
                (record) =>
                  record.status === "queued" ||
                  record.status === "downloading",
              )
            ) {
              void runPump();
            }
          } catch {
            set({ hydrated: true });
          }
          void refreshStorage();
        })();
        try {
          await hydrationPromise;
        } finally {
          hydrationPromise = null;
        }
        return;
      }
      await hydrationPromise;
    },

    verifyDownloads: async () => {
      await get().hydrate();
      set({ verificationStatus: "checking", verificationError: null });
      try {
        const rows = await readAllDownloadedRecords(accountScope);
        let verified = 0;
        let missing = 0;
        for (const row of rows) {
          const result = await verifyOrRepairRecord(row);
          if (result.ok) {
            verified += 1;
          } else {
            missing += 1;
            // verifyOrRepairRecord already flipped the row to "queued" in SQLite;
            // mirror that into the in-memory record so the pump and UI agree.
            const current = get().records[row.key];
            if (current) {
              persist({
                ...current,
                status: "queued",
                audioPath: result.audioValid ? current.audioPath : undefined,
                coverPath: result.coverValid ? current.coverPath : undefined,
                lyricsPath: result.lyricsValid ? current.lyricsPath : undefined,
                transferToken: nativeBackgroundDownloads
                  ? createDownloadTransferToken()
                  : current.transferToken,
                updatedAt: Date.now(),
              });
            }
          }
        }
        set({
          verificationStatus: missing > 0 ? "repair-needed" : "ok",
          verificationCheckedAt: Date.now(),
          verifiedDownloads: verified,
          missingDownloads: missing,
          verificationError: null,
        });
        if (missing > 0) {
          if (nativeBackgroundDownloads) {
            void enqueueRecordsWithNativeBackgroundDownloader(
              Object.values(get().records).filter(
                (record) =>
                  record.accountScope === accountScope &&
                  record.status === "queued",
              ),
            );
          } else {
            void runPump();
          }
        }
        void refreshStorage();
      } catch (e) {
        set({
          verificationStatus: "failed",
          verificationCheckedAt: Date.now(),
          verificationError: e instanceof Error ? e.message : "Download verification failed",
        });
      }
    },

    retryFailedDownloads: async () => {
      const failed = Object.values(get().records).filter(
        (r) => r.accountScope === accountScope && r.status === "error",
      );
      const retried: OfflineDownloadRecord[] = [];
      for (const record of failed) {
        const updated = {
          ...record,
          status: "queued" as const,
          error: undefined,
          transferToken: nativeBackgroundDownloads
            ? createDownloadTransferToken()
            : record.transferToken,
          updatedAt: Date.now(),
        };
        retried.push(updated);
        persist(updated);
      }
      if (failed.length > 0) {
        if (nativeBackgroundDownloads) {
          await enqueueRecordsWithNativeBackgroundDownloader(retried).catch(
            () => {},
          );
        } else {
          void runPump();
        }
      }
    },

    retryFailedMutations: async () => {
      const retryScope = accountScope;
      const reset = resetExhaustedOfflineMutations(
        readMutationQueue(),
        retryScope,
        MAX_MUTATION_ATTEMPTS,
      );
      if (reset.reset === 0) {
        const counts = currentMutationCounts(retryScope);
        if (accountScope === retryScope) {
          set({ pendingMutations: counts.pending, failedMutations: counts.failed });
        }
        return;
      }
      if (!writeMutationQueue(reset.mutations)) {
        if (accountScope === retryScope) {
          set({ syncStatus: "failed", syncError: "Couldn't retry offline changes" });
        }
        return;
      }

      const counts = offlineMutationCounts(
        reset.mutations,
        retryScope,
        MAX_MUTATION_ATTEMPTS,
      );
      if (accountScope === retryScope) {
        set({
          pendingMutations: counts.pending,
          failedMutations: counts.failed,
          syncStatus: "idle",
          syncError: null,
        });
      }
      emit(OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT, { scope: retryScope });
      await get().syncOfflineMutations();
    },

    syncOfflineMutations: async () => {
      if (syncRunning) return;
      const replayScope = accountScope;
      const replayGeneration = accountGeneration;
      const replayIsCurrent = () =>
        isOfflineMutationReplayCurrent(
          replayScope,
          replayGeneration,
          accountScope,
          accountGeneration,
        );
      // Mirror navigator.onLine guard from the web: nothing to do with an empty
      // queue, and we avoid flipping the status pill on every cold start.
      const queue = readMutationQueue();
      const pending = pendingOfflineMutations(queue, replayScope, MAX_MUTATION_ATTEMPTS);
      const beforeCounts = offlineMutationCounts(queue, replayScope, MAX_MUTATION_ATTEMPTS);
      if (pending.length === 0) {
        if (replayIsCurrent()) {
          set({
            syncStatus: beforeCounts.failed > 0 ? "failed" : "idle",
            syncError:
              beforeCounts.failed > 0 ? "Some offline changes need attention" : null,
            pendingMutations: 0,
            failedMutations: beforeCounts.failed,
          });
        }
        return;
      }
      if (!getIsOnline()) {
        // Offline is a wait state, not a failed mutation attempt. Burning retry
        // counts here could permanently abandon every queued edit after five
        // foregrounds in airplane mode.
        if (replayIsCurrent()) {
          set({
            syncStatus: beforeCounts.failed > 0 ? "failed" : "idle",
            syncError:
              beforeCounts.failed > 0 ? "Some offline changes need attention" : null,
            pendingMutations: beforeCounts.pending,
            failedMutations: beforeCounts.failed,
          });
        }
        return;
      }
      syncRunning = true;
      if (replayIsCurrent()) {
        set({ syncStatus: "syncing", syncError: null });
      }
      try {
        // We re-read the persisted queue fresh after every await — JSON.parse
        // yields new object references each time, so items can't be matched by
        // reference; locate each by a stable content signature instead. Rewriting
        // the whole array per attempt keeps concurrent queueOfflineMutation
        // appends (which push to the end) intact: success splices the item out,
        // failure bumps its attempts in place.
        let authRequired = false;
        let lastError: string | null = null;
        // Snapshot the signatures to process (oldest first); the live array is
        // re-read inside the loop so we always write back the freshest copy.
        await replayMutationsFifo(pending, async (target) => {
          if (!replayIsCurrent()) return "stop";
          const sig = mutationSignature(target);
          const list = readMutationQueue();
          const idx = list.findIndex((item) => mutationSignature(item) === sig);
          if (idx === -1) return "continue"; // already drained or signature changed
          const item = list[idx];
          try {
            await performMutation(item);
            // The authenticated cookie can change while a request is in flight.
            // Preserve the row rather than accepting an ambiguous response; the
            // absolute mutation is safe to retry under the captured account.
            if (!replayIsCurrent()) return "stop";
            const after = readMutationQueue();
            const removeAt = after.findIndex((m) => mutationSignature(m) === sig);
            const settled =
              removeAt === -1
                ? { mutations: after, discardedFailures: 0 }
                : settleAppliedOfflineMutation(
                    after,
                    removeAt,
                    MAX_MUTATION_ATTEMPTS,
                    replayScope,
                    canonicalOf,
                  );
            if (!writeMutationQueue(settled.mutations)) {
              lastError = "Couldn't save offline sync progress";
              return "stop";
            }
            emit(OFFLINE_MUTATION_REPLAY_APPLIED_EVENT, {
              scope: offlineMutationScope(item, replayScope),
              mutation: item,
            });
            const counts = offlineMutationCounts(
              settled.mutations,
              replayScope,
              MAX_MUTATION_ATTEMPTS,
            );
            if (replayIsCurrent()) {
              set({
                pendingMutations: counts.pending,
                failedMutations: counts.failed,
              });
            }
            return "continue";
          } catch (e) {
            if (!replayIsCurrent()) return "stop";
            const status = mutationErrorStatus(e);
            const failure = planOfflineMutationFailure({
              attempts: item.attempts ?? 0,
              online: getIsOnline(),
              status,
              maxAttempts: MAX_MUTATION_ATTEMPTS,
            });
            if (failure.kind === "auth-required") {
              authRequired = true;
              return "stop";
            }
            if (failure.kind === "offline") {
              // apiFetch/apiFetchWithTimeout marks a rejected or timed-out
              // transport offline. Preserve this item and every item behind it
              // unchanged; reconnect re-runs the drain.
              lastError = null;
              return "stop";
            }
            const after = readMutationQueue();
            const bumpAt = after.findIndex((m) => mutationSignature(m) === sig);
            if (bumpAt !== -1) {
              after[bumpAt] = {
                ...after[bumpAt],
                attempts: failure.nextAttempts,
                error: e instanceof Error ? e.message : "Sync failed",
              };
              if (!writeMutationQueue(after)) {
                lastError = "Couldn't save offline sync progress";
                return "stop";
              }
              if (failure.kind === "retry-exhausted") {
                emit(OFFLINE_MUTATION_REPLAY_EXHAUSTED_EVENT, {
                  scope: offlineMutationScope(item, replayScope),
                  mutation: after[bumpAt],
                  error: e instanceof Error ? e.message : "Sync failed",
                });
              }
            } else {
              return "continue";
            }
            lastError = e instanceof Error ? e.message : "Sync failed";
            const counts = offlineMutationCounts(
              after,
              replayScope,
              MAX_MUTATION_ATTEMPTS,
            );
            if (replayIsCurrent()) {
              set({
                pendingMutations: counts.pending,
                failedMutations: counts.failed,
              });
            }
            // Stop behind any mutation that remains retryable. Once an item has
            // exhausted its retry budget it is a dead letter, so later FIFO
            // entries may continue draining instead of being blocked forever.
            return failure.stop ? "stop" : "continue";
          }
        });
        const counts = currentMutationCounts(replayScope);
        if (replayIsCurrent()) {
          if (authRequired) {
            set({
              syncStatus: "auth-required",
              syncError: "Sign in to finish syncing offline changes",
            });
          } else if (lastError || counts.failed > 0) {
            set({
              syncStatus: "failed",
              syncError:
                lastError ??
                `${counts.failed} offline ${counts.failed === 1 ? "change needs" : "changes need"} retry`,
            });
          } else {
            set({ syncStatus: "idle", syncError: null });
          }
          set({
            pendingMutations: counts.pending,
            failedMutations: counts.failed,
          });
        }
      } catch (e) {
        if (replayIsCurrent()) {
          const counts = currentMutationCounts(replayScope);
          set({
            syncStatus: "failed",
            syncError: e instanceof Error ? e.message : "Sync failed",
            pendingMutations: counts.pending,
            failedMutations: counts.failed,
          });
        }
      } finally {
        syncRunning = false;
        // A new account may have attempted a drain while the previous account
        // still held the singleton lock. Give the active scope its own pass now.
        if (!replayIsCurrent()) {
          void get().syncOfflineMutations();
        }
      }
    },

    clearDownloads: async () => {
      const targetScope = accountScope;
      const records = Object.values(get().records).filter(
        (record) => record.accountScope === targetScope,
      );
      const keys = records.map((record) =>
        keyFor(record.accountScope, record.songId),
      );
      const transferIdentities = records.flatMap((record) => {
        const reference = nativeDownloadReference(record);
        return reference
          ? [nativeTransferIdentity(reference.key, reference.transferToken)]
          : [];
      });
      for (const identity of transferIdentities) {
        nativeRevisionGate.tombstone(identity);
      }
      // Block delayed batch persistence before awaiting the native tombstones.
      set((state) => {
        const nextRecords = { ...state.records };
        const nextProgress = { ...state.progress };
        for (const key of keys) {
          delete nextRecords[key];
          delete nextProgress[key];
          delete lastEmit[key];
        }
        return { records: nextRecords, progress: nextProgress };
      });

      // Stop the native URLSession writer before deleting its row/directory.
      // Otherwise a just-cleared in-flight download can finish after the purge
      // and recreate an orphaned multi-MB file with no record pointing to it.
      if (nativeBackgroundDownloads) {
        try {
          await cancelNativeBackgroundDownloadAccount(targetScope);
        } catch (error) {
          for (const identity of transferIdentities) {
            nativeRevisionGate.clearTombstone(identity);
          }
          set((state) => {
            const nextRecords = { ...state.records };
            for (const record of records) {
              const key = keyFor(record.accountScope, record.songId);
              if (!nextRecords[key]) nextRecords[key] = record;
            }
            return { records: nextRecords };
          });
          throw error;
        }
      } else {
        await pauseActiveDownload();
      }
      set({
        verificationStatus: "idle",
        verificationCheckedAt: null,
        verifiedDownloads: 0,
        missingDownloads: 0,
        verificationError: null,
      });
      await dbDeleteRows(keys);
      await Promise.all(
        records.map(async (record) => {
          const retained = Object.values(get().records).some(
            (candidate) => candidate.songId === record.songId,
          );
          if (retained) return;
          await FileSystem.deleteAsync(`${OFFLINE_DIR}${safeName(record.songId)}/`, { idempotent: true }).catch(
            () => {},
          );
        }),
      );
      // Orphaned NSURLSession partials live outside offline-media, so the loop
      // above never touches them — sweep that OS scratch too so a manual clear
      // reclaims it as well (see purgeOrphanedDownloadArtifacts).
      await purgeOrphanedDownloadArtifacts();
      await refreshStorage();
    },

    refreshStorage,
    pauseActiveDownload,
  };
});

// Account deletion is stronger than sign-out: remove this account's downloaded
// bytes, SQLite records, and deferred mutation outbox entries so deleted data
// cannot reappear or attempt to sync if the same email is registered later.
export async function clearOfflineAccountData(scope: string): Promise<void> {
  const normalized = scope.trim();
  if (!normalized) return;

  try {
    const store = useOfflineStore.getState();
    if (nativeBackgroundDownloads) {
      await cancelNativeBackgroundDownloadAccount(normalized).catch(() => {});
    } else if (normalized === accountScope) {
      await store.pauseActiveDownload();
    }
    await store.hydrate();

    const records = Object.values(useOfflineStore.getState().records);
    const { deleting, retainedSongIds } = planOfflineAccountDeletion(records, normalized);
    const deletingKeys = new Set(
      deleting.map((record) => keyFor(record.accountScope, record.songId)),
    );
    useOfflineStore.setState((state) => ({
      records: Object.fromEntries(
        Object.entries(state.records).filter(([key]) => !deletingKeys.has(key)),
      ),
      progress: Object.fromEntries(
        Object.entries(state.progress).filter(([key]) => !deletingKeys.has(key)),
      ),
      ...(normalized === accountScope
        ? {
            verificationStatus: "idle" as const,
            verificationCheckedAt: null,
            verifiedDownloads: 0,
            missingDownloads: 0,
            verificationError: null,
          }
        : {}),
    }));

    for (const record of deleting) {
      await dbDeleteRow(keyFor(record.accountScope, record.songId)).catch(() => {});
      // The legacy directory layout is keyed by song id rather than account.
      // Keep the bytes if another account on this device references that id.
      if (!retainedSongIds.has(record.songId)) {
        await FileSystem.deleteAsync(`${OFFLINE_DIR}${safeName(record.songId)}/`, {
          idempotent: true,
        }).catch(() => {});
      }
    }
    await purgeOrphanedDownloadArtifacts();
  } catch {
    // Server deletion remains authoritative; local cleanup is best-effort and
    // each row/file delete is idempotent.
  }
  discardOfflineMutationsForScope(normalized);
  emit(OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT, { scope: normalized });
  const counts = currentMutationCounts();
  useOfflineStore.setState({
    pendingMutations: counts.pending,
    failedMutations: counts.failed,
    ...(normalized === accountScope || accountScope === "unauthenticated"
      ? {
          syncStatus: counts.failed > 0 ? ("failed" as const) : ("idle" as const),
          syncError:
            counts.failed > 0 ? "Some offline changes need attention" : null,
        }
      : {}),
  });
  void useOfflineStore.getState().refreshStorage();
}

async function isValidStoredDownloadPath(
  path: string | null | undefined,
): Promise<boolean> {
  const livePath = resolveMediaPath(path);
  if (!livePath) return false;
  try {
    const info = await FileSystem.getInfoAsync(livePath);
    return info.exists && !info.isDirectory && info.size > 0;
  } catch {
    return false;
  }
}

// Validate and re-attach records that SQLite says completed. A catalogued cover
// or lyrics file is part of a complete download, so a ready row missing either
// is queued for an in-place sidecar repair before hydration completes. Existing
// valid audio stays attached and native transport adopts it rather than fetching
// the large payload again. Queued/downloading rows are never promoted from a
// stray destination because an interrupted transfer can leave a partial file.
async function reconcileDownloadedFiles(): Promise<void> {
  const records = Object.values(useOfflineStore.getState().records);
  const fixed: Record<string, OfflineDownloadRecord> = {};
  for (const rec of records) {
    if (rec.status !== "ready") continue;

    const relDir = `offline-media/${safeName(rec.songId)}`;
    const absDir = `${FileSystem.documentDirectory ?? ""}${relDir}`;
    let names: string[] = [];
    try {
      names = await FileSystem.readDirectoryAsync(absDir);
    } catch {}
    const audioName = names.find((name) => name.startsWith("audio"));
    const coverName = names.find((name) => name.startsWith("cover"));
    const lyricsName = names.find((name) => name.startsWith("lyrics"));
    const discoveredAudio = audioName ? `${relDir}/${audioName}` : undefined;
    const discoveredCover = coverName ? `${relDir}/${coverName}` : undefined;
    const discoveredLyrics = lyricsName ? `${relDir}/${lyricsName}` : undefined;

    const [storedAudioValid, storedCoverValid, storedLyricsValid] =
      await Promise.all([
        isValidStoredDownloadPath(rec.audioPath),
        isValidStoredDownloadPath(rec.coverPath),
        isValidStoredDownloadPath(rec.lyricsPath),
      ]);
    const audioPath = storedAudioValid
      ? toMediaRelativePath(rec.audioPath) ?? undefined
      : (await isValidStoredDownloadPath(discoveredAudio))
        ? discoveredAudio
        : undefined;
    const coverPath = storedCoverValid
      ? toMediaRelativePath(rec.coverPath) ?? undefined
      : (await isValidStoredDownloadPath(discoveredCover))
        ? discoveredCover
        : undefined;
    const lyricsPath = storedLyricsValid
      ? toMediaRelativePath(rec.lyricsPath) ?? undefined
      : (await isValidStoredDownloadPath(discoveredLyrics))
        ? discoveredLyrics
        : undefined;

    const missingRequiredAsset =
      !audioPath ||
      (Boolean(rec.song.imageUrl?.trim()) && !coverPath) ||
      (Boolean(rec.song.lyricsUrl?.trim()) && !lyricsPath);
    const nextStatus = missingRequiredAsset ? "queued" : "ready";
    if (
      nextStatus === rec.status &&
      audioPath === rec.audioPath &&
      coverPath === rec.coverPath &&
      lyricsPath === rec.lyricsPath
    ) {
      continue;
    }

    const key = keyFor(rec.accountScope, rec.songId);
    fixed[key] = {
      ...rec,
      status: nextStatus,
      audioPath,
      coverPath,
      lyricsPath,
      resumeData: undefined,
      transferToken:
        missingRequiredAsset && nativeBackgroundDownloads
          ? createDownloadTransferToken()
          : rec.transferToken,
      error: undefined,
      updatedAt: Date.now(),
    };
  }
  const keys = Object.keys(fixed);
  if (keys.length === 0) return;
  useOfflineStore.setState((s) => ({ records: { ...s.records, ...fixed } }));
  const changed = Object.values(fixed);
  for (
    let offset = 0;
    offset < changed.length;
    offset += DOWNLOAD_RECORD_DB_CHUNK_SIZE
  ) {
    await dbUpsertRows(
      changed.slice(offset, offset + DOWNLOAD_RECORD_DB_CHUNK_SIZE).map(recordToRow),
    ).catch(() => {});
  }
}

// Reclaim space left behind by interrupted downloads — two sources expo never
// cleans on its own:
//   1. NSURLSession partial-download temp files. createDownloadResumable()
//      streams into <container>/Library/Caches/com.apple.nsurlsessiond/Downloads/
//      <bundle>/ as CFNetworkDownload_*.tmp; when a download is interrupted
//      (offline, app killed, cancelled) the partial is orphaned and never
//      removed, so repeated attempts pile up indefinitely. At launch nothing is
//      in flight, so every file under there is dead weight.
//   2. offline-media song folders with no backing "ready" record (orphans from
//      deletes / reinstalls / a move that never completed).
// All best-effort and self-contained — cleanup must never break launch. Called
// from hydrate() (at launch, before resuming downloads so it can't delete a
// partial a just-resumed download is actively writing) and from clearDownloads()
// so a manual "Clear downloads" sweeps the OS scratch too. Idempotent.
async function purgeOrphanedDownloadArtifacts(): Promise<void> {
  const doc = FileSystem.documentDirectory;

  // Never sweep nsurlsessiond while the native coordinator owns a persistent
  // background session: those "temporary" files may be live tasks that iOS is
  // continuing while React Native is not running.
  if (doc && !nativeBackgroundDownloads) {
    const containerRoot = doc.replace(/Documents\/?$/, "");
    try {
      const downloadsRoot = `${containerRoot}Library/Caches/com.apple.nsurlsessiond/Downloads/`;
      const info = await FileSystem.getInfoAsync(downloadsRoot);
      if (info.exists) {
        // Each app container has its own NSURLSession scratch, so everything
        // under Downloads/ belongs to this app.
        const subdirs = await FileSystem.readDirectoryAsync(downloadsRoot);
        for (const sub of subdirs) {
          const subPath = `${downloadsRoot}${sub}/`;
          const files = await FileSystem.readDirectoryAsync(subPath).catch(() => [] as string[]);
          await Promise.all(
            files.map((f) => FileSystem.deleteAsync(`${subPath}${f}`, { idempotent: true }).catch(() => {})),
          );
        }
      }
    } catch {}

    // NOTE: CFNetwork can also strand a CFNetworkDownload_*.tmp partial directly
    // in the container's tmp/, but expo-file-system is sandboxed to Documents/ +
    // Caches/ (the nsurlsessiond sweep above works only because it's under Caches),
    // so tmp/ is unreachable from JS — a sweep there silently no-ops. iOS reclaims
    // NSTemporaryDirectory on its own; a stuck one can be zeroed via devicectl.
  }

  try {
    const info = await FileSystem.getInfoAsync(OFFLINE_DIR);
    if (info.exists) {
      const folders = await FileSystem.readDirectoryAsync(OFFLINE_DIR);
      if (folders.length > 0) {
        // A folder is an orphan only if NO record (any status) references it —
        // keying on "ready" alone would delete folders for queued/downloading/
        // just-reconciled records and wipe real downloads.
        const knownFolders = new Set(
          Object.values(useOfflineStore.getState().records).map((r) => safeName(r.songId)),
        );
        await Promise.all(
          folders
            .filter((folder) => !knownFolders.has(folder))
            .map((folder) =>
              FileSystem.deleteAsync(`${OFFLINE_DIR}${folder}`, { idempotent: true }).catch(() => {}),
            ),
        );
      }
    }
  } catch {}
}

function initializeNativeBackgroundDownloadListener(): void {
  if (!nativeBackgroundDownloads || nativeDownloadListenerInitialized) return;
  nativeDownloadListenerInitialized = true;
  nativeDownloadSubscription = addNativeBackgroundDownloadListener((state) => {
    if (!useOfflineStore.getState().hydrated) {
      bufferedNativeDownloadStates.push(state);
      return;
    }
    queueNativeDownloadStateApplication(state);
  });
}

function queueNativeDownloadStateApplication(
  state: NativeBackgroundDownloadState,
): void {
  nativeStateApplyTail = nativeStateApplyTail
    .then(() => applyNativeBackgroundDownloadState(state))
    .catch(() => {});
}

function flushBufferedNativeDownloadStates(): void {
  if (bufferedNativeDownloadStates.length === 0) return;
  const buffered = bufferedNativeDownloadStates;
  bufferedNativeDownloadStates = [];
  for (const state of buffered) {
    queueNativeDownloadStateApplication(state);
  }
}

async function applyNativeBackgroundDownloadState(
  nativeState: NativeBackgroundDownloadState,
): Promise<void> {
  const state = nativeState as BackgroundDownloadTransportState;
  if (!nativeRevisionGate.shouldApply(state.key, state.transferToken, state.revision)) return;
  const knownRevision = nativeRevisionGate.knownRevision(
    state.key,
    state.transferToken,
  );

  const current = useOfflineStore.getState().records[state.key];
  const next = current
    ? applyBackgroundDownloadTransportState(current, state)
    : restoreRecordFromBackgroundDownloadState(state);
  if (!next) return;

  const revisionAdvanced = state.revision > knownRevision;
  const materialChange =
    !current ||
    current.status !== next.status ||
    current.audioPath !== next.audioPath ||
    current.coverPath !== next.coverPath ||
    current.lyricsPath !== next.lyricsPath ||
    current.error !== next.error ||
    revisionAdvanced;

  useOfflineStore.setState((store) => {
    const live = store.records[state.key];
    if (
      live &&
      (live.transferToken !== state.transferToken ||
        live.accountScope !== state.accountScope)
    ) {
      return {};
    }
    const progress = { ...store.progress };
    if (state.status === "downloading") {
      progress[state.key] = Math.max(0, Math.min(state.progress, 1));
    } else {
      delete progress[state.key];
    }
    return {
      records: { ...store.records, [state.key]: next },
      progress,
    };
  });

  const committedCandidate =
    useOfflineStore.getState().records[state.key];
  if (committedCandidate?.transferToken !== state.transferToken) return;

  if (
    materialChange ||
    isTerminalBackgroundDownloadState(state)
  ) {
    await dbUpsertRow(recordToRow(committedCandidate));
  }
  // Advance only after the durable write succeeds. If SQLite rejects, the same
  // native outbox revision remains eligible for replay and cannot be ACKed away.
  nativeRevisionGate.record(state.key, state.transferToken, state.revision);

  if (isTerminalBackgroundDownloadState(state)) {
    // Commit first, then acknowledge the native completion outbox. If SQLite
    // fails, the unacknowledged native row is replayed on the next launch.
    await acknowledgeNativeBackgroundDownloads([
      {
        key: state.key,
        transferToken: state.transferToken,
        revision: state.revision,
      },
    ]);
    if (state.status === "ready") {
      void useOfflineStore.getState().refreshStorage();
    }
  }
}

async function reconcileNativeBackgroundDownloads(
  scope = accountScope,
): Promise<void> {
  if (!nativeBackgroundDownloads) return;
  initializeNativeBackgroundDownloadListener();
  await setNativeBackgroundDownloadAccount(scope).catch(() => {});
  if (!useOfflineStore.getState().hydrated) return;

  let snapshot: NativeBackgroundDownloadState[];
  try {
    snapshot = await getNativeBackgroundDownloadSnapshot(scope);
  } catch {
    // Failure is not an authoritative empty snapshot. Rotating every token here
    // would cancel/restart healthy nsurlsessiond work after a transient bridge
    // error, so leave the durable generations untouched until the next resume.
    return;
  }
  const snapshotTokens = new Set(
    snapshot.map((state) => `${state.key}\u0000${state.transferToken}`),
  );
  for (const state of snapshot) {
    await applyNativeBackgroundDownloadState(state);
  }

  const activeRecords = Object.values(
    useOfflineStore.getState().records,
  ).filter(
    (record) =>
      record.accountScope === scope &&
      (record.status === "queued" || record.status === "downloading"),
  );
  const repaired = activeRecords.map((record) => {
    const hasNativeJob =
      !!record.transferToken &&
      snapshotTokens.has(
        `${keyFor(record.accountScope, record.songId)}\u0000${record.transferToken}`,
      );
    if (hasNativeJob && record.transferToken) return record;
    return {
      ...record,
      status: "queued" as const,
      transferToken: createDownloadTransferToken(),
      updatedAt: Date.now(),
    };
  });

  const changed = repaired.filter(
    (record, index) => record !== activeRecords[index],
  );
  if (changed.length > 0) {
    useOfflineStore.setState((store) => ({
      records: {
        ...store.records,
        ...Object.fromEntries(
          changed.map((record) => [
            keyFor(record.accountScope, record.songId),
            record,
          ]),
        ),
      },
    }));
    for (
      let offset = 0;
      offset < changed.length;
      offset += DOWNLOAD_RECORD_DB_CHUNK_SIZE
    ) {
      await dbUpsertRows(
        changed
          .slice(offset, offset + DOWNLOAD_RECORD_DB_CHUNK_SIZE)
          .map(recordToRow),
      );
    }
  }
  await enqueueRecordsWithNativeBackgroundDownloader(repaired);
}

// Subscribe to RN AppState 'active' transitions and drain the mutation outbox on
// each foreground. NO NetInfo / native deps — the web app keyed this off the
// 'online' + 'visibilitychange' events; AppState 'active' is the RN analogue
// (covers cold launch → foreground, background → foreground, and resume). Returns
// an unsubscribe fn. The root layout owns the single call site (see brief).
export function initOfflineSync(): () => void {
  let previous: AppStateStatus = AppState.currentState;
  if (nativeBackgroundDownloads) {
    initializeNativeBackgroundDownloadListener();
    void setNativeBackgroundDownloadAccount(accountScope).catch(() => {});
  }
  // Cover the cold-launch case: AppState is usually already "active" on mount,
  // so fire one immediate drain in addition to subscribing for later resumes.
  void useOfflineStore.getState().syncOfflineMutations();
  const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
    const cameToForeground = previous.match(/inactive|background/) && next === "active";
    previous = next;
    if (cameToForeground) {
      void useOfflineStore.getState().syncOfflineMutations();
      if (nativeBackgroundDownloads) {
        // Events are intentionally lossy while JS is suspended; the durable
        // native snapshot is authoritative on every foreground.
        void reconcileNativeBackgroundDownloads();
      } else {
        // Resume any legacy Expo downloads iOS suspended while backgrounded.
        void useOfflineStore.getState().queueDownloads([], "home");
      }
    }
  });
  // Connectivity edges, the case AppState can't see: toggling airplane mode while
  // the app stays foregrounded never changes AppState, so without this a large
  // download would just die and orphan its partial. Pause on drop (banking a
  // resume blob), kick the pump on recovery to resume from where it left off.
  const unsubscribeOnline = subscribeOnline((isOnline) => {
    if (isOnline) {
      if (nativeBackgroundDownloads) {
        void reconcileNativeBackgroundDownloads();
      } else {
        void useOfflineStore.getState().queueDownloads([], "home");
      }
      void useOfflineStore.getState().syncOfflineMutations();
    } else if (!nativeBackgroundDownloads) {
      void useOfflineStore.getState().pauseActiveDownload();
    }
  });
  return () => {
    subscription.remove();
    unsubscribeOnline();
    nativeDownloadSubscription?.remove();
    nativeDownloadSubscription = null;
    nativeDownloadListenerInitialized = false;
  };
}

// Swap a song's URLs for its downloaded file:// copies when a ready record exists.
// networkImageUrl stays remote so the lock-screen artwork still resolves (§11).
export function resolveOfflinePlaybackSong(song: PlayerSong): PlayerSong {
  const record = useOfflineStore.getState().records[keyFor(accountScope, song.id)];
  // Resolve the stored (relative) path against the live container; the native
  // engine needs an absolute file:// URL, and a legacy absolute path is re-rooted.
  return preferDownloadedPlaybackSong(song, record, {
    audioUrl: resolveMediaPath(record?.audioPath),
    imageUrl: resolveMediaPath(record?.coverPath),
    lyricsUrl: resolveMediaPath(record?.lyricsPath),
  });
}

// Convert a downloaded queue entry back to its original network-addressable
// shape before writing a cross-device/local-resume snapshot.
export function resolvePortablePlaybackSong(song: PlayerSong): PlayerSong {
  const record = useOfflineStore.getState().records[keyFor(accountScope, song.id)];
  return portablePlaybackSong(song, record);
}

export function hasUserDownloadScope(record: Pick<OfflineDownloadRecord, "scopes"> | null | undefined): boolean {
  return Boolean(record?.scopes.some((scope) => scope !== PLAYBACK_CACHE_SCOPE));
}

export type BatchDownloadState = {
  total: number;
  ready: number;
  active: number; // queued + downloading
  failed: number;
  progress: number; // 0..1 across the whole batch
  status: "idle" | "downloading" | "ready" | "error";
};

// Aggregate download state for a set of songs (a playlist / Liked Songs) —
// drives the fill ring on the "Download all" controls. Recomputes only when the
// records or live progress change (songs ref is stable per screen).
export function useBatchDownload(songs: PlayerSong[], scope?: DownloadScope): BatchDownloadState {
  const records = useOfflineStore((s) => s.records);
  const progress = useOfflineStore((s) => s.progress);
  return useMemo(() => {
    const total = songs.length;
    let ready = 0;
    let active = 0;
    let failed = 0;
    let sum = 0;
    for (const song of songs) {
      const key = keyFor(accountScope, song.id);
      const rec = records[key];
      if (!rec || (scope && !rec.scopes.includes(scope))) continue;
      if (rec.status === "ready") {
        ready += 1;
        sum += 1;
      } else if (rec.status === "downloading") {
        active += 1;
        sum += progress[key] ?? 0;
      } else if (rec.status === "queued") {
        active += 1;
      } else if (rec.status === "error") {
        failed += 1;
      }
    }
    const status: BatchDownloadState["status"] =
      total > 0 && ready === total ? "ready" : active > 0 ? "downloading" : failed > 0 ? "error" : "idle";
    return { total, ready, active, failed, progress: total > 0 ? sum / total : 0, status };
  }, [records, progress, scope, songs]);
}

// Enabling auto-download backfills existing likes (the web behavior).
export async function backfillLikedDownloads(): Promise<void> {
  try {
    const { apiFetch } = await import("@/lib/http");
    const { withAccountScope } = await import("@/lib/api");
    const res = await apiFetch(withAccountScope("/api/liked", accountScope), { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { songs?: PlayerSong[] };
    if (Array.isArray(data.songs) && data.songs.length) {
      await useOfflineStore.getState().queueDownloads(data.songs, "liked");
    }
  } catch {}
}
