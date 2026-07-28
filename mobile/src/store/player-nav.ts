// Pure play-queue navigation helpers, deliberately free of React Native / storage
// imports so they can be unit-tested directly. (The player store reads native
// storage at module load, so importing it under a plain test runner isn't viable.)

export type QueueStartPolicy = {
  respectShuffle: boolean;
  shuffle: boolean;
  online: boolean;
};

export function resolveInitialQueueIndex(
  queueLength: number,
  requestedIndex: number,
  policy: QueueStartPolicy,
  random: () => number = Math.random,
): number {
  if (queueLength <= 0) return -1;
  const anchor = Number.isInteger(requestedIndex)
    ? Math.max(0, Math.min(queueLength - 1, requestedIndex))
    : 0;
  // playbackPlan has already selected an available/downloaded fallback offline.
  // Randomizing again would discard it and can choose a remote-only row.
  if (!policy.respectShuffle || !policy.shuffle || !policy.online) return anchor;
  const sample = random();
  const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return Math.min(Math.floor(bounded * queueLength), queueLength - 1);
}

/**
 * Step backward through the shuffle play-history to the most recent entry that is
 * still in range and playable. `canPlay(index)` lets the caller exclude entries
 * that aren't streamable right now — offline, only downloaded queue items pass —
 * so "previous" never lands on an un-streamable track. Online, `canPlay` is
 * always true and this simply returns the last visited index.
 *
 * Returns the target index plus the remaining history (consumed entries removed),
 * or null when no eligible entry exists (empty history, or every remembered track
 * is now out of range / un-downloaded).
 */
export function rewindHistory(
  history: readonly number[],
  queueLength: number,
  canPlay: (index: number) => boolean,
): { index: number; remaining: number[] } | null {
  const remaining = history.slice();
  while (remaining.length > 0) {
    const idx = remaining.pop();
    if (idx !== undefined && idx >= 0 && idx < queueLength && canPlay(idx)) {
      return { index: idx, remaining };
    }
  }
  return null;
}

export type PlayableQueueSearch = {
  queueLength: number;
  currentIndex: number;
  direction?: 1 | -1;
  shuffle: boolean;
  repeatMode: "off" | "one" | "all";
  shuffleRemaining: readonly number[];
};

/**
 * Find the next playable queue slot without changing queue state.
 *
 * Repeat semantics matter here: the old offline picker always used modulo
 * arithmetic (and shuffle fell back to every queue item), so repeat-off playback
 * wrapped to the beginning and could cycle downloaded tracks forever. This helper
 * mirrors normal queue navigation: repeat "all" may wrap/refill; "off" and "one"
 * stop once the remaining forward/backward range is exhausted.
 */
export function findPlayableQueueIndex(
  state: PlayableQueueSearch,
  canPlay: (index: number) => boolean,
): number | null {
  const { queueLength, currentIndex, shuffle, repeatMode, shuffleRemaining } = state;
  const direction = state.direction ?? 1;
  if (queueLength <= 1 || currentIndex < 0 || currentIndex >= queueLength) return null;

  if (shuffle) {
    const seen = new Set<number>();
    for (const index of shuffleRemaining) {
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < queueLength &&
        index !== currentIndex &&
        !seen.has(index)
      ) {
        seen.add(index);
        if (canPlay(index)) return index;
      }
    }
    if (repeatMode !== "all") return null;
    for (let index = 0; index < queueLength; index += 1) {
      if (index !== currentIndex && canPlay(index)) return index;
    }
    return null;
  }

  for (let step = 1; step < queueLength; step += 1) {
    const raw = currentIndex + direction * step;
    if (raw < 0 || raw >= queueLength) {
      if (repeatMode !== "all") break;
    }
    const index = ((raw % queueLength) + queueLength) % queueLength;
    if (canPlay(index)) return index;
  }
  return null;
}
