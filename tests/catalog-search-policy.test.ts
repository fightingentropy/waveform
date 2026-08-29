import { describe, expect, test } from "bun:test";
import { apiReadTimeoutMs } from "../packages/shared/src/api-timeout-policy";
import {
  catalogSearchPath,
  catalogSearchSectionOrder,
} from "../packages/shared/src/catalog-search";
import { shouldIncludeYouTubePlaylistSearch } from "../src/worker/youtube-catalog";

describe("catalog search request policy", () => {
  test("keeps ordinary top and song searches on the Spotify fast path", () => {
    expect(catalogSearchPath("Summer You Were Mine", "top")).toBe(
      "/api/search/catalog?q=Summer%20You%20Were%20Mine",
    );
    expect(catalogSearchPath("Summer You Were Mine", "songs")).not.toContain("include=");
    expect(
      shouldIncludeYouTubePlaylistSearch(
        new URL(catalogSearchPath("Summer You Were Mine", "top"), "https://music.test").searchParams,
      ),
    ).toBe(false);
  });

  test("requests YouTube only for the dedicated playlists filter", () => {
    const path = catalogSearchPath("Summer You Were Mine", "playlists");
    expect(path).toBe(
      "/api/search/catalog?q=Summer%20You%20Were%20Mine&include=youtube-playlists",
    );
    expect(
      shouldIncludeYouTubePlaylistSearch(new URL(path, "https://music.test").searchParams),
    ).toBe(true);
  });

  test("puts songs before secondary entities in Top results", () => {
    expect(catalogSearchSectionOrder("top")).toEqual(["songs", "artists", "playlists"]);
    expect(catalogSearchSectionOrder("playlists")).toEqual(["playlists"]);
  });

  test("gives the shared catalog fast path a provider-aware client timeout", () => {
    expect(apiReadTimeoutMs(catalogSearchPath("Summer You Were Mine", "top"))).toBe(9_000);
    expect(apiReadTimeoutMs("/api/library")).toBe(5_000);
  });
});
