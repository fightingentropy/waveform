import type { PlayerSong } from "@/types/player";

// Pick a playable starting slot without changing the queue itself. Keeping one
// canonical queue is critical: reconnecting must not suddenly restore tracks or
// alter shuffle/history indices because the app started while offline.
export function resolvePlaybackStartIndex(
  songs: PlayerSong[],
  requestedIndex: number,
  online: boolean,
  isAvailableOffline: (song: PlayerSong) => boolean,
): number {
  if (songs.length === 0) return -1;
  const requested = Math.max(0, Math.min(songs.length - 1, Math.floor(requestedIndex)));
  if (online || isAvailableOffline(songs[requested])) return requested;
  for (let step = 1; step < songs.length; step += 1) {
    const index = (requested + step) % songs.length;
    if (isAvailableOffline(songs[index])) return index;
  }
  return requested;
}

// Keep an already-cached current song until it ends, plus a bounded number of
// upcoming songs in actual playback order. The first song in a newly-started
// queue is not downloaded a second time alongside its active stream.
export function selectPlaybackCacheSongs(
  queue: PlayerSong[],
  currentIndex: number,
  upcomingIndices: number[],
  existingCachedIds: ReadonlySet<string>,
  upcomingLimit: number,
): PlayerSong[] {
  const selected: PlayerSong[] = [];
  const seen = new Set<string>();
  const current = queue[currentIndex];
  if (current && existingCachedIds.has(current.id)) {
    selected.push(current);
    seen.add(current.id);
  }
  let upcomingCount = 0;
  for (const index of upcomingIndices) {
    const song = queue[index];
    if (!song || seen.has(song.id)) continue;
    selected.push(song);
    seen.add(song.id);
    upcomingCount += 1;
    if (upcomingCount >= upcomingLimit) break;
  }
  return selected;
}

export function isLikelyNetworkPlaybackError(message: string): boolean {
  return /network|internet|offline|connection|timed?\s*out|NSURLErrorDomain|\b-100[159]\b/i.test(message);
}
