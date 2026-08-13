import { describe, expect, test } from "bun:test";
import {
  escapeLikePattern,
  normalizeLibrarySearchQuery,
  songMatchesLibraryQuery,
} from "../packages/shared/src/library-search";

describe("library search query matching", () => {
  test("matches title or artist case-insensitively", () => {
    const song = { title: "Helix", artist: "Justice" };
    expect(songMatchesLibraryQuery(song, "hel")).toBe(true);
    expect(songMatchesLibraryQuery(song, "JUST")).toBe(true);
    expect(songMatchesLibraryQuery(song, "nope")).toBe(false);
  });

  test("an empty query matches every song", () => {
    expect(songMatchesLibraryQuery({ title: "A", artist: "B" }, "   ")).toBe(true);
  });

  test("escapes LIKE wildcards in user input", () => {
    expect(escapeLikePattern("100%_real\\x")).toBe("100\\%\\_real\\\\x");
    expect(normalizeLibrarySearchQuery("  Helix  ")).toBe("helix");
  });
});
