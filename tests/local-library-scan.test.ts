import { describe, expect, test } from "bun:test";
import { encodeRelativePath, stableSongId, titleFromFileName } from "../src/server/local-library-scan";

describe("local library scan helpers", () => {
  test("stableSongId is path-derived and prefix-stable", () => {
    expect(stableSongId("Artist/Album/Track.flac")).toMatch(/^local-server:[0-9a-f]{24}$/);
    expect(stableSongId("Artist/Album/Track.flac")).toBe(stableSongId("Artist/Album/Track.flac"));
    expect(stableSongId("Artist/Album/Track.flac")).not.toBe(stableSongId("Artist/Album/Other.flac"));
  });

  test("titleFromFileName splits artist suffix and falls back", () => {
    expect(titleFromFileName("Helix - Justice.flac")).toEqual({ title: "Helix", artist: "Justice" });
    expect(titleFromFileName("Untitled.mp3")).toEqual({ title: "Untitled", artist: "Unknown Artist" });
  });

  test("encodeRelativePath percent-encodes each segment", () => {
    expect(encodeRelativePath("Artist Name/Track 1.flac")).toBe("Artist%20Name/Track%201.flac");
  });
});
