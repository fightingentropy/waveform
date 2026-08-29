import { describe, expect, test } from "bun:test";
import {
  publishApiCacheUpdate,
  subscribeApiCacheUpdate,
} from "../packages/shared/src/api-cache-updates";

describe("API cache update channel", () => {
  test("publishes new cache data only to consumers of the matching URL", () => {
    const likedUpdates: unknown[] = [];
    const homeUpdates: unknown[] = [];
    const unsubscribeLiked = subscribeApiCacheUpdate("/api/liked?account=user-a", (data) => {
      likedUpdates.push(data);
    });
    const unsubscribeHome = subscribeApiCacheUpdate("/api/home?account=user-a", (data) => {
      homeUpdates.push(data);
    });

    const payload = { songs: [{ id: "song-1" }], likedSongIds: ["song-1"] };
    publishApiCacheUpdate("/api/liked?account=user-a", payload);

    expect(likedUpdates).toEqual([payload]);
    expect(homeUpdates).toEqual([]);
    unsubscribeLiked();
    unsubscribeHome();
  });

  test("stops updating a consumer after it unsubscribes", () => {
    const updates: unknown[] = [];
    const unsubscribe = subscribeApiCacheUpdate("/api/liked", (data) => updates.push(data));

    publishApiCacheUpdate("/api/liked", { songs: [{ id: "first" }] });
    unsubscribe();
    publishApiCacheUpdate("/api/liked", { songs: [{ id: "second" }] });

    expect(updates).toEqual([{ songs: [{ id: "first" }] }]);
  });

  test("continues notifying consumers when another listener throws", () => {
    const updates: unknown[] = [];
    const unsubscribeBroken = subscribeApiCacheUpdate("/api/liked", () => {
      throw new Error("stale listener");
    });
    const unsubscribeHealthy = subscribeApiCacheUpdate("/api/liked", (data) => updates.push(data));

    publishApiCacheUpdate("/api/liked", { songs: [] });

    expect(updates).toEqual([{ songs: [] }]);
    unsubscribeBroken();
    unsubscribeHealthy();
  });
});
