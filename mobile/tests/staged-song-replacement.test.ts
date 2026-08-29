import { describe, expect, test } from "bun:test";
import {
  findStagedSongReplacementIndex,
  isSameLogicalPlaybackSong,
  isStagedSongReplacementTarget,
} from "../src/lib/staged-song-replacement";
import type { PlayerSong } from "../src/types/player";

function song(id: string, discoverTrackId?: string): PlayerSong {
  return {
    id,
    title: "Song",
    artist: "Artist",
    imageUrl: "",
    audioUrl: `/audio/${id}`,
    discoverTrackId,
  };
}

describe("staged song replacement", () => {
  test("treats preview and lossless ids for one provider track as continuous playback", () => {
    const preview = song("preview-opus-id", "spotify-track");
    const lossless = song("lossless-flac-id", "spotify-track");

    expect(isSameLogicalPlaybackSong(preview, lossless)).toBe(true);
    expect(isSameLogicalPlaybackSong(preview, song("other-id", "other-track"))).toBe(false);
  });

  test("replaces a preview by logical provider id when its temporary id changed", () => {
    const queue = [song("before"), song("preview-opus-id", "spotify-track")];
    const lossless = song("lossless-flac-id", "spotify-track");

    expect(findStagedSongReplacementIndex(queue, "discover:spotify-track", lossless)).toBe(1);
  });

  test("still prefers an exact old-id match", () => {
    const queue = [song("discover:spotify-track", "spotify-track")];
    expect(findStagedSongReplacementIndex(queue, "discover:spotify-track", song("preview-id", "spotify-track"))).toBe(0);
  });

  test("does not let a late preview overwrite an already-promoted library song", () => {
    const promoted = song("library-flac-id");
    const latePreview = { ...song("preview-opus-id", "spotify-track"), preview: true };

    expect(isStagedSongReplacementTarget(promoted, "discover:spotify-track", latePreview)).toBe(false);
  });

  test("does not let a late preview downgrade an in-flight lossless upgrade", () => {
    const lossless = { ...song("lossless-flac-id", "spotify-track"), preview: false };
    const latePreview = { ...song("preview-opus-id", "spotify-track"), preview: true };

    expect(isStagedSongReplacementTarget(lossless, "discover:spotify-track", latePreview)).toBe(false);
  });
});
