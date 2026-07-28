import { describe, expect, test } from "bun:test";
import { planOfflineAccountDeletion } from "../src/lib/account-deletion-policy";

describe("local account deletion cleanup", () => {
  test("removes only the deleted account and preserves shared song bytes for another account", () => {
    const accountAOnly = { accountScope: "account-a", songId: "song-a" };
    const sharedByA = { accountScope: "account-a", songId: "shared-song" };
    const sharedByB = { accountScope: "account-b", songId: "shared-song" };
    const accountBOnly = { accountScope: "account-b", songId: "song-b" };

    const plan = planOfflineAccountDeletion(
      [accountAOnly, sharedByA, sharedByB, accountBOnly],
      "account-a",
    );

    expect(plan.deleting).toEqual([accountAOnly, sharedByA]);
    expect(plan.retainedSongIds.has("shared-song")).toBe(true);
    expect(plan.retainedSongIds.has("song-a")).toBe(false);
    expect(plan.retainedSongIds.has("song-b")).toBe(true);
  });
});
