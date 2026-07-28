import { useMemo } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";
import { toAbsoluteApiUrl } from "@/lib/config";
import {
  dbAllRows,
  dbDeleteRow,
  dbUpsertRow,
  dbUpsertRows,
  readAllDownloadedRecords,
  resolveMediaPath,
  toMediaRelativePath,
  verifyOrRepairRecord,
  type DownloadRow,
} from "@/lib/offline-db";
import {
  type DownloadScope,
  type DownloadStatus,
  type OfflineDownloadRecord,
  PLAYBACK_CACHE_SCOPE,
  offlineDownloadKey,
  planQueuedDownloads,
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
import { apiFetch, apiFetchWithTimeout } from "@/lib/http";
import { getIsOnline, markOffline, subscribeOnline } from "@/lib/connectivity";
import { canonicalOf } from "@/lib/canonical-ids";
import {
  OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT,
  OFFLINE_MUTATION_REPLAY_APPLIED_EVENT,
  OFFLINE_MUTATION_REPLAY_EXHAUSTED_EVENT,
  emit,
} from "@/lib/events";
import { planOfflineAccountDeletion } from "@/lib/account-deletion-policy";
import { portablePlaybackSong, preferDownloadedPlaybackSong } from "@/lib/offline-playback";
import { resetPlaybackEngaged } from "@/audio/publish-gate";
import { storage } from "@/lib/storage";
import type { PlayerSong } from "@/types/player";

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
}

export function keyFor(scope: string, songId: string): string {
  return offlineDownloadKey(scope, songId);
}
function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}
function extFromUrl(url: string, fallback: string): string {
  const path = url.split(/[?#]/)[0] ?? "";
  const m = path.match(/\.([a-zA-Z0-9]{1,5})$/);
  return m ? `.${m[1].toLowerCase()}` : fallback;
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
  isDownloaded: (songId: string) => boolean;
  hydrate: () => Promise<void>;
  verifyDownloads: () => Promise<void>;
  retryFailedDownloads: () => Promise<void>;
  syncOfflineMutations: () => Promise<void>;
  retryFailedMutations: () => Promise<void>;
  clearDownloads: () => Promise<void>;
  refreshStorage: () => Promise<void>;
  // Pause the in-flight download (banking its resume blob) — called on app-background.
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
    updatedAt: row.updatedAt,
  };
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

  const removeRecord = async (record: OfflineDownloadRecord) => {
    const key = keyFor(record.accountScope, record.songId);
    if (activeDownload?.key === key) {
      // Queue-ahead targets are unpinned as playback moves. Cancel that native
      // transfer before removing its directory so it cannot keep consuming data
      // or recreate an orphan after the deletion.
      await pauseActiveDownload();
    }
    clearProgress(key);
    set((s) => {
      const next = { ...s.records };
      delete next[key];
      return { records: next };
    });
    await dbDeleteRow(key).catch(() => {});
    // best-effort file cleanup
    try {
      await FileSystem.deleteAsync(`${OFFLINE_DIR}${safeName(record.songId)}/`, { idempotent: true });
    } catch {}
  };

  // Serial download pump — one track at a time, mirroring the web pump.
  let pumping = false;
  // The download in flight right now, exposed so a connectivity drop or an
  // app-background can pauseAsync() it (banking an NSURLSession resume blob)
  // before the socket dies — otherwise the partial is orphaned and we restart
  // from zero. Null whenever nothing is downloading.
  let activeDownload: { resumable: FileSystem.DownloadResumable; key: string } | null = null;
  // Key that pauseActiveDownload just paused, so the pump can tell a deliberate
  // pause (re-queue + keep the resume blob) from a genuine failure (mark error).
  let pausedKey: string | null = null;
  // Guards the mutation-outbox drain so overlapping AppState/foreground events
  // (and the Sync-now button) can't run two drains concurrently.
  let syncRunning = false;
  const runPump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      // ensure base dir
      try {
        await FileSystem.makeDirectoryAsync(OFFLINE_DIR, { intermediates: true });
      } catch {}
      while (true) {
        // Run while online (foreground or background). Offline: stop so we don't
        // flip every row to "error"; connectivity handler re-kicks the pump.
        if (!getIsOnline()) break;
        const queuedRecords = Object.values(get().records).filter(
          (record) => record.accountScope === accountScope && record.status === "queued",
        );
        // The two tracks protecting active playback get the next download slot;
        // bulk playlist/liked downloads continue immediately behind them.
        const queued =
          queuedRecords.find((record) => record.scopes.includes(PLAYBACK_CACHE_SCOPE)) ??
          queuedRecords[0];
        if (!queued) break;
        const key = keyFor(accountScope, queued.songId);
        const resumeData = queued.resumeData;
        persist({ ...queued, status: "downloading", updatedAt: Date.now() });
        setProgress(key, 0);
        try {
          const dir = `${OFFLINE_DIR}${safeName(queued.songId)}/`;
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          const audioExt = extFromUrl(queued.song.audioUrl, ".audio");
          const audioPath = `${dir}audio${audioExt}`;
          // Audio is ~all the bytes (cover/lyrics are tiny), so its byte stream
          // drives the fill ring. createDownloadResumable gives us the progress
          // callback that downloadAsync lacks — and, seeded with a resume blob,
          // the ability to continue a partial instead of starting over.
          const resumable = FileSystem.createDownloadResumable(
            toAbsoluteApiUrl(queued.song.audioUrl),
            audioPath,
            {},
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
              if (totalBytesExpectedToWrite > 0) {
                setProgress(key, totalBytesWritten / totalBytesExpectedToWrite);
              }
            },
            resumeData,
          );
          activeDownload = { resumable, key };
          // resumeAsync() continues from the saved partial (server replies 206);
          // downloadAsync() starts fresh. Either resolves to undefined when a
          // pauseAsync() cancels it — that's our deliberate-pause signal below.
          let result: FileSystem.FileSystemDownloadResult | undefined;
          try {
            result = resumeData ? await resumable.resumeAsync() : await resumable.downloadAsync();
          } catch (error) {
            // A queue-ahead download is also our end-to-end reachability probe.
            // When it cannot reach the media URL, prefer cached/downloaded tracks
            // immediately instead of trusting iOS's still-present cellular route.
            if (pausedKey !== key) markOffline();
            throw error;
          }
          activeDownload = null;
          if (!result) {
            // Cancelled by pauseActiveDownload (offline/background). It has already
            // re-queued the row with its resume blob — leave that record intact.
            pausedKey = null;
            clearProgress(key);
            continue;
          }
          if (result.status >= 400) {
            // expo resolves (doesn't throw) on a bad HTTP status and writes the
            // response body to the file — e.g. an expired signed URL returning
            // HTML. Signed media URLs can expire while a large playlist waits in
            // this serial queue, so refresh the song once at the authoritative
            // endpoint and retry with the new URL instead of leaving a permanently
            // poisoned "Retry" row that keeps using the same stale signature.
            if (result.status === 401 || result.status === 403 || result.status === 404) {
              try {
                const response = await apiFetch(`/api/songs/${encodeURIComponent(queued.songId)}`, {
                  cache: "no-store",
                });
                if (response.ok) {
                  const fresh = (await response.json()) as PlayerSong;
                  const latest = get().records[key];
                  if (
                    latest &&
                    fresh?.id === queued.songId &&
                    fresh.audioUrl &&
                    fresh.audioUrl !== queued.song.audioUrl
                  ) {
                    await FileSystem.deleteAsync(audioPath, { idempotent: true }).catch(() => {});
                    clearProgress(key);
                    persist({
                      ...latest,
                      song: fresh,
                      status: "queued",
                      resumeData: undefined,
                      error: undefined,
                      updatedAt: Date.now(),
                    });
                    continue;
                  }
                }
              } catch {
                // Fall through to the normal error/offline classification below.
              }
            }
            // Guard every other error response so garbage is never marked ready.
            throw new Error(`Download failed with HTTP ${result.status}`);
          }
          // Write-time integrity check — confirm the bytes actually landed before
          // we trust this as a download. expo resolves on any *completed* HTTP
          // response, so without this a 0-byte or truncated file could be marked
          // "ready". Require a non-empty file; for a full (non-resumed, 200)
          // response that advertised a Content-Length, also require the on-disk
          // size to reach it, catching a short/truncated transfer. Resumed 206s
          // report only the remaining length, so the length match is skipped there
          // (the size>0 floor still applies). A failure throws into the catch below
          // → re-queued while offline, "error" while online — never a bad "ready".
          const info = await FileSystem.getInfoAsync(audioPath);
          if (!info.exists || info.isDirectory || info.size <= 0) {
            throw new Error("Downloaded audio file is missing or empty");
          }
          const expectedBytes = Number(
            result.headers?.["Content-Length"] ?? result.headers?.["content-length"],
          );
          if (
            !resumeData &&
            result.status === 200 &&
            Number.isFinite(expectedBytes) &&
            expectedBytes > 0 &&
            info.size < expectedBytes
          ) {
            throw new Error(`Downloaded audio is truncated (${info.size}/${expectedBytes} bytes)`);
          }
          setProgress(key, 1);

          let coverPath: string | undefined;
          if (queued.song.imageUrl) {
            try {
              const coverExt = extFromUrl(queued.song.imageUrl, ".jpg");
              const p = `${dir}cover${coverExt}`;
              await FileSystem.downloadAsync(toAbsoluteApiUrl(queued.song.imageUrl), p);
              coverPath = p;
            } catch {}
          }
          let lyricsPath: string | undefined;
          if (queued.song.lyricsUrl) {
            try {
              const p = `${dir}lyrics.lrc`;
              await FileSystem.downloadAsync(toAbsoluteApiUrl(queued.song.lyricsUrl), p);
              lyricsPath = p;
            } catch {}
          }

          // The record may have gained/lost scopes while downloading; re-read.
          const latest = get().records[key];
          clearProgress(key);
          if (!latest) continue; // unpinned mid-download
          // Persist paths RELATIVE to documentDirectory — never the absolute
          // container path, which iOS can change across a reinstall and strand.
          persist({
            ...latest,
            status: "ready",
            audioPath: toMediaRelativePath(audioPath) ?? audioPath,
            coverPath: toMediaRelativePath(coverPath) ?? undefined,
            lyricsPath: toMediaRelativePath(lyricsPath) ?? undefined,
            resumeData: undefined,
            updatedAt: Date.now(),
            error: undefined,
          });
        } catch (e) {
          activeDownload = null;
          clearProgress(key);
          if (pausedKey === key) {
            // A deliberate pause surfaced as a rejection rather than an undefined
            // result — pauseActiveDownload already re-queued it with a resume blob.
            pausedKey = null;
            continue;
          }
          const latest = get().records[key];
          if (!latest) continue;
          if (!getIsOnline()) {
            // Connectivity dropped mid-download and the socket error raced ahead of
            // our pause (no resume blob captured). Keep it queued so it retries from
            // scratch on reconnect, instead of stranding it as a manual-retry error.
            persist({ ...latest, status: "queued", resumeData: undefined, updatedAt: Date.now() });
          } else {
            persist({ ...latest, status: "error", resumeData: undefined, updatedAt: Date.now(), error: e instanceof Error ? e.message : "Download failed" });
          }
        }
      }
    } finally {
      pumping = false;
    }
  };

  const persistQueuedRecordBatch = async (records: readonly OfflineDownloadRecord[]) => {
    let pumpStarted = false;
    try {
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
        if (!pumpStarted) {
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
      if (!pumpStarted) void runPump();
    }
  };

  // Pause whatever is downloading right now and bank its NSURLSession resume blob
  // on the record, so a later resumeAsync() continues from the partial. Invoked on
  // the two interruptions we can see coming — connectivity loss and app-background.
  // Best-effort: if pauseAsync can't produce a blob, the row just restarts fresh.
  const pauseActiveDownload = async () => {
    const active = activeDownload;
    if (!active) return;
    activeDownload = null;
    pausedKey = active.key;
    let resumeData: string | undefined;
    try {
      const state = await active.resumable.pauseAsync();
      resumeData = state.resumeData;
    } catch {}
    clearProgress(active.key);
    const latest = get().records[active.key];
    if (latest) persist({ ...latest, status: "queued", resumeData, updatedAt: Date.now() });
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
      const planned = planQueuedDownloads(get().records, songs, scope, accountScope);
      if (planned.changedRecords.length > 0) {
        // One clone + one subscriber notification for the whole batch, rather
        // than N increasingly-large clones and N React render notifications.
        set({ records: planned.records });
      }
      // Persist at most 32 records per native SQLite statement and yield between
      // chunks. The first durable chunk starts the same serial download pump;
      // later chunks are cancellation-aware through object-identity checks.
      void persistQueuedRecordBatch(planned.changedRecords);
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
        persist({ ...record, scopes, updatedAt: Date.now() });
      }
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
            const rows = await dbAllRows();
            const records: Record<string, OfflineDownloadRecord> = {};
            for (const row of rows) {
              const record = rowToRecord(row);
              // A row left "downloading" means the app died mid-download; its
              // process-local resume blob is gone, so restart it from scratch.
              if (record.status === "downloading") record.status = "queued";
              records[row.key] = record;
            }
            set({ records });
            // Validate/re-root trusted completed records before publishing
            // `hydrated=true`, so source selection can never observe a stale
            // ready row. Queued/interrupted files are deliberately NOT promoted.
            await reconcileDownloadedFiles();
            await purgeOrphanedDownloadArtifacts();
            set({ hydrated: true });
            if (
              Object.values(get().records).some(
                (r) => r.status === "queued" || r.status === "downloading",
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
              persist({ ...current, status: "queued", audioPath: undefined, updatedAt: Date.now() });
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
        if (missing > 0) void runPump();
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
      for (const record of failed) {
        persist({ ...record, status: "queued", error: undefined, updatedAt: Date.now() });
      }
      if (failed.length > 0) void runPump();
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
      // Stop the native URLSession writer before deleting its row/directory.
      // Otherwise a just-cleared in-flight download can finish after the purge
      // and recreate an orphaned multi-MB file with no record pointing to it.
      await pauseActiveDownload();
      const records = Object.values(get().records).filter((r) => r.accountScope === accountScope);
      // Drop everything from memory in ONE update first: the pump's next lookup
      // then finds nothing queued and stops immediately (no race with a large
      // in-flight queue). DB rows + files are torn down in the background so the
      // UI resets instantly rather than awaiting hundreds of file deletes.
      const keys = records.map((r) => keyFor(r.accountScope, r.songId));
      set((s) => {
        const nextRecords = { ...s.records };
        const nextProgress = { ...s.progress };
        for (const key of keys) {
          delete nextRecords[key];
          delete nextProgress[key];
        }
        return { records: nextRecords, progress: nextProgress };
      });
      for (const key of keys) delete lastEmit[key];
      set({
        verificationStatus: "idle",
        verificationCheckedAt: null,
        verifiedDownloads: 0,
        missingDownloads: 0,
        verificationError: null,
      });
      void (async () => {
        for (const record of records) {
          await dbDeleteRow(keyFor(record.accountScope, record.songId)).catch(() => {});
          await FileSystem.deleteAsync(`${OFFLINE_DIR}${safeName(record.songId)}/`, { idempotent: true }).catch(
            () => {},
          );
        }
        // Orphaned NSURLSession partials live outside offline-media, so the loop
        // above never touches them — sweep that OS scratch too so a manual clear
        // reclaims it as well (see purgeOrphanedDownloadArtifacts).
        await purgeOrphanedDownloadArtifacts();
        void refreshStorage();
      })();
      void refreshStorage();
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
    if (normalized === accountScope) await store.pauseActiveDownload();
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

// Validate and re-attach records that SQLite says completed. Queued/downloading
// rows are NEVER promoted just because an "audio*" destination is non-empty: an
// app kill can leave a truncated partial there, and treating it as ready makes a
// corrupt download permanent. Conversely, a ready row whose file disappeared is
// re-queued before hydration completes, so playback never prefers a dead file.
async function reconcileDownloadedFiles(): Promise<void> {
  const records = Object.values(useOfflineStore.getState().records);
  const fixed: Record<string, OfflineDownloadRecord> = {};
  for (const rec of records) {
    if (rec.status !== "ready") continue;

    const hasRelativePath =
      !!rec.audioPath &&
      !rec.audioPath.startsWith("file://") &&
      !rec.audioPath.startsWith("/");
    if (hasRelativePath) {
      const livePath = resolveMediaPath(rec.audioPath);
      try {
        const info = livePath ? await FileSystem.getInfoAsync(livePath) : null;
        if (info?.exists && !info.isDirectory && info.size > 0) continue;
      } catch {}
    }

    const relDir = `offline-media/${safeName(rec.songId)}`;
    const absDir = `${FileSystem.documentDirectory ?? ""}${relDir}`;
    let names: string[] = [];
    try {
      names = await FileSystem.readDirectoryAsync(absDir);
    } catch {}
    const audioName = names.find((n) => n.startsWith("audio"));
    let size = 0;
    if (audioName) {
      try {
        const info = await FileSystem.getInfoAsync(`${absDir}/${audioName}`);
        size = info.exists && !info.isDirectory ? info.size : 0;
      } catch {}
    }

    const key = keyFor(rec.accountScope, rec.songId);
    if (!audioName || size <= 0) {
      fixed[key] = {
        ...rec,
        status: "queued",
        audioPath: undefined,
        coverPath: undefined,
        lyricsPath: undefined,
        resumeData: undefined,
        error: undefined,
        updatedAt: Date.now(),
      };
      continue;
    }

    const coverName = names.find((name) => name.startsWith("cover"));
    const lyricsName = names.find((name) => name.startsWith("lyrics"));
    fixed[key] = {
      ...rec,
      status: "ready",
      audioPath: `${relDir}/${audioName}`,
      coverPath: coverName ? `${relDir}/${coverName}` : undefined,
      lyricsPath: lyricsName ? `${relDir}/${lyricsName}` : undefined,
      resumeData: undefined,
      error: undefined,
      updatedAt: Date.now(),
    };
  }
  const keys = Object.keys(fixed);
  if (keys.length === 0) return;
  useOfflineStore.setState((s) => ({ records: { ...s.records, ...fixed } }));
  await Promise.all(Object.values(fixed).map((r) => dbUpsertRow(recordToRow(r)).catch(() => {})));
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

  if (doc) {
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

// Subscribe to RN AppState 'active' transitions and drain the mutation outbox on
// each foreground. NO NetInfo / native deps — the web app keyed this off the
// 'online' + 'visibilitychange' events; AppState 'active' is the RN analogue
// (covers cold launch → foreground, background → foreground, and resume). Returns
// an unsubscribe fn. The root layout owns the single call site (see brief).
export function initOfflineSync(): () => void {
  let previous: AppStateStatus = AppState.currentState;
  // Cover the cold-launch case: AppState is usually already "active" on mount,
  // so fire one immediate drain in addition to subscribing for later resumes.
  void useOfflineStore.getState().syncOfflineMutations();
  const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
    const cameToForeground = previous.match(/inactive|background/) && next === "active";
    previous = next;
    if (cameToForeground) {
      void useOfflineStore.getState().syncOfflineMutations();
      // Resume any downloads iOS suspended while we were backgrounded. An empty
      // batch is a no-op that still kicks the serial pump for queued rows.
      void useOfflineStore.getState().queueDownloads([], "home");
    }
  });
  // Connectivity edges, the case AppState can't see: toggling airplane mode while
  // the app stays foregrounded never changes AppState, so without this a large
  // download would just die and orphan its partial. Pause on drop (banking a
  // resume blob), kick the pump on recovery to resume from where it left off.
  const unsubscribeOnline = subscribeOnline((isOnline) => {
    if (isOnline) {
      void useOfflineStore.getState().queueDownloads([], "home");
      void useOfflineStore.getState().syncOfflineMutations();
    } else {
      void useOfflineStore.getState().pauseActiveDownload();
    }
  });
  return () => {
    subscription.remove();
    unsubscribeOnline();
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
