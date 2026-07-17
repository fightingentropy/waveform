import { describe, expect, test } from "bun:test";
import {
  mergeRefreshedPlayEventMediaUrls,
  playEventSongHasDeviceLocalUrl,
} from "../src/worker/index";
import type { PlayerSong } from "../src/types/player";

function makeSong(overrides: Partial<PlayerSong> = {}): Pick<PlayerSong, "audioUrl" | "imageUrl" | "lyricsUrl"> {
  return {
    audioUrl: "/api/files/local/test.flac",
    imageUrl: "/apple-icon.png",
    ...overrides,
  };
}

describe("playEventSongHasDeviceLocalUrl", () => {
  // Offline downloads and the native Capacitor wrapper were removed, so the only
  // device-local scheme the web app still produces is blob: (browser-local
  // uploads), which the server can't fetch and must not record a play event for.
  test("rejects blob: URLs in any media field", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "blob:https://localhost/abc-123" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ imageUrl: "blob:https://localhost/abc-123" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ lyricsUrl: "blob:https://localhost/lyr-1" }))).toBe(true);
  });

  test("accepts relative /api URLs and absolute http(s) URLs", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong())).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "https://example.com/api/files/local/test.flac" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "http://example.com/test.mp3", imageUrl: "https://example.com/cover.jpg" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ lyricsUrl: "/api/lyrics/test.lrc" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "/api/files/local/test.flac?codec=flac" }))).toBe(false);
  });
});

describe("mergeRefreshedPlayEventMediaUrls", () => {
  test("replaces stale signed media without overwriting listening-history metadata", () => {
    const stale = {
      id: "local-server:abc123",
      title: "Stored title",
      artist: "Stored artist",
      album: "Stored album",
      imageUrl: "/api/artwork/local/local-server%3Aabc123?spotify_sig=old",
      audioUrl: "/api/files/local/song.flac?spotify_sig=old",
      lyricsUrl: "/api/files/local/song.lrc?spotify_sig=old",
    } satisfies PlayerSong;

    const [merged] = mergeRefreshedPlayEventMediaUrls(
      [stale],
      [{
        id: stale.id,
        imageUrl: "/api/artwork/local/local-server%3Aabc123?spotify_exp=200&spotify_sig=fresh",
        audioUrl: "/api/files/local/song.flac?spotify_exp=200&spotify_sig=fresh",
        lyricsUrl: "/api/files/local/song.lrc?spotify_exp=200&spotify_sig=fresh",
      }],
    );

    expect(merged?.title).toBe("Stored title");
    expect(merged?.artist).toBe("Stored artist");
    expect(merged?.album).toBe("Stored album");
    expect(merged?.imageUrl).toContain("spotify_exp=200");
    expect(merged?.audioUrl).toContain("spotify_exp=200");
    expect(merged?.lyricsUrl).toContain("spotify_exp=200");
  });

  test("keeps the stored snapshot when no refreshed media is returned", () => {
    const song = {
      id: "podcast:episode-1",
      title: "Episode",
      artist: "Show",
      imageUrl: "/api/podcast-media/show?url=cover",
      audioUrl: "/api/podcast-media/show?url=audio",
    } satisfies PlayerSong;

    expect(mergeRefreshedPlayEventMediaUrls([song], [])[0]).toEqual(song);
  });
});
