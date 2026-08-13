import { describe, expect, test } from "bun:test";
import {
  isAllowedLocalMediaRelativePath,
  isSafeRelativeFileName,
  normalizeLibraryRelativePath,
} from "../src/lib/local-media-path";

function catalog(paths: string[]): Map<string, true> {
  return new Map(paths.map((path) => [path, true] as const));
}

describe("normalizeLibraryRelativePath", () => {
  test("accepts nested posix paths and strips empty segments", () => {
    expect(normalizeLibraryRelativePath("Album/track.flac")).toBe("Album/track.flac");
    expect(normalizeLibraryRelativePath("/Album//track.flac/")).toBe("Album/track.flac");
  });

  test("rejects traversal, NUL, and empty input", () => {
    expect(normalizeLibraryRelativePath("")).toBeNull();
    expect(normalizeLibraryRelativePath(".")).toBeNull();
    expect(normalizeLibraryRelativePath("Album/../secret.env")).toBeNull();
    expect(normalizeLibraryRelativePath("Album/./track.flac")).toBeNull();
    expect(normalizeLibraryRelativePath("Album\\..\\secret.env")).toBeNull();
    expect(normalizeLibraryRelativePath("Album/\0track.flac")).toBeNull();
  });
});

describe("isSafeRelativeFileName", () => {
  test("allows a single cache file name", () => {
    expect(isSafeRelativeFileName("song-id.jpg")).toBe(true);
  });

  test("rejects nested or traversing names", () => {
    expect(isSafeRelativeFileName("../song-id.jpg")).toBe(false);
    expect(isSafeRelativeFileName("nested/song-id.jpg")).toBe(false);
    expect(isSafeRelativeFileName("")).toBe(false);
  });
});

describe("isAllowedLocalMediaRelativePath", () => {
  const songs = catalog(["Album/track.flac", "root-song.mp3"]);

  test("allows catalogued audio", () => {
    expect(isAllowedLocalMediaRelativePath("Album/track.flac", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("root-song.mp3", songs)).toBe(true);
  });

  test("allows image, lyrics, and json sidecars in a catalogued audio directory", () => {
    expect(isAllowedLocalMediaRelativePath("Album/track.cover.jpg", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("Album/track.lrc", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("Album/track.lyrics.txt", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("Album/track.spotify.json", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("Album/cover.webp", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("Album/folder.png", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("Album/unrelated.jpg", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("root-song.cover.jpeg", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath("cover.jpg", songs)).toBe(true);
  });

  test("rejects files that are not catalogued audio or their sidecars", () => {
    expect(isAllowedLocalMediaRelativePath("Album/secret.env", songs)).toBe(false);
    expect(isAllowedLocalMediaRelativePath("Album/notes.md", songs)).toBe(false);
    expect(isAllowedLocalMediaRelativePath("Other/track.flac", songs)).toBe(false);
    expect(isAllowedLocalMediaRelativePath("Other/cover.jpg", songs)).toBe(false);
  });

  test("allows discover staging media and rejects other hidden paths", () => {
    expect(isAllowedLocalMediaRelativePath(".discover/abc123/Artist - Title.flac", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath(".discover/abc123/Artist - Title.cover.jpg", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath(".discover/abc123/Artist - Title.spotify.json", songs)).toBe(true);
    expect(isAllowedLocalMediaRelativePath(".discover/abc123/secret.env", songs)).toBe(false);
    expect(isAllowedLocalMediaRelativePath(".discover/abc123/nested/track.flac", songs)).toBe(false);
    expect(isAllowedLocalMediaRelativePath(".discover/track.flac", songs)).toBe(false);
    expect(isAllowedLocalMediaRelativePath(".ssh/id_rsa", songs)).toBe(false);
  });

  test("rejects traversal even when the catalog contains the target name", () => {
    expect(isAllowedLocalMediaRelativePath("../Album/track.flac", songs)).toBe(false);
    expect(isAllowedLocalMediaRelativePath("Album/../../.env", songs)).toBe(false);
  });
});
