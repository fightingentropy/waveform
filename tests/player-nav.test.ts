import { describe, expect, test } from "bun:test";
import { findPlayableQueueIndex, rewindHistory } from "../mobile/src/store/player-nav";

// Regression for the offline "previous" bug: in shuffle, online `previous()` walks
// the real play-history, but offline it used to route through the forward-biased
// skipToPlayable picker and jump to an UNPLAYED track. rewindHistory is the shared
// backward walk — online every entry is playable (pops the last visit); offline
// only downloaded queue items are playable, so it steps past un-streamable ones.
describe("rewindHistory (shuffle 'previous')", () => {
  const ALL_PLAYABLE = () => true;

  test("online: returns the most recent visited index + remaining history", () => {
    expect(rewindHistory([5, 2, 8], 10, ALL_PLAYABLE)).toEqual({ index: 8, remaining: [5, 2] });
  });

  test("pressing back twice walks the history newest-first", () => {
    const first = rewindHistory([5, 2, 8], 10, ALL_PLAYABLE);
    expect(first?.index).toBe(8);
    expect(rewindHistory(first!.remaining, 10, ALL_PLAYABLE)).toEqual({ index: 2, remaining: [5] });
  });

  test("offline: skips history entries that aren't downloaded", () => {
    const downloaded = new Set([5, 0, 3]); // 2 and 8 were played but aren't downloaded
    expect(rewindHistory([5, 2, 8], 10, (i) => downloaded.has(i))).toEqual({ index: 5, remaining: [] });
  });

  test("offline: lands on the nearest downloaded entry, keeping older history", () => {
    const downloaded = new Set([5, 2]);
    expect(rewindHistory([1, 5, 7, 2, 8], 10, (i) => downloaded.has(i))).toEqual({
      index: 2,
      remaining: [1, 5, 7],
    });
  });

  test("returns null when history is empty (nothing to go back to)", () => {
    expect(rewindHistory([], 10, ALL_PLAYABLE)).toBeNull();
  });

  test("returns null when no remembered track is downloaded", () => {
    expect(rewindHistory([2, 8], 10, () => false)).toBeNull();
  });

  test("skips out-of-range indices left over from a shrunk queue", () => {
    expect(rewindHistory([3, 99, 12], 10, ALL_PLAYABLE)).toEqual({ index: 3, remaining: [] });
  });
});

describe("findPlayableQueueIndex (offline queue boundaries)", () => {
  const base = {
    queueLength: 5,
    currentIndex: 3,
    direction: 1 as const,
    shuffle: false,
    repeatMode: "off" as const,
    shuffleRemaining: [] as number[],
  };

  test("repeat off skips remote-only rows ahead but never wraps", () => {
    expect(findPlayableQueueIndex(base, (index) => index === 4)).toBe(4);
    expect(findPlayableQueueIndex(base, (index) => index === 1)).toBeNull();
  });

  test("repeat all may wrap in either linear direction", () => {
    expect(
      findPlayableQueueIndex({ ...base, repeatMode: "all" }, (index) => index === 1),
    ).toBe(1);
    expect(
      findPlayableQueueIndex(
        {
          ...base,
          currentIndex: 1,
          direction: -1,
          repeatMode: "all",
        },
        (index) => index === 4,
      ),
    ).toBe(4);
  });

  test("shuffle repeat off uses only the unplayed pool", () => {
    const state = {
      ...base,
      shuffle: true,
      shuffleRemaining: [4, 1],
    };
    expect(findPlayableQueueIndex(state, (index) => index === 1)).toBe(1);
    expect(
      findPlayableQueueIndex({ ...state, shuffleRemaining: [] }, (index) => index === 1),
    ).toBeNull();
  });

  test("shuffle repeat all refills from playable queue rows", () => {
    expect(
      findPlayableQueueIndex(
        {
          ...base,
          shuffle: true,
          repeatMode: "all",
          shuffleRemaining: [],
        },
        (index) => index === 1,
      ),
    ).toBe(1);
  });

  test("never returns the current item as an advance target", () => {
    expect(findPlayableQueueIndex(base, (index) => index === base.currentIndex)).toBeNull();
  });
});
