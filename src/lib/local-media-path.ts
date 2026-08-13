export const LOCAL_AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

export const LOCAL_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
export const LOCAL_LYRICS_EXTENSIONS = new Set([".lrc", ".txt"]);
export const LOCAL_MEDIA_DISCOVER_DIRNAME = ".discover";
export const LOCAL_MEDIA_SIDECAR_JSON_SUFFIX = ".spotify.json";

type CataloguedAudioPaths = {
  has(path: string): boolean;
  keys(): IterableIterator<string>;
};

function extensionOf(relativePath: string): string {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function fileNameOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

function directoryOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

function isMediaOrSidecarFile(relativePath: string): boolean {
  const base = fileNameOf(relativePath).toLowerCase();
  if (base.endsWith(LOCAL_MEDIA_SIDECAR_JSON_SUFFIX)) return true;
  const extension = extensionOf(relativePath);
  return (
    LOCAL_AUDIO_EXTENSIONS.has(extension) ||
    LOCAL_IMAGE_EXTENSIONS.has(extension) ||
    LOCAL_LYRICS_EXTENSIONS.has(extension)
  );
}

/**
 * Discover staging lives at `.discover/<trackId>/<file>` and is skipped by the
 * library scan, so it is never in `entriesByPath`. Playback still streams those
 * files through `/api/files/local/`.
 */
function isDiscoverStagingPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.length !== 3 || parts[0] !== LOCAL_MEDIA_DISCOVER_DIRNAME) return false;
  const trackId = parts[1];
  if (!trackId || trackId === "." || trackId === "..") return false;
  return isMediaOrSidecarFile(relativePath);
}

function isSidecarNextToCataloguedAudio(
  relativePath: string,
  cataloguedAudioPaths: CataloguedAudioPaths,
): boolean {
  if (!isMediaOrSidecarFile(relativePath)) return false;
  if (LOCAL_AUDIO_EXTENSIONS.has(extensionOf(relativePath))) return false;

  const directory = directoryOf(relativePath);
  for (const audioPath of cataloguedAudioPaths.keys()) {
    if (directoryOf(audioPath) === directory) return true;
  }
  return false;
}

/**
 * Rejects empty paths, NUL bytes, `.` / `..` segments, and backslash escapes.
 * Returns a `/`-joined relative path or null.
 */
export function normalizeLibraryRelativePath(relativePath: string): string | null {
  if (!relativePath || relativePath.includes("\0")) return null;
  const parts = relativePath.split(/[/\\]+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

/** True when `fileName` is a single path segment with no traversal. */
export function isSafeRelativeFileName(fileName: string): boolean {
  const normalized = normalizeLibraryRelativePath(fileName);
  return normalized !== null && normalized === fileName && !normalized.includes("/");
}

/**
 * Whether a path under a music root may be served as local media.
 *
 * Catalogued audio files are allowed. Covers, lyrics, and `.spotify.json`
 * sidecars are allowed only next to a catalogued audio file. Discover staging
 * under `.discover/<id>/` is allowed because those files are intentionally
 * omitted from the library scan.
 */
export function isAllowedLocalMediaRelativePath(
  relativePath: string,
  cataloguedAudioPaths: CataloguedAudioPaths,
): boolean {
  const normalized = normalizeLibraryRelativePath(relativePath);
  if (!normalized) return false;
  if (isDiscoverStagingPath(normalized)) return true;
  if (cataloguedAudioPaths.has(normalized)) return true;
  return isSidecarNextToCataloguedAudio(normalized, cataloguedAudioPaths);
}
