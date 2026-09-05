import { beforeEach, describe, expect, test } from "bun:test";
import { getUpcomingPlaybackIndices, usePlayerStore } from "../src/store/player";
import type { PlayerSong } from "../src/types/player";

function song(id: string): PlayerSong {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    imageUrl: `https://example.com/${id}.jpg`,
    audioUrl: `https://example.com/${id}.mp3`,
  };
}

function songs(...ids: string[]): PlayerSong[] {
  return ids.map(song);
}

function podcast(id: string): PlayerSong {
  return { ...song(id), source: "podcast" };
}

function queueIds(): string[] {
  return usePlayerStore.getState().queue.map((item) => item.id);
}

function idsAt(indices: number[]): string[] {
  const { queue } = usePlayerStore.getState();
  return indices.map((index) => queue[index]?.id ?? `<invalid:${index}>`);
}

beforeEach(() => {
  usePlayerStore.setState({
    playbackError: null,
    queue: [],
    currentIndex: -1,
    currentSong: null,
    playHistory: [],
    playFuture: [],
    shuffleRemaining: [],
    isPlaying: false,
    shuffle: false,
    repeatMode: "off",
  });
});

describe("failed playback preserves the user's selection", () => {
  test("a missing file pauses without consuming shuffle or changing the queue", () => {
    usePlayerStore.setState({ shuffle: true });
    usePlayerStore.getState().setQueue(songs("a", "b", "c"), 1);
    const before = usePlayerStore.getState();

    before.failPlayback("b", "Couldn’t load this song");

    const after = usePlayerStore.getState();
    expect(after.isPlaying).toBe(false);
    expect(after.currentSong?.id).toBe("b");
    expect(after.currentIndex).toBe(before.currentIndex);
    expect(after.queue).toBe(before.queue);
    expect(after.shuffleRemaining).toEqual(before.shuffleRemaining);
    expect(after.playHistory).toEqual(before.playHistory);
    expect(after.playbackError?.songId).toBe("b");

    after.play();
    expect(usePlayerStore.getState().currentSong?.id).toBe("b");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(usePlayerStore.getState().playbackError).toBeNull();
  });

  test("a late or prefetched failure cannot pause a different song", () => {
    usePlayerStore.getState().setQueue(songs("a", "b"), 1);
    usePlayerStore.getState().failPlayback("a", "Couldn’t load this song");
    expect(usePlayerStore.getState().currentSong?.id).toBe("b");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(usePlayerStore.getState().playbackError).toBeNull();
  });
});

describe("setQueue keeps one kind per queue", () => {
  test("starting a music track drops podcasts from a mixed list", () => {
    const mixed = [song("a"), podcast("p1"), song("b"), podcast("p2"), song("c")];
    const started = usePlayerStore.getState().setQueue(mixed, 2); // "b"

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b", "c"]);
    expect(state.currentSong?.id).toBe("b");
    expect(state.queue[state.currentIndex]?.id).toBe("b");
    expect(started?.id).toBe("b");
    expect(state.isPlaying).toBe(true);
  });

  test("re-indexes the start when an earlier item is filtered out", () => {
    // The clicked track sits after a podcast, so its raw index shifts left once
    // the podcast is dropped.
    const mixed = [podcast("p1"), song("a"), song("b")];
    usePlayerStore.getState().setQueue(mixed, 2); // "b" at raw index 2

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("b");
  });

  test("next() on the filtered music queue never lands on a podcast", () => {
    usePlayerStore.getState().setQueue([song("a"), podcast("p1"), song("b")], 0);

    usePlayerStore.getState().next();
    const state = usePlayerStore.getState();
    expect(state.currentSong?.id).toBe("b");
    expect(state.currentSong?.source).not.toBe("podcast");
  });

  test("starting a podcast keeps podcasts and drops music", () => {
    const mixed = [song("a"), podcast("p1"), song("b"), podcast("p2")];
    usePlayerStore.getState().setQueue(mixed, 1); // podcast "p1"

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["p1", "p2"]);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong?.id).toBe("p1");
  });

  test("shuffle play on a mixed list starts on music, not a podcast", () => {
    usePlayerStore.setState({ shuffle: true });
    const mixed = [song("a"), podcast("p1"), song("b"), podcast("p2"), song("c")];
    const started = usePlayerStore.getState().setQueue(mixed, 0, { respectShuffle: true });

    expect(queueIds()).toEqual(["a", "b", "c"]);
    expect(started).not.toBeNull();
    expect(["a", "b", "c"]).toContain(started!.id);
    expect(started!.source).not.toBe("podcast");
  });

  test("an empty list clears the queue", () => {
    usePlayerStore.setState({
      queue: songs("a", "b"),
      currentIndex: 0,
      currentSong: song("a"),
      isPlaying: true,
    });

    usePlayerStore.getState().setQueue([], 0);

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.currentIndex).toBe(-1);
    expect(state.currentSong).toBe(null);
    expect(state.isPlaying).toBe(false);
  });
});

describe("addToQueue", () => {
  test("on an empty queue makes the song current without starting playback", () => {
    const track = song("a");
    usePlayerStore.getState().addToQueue(track);

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([track]);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong).toEqual(track);
    expect(state.isPlaying).toBe(false);
  });

  test("appends without disturbing the current song in linear mode", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({ queue, currentIndex: 1, currentSong: queue[1] });

    usePlayerStore.getState().addToQueue(song("d"));

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b", "c", "d"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("b");
    expect(state.shuffleRemaining).toEqual([]);
  });

  test("makes the appended index shuffle-eligible when shuffle is on", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({
      queue,
      currentIndex: 0,
      currentSong: queue[0],
      shuffle: true,
      shuffleRemaining: [1, 2],
    });

    usePlayerStore.getState().addToQueue(song("d"));

    const state = usePlayerStore.getState();
    expect(state.shuffleRemaining).toEqual([1, 2, 3]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["b", "c", "d"]);
  });
});

describe("playNext", () => {
  test("on an empty queue behaves like addToQueue", () => {
    const track = song("a");
    usePlayerStore.getState().playNext(track);

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([track]);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong).toEqual(track);
    expect(state.isPlaying).toBe(false);
  });

  test("inserts after the current song in linear mode and next() plays it", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({ queue, currentIndex: 1, currentSong: queue[1] });

    usePlayerStore.getState().playNext(song("x"));
    expect(queueIds()).toEqual(["a", "b", "x", "c"]);
    expect(usePlayerStore.getState().currentSong?.id).toBe("b");

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentIndex).toBe(2);
    expect(usePlayerStore.getState().currentSong?.id).toBe("x");

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.id).toBe("c");
  });

  test("remaps playHistory/playFuture/shuffleRemaining under shuffle", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 1,
      currentSong: queue[1],
      shuffle: true,
      playHistory: [0, 2],
      playFuture: [3],
      shuffleRemaining: [2, 3],
    });

    usePlayerStore.getState().playNext(song("x"));

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b", "x", "c", "d"]);
    // Stored indices still point at the same songs they did before the splice.
    expect(idsAt(state.playHistory)).toEqual(["a", "c"]);
    expect(state.playHistory).toEqual([0, 3]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["c", "d"]);
    expect(state.shuffleRemaining).toEqual([3, 4]);
    // The inserted index is pushed onto the redo stack so next() plays it.
    expect(state.playFuture).toEqual([4, 2]);
    expect(idsAt(state.playFuture)).toEqual(["d", "x"]);
  });

  test("plays next under shuffle without touching the shuffle pool", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 1,
      currentSong: queue[1],
      shuffle: true,
      shuffleRemaining: [0, 2, 3],
    });

    usePlayerStore.getState().playNext(song("x"));
    usePlayerStore.getState().next();

    const state = usePlayerStore.getState();
    expect(state.currentSong?.id).toBe("x");
    expect(state.currentIndex).toBe(2);
    expect(state.playFuture).toEqual([]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["a", "c", "d"]);
    expect(state.playHistory).toEqual([1]);
  });

  test("shuffle next() consumes the pool head so up-next matches playback", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 0,
      currentSong: queue[0],
      shuffle: true,
      shuffleRemaining: [3, 1, 2],
      playFuture: [],
    });

    usePlayerStore.getState().next();

    const state = usePlayerStore.getState();
    expect(state.currentSong?.id).toBe("d");
    expect(state.currentIndex).toBe(3);
    expect(state.shuffleRemaining).toEqual([1, 2]);
  });
});

describe("removeFromQueue", () => {
  test("refuses the current index and out-of-range indices", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({ queue, currentIndex: 1, currentSong: queue[1] });
    const before = usePlayerStore.getState();

    usePlayerStore.getState().removeFromQueue(1);
    usePlayerStore.getState().removeFromQueue(-1);
    usePlayerStore.getState().removeFromQueue(3);
    usePlayerStore.getState().removeFromQueue(1.5);

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual(before.queue);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("b");
  });

  test("removing before the current index shifts currentIndex and remaps stored indices", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 2,
      currentSong: queue[2],
      shuffle: true,
      playHistory: [0, 1],
      playFuture: [3],
      shuffleRemaining: [0, 3],
    });

    usePlayerStore.getState().removeFromQueue(0);

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["b", "c", "d"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("c");
    expect(state.queue[state.currentIndex]?.id).toBe("c");
    // Index 0 (the removed song) is dropped everywhere; the rest shift down.
    expect(state.playHistory).toEqual([0]);
    expect(idsAt(state.playHistory)).toEqual(["b"]);
    expect(state.playFuture).toEqual([2]);
    expect(idsAt(state.playFuture)).toEqual(["d"]);
    expect(state.shuffleRemaining).toEqual([2]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["d"]);
  });

  test("removing after the current index leaves currentIndex alone", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 1,
      currentSong: queue[1],
      shuffle: true,
      playHistory: [0],
      playFuture: [3],
      shuffleRemaining: [2, 3],
    });

    usePlayerStore.getState().removeFromQueue(2);

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b", "d"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("b");
    expect(state.playHistory).toEqual([0]);
    expect(state.playFuture).toEqual([2]);
    expect(idsAt(state.playFuture)).toEqual(["d"]);
    expect(state.shuffleRemaining).toEqual([2]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["d"]);
  });
});

describe("getUpcomingPlaybackIndices", () => {
  const linear = (repeatMode: "off" | "all" = "off") => ({
    shuffle: false,
    repeatMode,
    playFuture: [] as number[],
    shuffleRemaining: [] as number[],
  });

  test("linear mode walks forward in array order", () => {
    expect(getUpcomingPlaybackIndices(5, 1, 3, linear())).toEqual([2, 3, 4]);
  });

  test("linear mode truncates at the end of the queue when repeat is off", () => {
    expect(getUpcomingPlaybackIndices(5, 3, 3, linear())).toEqual([4]);
    expect(getUpcomingPlaybackIndices(5, 4, 3, linear())).toEqual([]);
  });

  test("linear mode wraps once when repeat is all", () => {
    expect(getUpcomingPlaybackIndices(5, 3, 3, linear("all"))).toEqual([4, 0, 1]);
    // Never includes the current index, even while wrapping.
    expect(getUpcomingPlaybackIndices(3, 1, 5, linear("all"))).toEqual([2, 0]);
  });

  test("shuffle drains the redo stack (top first) before the pool", () => {
    const indices = getUpcomingPlaybackIndices(10, 0, 3, {
      shuffle: true,
      repeatMode: "off",
      playFuture: [7, 2], // top of stack (2) plays next, then 7
      shuffleRemaining: [2, 5, 7, 9],
    });
    // 2 and 7 come from the redo stack; the pool then fills with the next unseen
    // entry (5), skipping 2 and 7 which are already queued.
    expect(indices).toEqual([2, 7, 5]);
  });

  test("shuffle with an empty redo stack warms the pool's leading entries", () => {
    expect(
      getUpcomingPlaybackIndices(10, 0, 3, {
        shuffle: true,
        repeatMode: "off",
        playFuture: [],
        shuffleRemaining: [3, 5, 8],
      }),
    ).toEqual([3, 5, 8]);
  });

  test("shuffle stops at an exhausted pool when repeat is off, refills when repeat is all", () => {
    expect(
      getUpcomingPlaybackIndices(4, 2, 3, {
        shuffle: true,
        repeatMode: "off",
        playFuture: [],
        shuffleRemaining: [],
      }),
    ).toEqual([]);

    // repeat "all" refills from the full queue minus the current index.
    expect(
      [...getUpcomingPlaybackIndices(4, 2, 3, {
        shuffle: true,
        repeatMode: "all",
        playFuture: [],
        shuffleRemaining: [],
      })].sort((left, right) => left - right),
    ).toEqual([0, 1, 3]);
  });

  test("never returns the current index and dedupes across stack + pool", () => {
    const indices = getUpcomingPlaybackIndices(6, 3, 5, {
      shuffle: true,
      repeatMode: "all",
      playFuture: [3, 1], // 3 == current, must be dropped; 1 is valid
      shuffleRemaining: [1, 4],
    });
    expect(indices).not.toContain(3);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices).toEqual([1, 4]);
  });

  test("degenerate inputs yield no upcoming tracks", () => {
    expect(getUpcomingPlaybackIndices(0, -1, 3, linear())).toEqual([]);
    expect(getUpcomingPlaybackIndices(5, 1, 0, linear())).toEqual([]);
    expect(
      getUpcomingPlaybackIndices(1, 0, 3, { shuffle: true, repeatMode: "off", playFuture: [], shuffleRemaining: [] }),
    ).toEqual([]);
  });
});

describe("queue mutation shuffle invariants", () => {
  test("a mixed sequence of mutations keeps stored indices valid and aimed at the same songs", () => {
    const queue = songs("a", "b", "c", "d", "e");
    usePlayerStore.setState({
      queue,
      currentIndex: 2,
      currentSong: queue[2],
      shuffle: true,
      playHistory: [0, 4],
      playFuture: [1],
      shuffleRemaining: [1, 3],
    });

    usePlayerStore.getState().playNext(song("x")); // insert at 3
    usePlayerStore.getState().addToQueue(song("y")); // append at 6
    usePlayerStore.getState().removeFromQueue(0); // drop "a"

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["b", "c", "x", "d", "e", "y"]);
    expect(state.currentSong?.id).toBe("c");
    expect(state.queue[state.currentIndex]?.id).toBe("c");

    // "a" disappeared from history; the rest still target the original songs.
    expect(idsAt(state.playHistory)).toEqual(["e"]);
    expect(idsAt(state.playFuture)).toEqual(["b", "x"]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["b", "d", "y"]);

    for (const indices of [state.playHistory, state.playFuture, state.shuffleRemaining]) {
      for (const index of indices) {
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(state.queue.length);
      }
    }
    expect(new Set(state.shuffleRemaining).size).toBe(state.shuffleRemaining.length);
    expect(state.shuffleRemaining).not.toContain(state.currentIndex);
  });
});
