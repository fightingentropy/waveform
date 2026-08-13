import { describe, expect, test } from "bun:test";
import {
  isSpaceKey,
  shouldPreserveEditableShortcutTarget,
  shouldPreservePlaybackShortcutTarget,
  type PlaybackKeyTargetInfo,
} from "../src/lib/player-keyboard";

function target(partial: Partial<PlaybackKeyTargetInfo>): PlaybackKeyTargetInfo {
  return {
    isContentEditable: false,
    tagName: "DIV",
    inputType: null,
    ...partial,
  };
}

describe("isSpaceKey", () => {
  test("accepts Space code and legacy Spacebar key", () => {
    expect(isSpaceKey({ code: "Space", key: " " })).toBe(true);
    expect(isSpaceKey({ code: "KeyA", key: "Spacebar" })).toBe(true);
    expect(isSpaceKey({ code: "ArrowRight", key: "ArrowRight" })).toBe(false);
  });
});

describe("shouldPreservePlaybackShortcutTarget", () => {
  test("lets range inputs keep receiving space/arrows for seeking", () => {
    expect(shouldPreservePlaybackShortcutTarget(null)).toBe(false);
    expect(shouldPreservePlaybackShortcutTarget(target({}))).toBe(false);
    expect(shouldPreservePlaybackShortcutTarget(target({ tagName: "INPUT", inputType: "range" }))).toBe(false);
    expect(shouldPreservePlaybackShortcutTarget(target({ tagName: "INPUT", inputType: "text" }))).toBe(true);
    expect(shouldPreservePlaybackShortcutTarget(target({ tagName: "TEXTAREA" }))).toBe(true);
    expect(shouldPreservePlaybackShortcutTarget(target({ isContentEditable: true }))).toBe(true);
  });
});

describe("shouldPreserveEditableShortcutTarget", () => {
  test("keeps cmd-arrow caret movement in every input, including range", () => {
    expect(shouldPreserveEditableShortcutTarget(target({ tagName: "INPUT", inputType: "range" }))).toBe(true);
    expect(shouldPreserveEditableShortcutTarget(target({ tagName: "SELECT" }))).toBe(true);
    expect(shouldPreserveEditableShortcutTarget(target({}))).toBe(false);
  });
});
