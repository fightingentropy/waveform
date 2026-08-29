import { describe, expect, test } from "bun:test";
import { effectivePlaybackDuration } from "../src/lib/playback-duration";
import type { PlayerSong } from "../src/types/player";

function song(overrides: Partial<PlayerSong> = {}): PlayerSong {
  return {
    id: "song-1",
    title: "Song",
    artist: "Artist",
    imageUrl: "",
    audioUrl: "/song.opus",
    duration: 287,
    ...overrides,
  };
}

describe("playback duration reconciliation", () => {
  test("rejects an absurd eight-hour container duration for a catalog preview", () => {
    expect(
      effectivePlaybackDuration(song({ discoverTrackId: "spotify-track" }), 28_800),
    ).toBe(287);
  });

  test("keeps a plausible native duration difference", () => {
    expect(
      effectivePlaybackDuration(song({ discoverTrackId: "spotify-track" }), 292),
    ).toBe(292);
  });

  test("uses catalog metadata until the backend reports a positive duration", () => {
    expect(
      effectivePlaybackDuration(song({ discoverTrackId: "spotify-track" }), 0),
    ).toBe(287);
  });

  test("does not override ordinary library-track duration measurements", () => {
    expect(effectivePlaybackDuration(song(), 320)).toBe(320);
  });
});
