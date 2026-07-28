import { describe, expect, test } from "bun:test";
import {
  isLikelyNetworkPlaybackError,
  resolvePlaybackStartIndex,
  selectPlaybackCacheSongs,
} from "../src/lib/playback-continuity";
import { resolveInitialQueueIndex } from "../src/store/player-nav";
import type { PlayerSong } from "../src/types/player";

const songs = ["a", "b", "c", "d"].map(
  (id): PlayerSong => ({
    id,
    title: id,
    artist: "Artist",
    imageUrl: `/api/artwork/${id}.jpg`,
    audioUrl: `/api/files/${id}.flac`,
  }),
);

describe("playback continuity", () => {
  test("offline start keeps the whole queue and selects the next available song", () => {
    const originalIds = songs.map((song) => song.id);
    const index = resolvePlaybackStartIndex(songs, 1, false, (song) => song.id === "d");
    expect(index).toBe(3);
    expect(songs.map((song) => song.id)).toEqual(originalIds);
  });

  test("offline start wraps and leaves the requested song when no local copy exists", () => {
    expect(resolvePlaybackStartIndex(songs, 3, false, (song) => song.id === "b")).toBe(1);
    expect(resolvePlaybackStartIndex(songs, 2, false, () => false)).toBe(2);
  });

  test("online start always honors the requested index", () => {
    expect(resolvePlaybackStartIndex(songs, 2, true, () => false)).toBe(2);
  });

  test("offline shuffle honors the downloaded fallback instead of randomizing remotely", () => {
    const downloadedFallback = resolvePlaybackStartIndex(
      songs,
      1,
      false,
      (song) => song.id === "d",
    );

    expect(
      resolveInitialQueueIndex(
        songs.length,
        downloadedFallback,
        { respectShuffle: true, shuffle: true, online: false },
        () => 0,
      ),
    ).toBe(3);
    expect(
      resolveInitialQueueIndex(
        songs.length,
        downloadedFallback,
        { respectShuffle: true, shuffle: true, online: true },
        () => 0,
      ),
    ).toBe(0);
  });

  test("cache keeps a cached current song plus two actual upcoming songs", () => {
    const selected = selectPlaybackCacheSongs(songs, 1, [3, 0, 2], new Set(["b"]), 2);
    expect(selected.map((song) => song.id)).toEqual(["b", "d", "a"]);
  });

  test("a newly streamed current song is not redundantly downloaded", () => {
    const selected = selectPlaybackCacheSongs(songs, 0, [1, 2], new Set(), 2);
    expect(selected.map((song) => song.id)).toEqual(["b", "c"]);
  });

  test("recognizes network failures without treating every audio error as offline", () => {
    expect(isLikelyNetworkPlaybackError("The Internet connection appears to be offline. [NSURLErrorDomain -1009]")).toBe(true);
    expect(isLikelyNetworkPlaybackError("connection timed out")).toBe(true);
    expect(isLikelyNetworkPlaybackError("unsupported audio codec")).toBe(false);
  });
});
