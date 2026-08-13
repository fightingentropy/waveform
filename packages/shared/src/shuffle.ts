export function clampQueueIndex(queueLength: number, index: number): number {
  if (queueLength <= 0) return -1;
  if (!Number.isInteger(index)) return 0;
  return Math.max(0, Math.min(queueLength - 1, index));
}

export function createShuffleRemaining(
  queueLength: number,
  currentIndex: number,
  random: () => number = Math.random,
): number[] {
  if (queueLength <= 1) return [];
  const current = clampQueueIndex(queueLength, currentIndex);
  const remaining: number[] = [];
  for (let index = 0; index < queueLength; index += 1) {
    if (index !== current) remaining.push(index);
  }
  // Randomize the play order ONCE (Fisher–Yates) rather than picking a random
  // index at each next(). The queue sheet renders this exact order as "up next"
  // and next() consumes it head-first, so a fixed shuffled order is what keeps
  // the displayed queue matching what actually plays.
  for (let i = remaining.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const left = remaining[i];
    const right = remaining[j];
    if (left === undefined || right === undefined) continue;
    remaining[i] = right;
    remaining[j] = left;
  }
  return remaining;
}

export function validShuffleRemaining(
  queueLength: number,
  currentIndex: number,
  remaining: number[],
): number[] {
  if (queueLength <= 1) return [];
  const seen = new Set<number>();
  return remaining.filter((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= queueLength || index === currentIndex) return false;
    if (seen.has(index)) return false;
    seen.add(index);
    return true;
  });
}

export function getNextShufflePool(
  queueLength: number,
  currentIndex: number,
  remaining: number[],
  random: () => number = Math.random,
): number[] {
  const validRemaining = validShuffleRemaining(queueLength, currentIndex, remaining);
  return validRemaining.length > 0 ? validRemaining : createShuffleRemaining(queueLength, currentIndex, random);
}

export function chooseNextShuffleIndex(
  queueLength: number,
  currentIndex: number,
  remaining: number[],
  random: () => number = Math.random,
): number {
  const pool = getNextShufflePool(queueLength, currentIndex, remaining, random);
  if (pool.length === 0) return clampQueueIndex(queueLength, currentIndex);
  return pool[0] ?? clampQueueIndex(queueLength, currentIndex);
}
