import { describe, expect, test } from "bun:test";
import { isCurrentTrackEvent } from "../src/lib/native-audio-event";

describe("native audio event identity", () => {
  test("accepts an event for the current song on the active deck", () => {
    expect(
      isCurrentTrackEvent(
        { deck: "A", songId: "stay" },
        "A",
        "stay",
        "stay",
      ),
    ).toBe(true);
  });

  test("rejects a late event from the outgoing song after a direct selection", () => {
    expect(
      isCurrentTrackEvent(
        { deck: "A", songId: "old-queue-song" },
        "A",
        "stay",
        "stay",
      ),
    ).toBe(false);
  });

  test("rejects events without native song identity", () => {
    expect(isCurrentTrackEvent({ deck: "A" }, "A", "stay", "stay")).toBe(false);
  });
});
