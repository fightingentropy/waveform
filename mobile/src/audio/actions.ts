import { getIsOnline } from "@/lib/connectivity";
import { useOfflineStore } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import { markPlaybackEngaged } from "@/audio/publish-gate";
import { seek } from "@/audio/engine";
import { resolvePlaybackStartIndex } from "@/lib/playback-continuity";
import type { PlayerSong } from "@/types/player";

// High-level playback actions the UI calls. The store is the single source of
// truth for queue/order; the engine reacts to store changes and drives the
// active audio backend (native dual-deck on iOS, RNTP elsewhere).

// Keep the full queue online and offline. When the requested song is not locally
// available, start at the next cached/downloaded slot without filtering the
// array; reconnecting therefore cannot change order or invalidate shuffle/history.
function playbackPlan(songs: PlayerSong[], startIndex: number): { songs: PlayerSong[]; startIndex: number } {
  const isDownloaded = useOfflineStore.getState().isDownloaded;
  return {
    songs,
    startIndex: resolvePlaybackStartIndex(songs, startIndex, getIsOnline(), (song) => isDownloaded(song.id)),
  };
}

export function playSongs(
  songs: PlayerSong[],
  startIndex: number,
  options?: {
    respectShuffle?: boolean;
    contextKey?: string;
    // Richer description of the collection, threaded into setQueue as
    // queueContext for Smart Shuffle's top-up + Add/Skip actions.
    contextMeta?: { playlistId?: string; editable?: boolean; kind?: "liked" | "playlist" };
  },
): void {
  markPlaybackEngaged();
  const plan = playbackPlan(songs, startIndex);
  usePlayerStore.getState().setQueue(plan.songs, plan.startIndex, options);
}

export function playSong(song: PlayerSong): void {
  markPlaybackEngaged();
  usePlayerStore.getState().setQueue([song], 0);
}

// Tap a tile: toggle if it's already current, otherwise start it within its list.
// `contextKey` tags the queue with the collection it was started from, so that
// collection's Play button can show Pause/resume instead of restarting.
export function toggleSongInList(songs: PlayerSong[], startIndex: number, contextKey?: string): void {
  markPlaybackEngaged();
  const state = usePlayerStore.getState();
  const target = songs[startIndex];
  if (target && state.currentSong?.id === target.id) {
    state.toggle();
    return;
  }
  const plan = playbackPlan(songs, startIndex);
  state.setQueue(plan.songs, plan.startIndex, { contextKey });
}

export async function seekTo(seconds: number): Promise<void> {
  markPlaybackEngaged();
  await seek(Math.max(0, seconds));
}
