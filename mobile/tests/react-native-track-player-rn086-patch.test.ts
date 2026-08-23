import { describe, expect, test } from "bun:test";
import {
  patchTrackPlayerKotlin,
  patchTrackPlayerMusicServiceKotlin,
} from "../scripts/patch-react-native-track-player-rn086.mjs";

const trackPlayerSource = `
class MusicModule {
    private val scope = MainScope()

    /* ****************************** API ****************************** */
    @ReactMethod
    fun add(data: ReadableArray?, callback: Promise) = scope.launch {
        if (data == null) return@launch
        callback.resolve(null)
    }

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
}
`;

const musicServiceSource = `
private fun emit(event: String, data: Bundle? = null) {
    reactNativeHost.reactInstanceManager.currentReactContext
        ?.emit(event, data)
}

private fun emitList(event: String, data: List<Bundle> = emptyList()) {
    reactNativeHost.reactInstanceManager.currentReactContext
        ?.emit(event, data)
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

  test("makes coroutine-backed React methods return JVM void for TurboModules", () => {
    const patched = patchTrackPlayerKotlin(trackPlayerSource);

    expect(patched).toContain(
      "private fun launchReactMethod(block: suspend () -> Unit)",
    );
    expect(patched).toContain(
      "fun add(data: ReadableArray?, callback: Promise) = launchReactMethod {",
    );
    expect(patched).toContain("return@launchReactMethod");
    expect(patched).not.toContain("= scope.launch {");
  });

  test("uses the Bridgeless-aware React context for native playback events", () => {
    const patched = patchTrackPlayerMusicServiceKotlin(musicServiceSource);

    expect(patched.match(/ {4}reactContext\n/g)).toHaveLength(2);
    expect(patched).not.toContain(
      "reactNativeHost.reactInstanceManager.currentReactContext",
    );
    expect(patchTrackPlayerMusicServiceKotlin(patched)).toBe(patched);
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
