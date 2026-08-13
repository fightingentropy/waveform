"use client";

import { create } from "zustand";
import { songKind } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";
import {
  createShuffleRemaining,
  getNextShufflePool,
  validShuffleRemaining,
} from "@spotify/shared/shuffle";

export {
  PLAYBACK_RATE_CYCLE,
  formatPlaybackRate,
  nextPlaybackRate,
} from "@spotify/shared/playback-rate";
export {
  SLEEP_TIMER_MINUTE_OPTIONS,
  sleepTimerRemainingMinutes,
} from "@spotify/shared/sleep-timer";
export {
  chooseNextShuffleIndex,
  getNextShufflePool,
} from "@spotify/shared/shuffle";

export type { PlayerSong } from "@/types/player";

type PlayerState = {
  queue: PlayerSong[];
  currentIndex: number; // index in queue
  currentSong: PlayerSong | null;
  playHistory: number[];
  playFuture: number[];
  shuffleRemaining: number[];
  isPlaying: boolean;
  volume: number; // 0..1
  isMuted: boolean;
  shuffle: boolean;
  repeatMode: "off" | "one" | "all";
  crossfadeEnabled: boolean;
  crossfadeSeconds: number; // 0..12
  playbackRate: number; // 0.5..3, applied to podcast playback only
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
  playNext: (song: PlayerSong) => void;
  removeFromQueue: (index: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  setCrossfadeEnabled: (enabled: boolean) => void;
  setCrossfadeSeconds: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  startSleepTimer: (minutes: number) => void;
  setSleepAtEndOfTrack: () => void;
  cancelSleepTimer: () => void;
};

type SetQueueOptions = {
  respectShuffle?: boolean;
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
const VOLUME_STORAGE_KEY = "spotify_volume";
const MUTED_STORAGE_KEY = "spotify_muted";
const REPEAT_MODE_STORAGE_KEY = "spotify_repeat_mode";
const CROSSFADE_ENABLED_STORAGE_KEY = "spotify_crossfade_enabled";
const CROSSFADE_SECONDS_STORAGE_KEY = "spotify_crossfade_seconds";
const PLAYBACK_RATE_STORAGE_KEY = "spotify_playback_rate";

function readStoredShuffle(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(SHUFFLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredShuffle(enabled: boolean): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(SHUFFLE_STORAGE_KEY, enabled ? "1" : "0");
    }
  } catch {}
}

function readStoredVolume(): number {
  try {
    if (typeof window === "undefined") return 0.9;
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null) return 0.9;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.9;
  } catch {
    return 0.9;
  }
}

function writeStoredVolume(value: number): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(VOLUME_STORAGE_KEY, String(value));
  } catch {}
}

function readStoredMuted(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredMuted(muted: boolean): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(MUTED_STORAGE_KEY, muted ? "1" : "0");
  } catch {}
}

function readStoredRepeatMode(): PlayerState["repeatMode"] {
  try {
    if (typeof window === "undefined") return "off";
    const raw = localStorage.getItem(REPEAT_MODE_STORAGE_KEY);
    return raw === "one" || raw === "all" || raw === "off" ? raw : "off";
  } catch {
    return "off";
  }
}

function writeStoredRepeatMode(mode: PlayerState["repeatMode"]): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(REPEAT_MODE_STORAGE_KEY, mode);
  } catch {}
}

function readStoredCrossfadeEnabled(): boolean {
  try {
    if (typeof window === "undefined") return true;
    const raw = localStorage.getItem(CROSSFADE_ENABLED_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function readStoredCrossfadeSeconds(): number {
  try {
    if (typeof window === "undefined") return 4;
    const raw = localStorage.getItem(CROSSFADE_SECONDS_STORAGE_KEY);
    const value = Number(raw ?? 4);
    return Number.isFinite(value) ? Math.max(0, Math.min(12, value)) : 4;
  } catch {
    return 4;
  }
}

function readStoredPlaybackRate(): number {
  try {
    if (typeof window === "undefined") return 1;
    const raw = localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY);
    if (raw === null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0.5, Math.min(3, value)) : 1;
  } catch {
    return 1;
  }
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

function randomQueueIndex(queueLength: number, currentIndex: number): number {
  if (queueLength <= 0) return -1;
  if (queueLength <= 1) return 0;
  let index = currentIndex;
  while (index === currentIndex) {
    index = Math.floor(Math.random() * queueLength);
  }
  return index;
}

function resolveQueueStartIndex(queueLength: number, startIndex: number, useShuffleStart: boolean): number {
  if (queueLength <= 0) return -1;
  return useShuffleStart ? randomQueueIndex(queueLength, -1) : clampQueueIndex(queueLength, startIndex);
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
// comes before the shuffle pool. The pool is shuffled once (Fisher–Yates) and
// consumed head-first, so warming the leading entries matches what next() plays.
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

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  currentSong: null,
  playHistory: [],
  playFuture: [],
  shuffleRemaining: [],
  isPlaying: false,
  volume: readStoredVolume(),
  isMuted: readStoredMuted(),
  shuffle: readStoredShuffle(),
  repeatMode: readStoredRepeatMode(),
  // Lazy initializers read persisted values on the client and fall back to
  // deterministic SSR defaults (true / 4) so there's no hydration mismatch.
  // This is the single source of truth for crossfade hydration.
  crossfadeEnabled: readStoredCrossfadeEnabled(),
  crossfadeSeconds: readStoredCrossfadeSeconds(),
  playbackRate: readStoredPlaybackRate(),
  sleepTimerEndsAt: null,
  sleepAtEndOfTrack: false,
  setQueue: (songs, startIndex, options) => {
    // Keep a queue to a single kind so music never auto-advances into a podcast
    // (or radio) item. The track you explicitly start — songs[startIndex], read
    // before any shuffle randomization — anchors the kind; mixed lists like
    // "Recently played" (which can include podcast episodes you've listened to)
    // are filtered down to that kind. Podcast/radio queues filter to themselves,
    // so the Podcasts and Radio pages are unaffected. See songKind().
    const anchorIndex = clampQueueIndex(songs.length, startIndex);
    const anchor = anchorIndex >= 0 ? songs[anchorIndex] ?? null : null;
    const queue = anchor ? songs.filter((item) => songKind(item) === songKind(anchor)) : songs;
    const start = anchor
      ? options?.respectShuffle === true && get().shuffle
        ? resolveQueueStartIndex(queue.length, 0, true)
        : Math.max(0, queue.findIndex((item) => item.id === anchor.id))
      : -1;
    const currentSong = start >= 0 ? queue[start] ?? null : null;
    set(() => ({
      queue,
      currentIndex: start,
      currentSong,
      playHistory: [],
      playFuture: [],
      shuffleRemaining: get().shuffle ? createShuffleRemaining(queue.length, start) : [],
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
      const matchIndex = s.queue.findIndex((item) => item.id === oldId);
      if (matchIndex < 0) {
        return s.currentSong?.id === oldId ? { currentSong: song } : s;
      }
      const queue = s.queue.slice();
      queue[matchIndex] = song;
      return {
        queue,
        currentSong: s.currentSong?.id === oldId ? song : s.currentSong,
      };
    }),
  addToQueue: (song) =>
    set((s) => {
      const queue = [...s.queue, song];
      const appendedIndex = queue.length - 1;
      if (s.currentIndex < 0) {
        // Empty queue: make the song current but leave playback paused.
        return {
          queue,
          currentIndex: 0,
          currentSong: queue[0],
        };
      }
      return {
        queue,
        shuffleRemaining: s.shuffle ? [...s.shuffleRemaining, appendedIndex] : s.shuffleRemaining,
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
        };
      }
      const insertAt = s.currentIndex + 1;
      const queue = s.queue.slice();
      queue.splice(insertAt, 0, song);
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
        shuffleRemaining: remapQueueIndices(s.shuffleRemaining, insertAt, 1),
      };
    }),
  removeFromQueue: (index) =>
    set((s) => {
      if (!Number.isInteger(index) || index < 0 || index >= s.queue.length || index === s.currentIndex) {
        return s;
      }
      const queue = s.queue.slice();
      queue.splice(index, 1);
      return {
        queue,
        currentIndex: index < s.currentIndex ? s.currentIndex - 1 : s.currentIndex,
        playHistory: remapQueueIndices(s.playHistory, index, -1),
        playFuture: remapQueueIndices(s.playFuture, index, -1),
        shuffleRemaining: remapQueueIndices(s.shuffleRemaining, index, -1),
      };
    }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  toggle: () => set((s) => ({ isPlaying: !s.isPlaying })),
  next: () =>
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
        // repeat one handled in PlayerBar; here stop at end for off
        return { ...s, isPlaying: false };
      }
      const idx = s.currentIndex + 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    }),
  previous: () =>
    set((s) => {
      if (s.queue.length === 0) return s;
      if (s.shuffle) {
        const history = s.playHistory.slice();
        const idx = history.pop();
        if (idx === undefined || idx < 0 || idx >= s.queue.length) return s;
        return {
          ...s,
          currentIndex: idx,
          currentSong: s.queue[idx],
          playHistory: history,
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
    }),
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
    try { if (typeof window !== "undefined") localStorage.setItem(CROSSFADE_ENABLED_STORAGE_KEY, enabled ? "1" : "0"); } catch {}
    set({ crossfadeEnabled: enabled });
  },
  setCrossfadeSeconds: (seconds) => {
    const clamped = Math.max(0, Math.min(12, seconds));
    try { if (typeof window !== "undefined") localStorage.setItem(CROSSFADE_SECONDS_STORAGE_KEY, String(clamped)); } catch {}
    set({ crossfadeSeconds: clamped });
  },
  setPlaybackRate: (rate) => {
    const clamped = Number.isFinite(rate) ? Math.max(0.5, Math.min(3, rate)) : 1;
    try { if (typeof window !== "undefined") localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(clamped)); } catch {}
    set({ playbackRate: clamped });
  },
  startSleepTimer: (minutes) =>
    set({ sleepTimerEndsAt: Date.now() + minutes * 60_000, sleepAtEndOfTrack: false }),
  setSleepAtEndOfTrack: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: true }),
  cancelSleepTimer: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: false }),
}));
