import { describe, expect, test } from "bun:test";
import {
  appendQueuePage,
  insertIntoShuffleRemaining,
  mergeOrderedQueuePage,
  remapOrderedQueueIndices,
  wouldDuplicateSongInQueue,
} from "../src/lib/queue-append";
import type { PlayerSong } from "../src/types/player";

function song(id: string, source?: PlayerSong["source"]): PlayerSong {
  return {
    id,
    title: id,
    artist: "Artist",
    imageUrl: "",
    audioUrl: `/api/files/${id}.flac`,
    source,
  };
}

describe("paged queue append", () => {
  test("appends unique music and returns stable new indices", () => {
    const initial = [song("a"), song("b")];
    const result = appendQueuePage(initial, [song("b"), song("c"), song("d")], initial[0]);

    expect(result.queue.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.addedIndices).toEqual([2, 3]);
  });

  test("does not let a fetched mixed-kind row contaminate a music queue", () => {
    const initial = [song("a")];
    const podcast = song("podcast", "podcast");
    const result = appendQueuePage(initial, [podcast, song("b")], initial[0]);

    expect(result.queue.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.addedIndices).toEqual([1]);
  });
});

describe("manual queue duplicate guard", () => {
  test("rejects Play Next when the id exists anywhere in the queue", () => {
    const queue = [song("current"), song("next"), song("later")];

    expect(wouldDuplicateSongInQueue(queue, song("current"))).toBe(true);
    expect(wouldDuplicateSongInQueue(queue, song("next"))).toBe(true);
    expect(wouldDuplicateSongInQueue(queue, song("later"))).toBe(true);
    expect(wouldDuplicateSongInQueue(queue, song("different"))).toBe(false);
  });

  test("rejects Add to Queue when it matches the tail or an earlier row", () => {
    const queue = [song("first"), song("tail")];

    expect(wouldDuplicateSongInQueue(queue, song("tail"))).toBe(true);
    expect(wouldDuplicateSongInQueue(queue, song("first"))).toBe(true);
    expect(wouldDuplicateSongInQueue([], song("first"))).toBe(false);
  });
});

describe("hydrated shuffle-page insertion", () => {
  test("inserts every new index into a randomized position across the live pool", () => {
    const samples = [0, 0.5, 1];
    let sampleIndex = 0;

    const merged = insertIntoShuffleRemaining(
      [1, 2, 3, 4],
      [5, 6, 7],
      () => samples[sampleIndex++]!,
    );

    expect(merged).toEqual([5, 1, 2, 6, 3, 4, 7]);
    expect(merged.slice(-3)).not.toEqual([5, 6, 7]);
    expect([...merged].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("does not mutate the existing remaining pool or the added page", () => {
    const remaining = [2, 4, 1];
    const additions = [5, 6];

    const merged = insertIntoShuffleRemaining(remaining, additions, () => 0);

    expect(merged).toEqual([6, 5, 2, 4, 1]);
    expect(remaining).toEqual([2, 4, 1]);
    expect(additions).toEqual([5, 6]);
  });

  test("handles invalid random samples deterministically at pool boundaries", () => {
    const samples = [Number.NaN, -1, 2];
    let sampleIndex = 0;

    expect(
      insertIntoShuffleRemaining(
        [1],
        [2, 3, 4],
        () => samples[sampleIndex++]!,
      ),
    ).toEqual([3, 2, 1, 4]);
  });

  test("matches sequential insertion for the same deterministic random choices", () => {
    const remaining = [10, 20, 30, 40, 50];
    const additions = [60, 70, 80, 90, 100, 110];
    const samples = [0.81, 0.04, 0.55, 0.22, 0.97, 0.41];
    const expected = [...remaining];
    additions.forEach((addition, index) => {
      expected.splice(
        Math.floor(samples[index] * (expected.length + 1)),
        0,
        addition,
      );
    });
    let sampleIndex = 0;

    expect(
      insertIntoShuffleRemaining(
        remaining,
        additions,
        () => samples[sampleIndex++]!,
      ),
    ).toEqual(expected);
  });

  test("interleaves a large hydrated page while preserving every pool invariant", () => {
    const remaining = Array.from({ length: 10_000 }, (_, index) => index);
    const additions = Array.from({ length: 100 }, (_, index) => 10_000 + index);
    let randomCalls = 0;
    let randomState = 0x12345678;
    const merged = insertIntoShuffleRemaining(remaining, additions, () => {
      randomCalls += 1;
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    });

    expect(randomCalls).toBe(additions.length);
    expect(merged.length).toBe(remaining.length + additions.length);
    expect(merged.filter((index) => index < 10_000)).toEqual(remaining);
    expect(
      merged
        .filter((index) => index >= 10_000)
        .sort((a, b) => a - b),
    ).toEqual(additions);
    expect(new Set(merged).size).toBe(merged.length);
  });
});

describe("globally ordered queue-page merge", () => {
  const byTitle = (a: PlayerSong, b: PlayerSong) => a.title.localeCompare(b.title);

  test("merges a sorted page across the whole active queue", () => {
    const existing = [song("bravo"), song("delta")];
    const incoming = [song("alpha"), song("charlie")];

    const merged = mergeOrderedQueuePage(existing, incoming, existing[1], {
      compare: byTitle,
    });

    expect(merged.queue.map((item) => item.id)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    expect(merged.oldIndexToNewIndex).toEqual([1, 3]);
    expect(merged.addedIndices).toEqual([0, 2]);
  });

  test("remaps current, history, future, and shuffle indices to the same songs", () => {
    const existing = [song("bravo"), song("delta"), song("foxtrot")];
    const merged = mergeOrderedQueuePage(
      existing,
      [song("alpha"), song("echo")],
      existing[1],
      { compare: byTitle },
    );
    const idsAt = (indices: number[]) => indices.map((index) => merged.queue[index]?.id);

    const currentIndex = merged.oldIndexToNewIndex[1];
    const history = remapOrderedQueueIndices([0, 2], merged.oldIndexToNewIndex);
    const future = remapOrderedQueueIndices([2, 0], merged.oldIndexToNewIndex);
    const remaining = remapOrderedQueueIndices([0, 2], merged.oldIndexToNewIndex);

    expect(merged.queue[currentIndex]?.id).toBe("delta");
    expect(idsAt(history)).toEqual(["bravo", "foxtrot"]);
    expect(idsAt(future)).toEqual(["foxtrot", "bravo"]);
    expect(idsAt(remaining)).toEqual(["bravo", "foxtrot"]);
  });

  test("places later provider pages first for descending equal-key runs", () => {
    const existing = [song("old-b"), song("old-a")];
    const incoming = [song("new-b"), song("new-a")];

    const merged = mergeOrderedQueuePage(
      existing,
      incoming,
      existing[0],
      {
        compare: () => 0,
        incomingBeforeEqual: true,
      },
    );

    expect(merged.queue.map((item) => item.id)).toEqual([
      "new-b",
      "new-a",
      "old-b",
      "old-a",
    ]);
    expect(merged.oldIndexToNewIndex).toEqual([2, 3]);
  });

  test("keeps an earlier new title after the current song so repeat-off reaches it", () => {
    const existing = [song("bravo"), song("delta")];

    const merged = mergeOrderedQueuePage(existing, [song("alpha")], existing[0], {
      compare: byTitle,
      frozenPrefixEnd: 0,
    });

    expect(merged.queue.map((item) => item.id)).toEqual(["bravo", "alpha", "delta"]);
    expect(merged.oldIndexToNewIndex).toEqual([0, 2]);
    expect(merged.addedIndices).toEqual([1]);
    expect(merged.addedIndices.every((index) => index > 0)).toBe(true);
  });

  test("keeps every custom-desc page after the current prefix without starving a page", () => {
    const firstPage = [song("c"), song("b"), song("a")];
    const second = mergeOrderedQueuePage(
      firstPage,
      [song("f"), song("e"), song("d")],
      firstPage[0],
      {
        compare: () => 0,
        incomingBeforeEqual: true,
        frozenPrefixEnd: 0,
      },
    );
    const third = mergeOrderedQueuePage(
      second.queue,
      [song("i"), song("h"), song("g")],
      second.queue[0],
      {
        compare: () => 0,
        incomingBeforeEqual: true,
        frozenPrefixEnd: 0,
      },
    );

    expect(third.queue.map((item) => item.id)).toEqual([
      "c",
      "i",
      "h",
      "g",
      "f",
      "e",
      "d",
      "b",
      "a",
    ]);
    expect(new Set(third.queue.map((item) => item.id)).size).toBe(9);
    expect(third.addedIndices.every((index) => index > 0)).toBe(true);
  });

  test("keeps Smart Shuffle recommendations anchored while sorting collection rows", () => {
    const existing = [
      song("alpha"),
      song("recommendation-1"),
      song("delta"),
      song("recommendation-2"),
      song("foxtrot"),
    ];

    const merged = mergeOrderedQueuePage(
      existing,
      [song("bravo"), song("echo")],
      existing[0],
      {
        compare: byTitle,
        frozenPrefixEnd: 0,
        interleavedOldIndices: new Set([1, 3]),
      },
    );

    expect(merged.queue.map((item) => item.id)).toEqual([
      "alpha",
      "recommendation-1",
      "bravo",
      "delta",
      "recommendation-2",
      "echo",
      "foxtrot",
    ]);
    expect(
      merged.queue
        .filter((_, index) => ![1, 4].includes(index))
        .map((item) => item.id),
    ).toEqual(["alpha", "bravo", "delta", "echo", "foxtrot"]);
    expect(merged.oldIndexToNewIndex).toEqual([0, 1, 3, 4, 6]);
  });

  test("keeps a Play Next row directly after current during later hydration", () => {
    const existing = [
      song("alpha"),
      song("zz-manual-next"),
      song("delta"),
      song("foxtrot"),
    ];

    const merged = mergeOrderedQueuePage(
      existing,
      [song("bravo"), song("echo")],
      existing[0],
      {
        compare: byTitle,
        frozenPrefixEnd: 0,
        interleavedOldIndices: new Set([1]),
      },
    );

    expect(merged.queue.map((item) => item.id)).toEqual([
      "alpha",
      "zz-manual-next",
      "bravo",
      "delta",
      "echo",
      "foxtrot",
    ]);
    expect(merged.oldIndexToNewIndex).toEqual([0, 1, 3, 5]);
    expect(merged.addedIndices).toEqual([2, 4]);
  });

  test("keeps Add to Queue rows in an opaque tail block", () => {
    const existing = [
      song("alpha"),
      song("delta"),
      song("foxtrot"),
      song("00-manual-tail"),
    ];

    const merged = mergeOrderedQueuePage(
      existing,
      [song("bravo"), song("echo"), song("golf")],
      existing[0],
      {
        compare: byTitle,
        frozenPrefixEnd: 0,
        trailingOldIndices: new Set([3]),
      },
    );

    expect(merged.queue.map((item) => item.id)).toEqual([
      "alpha",
      "bravo",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "00-manual-tail",
    ]);
    expect(merged.oldIndexToNewIndex).toEqual([0, 2, 4, 6]);
    expect(merged.addedIndices).toEqual([1, 3, 5]);
  });

  test("merges two sorted pages with a linear comparison budget", () => {
    const existing = Array.from({ length: 128 }, (_, index) =>
      song(String(index * 2).padStart(3, "0")),
    );
    const incoming = Array.from({ length: 128 }, (_, index) =>
      song(String(index * 2 + 1).padStart(3, "0")),
    );
    let comparisons = 0;

    const merged = mergeOrderedQueuePage(existing, incoming, existing[0], {
      compare: (a, b) => {
        comparisons += 1;
        return a.title.localeCompare(b.title);
      },
    });

    expect(merged.queue.map((item) => item.id)).toEqual(
      Array.from({ length: 256 }, (_, index) => String(index).padStart(3, "0")),
    );
    // Two sortedness scans plus one two-way merge: (127 + 127) + 255.
    expect(comparisons).toBe(509);
  });

  test("falls back safely when a sort change disrupts either sorted input", () => {
    const existing = [song("delta"), song("bravo")];
    const incoming = [song("charlie"), song("alpha")];

    const merged = mergeOrderedQueuePage(existing, incoming, existing[0], {
      compare: byTitle,
    });

    expect(merged.queue.map((item) => item.id)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    expect(merged.oldIndexToNewIndex).toEqual([3, 1]);
    expect(merged.addedIndices).toEqual([0, 2]);
  });
});
