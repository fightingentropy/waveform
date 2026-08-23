import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const replacements = [
  {
    before:
      "Arguments.fromBundle(musicService.tracks[index].originalItem)",
    after:
      "musicService.tracks[index].originalItem?.let { Arguments.fromBundle(it) }",
  },
  {
    before: `else Arguments.fromBundle(
                musicService.tracks[musicService.getCurrentTrackIndex()].originalItem
            )`,
    after: `else musicService.tracks[musicService.getCurrentTrackIndex()].originalItem
                ?.let { Arguments.fromBundle(it) }`,
  },
];

const mainScopeAnchor = "    private val scope = MainScope()";
const reactMethodLaunchHelper = `

    // React Native's TurboModule parser requires Promise-based @ReactMethod
    // functions to return JVM void. RNTP v4 exposes the Job returned by
    // scope.launch, which crashes module registration in Bridgeless mode.
    private fun launchReactMethod(block: suspend () -> Unit) {
        scope.launch { block() }
    }`;
const apiAnchor = "    /* ****************************** API ****************************** */";

function patchReactMethodLaunches(source) {
  const apiIndex = source.indexOf(apiAnchor);
  if (apiIndex < 0) {
    throw new Error(
      "react-native-track-player changed and the React Native 0.86 compatibility patch could not locate its Android API methods.",
    );
  }

  let prefix = source.slice(0, apiIndex);
  let api = source.slice(apiIndex);
  const legacyLaunchPattern = /=\s*scope\.launch\s*\{/g;
  const legacyLaunches = api.match(legacyLaunchPattern)?.length ?? 0;
  const patchedLaunches = api.match(/=\s*launchReactMethod\s*\{/g)?.length ?? 0;

  if (legacyLaunches === 0 && patchedLaunches === 0) {
    throw new Error(
      "react-native-track-player changed and no coroutine-backed Android @ReactMethod functions were found.",
    );
  }

  if (
    !prefix.includes(
      "private fun launchReactMethod(block: suspend () -> Unit)",
    )
  ) {
    if (!prefix.includes(mainScopeAnchor)) {
      throw new Error(
        "react-native-track-player changed and the Android MainScope anchor could not be found.",
      );
    }
    prefix = prefix.replace(
      mainScopeAnchor,
      `${mainScopeAnchor}${reactMethodLaunchHelper}`,
    );
  }

  api = api
    .replace(legacyLaunchPattern, "= launchReactMethod {")
    .replace(/return@launch(?!ReactMethod)/g, "return@launchReactMethod");

  return prefix + api;
}

export function patchTrackPlayerKotlin(source) {
  let patched = source;

  for (const { before, after } of replacements) {
    if (patched.includes(after)) continue;
    if (!patched.includes(before)) {
      throw new Error(
        "react-native-track-player changed and the React Native 0.86 compatibility patch could not be applied. " +
          "Check whether the installed version already handles nullable Track.originalItem bundles.",
      );
    }
    patched = patched.replace(before, after);
  }

  return patchReactMethodLaunches(patched);
}

export function patchTrackPlayerMusicServiceKotlin(source) {
  const legacyContext =
    "reactNativeHost.reactInstanceManager.currentReactContext";
  const legacyOccurrences = source.split(legacyContext).length - 1;
  const emitMethodsPresent =
    source.includes("private fun emit(") &&
    source.includes("private fun emitList(");

  if (!emitMethodsPresent) {
    throw new Error(
      "react-native-track-player changed and its Android event emitters could not be found.",
    );
  }
  if (legacyOccurrences !== 0 && legacyOccurrences !== 2) {
    throw new Error(
      "react-native-track-player changed and its Android React context bridge no longer matches the expected shape.",
    );
  }
  if (legacyOccurrences === 0 && !source.includes("reactContext\n")) {
    throw new Error(
      "react-native-track-player changed and its Bridgeless React context fix could not be verified.",
    );
  }

  return source.replaceAll(legacyContext, "reactContext");
}

function applyInstalledPackagePatch() {
  const packageRoot = path.dirname(
    fileURLToPath(import.meta.resolve("react-native-track-player/package.json")),
  );
  const sourcePath = path.join(
    packageRoot,
    "android",
    "src",
    "main",
    "java",
    "com",
    "doublesymmetry",
    "trackplayer",
    "module",
    "MusicModule.kt",
  );
  const servicePath = path.join(
    packageRoot,
    "android",
    "src",
    "main",
    "java",
    "com",
    "doublesymmetry",
    "trackplayer",
    "service",
    "MusicService.kt",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const serviceSource = fs.readFileSync(servicePath, "utf8");
  const patched = patchTrackPlayerKotlin(source);
  const patchedService = patchTrackPlayerMusicServiceKotlin(serviceSource);

  if (patched === source && patchedService === serviceSource) {
    process.stdout.write(
      "react-native-track-player already contains the React Native 0.86 Android compatibility fixes.\n",
    );
    return;
  }

  if (patched !== source) fs.writeFileSync(sourcePath, patched);
  if (patchedService !== serviceSource) {
    fs.writeFileSync(servicePath, patchedService);
  }
  process.stdout.write(
    "Applied the react-native-track-player React Native 0.86 Android compatibility fixes.\n",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  applyInstalledPackagePatch();
}
