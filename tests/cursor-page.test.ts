import { describe, expect, test } from "bun:test";
import {
  decodeOffsetCursor,
  decodeOrderIdCursor,
  decodeTitleIdCursor,
  decodeCreatedAtIdCursor,
  encodeOffsetCursor,
  encodeOrderIdCursor,
  encodeTitleIdCursor,
  encodeCreatedAtIdCursor,
  parsePageLimit,
  slicePage,
  wantsLibraryPage,
} from "../packages/shared/src/cursor-page";

describe("parsePageLimit", () => {
  test("clamps to the max and falls back for junk", () => {
    expect(parsePageLimit("50")).toBe(50);
    expect(parsePageLimit("99999")).toBe(5_000);
    expect(parsePageLimit("nope", 200)).toBe(200);
    expect(parsePageLimit("-1", 200)).toBe(200);
  });
});

describe("title/id cursors", () => {
  test("round-trip and reject truncated values", () => {
    const encoded = encodeTitleIdCursor("Helix", "song-1");
    expect(decodeTitleIdCursor(encoded)).toEqual({ title: "Helix", id: "song-1" });
    expect(decodeTitleIdCursor("%%%")).toBeNull();
  });
});

describe("order/id cursors", () => {
  test("round-trip playlist positions and reject junk", () => {
    const encoded = encodeOrderIdCursor(12, "song-9");
    expect(decodeOrderIdCursor(encoded)).toEqual({ order: 12, id: "song-9" });
    expect(decodeOrderIdCursor(encodeTitleIdCursor("Helix", "song-1"))).toBeNull();
    expect(decodeOrderIdCursor("%%%")).toBeNull();
  });
});

describe("createdAt/id cursors", () => {
  test("round-trip search-index keyset values and reject other cursor shapes", () => {
    const encoded = encodeCreatedAtIdCursor("2026-08-12T12:00:00.000Z", "song-3");
    expect(decodeCreatedAtIdCursor(encoded)).toEqual({
      createdAt: "2026-08-12T12:00:00.000Z",
      id: "song-3",
    });
    expect(decodeCreatedAtIdCursor(encodeTitleIdCursor("Helix", "song-1"))).toBeNull();
    expect(decodeCreatedAtIdCursor("%%%")).toBeNull();
  });
});

describe("offset pages", () => {
  test("returns the next cursor only while items remain", () => {
    expect(wantsLibraryPage(new URLSearchParams("limit=2"))).toBe(true);
    expect(wantsLibraryPage(new URLSearchParams())).toBe(false);
    expect(slicePage(["a", "b", "c"], decodeOffsetCursor(encodeOffsetCursor(0)) ?? 0, 2)).toEqual({
      items: ["a", "b"],
      nextCursor: "2",
    });
    expect(slicePage(["a", "b", "c"], 2, 2)).toEqual({
      items: ["c"],
      nextCursor: null,
    });
  });
});
