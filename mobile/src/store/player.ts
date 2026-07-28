import { create } from "zustand";
import { markPlaybackEngaged } from "@/audio/publish-gate";
import { getIsOnline } from "@/lib/connectivity";
import { songKind } from "@/lib/player-song";
import {
  appendQueuePage,
  insertIntoShuffleRemaining,
  mergeOrderedQueuePage,
  remapOrderedQueueIndices,
  wouldDuplicateSongInQueue,
} from "@/lib/queue-append";
import { storage } from "@/lib/storage";
import { useOfflineStore } from "@/store/offline";
import {
  findPlayableQueueIndex,
  resolveInitialQueueIndex,
  rewindHistory,
} from "@/store/player-nav";
import type { PlayerSong } from "@/types/player";

export type { PlayerSong } from "@/types/player";

// Ported from src/store/player.ts. Logic is verbatim; the only changes are the
// persistence layer (localStorage → synchronous MMKV `storage` shim) and the
// removal of the SSR `typeof window` guards. The queue-index-remap invariant,
// shuffle bookkeeping, and crossfade-commit contracts are preserved exactly —
// dropping any of them silently corrupts shuffle / back-forward navigation.

type PlayerState = {
  queue: PlayerSong[];
  currentIndex: number; // index in queue
  currentSong: PlayerSong | null;
  playHistory: number[];
  playFuture: number[];
  shuffleRemaining: number[];
  // Identifies the collection the current queue was started from (e.g. "liked",
  // `playlist:<id>`). Lets a collection's Play button know it owns the active
  // playback, so it can show Pause / resume instead of rebuilding the queue on
  // every press. null when the queue wasn't started from a tracked context.
  queueContextKey: string | null;
  // Monotonic id bumped ONLY when a brand-new queue/song is started (setQueue /
  // setSong) — never by in-place edits (replaceStagedSong, add/playNext/remove) or
  // navigation (next/previous/advanceToIndex). Lets subscribers (the Discover
  // stager) distinguish "the user started a fresh queue" — at which point transient
  // per-queue state must reset — from an in-place swap, deterministically and
  // without fingerprint heuristics.
  queueToken: number;
  // Bumped only by background catalog-page appends. Audio subscriptions use it
  // to defer the otherwise-immediate full queue snapshot until hydration ends.
  queueAppendToken: number;
  isPlaying: boolean;
  volume: number; // 0..1
  isMuted: boolean;
  shuffle: boolean;
  repeatMode: "off" | "one" | "all";
  crossfadeEnabled: boolean;
  crossfadeSeconds: number; // 0..12
  playbackRate: number; // 0.5..3, applied to podcast playback only
  // Smart Shuffle: a third listening mode (orthogonal to `shuffle`) that
  // interleaves recommended tracks not in the current collection into the queue.
  // Persisted (key spotify_smart_shuffle_enabled), mirroring the shuffle flag.
  smartShuffleEnabled: boolean;
  // Ids of the queue songs that are Smart Shuffle recommendations. IN-MEMORY
  // ONLY — never written to MMKV and never part of any cross-device resume
  // snapshot (playback-sync.ts serializes a hand-picked field list that omits
  // this). Rec-membership lives here, NOT on the song object, because staging
  // swaps the whole PlayerSong and changes its id (discover:<id> →
  // local-server:<sha1>); replaceStagedSong remaps the id so the sparkle
  // survives. Treated immutably: every mutation creates a fresh Set so
  // subscribers re-render.
  recommendedIds: Set<string>;
  // In-memory roles for explicit queue edits made while a provider playlist is
  // still hydrating. Play Next rows stay anchored near their insertion point;
  // Add to Queue rows start an opaque tail block. Both sets are remapped with
  // every queue splice, just like history/future/shuffle indices.
  manualNextIndices: Set<number>;
  manualTailIndices: Set<number>;
  // The collection the current queue was started from, carried so the rec
  // top-up + Add/Skip actions know where to add a kept track. IN-MEMORY ONLY
  // (not persisted). Set from SetQueueOptions.contextMeta in setQueue.
  queueContext: { playlistId?: string; editable?: boolean; kind?: "liked" | "playlist" } | null;
  // In-memory only: a sleep timer should not survive a relaunch.
  sleepTimerEndsAt: number | null; // epoch ms
  sleepAtEndOfTrack: boolean;
  setQueue: (songs: PlayerSong[], startIndex: number, options?: SetQueueOptions) => PlayerSong | null;
  setSong: (song: PlayerSong | null) => void;
  advanceToIndex: (index: number, options?: AdvanceToIndexOptions) => void;
  replaceSong: (song: PlayerSong) => void;
  // Swap a staged Discover track (matched by its old id) for the promoted,
  // now-in-library song after a "keep" action, so future loads use the library
  // copy instead of the .discover staging URL. Pure data swap — no reload.
  replaceStagedSong: (oldId: string, song: PlayerSong) => void;
  addToQueue: (song: PlayerSong) => void;
  // Append a fetched page without rebuilding or restarting the active queue.
  // expectedContextKey makes background playlist hydration a no-op if the user
  // has already started something else.
  appendToQueue: (
    songs: PlayerSong[],
    expectedContextKey?: string,
    order?: {
      compare: (a: PlayerSong, b: PlayerSong) => number;
      incomingBeforeEqual?: boolean;
    },
  ) => void;
  playNext: (song: PlayerSong) => void;
  removeFromQueue: (index: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  // Advance to the nearest queue item satisfying `canPlay`, skipping over the
  // ones that can't play right now (e.g. not-downloaded while offline). `direction`
  // is +1 (forward, the default — for next()) or -1 (backward — for previous()).
  // Returns false when nothing else in the queue is playable, so the caller can
  // stop instead of churning. NON-DESTRUCTIVE: the queue array is left intact (only
  // the current index moves), so the un-downloaded tracks stay in "up next" and
  // cross-device resume can still persist/restore the full queue. Reuses
  // advanceToIndex's shuffle/history bookkeeping.
  skipToPlayable: (canPlay: (song: PlayerSong) => boolean, direction?: 1 | -1) => boolean;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  setCrossfadeEnabled: (enabled: boolean) => void;
  setCrossfadeSeconds: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  // Toggle the Smart Shuffle mode. Persists + sets state; turning it OFF also
  // prunes any unplayed recs still queued ahead (removeUnplayedRecommendations).
  setSmartShuffleEnabled: (enabled: boolean) => void;
  // Interleave `recs` into the upcoming queue: walk from currentIndex+1, and
  // after every RECS_INTERVAL non-rec songs splice in the next rec (deduped vs
  // recommendedIds + queue). No-op unless smartShuffleEnabled && queueContextKey
  // && queue.length. Uses the playNext remap contract for index bookkeeping.
  injectRecommendations: (recs: PlayerSong[]) => void;
  // Remove every recommendation still queued AHEAD of the current track (never
  // the current). Used on mode-off, Skip, and going offline.
  removeUnplayedRecommendations: () => void;
  startSleepTimer: (minutes: number) => void;
  setSleepAtEndOfTrack: () => void;
  cancelSleepTimer: () => void;
};

type SetQueueOptions = {
  respectShuffle?: boolean;
  // Tags the queue with the collection it came from (see queueContextKey).
  contextKey?: string;
  // Richer description of the collection, stashed as queueContext for Smart
  // Shuffle's top-up + Add/Skip actions. In-memory only.
  contextMeta?: { playlistId?: string; editable?: boolean; kind?: "liked" | "playlist" };
};

type AdvanceToIndexOptions = {
  // True when the target index was peeked from playFuture (the redo stack), so
  // the commit should consume that entry rather than picking from the shuffle pool.
  fromFuture?: boolean;
  // Keep the current isPlaying value instead of forcing playback on. The
  // crossfade commit uses this so pausing mid-fade isn't undone when the queue
  // advances to the incoming track.
  preservePlayState?: boolean;
};

const MAX_PLAY_HISTORY = 200;
const SHUFFLE_STORAGE_KEY = "spotify_shuffle_enabled";
const SMART_SHUFFLE_STORAGE_KEY = "spotify_smart_shuffle_enabled";
const VOLUME_STORAGE_KEY = "spotify_volume";
const MUTED_STORAGE_KEY = "spotify_muted";
const REPEAT_MODE_STORAGE_KEY = "spotify_repeat_mode";
const CROSSFADE_ENABLED_STORAGE_KEY = "spotify_crossfade_enabled";
const CROSSFADE_SECONDS_STORAGE_KEY = "spotify_crossfade_seconds";
const PLAYBACK_RATE_STORAGE_KEY = "spotify_playback_rate";

function readStoredShuffle(): boolean {
  try {
    return storage.getItem(SHUFFLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredShuffle(enabled: boolean): void {
  try {
    storage.setItem(SHUFFLE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
}

function readStoredSmartShuffle(): boolean {
  try {
    return storage.getItem(SMART_SHUFFLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredSmartShuffle(enabled: boolean): void {
  try {
    storage.setItem(SMART_SHUFFLE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
}

function readStoredVolume(): number {
  try {
    const raw = storage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null) return 0.9;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.9;
  } catch {
    return 0.9;
  }
}

function writeStoredVolume(value: number): void {
  try {
    storage.setItem(VOLUME_STORAGE_KEY, String(value));
  } catch {}
}

function readStoredMuted(): boolean {
  try {
    return storage.getItem(MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredMuted(muted: boolean): void {
  try {
    storage.setItem(MUTED_STORAGE_KEY, muted ? "1" : "0");
  } catch {}
}

function readStoredRepeatMode(): PlayerState["repeatMode"] {
  try {
    const raw = storage.getItem(REPEAT_MODE_STORAGE_KEY);
    return raw === "one" || raw === "all" || raw === "off" ? raw : "off";
  } catch {
    return "off";
  }
}

function writeStoredRepeatMode(mode: PlayerState["repeatMode"]): void {
  try {
    storage.setItem(REPEAT_MODE_STORAGE_KEY, mode);
  } catch {}
}

function readStoredCrossfadeEnabled(): boolean {
  try {
    const raw = storage.getItem(CROSSFADE_ENABLED_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function readStoredCrossfadeSeconds(): number {
  try {
    const raw = storage.getItem(CROSSFADE_SECONDS_STORAGE_KEY);
    const value = Number(raw ?? 4);
    return Number.isFinite(value) ? Math.max(0, Math.min(12, value)) : 4;
  } catch {
    return 4;
  }
}

function readStoredPlaybackRate(): number {
  try {
    const raw = storage.getItem(PLAYBACK_RATE_STORAGE_KEY);
    if (raw === null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0.5, Math.min(3, value)) : 1;
  } catch {
    return 1;
  }
}

// Smart Shuffle tuning (exported so the controller + UI share one source of
// truth). RECS_INTERVAL: how many of the user's own songs play between each
// interleaved rec (~1 rec per 3). MIN_RECS_AHEAD: how many recs the controller
// keeps queued ahead of the current track before topping up. RECS_FETCH_BATCH:
// how many recs to request per fetch. MIN_SEEDS: fewest seed songs needed before
// asking for recommendations.
export const RECS_INTERVAL = 3;
export const MIN_RECS_AHEAD = 2;
export const RECS_FETCH_BATCH = 12;
export const MIN_SEEDS = 2;

// Tap-to-cycle order for the podcast speed chip.
export const PLAYBACK_RATE_CYCLE = [1, 1.25, 1.5, 1.75, 2, 0.75];

export function nextPlaybackRate(rate: number): number {
  const index = PLAYBACK_RATE_CYCLE.indexOf(rate);
  return PLAYBACK_RATE_CYCLE[(index + 1) % PLAYBACK_RATE_CYCLE.length];
}

export function formatPlaybackRate(rate: number): string {
  return `${rate}×`;
}

function pushHistory(history: number[], index: number): number[] {
  if (!Number.isInteger(index) || index < 0) return history;
  return [...history, index].slice(-MAX_PLAY_HISTORY);
}

function clampQueueIndex(queueLength: number, index: number): number {
  if (queueLength <= 0) return -1;
  if (!Number.isInteger(index)) return 0;
  return Math.max(0, Math.min(queueLength - 1, index));
}

function createShuffleRemaining(queueLength: number, currentIndex: number): number[] {
  if (queueLength <= 1) return [];
  const current = clampQueueIndex(queueLength, currentIndex);
  const remaining: number[] = [];
  for (let index = 0; index < queueLength; index += 1) {
    if (index !== current) remaining.push(index);
  }
  // Randomize the play order ONCE here (Fisher–Yates) rather than picking a random
  // index at each next(). The queue sheet renders this exact order as "up next"
  // (via getUpcomingPlaybackIndices) and next() consumes it head-first, so a fixed
  // shuffled order is what keeps the displayed queue matching what actually plays.
  for (let i = remaining.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }
  return remaining;
}

function validShuffleRemaining(queueLength: number, currentIndex: number, remaining: number[]): number[] {
  if (queueLength <= 1) return [];
  const seen = new Set<number>();
  return remaining.filter((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= queueLength || index === currentIndex) return false;
    if (seen.has(index)) return false;
    seen.add(index);
    return true;
  });
}

function removeQueueIndex(indices: number[], indexToRemove: number): number[] {
  return indices.filter((index) => index !== indexToRemove);
}

// Remap stored queue indices (playHistory / playFuture / shuffleRemaining) when
// the queue array shifts: an insertion at `pivot` pushes indices >= pivot up by
// one; a removal at `pivot` drops that entry and pulls indices > pivot down by
// one. Skipping this silently corrupts shuffle and back/forward navigation.
function remapQueueIndices(indices: number[], pivot: number, delta: 1 | -1): number[] {
  const remapped: number[] = [];
  for (const index of indices) {
    if (delta === -1) {
      if (index === pivot) continue;
      remapped.push(index > pivot ? index - 1 : index);
    } else {
      remapped.push(index >= pivot ? index + 1 : index);
    }
  }
  return remapped;
}

export function getNextShufflePool(queueLength: number, currentIndex: number, remaining: number[]): number[] {
  const validRemaining = validShuffleRemaining(queueLength, currentIndex, remaining);
  return validRemaining.length > 0 ? validRemaining : createShuffleRemaining(queueLength, currentIndex);
}

export function chooseNextShuffleIndex(queueLength: number, currentIndex: number, remaining: number[]): number {
  const pool = getNextShufflePool(queueLength, currentIndex, remaining);
  if (pool.length === 0) return clampQueueIndex(queueLength, currentIndex);
  return pool[Math.floor(Math.random() * pool.length)];
}

export type UpcomingPlaybackState = {
  shuffle: boolean;
  repeatMode: PlayerState["repeatMode"];
  playFuture: number[];
  shuffleRemaining: number[];
};

// The next `count` queue indices in *playback* order — the order next() would
// actually visit them, not array order. Used to prefetch/warm upcoming tracks so
// the warmer doesn't fetch the wrong songs under shuffle. Mirrors next() and the
// QueueSheet "up next" list: in shuffle, the redo stack (playFuture, top first)
// comes before the shuffle pool. Pool picks are random at play time, so warming
// the pool's leading entries is a best-effort hedge for the next fresh draw.
export function getUpcomingPlaybackIndices(
  queueLength: number,
  currentIndex: number,
  count: number,
  state: UpcomingPlaybackState,
): number[] {
  if (queueLength <= 0 || count <= 0) return [];
  const safeCurrent = clampQueueIndex(queueLength, currentIndex);
  const result: number[] = [];
  const seen = new Set<number>([safeCurrent]);
  const push = (index: number | undefined): void => {
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= queueLength) return;
    if (seen.has(index)) return;
    seen.add(index);
    result.push(index);
  };

  if (state.shuffle) {
    if (queueLength <= 1) return [];
    // Deterministic redo stack first (top of playFuture is the next track).
    for (let i = state.playFuture.length - 1; i >= 0 && result.length < count; i -= 1) {
      push(state.playFuture[i]);
    }
    if (result.length < count) {
      const validRemaining = validShuffleRemaining(queueLength, safeCurrent, state.shuffleRemaining);
      // Mirror next()'s repeat-off stop: once the pool is spent and we're not
      // repeating, there's no further track to warm.
      const pool =
        validRemaining.length > 0
          ? validRemaining
          : state.repeatMode === "all"
            ? createShuffleRemaining(queueLength, safeCurrent)
            : [];
      for (const index of pool) {
        if (result.length >= count) break;
        push(index);
      }
    }
    return result;
  }

  // Linear: walk forward, wrapping to the start once if repeat "all".
  for (let index = safeCurrent + 1; index < queueLength && result.length < count; index += 1) {
    push(index);
  }
  if (state.repeatMode === "all") {
    for (let index = 0; index <= safeCurrent && result.length < count; index += 1) {
      push(index);
    }
  }
  return result;
}

export function sleepTimerRemainingMinutes(endsAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((endsAt - now) / 60_000));
}

// Offline, a manual skip should hop to the nearest DOWNLOADED track in the given
// direction (forward for next(), backward for previous()) instead of flashing
// through an un-streamable one — WITHOUT mutating the queue. Returns true when it
// handled the advance, so the caller skips its normal (online) logic. Online, or
// when nothing in the queue is downloaded, returns false and the normal advance
// runs (the engine's reactive guard then stops a dead queue cleanly). Leaving the
// queue intact here is what lets cross-device resume persist/restore it in full —
// a destructive prune would shrink the saved queue to just the downloaded subset.
// Hoisted so next()/previous() (defined in the store factory below) can call it.
function skipDownloadedOffline(direction: 1 | -1): boolean {
  if (getIsOnline()) return false;
  const isDownloaded = useOfflineStore.getState().isDownloaded;
  return usePlayerStore.getState().skipToPlayable((song) => isDownloaded(song.id), direction);
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  currentSong: null,
  playHistory: [],
  playFuture: [],
  shuffleRemaining: [],
  queueContextKey: null,
  queueToken: 0,
  queueAppendToken: 0,
  isPlaying: false,
  volume: readStoredVolume(),
  isMuted: readStoredMuted(),
  shuffle: readStoredShuffle(),
  repeatMode: readStoredRepeatMode(),
  crossfadeEnabled: readStoredCrossfadeEnabled(),
  crossfadeSeconds: readStoredCrossfadeSeconds(),
  playbackRate: readStoredPlaybackRate(),
  smartShuffleEnabled: readStoredSmartShuffle(),
  recommendedIds: new Set<string>(),
  manualNextIndices: new Set<number>(),
  manualTailIndices: new Set<number>(),
  queueContext: null,
  sleepTimerEndsAt: null,
  sleepAtEndOfTrack: false,
  setQueue: (songs, startIndex, options) => {
    // Keep a queue to a single kind so music never auto-advances into a podcast
    // (or radio) item. The track you explicitly start — songs[startIndex], read
    // before any shuffle randomization — anchors the kind; mixed lists like
    // "Recently played" (which can include podcast episodes you've listened to)
    // are filtered down to that kind. See songKind().
    const anchorIndex = clampQueueIndex(songs.length, startIndex);
    const anchor = anchorIndex >= 0 ? songs[anchorIndex] ?? null : null;
    const queue = anchor ? songs.filter((item) => songKind(item) === songKind(anchor)) : songs;
    const requestedStart = anchor
      ? Math.max(0, queue.findIndex((item) => item.id === anchor.id))
      : -1;
    const start = anchor
      ? resolveInitialQueueIndex(queue.length, requestedStart, {
          respectShuffle: options?.respectShuffle === true,
          shuffle: get().shuffle,
          online: getIsOnline(),
        })
      : -1;
    const currentSong = start >= 0 ? queue[start] ?? null : null;
    set(() => ({
      queue,
      currentIndex: start,
      currentSong,
      playHistory: [],
      playFuture: [],
      shuffleRemaining: get().shuffle ? createShuffleRemaining(queue.length, start) : [],
      queueContextKey: currentSong != null ? (options?.contextKey ?? null) : null,
      queueContext: currentSong != null ? (options?.contextMeta ?? null) : null,
      // A brand-new queue carries no recommendations yet.
      recommendedIds: new Set<string>(),
      manualNextIndices: new Set<number>(),
      manualTailIndices: new Set<number>(),
      queueToken: get().queueToken + 1,
      isPlaying: currentSong != null,
    }));
    return currentSong;
  },
  setSong: (song) =>
    set({
      currentSong: song,
      queue: song ? [song] : [],
      currentIndex: song ? 0 : -1,
      playHistory: [],
      playFuture: [],
      shuffleRemaining: [],
      queueContextKey: null,
      queueContext: null,
      recommendedIds: new Set<string>(),
      manualNextIndices: new Set<number>(),
      manualTailIndices: new Set<number>(),
      queueToken: get().queueToken + 1,
    }),
  advanceToIndex: (index, options) =>
    set((s) => {
      if (index < 0 || index >= s.queue.length || index === s.currentIndex) return s;
      const nextPlaying = options?.preservePlayState ? s.isPlaying : true;
      if (!s.shuffle) {
        return {
          ...s,
          currentIndex: index,
          currentSong: s.queue[index],
          isPlaying: nextPlaying,
        };
      }
      // Mirror next()'s shuffle bookkeeping: when the target came from playFuture
      // (redo stack), consume that one entry and leave shuffleRemaining untouched;
      // otherwise treat it as a fresh pick, which only happens when playFuture is
      // empty, so the redo stack ends up cleared just like next().
      const future = s.playFuture.slice();
      const fromFuture = options?.fromFuture === true && future[future.length - 1] === index;
      return {
        ...s,
        currentIndex: index,
        currentSong: s.queue[index],
        playHistory: pushHistory(s.playHistory, s.currentIndex),
        playFuture: fromFuture ? future.slice(0, -1) : [],
        shuffleRemaining: fromFuture ? s.shuffleRemaining : removeQueueIndex(s.shuffleRemaining, index),
        isPlaying: nextPlaying,
      };
    }),
  skipToPlayable: (canPlay, direction = 1) => {
    const s = get();
    const target = findPlayableQueueIndex(
      {
        queueLength: s.queue.length,
        currentIndex: s.currentIndex,
        direction,
        shuffle: s.shuffle,
        repeatMode: s.repeatMode,
        shuffleRemaining: s.shuffleRemaining,
      },
      (index) => canPlay(s.queue[index]),
    );
    if (target == null) return false;
    get().advanceToIndex(target);
    return true;
  },
  replaceSong: (song) =>
    set((s) => {
      // Preserve the original queue array reference when nothing actually
      // changed, so consumers keying off queue identity (e.g. prefetch
      // effects) don't re-run on every refresh of the current song.
      const matchIndex = s.queue.findIndex((item) => item.id === song.id);
      if (matchIndex < 0) {
        return s.currentSong?.id === song.id ? { currentSong: song } : s;
      }
      const queue = s.queue.slice();
      queue[matchIndex] = song;
      return {
        queue,
        currentSong: s.currentSong?.id === song.id ? song : s.currentSong,
      };
    }),
  replaceStagedSong: (oldId, song) =>
    set((s) => {
      // Staging swaps the whole song and its id changes, so carry rec-membership
      // across (oldId → song.id) — otherwise the sparkle would vanish once a
      // recommended track finishes staging. Fresh Set so subscribers re-render.
      const recommendedIds = s.recommendedIds.has(oldId)
        ? new Set([...s.recommendedIds].map((id) => (id === oldId ? song.id : id)))
        : s.recommendedIds;
      const matchIndex = s.queue.findIndex((item) => item.id === oldId);
      if (matchIndex < 0) {
        return s.currentSong?.id === oldId
          ? { currentSong: song, recommendedIds }
          : recommendedIds === s.recommendedIds
            ? s
            : { recommendedIds };
      }
      const queue = s.queue.slice();
      queue[matchIndex] = song;
      return {
        queue,
        currentSong: s.currentSong?.id === oldId ? song : s.currentSong,
        recommendedIds,
      };
    }),
  addToQueue: (song) =>
    set((s) => {
      if (wouldDuplicateSongInQueue(s.queue, song)) return s;
      const queue = [...s.queue, song];
      const appendedIndex = queue.length - 1;
      if (s.currentIndex < 0) {
        // Empty queue: make the song current but leave playback paused.
        return {
          queue,
          currentIndex: 0,
          currentSong: queue[0],
          manualNextIndices: new Set<number>(),
          manualTailIndices: new Set<number>(),
        };
      }
      return {
        queue,
        manualTailIndices: new Set([...s.manualTailIndices, appendedIndex]),
        shuffleRemaining: s.shuffle ? [...s.shuffleRemaining, appendedIndex] : s.shuffleRemaining,
      };
    }),
  appendToQueue: (songs, expectedContextKey, order) =>
    set((s) => {
      if (expectedContextKey && s.queueContextKey !== expectedContextKey) return s;
      const ordered = order
        ? mergeOrderedQueuePage(
            s.queue,
            songs,
            s.currentSong,
            {
              compare: order.compare,
              incomingBeforeEqual: order.incomingBeforeEqual,
              frozenPrefixEnd: s.currentIndex,
              interleavedOldIndices: new Set(
                s.queue.flatMap((song, index) =>
                  s.recommendedIds.has(song.id) || s.manualNextIndices.has(index)
                    ? [index]
                    : [],
                ),
              ),
              trailingOldIndices: s.manualTailIndices,
            },
          )
        : null;
      const appended = ordered ?? appendQueuePage(s.queue, songs, s.currentSong);
      if (appended.addedIndices.length === 0) return s;
      const { queue } = appended;
      if (s.currentIndex < 0) {
        return {
          queue,
          currentIndex: 0,
          currentSong: queue[0],
          manualNextIndices: new Set<number>(),
          manualTailIndices: new Set<number>(),
          queueAppendToken: s.queueAppendToken + 1,
        };
      }
      const addedIndices = appended.addedIndices;
      if (ordered) {
        const currentIndex = ordered.oldIndexToNewIndex[s.currentIndex];
        if (!Number.isInteger(currentIndex) || currentIndex < 0) return s;
        const remappedShuffleRemaining = remapOrderedQueueIndices(
          s.shuffleRemaining,
          ordered.oldIndexToNewIndex,
        );
        return {
          queue,
          currentIndex,
          currentSong: queue[currentIndex],
          playHistory: remapOrderedQueueIndices(s.playHistory, ordered.oldIndexToNewIndex),
          playFuture: remapOrderedQueueIndices(s.playFuture, ordered.oldIndexToNewIndex),
          manualNextIndices: new Set(
            remapOrderedQueueIndices([...s.manualNextIndices], ordered.oldIndexToNewIndex),
          ),
          manualTailIndices: new Set(
            remapOrderedQueueIndices([...s.manualTailIndices], ordered.oldIndexToNewIndex),
          ),
          queueAppendToken: s.queueAppendToken + 1,
          shuffleRemaining: s.shuffle
            ? insertIntoShuffleRemaining(remappedShuffleRemaining, addedIndices)
            : remappedShuffleRemaining,
        };
      }
      return {
        queue,
        queueAppendToken: s.queueAppendToken + 1,
        shuffleRemaining: s.shuffle
          ? insertIntoShuffleRemaining(s.shuffleRemaining, addedIndices)
          : s.shuffleRemaining,
      };
    }),
  playNext: (song) =>
    set((s) => {
      if (s.currentIndex < 0) {
        const queue = [...s.queue, song];
        return {
          queue,
          currentIndex: 0,
          currentSong: queue[0],
          manualNextIndices: new Set<number>(),
          manualTailIndices: new Set<number>(),
        };
      }
      const insertAt = s.currentIndex + 1;
      if (wouldDuplicateSongInQueue(s.queue, song)) return s;
      const queue = s.queue.slice();
      queue.splice(insertAt, 0, song);
      const manualNextIndices = new Set(
        remapQueueIndices([...s.manualNextIndices], insertAt, 1),
      );
      manualNextIndices.add(insertAt);
      return {
        queue,
        playHistory: remapQueueIndices(s.playHistory, insertAt, 1),
        // Shuffle consults playFuture before drawing from the shuffle pool
        // (next() pops it and the crossfade target peeks it), so pushing the
        // inserted index there makes "play next" hold under shuffle too.
        // Linear mode reads currentIndex + 1 directly and ignores playFuture.
        playFuture: s.shuffle
          ? [...remapQueueIndices(s.playFuture, insertAt, 1), insertAt]
          : remapQueueIndices(s.playFuture, insertAt, 1),
        manualNextIndices,
        manualTailIndices: new Set(
          remapQueueIndices([...s.manualTailIndices], insertAt, 1),
        ),
        shuffleRemaining: remapQueueIndices(s.shuffleRemaining, insertAt, 1),
      };
    }),
  removeFromQueue: (index) =>
    set((s) => {
      if (!Number.isInteger(index) || index < 0 || index >= s.queue.length || index === s.currentIndex) {
        return s;
      }
      const removedId = s.queue[index].id;
      const queue = s.queue.slice();
      queue.splice(index, 1);
      // Drop the removed song's rec-membership (fresh Set so subscribers update).
      let recommendedIds = s.recommendedIds;
      if (recommendedIds.has(removedId)) {
        recommendedIds = new Set(s.recommendedIds);
        recommendedIds.delete(removedId);
      }
      return {
        queue,
        currentIndex: index < s.currentIndex ? s.currentIndex - 1 : s.currentIndex,
        playHistory: remapQueueIndices(s.playHistory, index, -1),
        playFuture: remapQueueIndices(s.playFuture, index, -1),
        manualNextIndices: new Set(
          remapQueueIndices([...s.manualNextIndices], index, -1),
        ),
        manualTailIndices: new Set(
          remapQueueIndices([...s.manualTailIndices], index, -1),
        ),
        shuffleRemaining: remapQueueIndices(s.shuffleRemaining, index, -1),
        recommendedIds,
      };
    }),
  play: () => {
    markPlaybackEngaged();
    set({ isPlaying: true });
  },
  pause: () => set({ isPlaying: false }),
  toggle: () => {
    markPlaybackEngaged();
    set((s) => ({ isPlaying: !s.isPlaying }));
  },
  next: () => {
    markPlaybackEngaged();
    // Offline shuffle: honor the redo stack first — forward after a back should
    // return you to where you were (mirrors online), skipping any entry that
    // isn't downloaded. With no downloaded redo entry it falls through to the
    // fresh-downloaded pick below. (Online, next()'s own playFuture pop handles
    // this; this branch only covers the offline shortcut that bypasses it.)
    if (get().shuffle && !getIsOnline()) {
      const s = get();
      const isDownloaded = useOfflineStore.getState().isDownloaded;
      const redo = rewindHistory(s.playFuture, s.queue.length, (i) => isDownloaded(s.queue[i].id));
      if (redo) {
        set({
          currentIndex: redo.index,
          currentSong: s.queue[redo.index],
          playFuture: redo.remaining,
          playHistory: pushHistory(s.playHistory, s.currentIndex),
          isPlaying: true,
        });
        return;
      }
    }
    if (!getIsOnline()) {
      // Offline is a complete branch, not a hint before normal navigation. If no
      // downloaded item remains, stop here; falling through used to select the
      // very next remote-only row and leave the engine buffering a known-dead URL.
      if (!skipDownloadedOffline(1)) get().pause();
      return;
    }
    set((s) => {
      if (s.queue.length === 0) return s.isPlaying ? { ...s, isPlaying: false } : s;
      if (s.shuffle) {
        if (s.queue.length === 1) {
          return s.repeatMode === "all"
            ? { ...s, currentIndex: 0, currentSong: s.queue[0], isPlaying: true }
            : { ...s, isPlaying: false };
        }
        const future = s.playFuture.slice();
        const idxFromFuture = future.pop();
        if (idxFromFuture === undefined) {
          // When the shuffle pool is exhausted, only refill if repeat "all" is
          // on; otherwise stop at the end of the shuffle cycle, mirroring linear
          // mode's behavior with repeat "off".
          const remaining = validShuffleRemaining(s.queue.length, s.currentIndex, s.shuffleRemaining);
          if (remaining.length === 0 && s.repeatMode !== "all") {
            return s.isPlaying ? { ...s, isPlaying: false } : s;
          }
        }
        const shufflePool =
          idxFromFuture === undefined
            ? getNextShufflePool(s.queue.length, s.currentIndex, s.shuffleRemaining)
            : s.shuffleRemaining;
        const idx =
          idxFromFuture === undefined
            ? shufflePool[0]
            : idxFromFuture;
        if (idx === undefined || idx < 0 || idx >= s.queue.length) return s;
        if (idx === s.currentIndex) return s;
        return {
          ...s,
          currentIndex: idx,
          currentSong: s.queue[idx],
          playHistory: pushHistory(s.playHistory, s.currentIndex),
          playFuture: future,
          shuffleRemaining: idxFromFuture === undefined ? removeQueueIndex(shufflePool, idx) : s.shuffleRemaining,
          isPlaying: true,
        };
      }
      const atEnd = s.currentIndex >= s.queue.length - 1;
      if (atEnd) {
        if (s.repeatMode === "all") {
          return { ...s, currentIndex: 0, currentSong: s.queue[0], isPlaying: true };
        }
        // repeat one handled in the audio controller; here stop at end for off
        return { ...s, isPlaying: false };
      }
      const idx = s.currentIndex + 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    });
  },
  previous: () => {
    markPlaybackEngaged();
    // Linear (non-shuffle) offline: hop backward to the nearest DOWNLOADED track
    // — there's no history stack in linear mode. Shuffle is handled below via
    // playHistory; routing it through the forward-biased skipToPlayable picker is
    // exactly the bug where offline "back" jumped to an unplayed track.
    if (!get().shuffle && !getIsOnline()) {
      // No downloaded predecessor means "previous" is a no-op, matching the
      // online repeat-off boundary instead of wrapping to the queue tail.
      skipDownloadedOffline(-1);
      return;
    }
    set((s) => {
      if (s.queue.length === 0) return s;
      if (s.shuffle) {
        // Step back through the ACTUAL play-history. Offline, skip any entry that
        // isn't currently downloaded so "back" never surfaces an un-streamable
        // track; online, canPlay is always true so this just pops the last visit.
        const skipUndownloaded = !getIsOnline();
        const isDownloaded = useOfflineStore.getState().isDownloaded;
        const back = rewindHistory(s.playHistory, s.queue.length, (i) =>
          skipUndownloaded ? isDownloaded(s.queue[i].id) : true,
        );
        if (!back) return s;
        return {
          ...s,
          currentIndex: back.index,
          currentSong: s.queue[back.index],
          playHistory: back.remaining,
          playFuture: pushHistory(s.playFuture, s.currentIndex),
          isPlaying: true,
        };
      }
      const atStart = s.currentIndex <= 0;
      if (atStart) {
        if (s.repeatMode === "all") {
          const idx = s.queue.length - 1;
          return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
        }
        return s;
      }
      const idx = s.currentIndex - 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    });
  },
  setVolume: (v) => {
    const volume = Math.max(0, Math.min(1, v));
    writeStoredVolume(volume);
    set({ volume });
  },
  toggleMute: () =>
    set((s) => {
      const isMuted = !s.isMuted;
      writeStoredMuted(isMuted);
      return { isMuted };
    }),
  toggleShuffle: () =>
    set((s) => {
      const shuffle = !s.shuffle;
      writeStoredShuffle(shuffle);
      return {
        shuffle,
        playHistory: [],
        playFuture: [],
        shuffleRemaining: shuffle ? createShuffleRemaining(s.queue.length, s.currentIndex) : [],
      };
    }),
  cycleRepeatMode: () =>
    set((s) => {
      const repeatMode = s.repeatMode === "off" ? "all" : s.repeatMode === "all" ? "one" : "off";
      writeStoredRepeatMode(repeatMode);
      return { repeatMode };
    }),
  setCrossfadeEnabled: (enabled) => {
    try {
      storage.setItem(CROSSFADE_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    } catch {}
    set({ crossfadeEnabled: enabled });
  },
  setCrossfadeSeconds: (seconds) => {
    const clamped = Math.max(0, Math.min(12, seconds));
    try {
      storage.setItem(CROSSFADE_SECONDS_STORAGE_KEY, String(clamped));
    } catch {}
    set({ crossfadeSeconds: clamped });
  },
  setPlaybackRate: (rate) => {
    const clamped = Number.isFinite(rate) ? Math.max(0.5, Math.min(3, rate)) : 1;
    try {
      storage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(clamped));
    } catch {}
    set({ playbackRate: clamped });
  },
  setSmartShuffleEnabled: (enabled) => {
    writeStoredSmartShuffle(enabled);
    // Pruning reads + remaps the live queue, so prune BEFORE flipping the flag
    // off (the prune itself doesn't gate on the flag, but doing it first keeps a
    // single coherent transition). Then publish the new flag.
    if (!enabled) get().removeUnplayedRecommendations();
    set({ smartShuffleEnabled: enabled });
  },
  injectRecommendations: (recs) =>
    set((s) => {
      if (!s.smartShuffleEnabled || s.queueContextKey == null || s.queue.length === 0) return s;
      if (recs.length === 0) return s;
      const queue = s.queue.slice();
      let playHistory = s.playHistory;
      let playFuture = s.playFuture;
      let shuffleRemaining = s.shuffleRemaining;
      let manualNextIndices = s.manualNextIndices;
      let manualTailIndices = s.manualTailIndices;
      const recommendedIds = new Set(s.recommendedIds);
      // Ids already present in the queue (post-mutation aware) so we never splice
      // a duplicate; seeded from the current queue and grown as we insert.
      const presentIds = new Set(queue.map((item) => item.id));
      let recCursor = 0;
      // Walk the upcoming queue counting only the user's OWN (non-rec) songs;
      // after every RECS_INTERVAL of them, splice the next eligible rec right
      // after that run. `position` tracks the live array index as it grows.
      let nonRecSinceLast = 0;
      let position = s.currentIndex + 1;
      while (position <= queue.length) {
        const reachedEnd = position === queue.length;
        const songAtPosition = reachedEnd ? null : queue[position];
        const isRec = songAtPosition != null && recommendedIds.has(songAtPosition.id);
        // Time to drop a rec once we've passed RECS_INTERVAL of the user's songs.
        if (nonRecSinceLast >= RECS_INTERVAL) {
          // Find the next rec not already queued or recommended (dedupe).
          let rec: PlayerSong | null = null;
          while (recCursor < recs.length) {
            const candidate = recs[recCursor];
            recCursor += 1;
            if (recommendedIds.has(candidate.id) || presentIds.has(candidate.id)) continue;
            rec = candidate;
            break;
          }
          if (rec == null) break; // no more recs to place
          const insertAt = position;
          queue.splice(insertAt, 0, rec);
          playHistory = remapQueueIndices(playHistory, insertAt, 1);
          shuffleRemaining = remapQueueIndices(shuffleRemaining, insertAt, 1);
          manualNextIndices = new Set(
            remapQueueIndices([...manualNextIndices], insertAt, 1),
          );
          manualTailIndices = new Set(
            remapQueueIndices([...manualTailIndices], insertAt, 1),
          );
          playFuture = s.shuffle
            ? [...remapQueueIndices(playFuture, insertAt, 1), insertAt]
            : remapQueueIndices(playFuture, insertAt, 1);
          recommendedIds.add(rec.id);
          presentIds.add(rec.id);
          nonRecSinceLast = 0;
          // The inserted rec now sits at `insertAt`; step past it to the song we
          // were about to inspect (now shifted up by one).
          position += 1;
          continue;
        }
        if (reachedEnd) break;
        if (!isRec) nonRecSinceLast += 1;
        position += 1;
      }
      return {
        queue,
        playHistory,
        playFuture,
        shuffleRemaining,
        recommendedIds,
        manualNextIndices,
        manualTailIndices,
      };
    }),
  removeUnplayedRecommendations: () =>
    set((s) => {
      if (s.recommendedIds.size === 0) return s;
      const queue = s.queue.slice();
      let playHistory = s.playHistory;
      let playFuture = s.playFuture;
      let shuffleRemaining = s.shuffleRemaining;
      let manualNextIndices = s.manualNextIndices;
      let manualTailIndices = s.manualTailIndices;
      const recommendedIds = new Set(s.recommendedIds);
      let changed = false;
      // Remove every rec strictly AHEAD of the current track, high index → low so
      // earlier indices stay valid. currentIndex is never touched (we only remove
      // indices above it), so it needs no adjustment.
      for (let index = queue.length - 1; index > s.currentIndex; index -= 1) {
        const id = queue[index].id;
        if (!recommendedIds.has(id)) continue;
        queue.splice(index, 1);
        playHistory = remapQueueIndices(playHistory, index, -1);
        playFuture = remapQueueIndices(playFuture, index, -1);
        shuffleRemaining = remapQueueIndices(shuffleRemaining, index, -1);
        manualNextIndices = new Set(
          remapQueueIndices([...manualNextIndices], index, -1),
        );
        manualTailIndices = new Set(
          remapQueueIndices([...manualTailIndices], index, -1),
        );
        recommendedIds.delete(id);
        changed = true;
      }
      if (!changed) return s;
      return {
        queue,
        playHistory,
        playFuture,
        shuffleRemaining,
        recommendedIds,
        manualNextIndices,
        manualTailIndices,
      };
    }),
  startSleepTimer: (minutes) =>
    set({ sleepTimerEndsAt: Date.now() + minutes * 60_000, sleepAtEndOfTrack: false }),
  setSleepAtEndOfTrack: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: true }),
  cancelSleepTimer: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: false }),
}));
