// Backend-agnostic cross-device resume + "now position" tracking, shared by both
// audio backends (engine-rntp on Android, engine-native on iOS). Extracted from
// the original engine.ts so the dispatcher can re-export publish/restore from one
// place and both backends write the same `lastPosition` / resume-seek state.

import {
  fetchServerPlaybackState,
  getPlaybackDeviceId,
  isPersistablePlayerSong,
  type PlaybackStateSnapshot,
  PLAYBACK_STATE_VERSION,
  readLocalPlaybackState,
  writeLocalPlaybackState,
  writeServerPlaybackState,
} from "@/lib/playback-state";
import { isPlaybackEngaged } from "@/audio/publish-gate";
import { getOfflineAccountScope, resolvePortablePlaybackSong } from "@/store/offline";
import { usePlayerStore } from "@/store/player";

export const PLAYBACK_STATE_PUBLISH_INTERVAL_MS = 8000;

let lastPosition = 0;
let lastPositionSongId: string | null = null;
let lastStatePublishMs = 0;
let lastSnapshotUpdatedAt = 0;
let pendingResumeSeek: { songId: string; time: number } | null = null;

export function setLastPosition(position: number, songId?: string | null): void {
  lastPosition = Math.max(0, position);
  lastPositionSongId = songId === undefined ? (usePlayerStore.getState().currentSong?.id ?? null) : songId;
}

export function getLastPosition(songId?: string): number {
  return songId && lastPositionSongId !== songId ? 0 : lastPosition;
}

export function setPendingResumeSeek(songId: string, time: number): void {
  pendingResumeSeek = { songId, time };
  setLastPosition(time, songId);
}

// Returns the pending resume position for `songId` (and consumes it), else null.
export function takePendingResumeSeek(songId: string): number | null {
  if (pendingResumeSeek && pendingResumeSeek.songId === songId) {
    const time = pendingResumeSeek.time;
    pendingResumeSeek = null;
    return time;
  }
  return null;
}

function buildSnapshot(): PlaybackStateSnapshot | null {
  const s = usePlayerStore.getState();
  const current = s.currentSong;
  if (!current) return null;
  const song = resolvePortablePlaybackSong(current);
  if (!song || !isPersistablePlayerSong(song)) return null;
  const queue = s.queue.map(resolvePortablePlaybackSong).filter(isPersistablePlayerSong);
  const currentIndex = Math.max(0, queue.findIndex((item) => item.id === song.id));
  const updatedAt = Math.max(Date.now(), lastSnapshotUpdatedAt + 1);
  lastSnapshotUpdatedAt = updatedAt;
  return {
    version: PLAYBACK_STATE_VERSION,
    accountScope: getOfflineAccountScope(),
    queue: queue.length ? queue : [song],
    currentIndex,
    queueContextKey: s.queueContextKey,
    song,
    // Time events from the previous deck/player can race a rapid queue switch.
    // Never attach that prior track's position to a newly-selected song.
    currentTime: lastPositionSongId === current.id ? lastPosition : 0,
    isPlaying: s.isPlaying,
    updatedAt,
    deviceId: getPlaybackDeviceId(),
  };
}

export async function publishPlaybackState(force: boolean): Promise<void> {
  // Passive launches (cold-start restore / viewing cross-device state) must never
  // write: loading a restored snapshot would otherwise auto-publish it and clobber
  // the genuinely-newest state. Only real user/remote transport actions flip this
  // flag on. See publish-gate.ts.
  if (!isPlaybackEngaged()) return;
  if (!force && Date.now() - lastStatePublishMs < PLAYBACK_STATE_PUBLISH_INTERVAL_MS) return;
  lastStatePublishMs = Date.now();
  const snapshot = buildSnapshot();
  if (!snapshot) return;
  writeLocalPlaybackState(snapshot);
  try {
    await writeServerPlaybackState(snapshot);
  } catch {
    // offline — local snapshot is kept; a future publish will sync it.
  }
}

function applyPlaybackSnapshot(snapshot: PlaybackStateSnapshot): void {
  lastSnapshotUpdatedAt = Math.max(lastSnapshotUpdatedAt, snapshot.updatedAt);
  setPendingResumeSeek(snapshot.song.id, snapshot.currentTime);
  // Keep the local cache aligned with whatever we restored (e.g. a newer server
  // snapshot) WITHOUT a server write — restore stays read-only server-side so it
  // can't clobber newer cross-device state. Preserves the snapshot's original
  // updatedAt (no Date.now() restamp), so last-write-wins stays meaningful.
  writeLocalPlaybackState(snapshot);
  const store = usePlayerStore.getState();
  store.setQueue(snapshot.queue, snapshot.currentIndex, { contextKey: snapshot.queueContextKey ?? undefined });
  store.pause(); // never auto-play on cold launch
}

// Restore queue/index/position on launch. Does NOT auto-play; the synchronous MMKV
// local snapshot is applied immediately so the mini-player appears at once.
//
// Phone-authoritative: this device resumes exactly what IT last played. When a
// usable local snapshot exists we apply it and STOP — we never reconcile against
// (or get overridden by) the server. The old behavior awaited a server fetch and
// swapped to whatever was strictly-newer there; because that resolved after launch
// — and compared against the stale captured local, with no "user took control"
// check — it could load a different song out from under you, including one you'd
// just tapped while the fetch was in flight. We still publish TO the server (so the
// web's now-playing view stays current), we just don't let it dictate this device.
export async function restorePlaybackState(scope: string = getOfflineAccountScope()): Promise<void> {
  // The caller passes the resolved account scope explicitly: this runs from
  // AudioBootstrap's effect, which fires BEFORE AuthProvider's effect sets the
  // offline module's scope, so getOfflineAccountScope() would still read its
  // "anonymous" default and reject this device's own (user-scoped) snapshot —
  // sending every cold launch down the server fallback and defeating the
  // phone-authoritative guarantee.
  const local = readLocalPlaybackState();
  const localUsable = local && local.accountScope === scope && local.song ? local : null;
  if (localUsable) {
    applyPlaybackSnapshot(localUsable);
    return;
  }

  // No usable local snapshot (fresh install / cleared storage): fall back to the
  // server ONCE — but only if the user hasn't already taken control since launch,
  // so a slow fetch can't clobber a song they started while it was in flight.
  try {
    const server = await fetchServerPlaybackState();
    if (server?.song && !isPlaybackEngaged()) applyPlaybackSnapshot(server);
  } catch {
    // offline / server error — nothing to restore.
  }
}
