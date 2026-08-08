import { describe, expect, test } from "bun:test";
import { stableArtworkCacheKey } from "../src/lib/artwork-cache";

describe("artwork disk-cache identity", () => {
  test("ignores rotating private-media signature parameters", () => {
    const first =
      "/api/artwork/local/song-1?spotify_user=user-1&spotify_scope=user&spotify_exp=100&spotify_sig=aaa";
    const refreshed =
      "/api/artwork/local/song-1?spotify_user=user-1&spotify_scope=user&spotify_exp=200&spotify_sig=bbb";

    expect(stableArtworkCacheKey(first)).toBe(
      "/api/artwork/local/song-1?spotify_user=user-1&spotify_scope=user",
    );
    expect(stableArtworkCacheKey(refreshed)).toBe(stableArtworkCacheKey(first));
  });

  test("keeps non-auth artwork parameters and external URLs distinct", () => {
    const signed =
      "https://music.example/api/artwork/local/song-1?w=320&spotify_exp=200&spotify_sig=bbb";
    expect(stableArtworkCacheKey(signed)).toBe(
      "https://music.example/api/artwork/local/song-1?w=320",
    );
    expect(stableArtworkCacheKey("https://cdn.example/cover.jpg?v=1")).toBe(
      "https://cdn.example/cover.jpg?v=1",
    );
  });
});
