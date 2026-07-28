import { songKind } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";

function queuePageAdditions(
  queue: readonly PlayerSong[],
  incoming: readonly PlayerSong[],
  anchor: PlayerSong | null,
): PlayerSong[] {
  const anchorKind = anchor ? songKind(anchor) : null;
  const seen = new Set(queue.map((song) => song.id));
  return incoming.filter((song) => {
    if (seen.has(song.id)) return false;
    if (anchorKind && songKind(song) !== anchorKind) return false;
    seen.add(song.id);
    return true;
  });
}

export function appendQueuePage(
  queue: PlayerSong[],
  incoming: readonly PlayerSong[],
  anchor: PlayerSong | null,
): { queue: PlayerSong[]; addedIndices: number[] } {
  const additions = queuePageAdditions(queue, incoming, anchor);
  if (additions.length === 0) return { queue, addedIndices: [] };
  const firstAddedIndex = queue.length;
  return {
    queue: [...queue, ...additions],
    addedIndices: additions.map((_, index) => firstAddedIndex + index),
  };
}

// Both audio engines use song identity to decide whether an index change needs a
// reload. Keep manual queue edits id-unique so A-B-A cannot later become an
// adjacent A-A transition when B is removed.
export function wouldDuplicateSongInQueue(
  queue: readonly PlayerSong[],
  song: PlayerSong,
): boolean {
  return queue.some((queuedSong) => queuedSong.id === song.id);
}

export type OrderedQueuePageMerge = {
  queue: PlayerSong[];
  addedIndices: number[];
  oldIndexToNewIndex: number[];
};

export type OrderedQueuePageMergeOptions = {
  compare: (a: PlayerSong, b: PlayerSong) => number;
  incomingBeforeEqual?: boolean;
  // Keep the already-played/current array prefix fixed. New rows must remain
  // after the current song or linear repeat-off playback can never reach them.
  frozenPrefixEnd?: number;
  // Smart Shuffle recommendations are interleaved rows, not collection rows.
  // Keep each one immediately after the same preceding collection row while
  // sorting the collection-only suffix around those anchors.
  interleavedOldIndices?: ReadonlySet<number>;
  // Add-to-Queue rows must stay at the tail after later provider pages arrive.
  // The first marked row starts an opaque trailing block, preserving any later
  // manual/recommendation rows exactly as the user arranged them.
  trailingOldIndices?: ReadonlySet<number>;
};

type OrderedQueueEntry = {
  song: PlayerSong;
  oldIndex: number | null;
  orderWithinSource: number;
};

function compareOrderedEntries(
  a: OrderedQueueEntry,
  b: OrderedQueueEntry,
  options: OrderedQueuePageMergeOptions,
): number {
  const compared = options.compare(a.song, b.song);
  if (Number.isFinite(compared) && compared !== 0) return compared;
  const aIsIncoming = a.oldIndex === null;
  const bIsIncoming = b.oldIndex === null;
  if (aIsIncoming !== bIsIncoming) {
    return aIsIncoming === (options.incomingBeforeEqual ?? false) ? -1 : 1;
  }
  return a.orderWithinSource - b.orderWithinSource;
}

function entriesAreSorted(
  entries: readonly OrderedQueueEntry[],
  compare: OrderedQueuePageMergeOptions["compare"],
): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    const compared = compare(entries[index - 1].song, entries[index].song);
    if (Number.isFinite(compared) && compared > 0) return false;
  }
  return true;
}

function mergeSortedEntries(
  existing: readonly OrderedQueueEntry[],
  incoming: readonly OrderedQueueEntry[],
  options: OrderedQueuePageMergeOptions,
): OrderedQueueEntry[] {
  const merged: OrderedQueueEntry[] = [];
  let existingIndex = 0;
  let incomingIndex = 0;
  while (existingIndex < existing.length && incomingIndex < incoming.length) {
    const compared = options.compare(
      existing[existingIndex].song,
      incoming[incomingIndex].song,
    );
    const takeIncoming =
      Number.isFinite(compared) && compared !== 0
        ? compared > 0
        : (options.incomingBeforeEqual ?? false);
    if (takeIncoming) {
      merged.push(incoming[incomingIndex]);
      incomingIndex += 1;
    } else {
      merged.push(existing[existingIndex]);
      existingIndex += 1;
    }
  }
  if (existingIndex < existing.length) merged.push(...existing.slice(existingIndex));
  if (incomingIndex < incoming.length) merged.push(...incoming.slice(incomingIndex));
  return merged;
}

export function mergeOrderedQueuePage(
  queue: PlayerSong[],
  incoming: readonly PlayerSong[],
  anchor: PlayerSong | null,
  options: OrderedQueuePageMergeOptions,
): OrderedQueuePageMerge {
  const additions = queuePageAdditions(queue, incoming, anchor);
  const frozenPrefixEnd = Math.min(
    queue.length - 1,
    Math.max(-1, Math.floor(options.frozenPrefixEnd ?? -1)),
  );
  const prefix: OrderedQueueEntry[] = queue
    .slice(0, frozenPrefixEnd + 1)
    .map((song, oldIndex) => ({ song, oldIndex, orderWithinSource: oldIndex }));
  const interleaved = options.interleavedOldIndices ?? new Set<number>();
  const trailingStart = Math.min(
    queue.length,
    ...[...(options.trailingOldIndices ?? [])].filter(
      (index) =>
        Number.isInteger(index) &&
        index > frozenPrefixEnd &&
        index >= 0 &&
        index < queue.length,
    ),
  );
  const trailing: OrderedQueueEntry[] = queue
    .slice(trailingStart)
    .map((song, offset) => ({
      song,
      oldIndex: trailingStart + offset,
      orderWithinSource: trailingStart + offset,
    }));
  const existingSuffix: OrderedQueueEntry[] = queue.flatMap((song, oldIndex) =>
    oldIndex > frozenPrefixEnd &&
    oldIndex < trailingStart &&
    !interleaved.has(oldIndex)
      ? [{ song, oldIndex, orderWithinSource: oldIndex }]
      : [],
  );
  const incomingPage: OrderedQueueEntry[] = additions.map((song, orderWithinSource) => ({
    song,
    oldIndex: null,
    orderWithinSource,
  }));
  // Normal pagination keeps both sides sorted, so hydration is O(n + m) even
  // near Spotify's 10k-track cap. A manual queue edit or mid-hydration sort
  // change can invalidate that precondition; detect it and take the stable sort
  // fallback once rather than silently producing a misordered queue.
  const sortableSuffix =
    entriesAreSorted(existingSuffix, options.compare) &&
    entriesAreSorted(incomingPage, options.compare)
      ? mergeSortedEntries(existingSuffix, incomingPage, options)
      : [...existingSuffix, ...incomingPage].sort((a, b) =>
          compareOrderedEntries(a, b, options),
        );

  const leadingInterleaved: OrderedQueueEntry[] = [];
  const interleavedAfter = new Map<number, OrderedQueueEntry[]>();
  let precedingSortableOldIndex: number | null = null;
  for (let oldIndex = frozenPrefixEnd + 1; oldIndex < trailingStart; oldIndex += 1) {
    const entry: OrderedQueueEntry = {
      song: queue[oldIndex],
      oldIndex,
      orderWithinSource: oldIndex,
    };
    if (!interleaved.has(oldIndex)) {
      precedingSortableOldIndex = oldIndex;
      continue;
    }
    if (precedingSortableOldIndex === null) {
      leadingInterleaved.push(entry);
      continue;
    }
    const group = interleavedAfter.get(precedingSortableOldIndex);
    if (group) group.push(entry);
    else interleavedAfter.set(precedingSortableOldIndex, [entry]);
  }
  const orderedSuffix = [...leadingInterleaved];
  for (const entry of sortableSuffix) {
    orderedSuffix.push(entry);
    if (entry.oldIndex !== null) {
      const anchored = interleavedAfter.get(entry.oldIndex);
      if (anchored) orderedSuffix.push(...anchored);
    }
  }
  const entries = [...prefix, ...orderedSuffix, ...trailing];
  const oldIndexToNewIndex = Array.from({ length: queue.length }, () => -1);
  const addedIndices: number[] = [];
  entries.forEach((entry, newIndex) => {
    if (entry.oldIndex === null) addedIndices.push(newIndex);
    else oldIndexToNewIndex[entry.oldIndex] = newIndex;
  });
  return {
    queue: entries.map((entry) => entry.song),
    addedIndices,
    oldIndexToNewIndex,
  };
}

export function remapOrderedQueueIndices(
  indices: readonly number[],
  oldIndexToNewIndex: readonly number[],
): number[] {
  const remapped: number[] = [];
  for (const oldIndex of indices) {
    if (!Number.isInteger(oldIndex) || oldIndex < 0 || oldIndex >= oldIndexToNewIndex.length) continue;
    const newIndex = oldIndexToNewIndex[oldIndex];
    if (Number.isInteger(newIndex) && newIndex >= 0) remapped.push(newIndex);
  }
  return remapped;
}

export function insertIntoShuffleRemaining(
  remaining: readonly number[],
  addedIndices: readonly number[],
  random: () => number = Math.random,
): number[] {
  if (addedIndices.length === 0) return [...remaining];
  const finalLength = remaining.length + addedIndices.length;
  // Fenwick tree of available final slots. Starting with every slot available
  // lets us replay the old sequential-insertion choices backward in
  // O(m log(n+m)), instead of moving O(n) array elements for every new row.
  const available = new Int32Array(finalLength + 1);
  for (let index = 1; index <= finalLength; index += 1) {
    available[index] = index & -index;
  }
  const samples = addedIndices.map(() => {
    const sample = random();
    return Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  });
  const merged = new Array<number>(finalLength);
  const occupied = new Uint8Array(finalLength);
  let highestBit = 1;
  while (highestBit * 2 <= finalLength) highestBit *= 2;

  const takeAvailableSlot = (rank: number): number => {
    let treeIndex = 0;
    for (let step = highestBit; step > 0; step = Math.floor(step / 2)) {
      const next = treeIndex + step;
      if (next <= finalLength && available[next] <= rank) {
        treeIndex = next;
        rank -= available[next];
      }
    }
    const oneBasedSlot = treeIndex + 1;
    for (let index = oneBasedSlot; index <= finalLength; index += index & -index) {
      available[index] -= 1;
    }
    return oneBasedSlot - 1;
  };

  for (let index = addedIndices.length - 1; index >= 0; index -= 1) {
    const availableCount = remaining.length + index + 1;
    const rank = Math.min(
      Math.floor(samples[index] * availableCount),
      availableCount - 1,
    );
    const slot = takeAvailableSlot(rank);
    merged[slot] = addedIndices[index];
    occupied[slot] = 1;
  }
  let remainingIndex = 0;
  for (let slot = 0; slot < finalLength; slot += 1) {
    if (occupied[slot] === 0) {
      merged[slot] = remaining[remainingIndex];
      remainingIndex += 1;
    }
  }
  return merged;
}
