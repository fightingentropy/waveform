import { describe, expect, test } from "bun:test";
import { formatPlaybackRate, nextPlaybackRate, PLAYBACK_RATE_CYCLE } from "../packages/shared/src/playback-rate";

describe("nextPlaybackRate", () => {
  test("cycles through the podcast speed chip order", () => {
    const seen = [PLAYBACK_RATE_CYCLE[0]];
    let rate = PLAYBACK_RATE_CYCLE[0];
    for (let i = 0; i < PLAYBACK_RATE_CYCLE.length; i += 1) {
      rate = nextPlaybackRate(rate);
      seen.push(rate);
    }
    expect(seen).toEqual([...PLAYBACK_RATE_CYCLE, PLAYBACK_RATE_CYCLE[0]]);
  });

  test("unknown rates restart at 1×", () => {
    expect(nextPlaybackRate(3)).toBe(1);
  });
});

describe("formatPlaybackRate", () => {
  test("appends the multiplication sign", () => {
    expect(formatPlaybackRate(1.25)).toBe("1.25×");
  });
});
