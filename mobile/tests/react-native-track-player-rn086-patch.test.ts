import { describe, expect, test } from "bun:test";
import { patchTrackPlayerKotlin } from "../scripts/patch-react-native-track-player-rn086.mjs";

const trackPlayerSource = `
fun getTrack(index: Int, callback: Promise) {
    callback.resolve(Arguments.fromBundle(musicService.tracks[index].originalItem))
}

fun getActiveTrack(callback: Promise) {
    callback.resolve(
        if (musicService.tracks.isEmpty()) null
        else Arguments.fromBundle(
                musicService.tracks[musicService.getCurrentTrackIndex()].originalItem
            )
    )
}
`;

describe("react-native-track-player React Native 0.86 patch", () => {
  test("preserves nullable native track bundles instead of passing them to fromBundle", () => {
    const patched = patchTrackPlayerKotlin(trackPlayerSource);

    expect(patched).toContain(
      "originalItem?.let { Arguments.fromBundle(it) }",
    );
    expect(patched).toContain(
      "originalItem\n                ?.let { Arguments.fromBundle(it) }",
    );
    expect(patched).not.toContain(
      "Arguments.fromBundle(musicService.tracks[index].originalItem)",
    );
  });

  test("is idempotent", () => {
    const patched = patchTrackPlayerKotlin(trackPlayerSource);
    expect(patchTrackPlayerKotlin(patched)).toBe(patched);
  });

  test("fails closed when the upstream Kotlin source changes", () => {
    expect(() => patchTrackPlayerKotlin("class MusicModule")).toThrow(
      "react-native-track-player changed",
    );
  });
});
