"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/store/player";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { isUnstagedDiscoverSong, stageDiscoverSong } from "@/client/discover-queue";

// Drives just-in-time staging for curated-playlist queues. Curated tracks enter
// the queue as placeholders (empty audioUrl); this materializes the current one
// so it can play, and prefetch-stages the next one so advancing is seamless.
// Mounted once, app-wide (next to PlayerBar) so it keeps working after the user
// navigates away from the playlist page. Renders nothing.
export function DiscoverQueueStager(): null {
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentSongId = usePlayerStore((s) => s.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const replaceStagedSong = usePlayerStore((s) => s.replaceStagedSong);
  const failPlayback = usePlayerStore((s) => s.failPlayback);

  // Placeholder ids with a stage request in flight (dedupe) and ones that failed
  // (don't retry forever / loop through the whole queue).
  const inFlightRef = useRef<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isPlaying) return;
    const stage = (placeholderId: string, song: Parameters<typeof stageDiscoverSong>[0]) => {
      if (inFlightRef.current.has(placeholderId) || failedRef.current.has(placeholderId)) return;
      inFlightRef.current.add(placeholderId);
      void stageDiscoverSong(song)
        .then((real) => {
          replaceStagedSong(placeholderId, real);
          // Nudge playback for the active track (the load effect also picks up the
          // new src since isPlaying stays true — this is belt-and-suspenders for
          // autoplay). No-ops for a prefetched track that isn't current yet.
          const state = usePlayerStore.getState();
          if (state.currentSong?.id === real.id && state.isPlaying) requestImmediatePlayback(real);
        })
        .catch(() => {
          failedRef.current.add(placeholderId);
          // Also handles a prefetched song that became current while loading.
          // Late failures for a different selection leave playback untouched.
          failPlayback(placeholderId, "This song couldn’t load. Press play to retry.");
        })
        .finally(() => {
          inFlightRef.current.delete(placeholderId);
        });
    };

    const current = queue[currentIndex] ?? null;
    if (current && isUnstagedDiscoverSong(current)) {
      // A new play attempt may retry a failed track. Prefetch failures remain
      // suppressed until that track is actually selected.
      failedRef.current.delete(current.id);
      stage(current.id, current);
    }

    // Prefetch one ahead (linear only — shuffle's next pick is random). Stage it
    // while the current track plays so the transition is gapless.
    if (isPlaying && !usePlayerStore.getState().shuffle) {
      const upcoming = queue[currentIndex + 1] ?? null;
      if (upcoming && isUnstagedDiscoverSong(upcoming)) stage(upcoming.id, upcoming);
    }
  }, [queue, currentIndex, currentSongId, isPlaying, failPlayback, replaceStagedSong]);

  return null;
}
