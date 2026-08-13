import { describe, expect, test } from "bun:test";
import { updateLikedIdsInPayload, updateLikedSongsInPayload } from "../packages/shared/src/like-cache";

describe("updateLikedIdsInPayload", () => {
  test("adds and removes ids on both likedSongIds and likes", () => {
    const data = { likedSongIds: ["a"], likes: ["a"] };
    expect(updateLikedIdsInPayload(data, "b", true)).toBe(true);
    expect(data.likedSongIds).toEqual(["a", "b"]);
    expect(data.likes).toEqual(["a", "b"]);
    expect(updateLikedIdsInPayload(data, "a", false)).toBe(true);
    expect(data.likedSongIds).toEqual(["b"]);
    expect(data.likes).toEqual(["b"]);
  });

  test("is a no-op when the id is already in the requested state", () => {
    const data = { likedSongIds: ["a"] };
    expect(updateLikedIdsInPayload(data, "a", true)).toBe(false);
    expect(data.likedSongIds).toEqual(["a"]);
  });
});

describe("updateLikedSongsInPayload", () => {
  test("prepends a liked song and removes an unliked one", () => {
    const data = { songs: [{ id: "a" }] };
    expect(updateLikedSongsInPayload(data, { songId: "b", nextLiked: true, song: { id: "b" } })).toBe(true);
    expect(data.songs).toEqual([{ id: "b" }, { id: "a" }]);
    expect(updateLikedSongsInPayload(data, { songId: "a", nextLiked: false })).toBe(true);
    expect(data.songs).toEqual([{ id: "b" }]);
  });

  test("refuses to like without a song object", () => {
    const data = { songs: [{ id: "a" }] };
    expect(updateLikedSongsInPayload(data, { songId: "b", nextLiked: true })).toBe(false);
    expect(data.songs).toEqual([{ id: "a" }]);
  });
});
