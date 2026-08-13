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

  return patched;
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
  const source = fs.readFileSync(sourcePath, "utf8");
  const patched = patchTrackPlayerKotlin(source);

  if (patched === source) {
    process.stdout.write(
      "react-native-track-player already contains the React Native 0.86 nullable-bundle fix.\n",
    );
    return;
  }

  fs.writeFileSync(sourcePath, patched);
  process.stdout.write(
    "Applied the react-native-track-player React Native 0.86 nullable-bundle fix.\n",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  applyInstalledPackagePatch();
}
