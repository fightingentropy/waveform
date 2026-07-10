import { getIsOnline, subscribeOnline } from "@/lib/connectivity";
import { selectPlaybackCacheSongs } from "@/lib/playback-continuity";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import {
  PLAYBACK_CACHE_SCOPE,
  getOfflineAccountScope,
  keyFor,
  useOfflineStore,
} from "@/store/offline";
import { getUpcomingPlaybackIndices, usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

const UPCOMING_CACHE_SIZE = 2;

let started = false;
let refreshRunning = false;
let refreshAgain = false;
let refreshScheduled = false;

function cacheable(song: PlayerSong): boolean {
  if (!song.audioUrl || isPodcastSong(song) || isRadioSong(song)) return false;
  if (song.source === "offline" || song.source === "browser-local" || song.source === "picked-file") return false;
  return !/^(file|data|blob):/i.test(song.audioUrl);
}

async function refreshPlaybackCache(): Promise<void> {
  if (refreshRunning) {
    refreshAgain = true;
    return;
  }
  refreshRunning = true;
  try {
    do {
      refreshAgain = false;
      if (!getIsOnline()) continue;
      const offline = useOfflineStore.getState();
      if (!offline.hydrated) continue;
      const state = usePlayerStore.getState();
      if (!state.currentSong || state.currentIndex < 0) {
        await offline.syncPlaybackCache([]);
        continue;
      }
      const upcomingIndices = getUpcomingPlaybackIndices(
        state.queue.length,
        state.currentIndex,
        UPCOMING_CACHE_SIZE,
        {
          shuffle: state.shuffle,
          repeatMode: state.repeatMode,
          playFuture: state.playFuture,
          shuffleRemaining: state.shuffleRemaining,
        },
      );
      const scope = getOfflineAccountScope();
      const existingCachedIds = new Set(
        state.queue
          .filter((song) =>
            useOfflineStore.getState().records[keyFor(scope, song.id)]?.scopes.includes(PLAYBACK_CACHE_SCOPE),
          )
          .map((song) => song.id),
      );
      const targets = selectPlaybackCacheSongs(
        state.queue,
        state.currentIndex,
        upcomingIndices,
        existingCachedIds,
        UPCOMING_CACHE_SIZE,
      ).filter(cacheable);
      await offline.syncPlaybackCache(targets);
    } while (refreshAgain);
  } finally {
    refreshRunning = false;
  }
}

function scheduleRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  setTimeout(() => {
    refreshScheduled = false;
    void refreshPlaybackCache();
  }, 0);
}

export function startPlaybackContinuity(): void {
  if (started) return;
  started = true;

  let player = usePlayerStore.getState();
  usePlayerStore.subscribe((state) => {
    const changed =
      state.queue !== player.queue ||
      state.currentIndex !== player.currentIndex ||
      state.shuffle !== player.shuffle ||
      state.repeatMode !== player.repeatMode ||
      state.playFuture !== player.playFuture ||
      state.shuffleRemaining !== player.shuffleRemaining;
    player = state;
    if (changed) scheduleRefresh();
  });

  let hydrated = useOfflineStore.getState().hydrated;
  useOfflineStore.subscribe((state) => {
    if (!hydrated && state.hydrated) scheduleRefresh();
    hydrated = state.hydrated;
  });

  subscribeOnline((online) => {
    if (online) scheduleRefresh();
  });
  scheduleRefresh();
}
