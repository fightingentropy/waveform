import { describe, expect, test } from "bun:test";
import { canDeletePlaylist } from "../src/lib/playlist-policy";

describe("playlist delete policy", () => {
  test("honors an explicit server capability", () => {
    expect(
      canDeletePlaylist({
        id: "local-folder-protected",
        editable: true,
        deletable: true,
      }),
    ).toBe(true);
    expect(
      canDeletePlaylist({
        id: "native-playlist",
        editable: true,
        deletable: false,
      }),
    ).toBe(false);
  });

  test("falls back to editable native playlists for older payloads", () => {
    expect(canDeletePlaylist({ id: "native-playlist", editable: true })).toBe(true);
    expect(canDeletePlaylist({ id: "native-playlist", editable: false })).toBe(false);
    expect(canDeletePlaylist({ id: "native-playlist" })).toBe(false);
  });

  test("protects converted local folders when the server capability is absent", () => {
    expect(canDeletePlaylist({ id: "local-folder-music", editable: true })).toBe(false);
  });
});
