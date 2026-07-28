import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import {
  LicensedSourceDownloadError,
  materializeLicensedSourceStream,
  type LicensedSourceStream,
} from "../lib/licensed-source-download";
import { maybeDecryptDeezerBuffer, resolveDeezerDecryptionId } from "../lib/deezer-decrypt";
import {
  RemoteUrlError,
  fetchPublicHttpUrl,
} from "../lib/safe-fetch";
import type { PlayerSong } from "../types/player";
import {
  DEFAULT_YOUTUBE_PREVIEW_CONFIG,
  downloadYouTubePreviewAudioResilient,
  fetchYouTubeMusicPlaylist,
  normalizeYouTubePlaylistSearchQuery,
  resolveYouTubePreviewMatch,
  searchYouTubePlaylists,
  type YouTubePlaylistSearchResult,
  type YouTubePreviewConfig,
} from "./youtube-preview";
import {
  allowsImplicitLocalAccess,
  requestRequiresProxyToken,
} from "./local-access";

const execFileAsync = promisify(execFile);

type LocalSongEntry = {
  song: PlayerSong;
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  // Inode identity. Two entries with the same (dev, ino) are hard links to ONE
  // physical file — the guaranteed-safe signal that they are the same song
  // (different rips never share an inode). Drives canonical-id assignment.
  ino: number;
  dev: number;
};

type LibrarySnapshot = {
  songs: PlayerSong[];
  entriesById: Map<string, LocalSongEntry>;
  entriesByPath: Map<string, LocalSongEntry>;
  scannedAt: number;
};

type LibrarySource = {
  key: string;
  root: string;
  cachePath: string;
  artworkDir: string;
  shared: boolean;
};

type RequestUserIdentity = {
  id: string;
  email: string | null;
  name: string | null;
  local: boolean;
};

type PersistentSongCache = {
  version: number;
  root: string;
  entries: Record<
    string,
    {
      size: number;
      mtimeMs: number;
      sidecarMtimeMs?: number;
      // Persisted so the cached-snapshot path can regroup by inode without a
      // re-stat. Optional for forward-compat; the v4 bump guarantees presence.
      ino?: number;
      dev?: number;
      song: PlayerSong;
    }
  >;
};

type PersistentLikesCache = {
  version: 1;
  root: string;
  likedSongIds: string[];
  // id -> epoch ms when the song was liked. Optional + additive: legacy caches
  // (and the 1358 likes that predate this) simply omit it, and those fall back to
  // file createdAt for ordering. NEW likes get a real timestamp so "Liked Songs"
  // can show most-recently-liked first (like Spotify's "Recently added"), instead
  // of library scan order where a song sat at the top forever. Version stays 1 on
  // purpose — bumping it would invalidate the existing cache and trip the
  // "everything is liked" legacy backfill, nuking real unlikes.
  likedAt?: Record<string, number>;
};

type LocalSidecar = {
  version?: number;
  title?: string;
  artist?: string;
  album?: string;
  coverFile?: string;
  lyricsFile?: string;
  updatedAt?: string;
  // Pins the song's id independent of its file path. Written by the YouTube
  // refetch flow so replacing a wrong-version .flac with the correct .opus keeps
  // the same id — the owner's like (mini-side) and any playlist rows reference
  // the id, so a path-derived id change would orphan them. See songFromFile.
  songId?: string;
};

type KnownFileStat = {
  size: number;
  mtimeMs: number;
};

type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";

const AUDIO_EXTENSIONS = new Set([
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

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const LYRICS_EXTENSIONS = new Set([".lrc", ".txt"]);
// v3: forces a one-time full rescan so cover/lyrics sidecars created by the
// backfill scripts get discovered (cached entries only re-check the audio
// file and its .spotify.json mtimes, not newly-appearing sidecar files).
// v4: persists (ino, dev) per entry so content-canonical ids can be assigned
// from the cached-snapshot path without re-statting every file.
const SCAN_CACHE_VERSION = 4;
const LIKES_CACHE_VERSION = 1;
const ARTWORK_CACHE_VERSION = 2;
const LOCAL_USER = {
  id: "local-mac-mini",
  email: "erlin@spotify.local",
  name: "Erlin",
  image: "/profile.jpg",
};
const PROXY_USER_ID_HEADER = "x-spotify-user-id";
const PROXY_USER_EMAIL_HEADER = "x-spotify-user-email";
const PROXY_USER_NAME_HEADER = "x-spotify-user-name";
const MEDIA_USER_SEARCH_PARAM = "spotify_user";
const MEDIA_SCOPE_SEARCH_PARAM = "spotify_scope";
const MEDIA_EXPIRY_SEARCH_PARAM = "spotify_exp";
const MEDIA_SIGNATURE_SEARCH_PARAM = "spotify_sig";
const MEDIA_SIGNATURE_TTL_SECONDS = 24 * 60 * 60;

const cwd = process.cwd();
const defaultDistDir = existsSync(resolve(cwd, "dist/client"))
  ? resolve(cwd, "dist/client")
  : resolve(cwd, "dist");
const distDir = resolve(process.env.SPOTIFY_DIST_DIR || defaultDistDir);
const musicRoot = resolve(process.env.SPOTIFY_MUSIC_DIR || resolve(homedir(), "Music"));
const cacheDir = resolve(process.env.SPOTIFY_CACHE_DIR || resolve(cwd, "cache"));
const profileImageDir = resolve(cacheDir, "profile");
const userMusicRoot = resolve(process.env.SPOTIFY_USER_MUSIC_DIR || resolve(cacheDir, "user-music"));
const libraryCachePath = resolve(
  process.env.SPOTIFY_LIBRARY_CACHE || resolve(cacheDir, "local-music-library.json"),
);
const artworkCacheDir = resolve(process.env.SPOTIFY_ARTWORK_CACHE_DIR || resolve(cacheDir, "artwork"));
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "5174");
const scanTtlMs = Math.max(1_000, Number(process.env.SPOTIFY_SCAN_TTL_MS || "30000"));
const configuredIdleTimeoutSeconds = Number(process.env.SPOTIFY_IDLE_TIMEOUT_SECONDS || "120");
const idleTimeoutSeconds = Number.isFinite(configuredIdleTimeoutSeconds)
  ? Math.max(30, configuredIdleTimeoutSeconds)
  : 120;
const remoteArtworkLookupEnabled = process.env.SPOTIFY_ARTWORK_LOOKUP !== "0";
const artworkLookupCountry = process.env.SPOTIFY_ARTWORK_COUNTRY || "GB";
const proxyToken = process.env.SPOTIFY_PROXY_TOKEN || "";
const trustLocalNetwork = process.env.SPOTIFY_TRUST_LOCAL_NETWORK === "1";
const proxyHostnames = new Set(
  (process.env.SPOTIFY_PROXY_HOSTNAMES || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const libraryOwnerUserIds = parseEnvList(process.env.SPOTIFY_LIBRARY_OWNER_USER_IDS || "");
const libraryOwnerEmails = parseEnvList(process.env.SPOTIFY_LIBRARY_OWNER_EMAILS || "");

function localProfileImageUrl(): string {
  for (const ext of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
    const fileName = `local-user-profile${ext}`;
    if (existsSync(resolve(profileImageDir, fileName))) return `/api/profile/image/${fileName}`;
  }
  return LOCAL_USER.image;
}

function localUser() {
  return {
    ...LOCAL_USER,
    image: localProfileImageUrl(),
  };
}
const SERVER_IMPORT_OUTPUT_FORMAT: OutputFormat = "flac";
const OUTPUT_FORMATS = new Set<OutputFormat>(["flac", "mp3", "aac", "ogg", "opus", "wav"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_LYRICS_BYTES = 2 * 1024 * 1024;

let librarySnapshot: LibrarySnapshot | null = null;
let scanPromise: Promise<LibrarySnapshot> | null = null;
const userLibrarySnapshots = new Map<string, LibrarySnapshot>();
const userScanPromises = new Map<string, Promise<LibrarySnapshot>>();
// Serializes likes read-modify-write per source so concurrent toggles don't
// lose updates (last-writer-wins). Keyed by source.key.
const likeWriteChains = new Map<string, Promise<unknown>>();
// Tracks sources whose one-time legacy-likes backfill has already been
// attempted this process, so side-effect-free GETs never re-run the migration.
const likesBackfilled = new Set<string>();

function json(payload: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function ifNoneMatchMatches(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === "*" || item === etag);
}

function jsonCached(
  request: Request,
  payload: unknown,
  init?: ResponseInit & { cacheControl?: string },
): Response {
  const { cacheControl, ...responseInit } = init ?? {};
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash("sha1").update(body).digest("hex").slice(0, 32)}"`;
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cacheControl || "private, max-age=30, stale-while-revalidate=300");
  headers.set("etag", etag);

  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { ...responseInit, headers });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeIdentityValue(value: string): string {
  return value.trim().toLowerCase();
}

function parseEnvList(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map(normalizeIdentityValue)
      .filter(Boolean),
  );
}

function listMatchesValue(list: Set<string>, value: string | null | undefined): boolean {
  if (list.has("*")) return true;
  if (!value) return false;
  return list.has(normalizeIdentityValue(value));
}

function stableUserDigest(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

function sharedLibrarySource(): LibrarySource {
  return {
    key: "shared",
    root: musicRoot,
    cachePath: libraryCachePath,
    artworkDir: artworkCacheDir,
    shared: true,
  };
}

function userLibrarySource(userId: string): LibrarySource {
  const digest = stableUserDigest(userId);
  const base = resolve(userMusicRoot, digest);
  return {
    key: `user:${digest}`,
    root: resolve(base, "music"),
    cachePath: resolve(base, "local-music-library.json"),
    artworkDir: resolve(base, "artwork"),
    shared: false,
  };
}

function notFound(message = "Not found"): Response {
  return json({ error: message }, { status: 404 });
}

function requestHostname(request: Request): string {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return (request.headers.get("host") || "").split(":")[0]?.toLowerCase() || "";
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// The real peer (socket) address as reported by Bun's server.requestIP(), keyed
// by the Request object so the trust check can consult it without threading the
// server through every helper signature. Populated by the fetch handler.
const requestPeerAddresses = new WeakMap<Request, string | null>();

function rememberRequestPeer(request: Request, address: string | null): void {
  requestPeerAddresses.set(request, address);
}

function hasValidProxyToken(request: Request): boolean {
  const token = request.headers.get("x-spotify-proxy-token") || "";
  return Boolean(proxyToken && timingSafeEqualStr(token, proxyToken));
}

function requestNeedsProxyToken(request: Request): boolean {
  return requestRequiresProxyToken({
    hostname: requestHostname(request),
    proxyHostnames,
    trustLocalNetwork,
  });
}

function allowsImplicitLocalUser(request: Request): boolean {
  return allowsImplicitLocalAccess({
    hostname: requestHostname(request),
    peerAddress: requestPeerAddresses.get(request),
    trustLocalNetwork,
  });
}

function isMutationRequest(request: Request): boolean {
  const method = request.method.toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function authorizeMutationRequest(request: Request): Response | null {
  if (!isMutationRequest(request)) return null;
  if (hasValidProxyToken(request) || allowsImplicitLocalUser(request)) return null;
  return json({ error: "Unauthorized" }, { status: 401 });
}

function methodNotAllowed(): Response {
  return json({ error: "Method not allowed" }, { status: 405 });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeRelativePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function resolveInside(root: string, relativePath: string): string | null {
  const normalized = relativePath.split("/").filter(Boolean).join("/");
  if (!normalized || normalized.includes("\0")) return null;
  const absolutePath = resolve(root, normalized);
  return isPathInside(root, absolutePath) ? absolutePath : null;
}

// Lexical containment (resolveInside) doesn't dereference symlinks, so a symlink
// planted inside the root could point outside it. For paths we actually serve to
// clients, realpath() both the root and the target and re-check containment so a
// symlink can't escape the library directory. Returns null if the path doesn't
// resolve (e.g. doesn't exist) or escapes the root.
async function resolveInsideReal(root: string, relativePath: string): Promise<string | null> {
  const absolutePath = resolveInside(root, relativePath);
  if (!absolutePath) return null;
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(absolutePath)]);
    return isPathInside(realRoot, realPath) ? absolutePath : null;
  } catch {
    return null;
  }
}

function relativeFromUrlPath(pathname: string, prefix: string): string {
  return pathname
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map(safeDecode)
    .join("/");
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".oga":
    case ".ogg":
      return "audio/ogg";
    case ".opus":
      return "audio/opus";
    case ".wav":
      return "audio/wav";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".webmanifest":
      return "application/json; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".lrc":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

type ParsedRange = { start: number; end: number } | "unsatisfiable" | null;

// Returns a satisfiable byte range, "unsatisfiable" when the Range header is
// well-formed `bytes=` syntax that cannot be satisfied (so the caller should
// answer 416), or null when there is no Range header / the header is malformed
// and should simply be ignored (RFC 7233 §3.1).
function parseRangeHeader(rangeHeader: string | null, size: number): ParsedRange {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=") || size <= 0) return null;
  const value = rangeHeader.slice("bytes=".length).trim();
  if (!value || value.includes(",")) return null;
  const dash = value.indexOf("-");
  if (dash < 0) return null;

  const startRaw = value.slice(0, dash);
  const endRaw = value.slice(dash + 1);
  if (!startRaw) {
    if (!/^\d+$/.test(endRaw)) return null;
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength)) return null;
    if (suffixLength <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  if (!/^\d+$/.test(startRaw)) return null;
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return null;
  if (start >= size) return "unsatisfiable";
  if (endRaw && !/^\d+$/.test(endRaw)) return null;
  let end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isFinite(end)) return null;
  if (end < start) return "unsatisfiable";
  if (end >= size) end = size - 1;
  return { start, end };
}

async function serveFile(
  path: string,
  request: Request,
  cacheControl = "public, max-age=3600",
  knownFileStat?: KnownFileStat,
): Promise<Response> {
  // Always stat() for the byte math. A stat is cheap relative to streaming the
  // file, and using a stale `knownFileStat` size/mtime for Content-Length /
  // Content-Range / etag while streaming the CURRENT bytes (Bun.file below)
  // corrupts range responses and 304s when a file is overwritten in place
  // within the scan TTL. `knownFileStat` is intentionally ignored here so the
  // headers always reflect the on-disk file we actually serve; the parameter is
  // kept for call-site compatibility.
  void knownFileStat;
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    return notFound();
  }
  if (!fileStat.isFile()) return notFound();
  const size = fileStat.size;
  const mtimeMs = fileStat.mtimeMs;
  const mtime = fileStat.mtime;

  const headers = new Headers();
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", cacheControl);
  headers.set("content-type", contentTypeForPath(path));
  headers.set("last-modified", mtime.toUTCString());
  headers.set("etag", `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`);

  const range = parseRangeHeader(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  if (!range && ifNoneMatchMatches(request.headers.get("if-none-match"), headers.get("etag") || "")) {
    return new Response(null, { status: 304, headers });
  }

  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(request.method === "HEAD" ? null : Bun.file(path).slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }

  headers.set("content-length", String(size));
  return new Response(request.method === "HEAD" ? null : Bun.file(path), { headers });
}

function stableSongId(relativePath: string): string {
  const digest = createHash("sha1").update(relativePath).digest("hex").slice(0, 24);
  return `local-server:${digest}`;
}

function titleFromFileName(fileName: string): { title: string; artist: string } {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  const separator = stem.lastIndexOf(" - ");
  if (separator > 0) {
    return {
      title: stem.slice(0, separator).trim() || stem,
      artist: stem.slice(separator + 3).trim() || "Unknown Artist",
    };
  }
  return { title: stem || "Untitled", artist: "Unknown Artist" };
}

function topLevelFolder(localPath: string | null | undefined): string | null {
  if (!localPath) return null;
  const slash = localPath.indexOf("/");
  if (slash <= 0) return null;
  return localPath.slice(0, slash);
}

// A top-level subdirectory of the music root surfaces as a browsable playlist.
// The id is derived from the folder name so it stays stable across rescans and
// carries a recognizable prefix the Worker matches to route playlist reads here
// (instead of to its D1-backed / curated playlist handlers).
function folderPlaylistId(folderName: string): string {
  return `local-folder-${createHash("sha1").update(folderName).digest("hex").slice(0, 16)}`;
}

// Group request-scoped songs by their top-level folder. Songs sitting directly
// in the library root belong to no folder and are skipped.
function folderPlaylistGroups(songs: PlayerSong[]): Map<string, PlayerSong[]> {
  const groups = new Map<string, PlayerSong[]>();
  for (const song of songs) {
    const folder = topLevelFolder(song.localPath);
    if (!folder) continue;
    const existing = groups.get(folder);
    if (existing) existing.push(song);
    else groups.set(folder, [song]);
  }
  return groups;
}

function earliestCreatedAt(songs: PlayerSong[]): string {
  let earliest: string | undefined;
  for (const song of songs) {
    if (song.createdAt && (!earliest || song.createdAt < earliest)) earliest = song.createdAt;
  }
  return earliest ?? new Date(0).toISOString();
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(", ")
      .trim();
  }
  return "";
}

function normalizeSearchText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function textMatchScore(expected: unknown, candidate: unknown): number {
  const left = normalizeSearchText(expected);
  const right = normalizeSearchText(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.82;

  const leftTokens = new Set(left.split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length > 1));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function contentTypeExtension(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

function audioExtensionFromContentType(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("aac")) return ".aac";
  if (normalized.includes("aiff") || normalized.includes("aif")) return ".aiff";
  if (normalized.includes("flac")) return ".flac";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return ".m4a";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("opus")) return ".opus";
  if (normalized.includes("wav")) return ".wav";
  return ".flac";
}

function extensionFromRemoteUrl(value: string, allowed: Set<string>, fallback: string): string {
  try {
    const parsed = new URL(value);
    const ext = extname(parsed.pathname).toLowerCase();
    return allowed.has(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function outputFormatFromPayload(value: unknown): OutputFormat {
  const format = typeof value === "string"
    ? value.trim().toLowerCase() as OutputFormat
    : SERVER_IMPORT_OUTPUT_FORMAT;
  return OUTPUT_FORMATS.has(format) ? format : SERVER_IMPORT_OUTPUT_FORMAT;
}

function sidecarPathForAudio(audioPath: string): string {
  return audioPath.replace(/\.[^.]+$/, ".spotify.json");
}

async function readSidecar(audioPath: string): Promise<LocalSidecar> {
  try {
    const raw = await readFile(sidecarPathForAudio(audioPath), "utf8");
    const parsed = JSON.parse(raw) as LocalSidecar;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSidecar(audioPath: string, sidecar: LocalSidecar): Promise<void> {
  const target = sidecarPathForAudio(audioPath);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  await rename(tempPath, target);
}

async function directoryNames(path: string, cache: Map<string, Promise<string[]>>): Promise<string[]> {
  const dir = dirname(path);
  let promise = cache.get(dir);
  if (!promise) {
    promise = readdir(dir).catch(() => []);
    cache.set(dir, promise);
  }
  return promise;
}

async function findSidecarByExtensions(
  source: LibrarySource,
  audioPath: string,
  extensions: Set<string>,
  candidates: string[],
  cache: Map<string, Promise<string[]>>,
): Promise<string> {
  const names = await directoryNames(audioPath, cache);
  const wanted = new Set(candidates.map((item) => item.toLowerCase()));
  const exact = names.find((name) => wanted.has(name.toLowerCase()) && extensions.has(extname(name).toLowerCase()));
  if (!exact) return "";
  const rel = relative(source.root, resolve(dirname(audioPath), exact)).split(sep).join("/");
  return rel && !rel.startsWith("..") ? rel : "";
}

async function findCoverPath(source: LibrarySource, audioPath: string, stem: string, sidecar: LocalSidecar, cache: Map<string, Promise<string[]>>): Promise<string> {
  if (sidecar.coverFile) {
    const candidate = resolve(dirname(audioPath), sidecar.coverFile);
    if (isPathInside(source.root, candidate) && existsSync(candidate)) {
      return relative(source.root, candidate).split(sep).join("/");
    }
  }

  return findSidecarByExtensions(
    source,
    audioPath,
    IMAGE_EXTENSIONS,
    [
      `${stem}.cover.jpg`,
      `${stem}.cover.jpeg`,
      `${stem}.cover.png`,
      `${stem}.cover.webp`,
      `${stem}.jpg`,
      `${stem}.jpeg`,
      `${stem}.png`,
      `${stem}.webp`,
      "cover.jpg",
      "cover.jpeg",
      "cover.png",
      "cover.webp",
      "folder.jpg",
      "folder.jpeg",
      "folder.png",
      "folder.webp",
      "front.jpg",
      "front.jpeg",
      "front.png",
      "front.webp",
    ],
    cache,
  );
}

async function findLyricsPath(source: LibrarySource, audioPath: string, stem: string, sidecar: LocalSidecar, cache: Map<string, Promise<string[]>>): Promise<string> {
  if (sidecar.lyricsFile) {
    const candidate = resolve(dirname(audioPath), sidecar.lyricsFile);
    if (isPathInside(source.root, candidate) && existsSync(candidate)) {
      return relative(source.root, candidate).split(sep).join("/");
    }
  }

  return findSidecarByExtensions(
    source,
    audioPath,
    LYRICS_EXTENSIONS,
    [`${stem}.lrc`, `${stem}.lyrics.lrc`, `${stem}.txt`, `${stem}.lyrics.txt`],
    cache,
  );
}

async function songFromFile(
  source: LibrarySource,
  relativePath: string,
  absolutePath: string,
  fileStat: Stats,
  directoryCache: Map<string, Promise<string[]>>,
): Promise<PlayerSong> {
  const fileName = basename(absolutePath);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const fallback = titleFromFileName(fileName);
  const sidecar = await readSidecar(absolutePath);
  // A pinned songId keeps a song's identity stable across a FILE change (the
  // YouTube-refetch flow rewrites a wrong-version .flac as the correct .opus);
  // otherwise the path-derived hash changes and orphans the like / playlist rows.
  const id =
    sidecar.songId?.trim() || stableSongId(source.shared ? relativePath : `${source.key}/${relativePath}`);
  let metadata: IAudioMetadata | null;

  try {
    metadata = await parseFile(absolutePath, { duration: true, skipCovers: true });
  } catch {
    metadata = null;
  }

  const common = metadata?.common;
  const format = metadata?.format;
  const artist =
    firstString(sidecar.artist) ||
    firstString(common?.artist) ||
    firstString(common?.artists) ||
    fallback.artist;
  const title = firstString(sidecar.title) || firstString(common?.title) || fallback.title;
  const album = firstString(sidecar.album) || firstString(common?.album);
  const coverPath = await findCoverPath(source, absolutePath, stem, sidecar, directoryCache);
  const lyricsPath = await findLyricsPath(source, absolutePath, stem, sidecar, directoryCache);

  return {
    id,
    title,
    artist,
    album: album || undefined,
    imageUrl: coverPath
      ? `/api/files/local/${encodeRelativePath(coverPath)}`
      : `/api/artwork/local/${encodeURIComponent(id)}`,
    audioUrl: `/api/files/local/${encodeRelativePath(relativePath)}`,
    lyricsUrl: lyricsPath ? `/api/files/local/${encodeRelativePath(lyricsPath)}` : undefined,
    createdAt: new Date(Number(fileStat.birthtimeMs || fileStat.mtimeMs)).toISOString(),
    duration:
      typeof format?.duration === "number" && Number.isFinite(format.duration)
        ? Math.round(format.duration)
        : undefined,
    audioBitDepth:
      typeof format?.bitsPerSample === "number" && Number.isFinite(format.bitsPerSample)
        ? format.bitsPerSample
        : undefined,
    audioSampleRate:
      typeof format?.sampleRate === "number" && Number.isFinite(format.sampleRate)
        ? format.sampleRate
        : undefined,
    source: "server",
    localPath: relativePath,
  };
}

async function collectAudioFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const output: Array<{ absolutePath: string; relativePath: string }> = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = resolve(dir, entry.name);
      if (!isPathInside(root, absolutePath)) continue;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      output.push({
        absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/"),
      });
    }
  }

  await walk(root);
  return output;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function readPersistentCache(source: LibrarySource): Promise<PersistentSongCache> {
  try {
    const raw = await readFile(source.cachePath, "utf8");
    const parsed = JSON.parse(raw) as PersistentSongCache;
    if (parsed?.version === SCAN_CACHE_VERSION && parsed.root === source.root) return parsed;
  } catch {}
  return { version: SCAN_CACHE_VERSION, root: source.root, entries: {} };
}

async function writePersistentCache(source: LibrarySource, cache: PersistentSongCache): Promise<void> {
  await mkdir(dirname(source.cachePath), { recursive: true });
  const tempPath = `${source.cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(tempPath, source.cachePath);
}

// Assigns every entry a content-canonical id derived from its inode group's
// anchor. Files that are hard links of one song share an inode, so they collapse
// onto a single canonical id WITHOUT changing each file's own `song.id`. The
// anchor (root-preferred path, else lexicographically-smallest) computes its
// canonical id with the SAME formula + per-user-source prefixing as
// songFromFile(), so the anchor's own id already equals the canonical id and
// existing id lookups keep resolving — only collapsed duplicate copies pick up a
// canonicalId that differs from their id. Different rips never share an inode, so
// this never merges distinct songs.
function assignCanonicalIds(source: LibrarySource, entries: LocalSongEntry[]): void {
  const groups = new Map<string, LocalSongEntry[]>();
  for (const entry of entries) {
    // ino is always > 0 for a real file; a missing/zero ino (malformed cache)
    // gets a per-path key so unrelated entries never group together.
    const key = entry.ino > 0 ? `${entry.dev}:${entry.ino}` : `solo:${entry.relativePath}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  for (const group of groups.values()) {
    let anchor = group[0];
    for (const entry of group) {
      const entryAtRoot = !entry.relativePath.includes("/");
      const anchorAtRoot = !anchor.relativePath.includes("/");
      if (entryAtRoot !== anchorAtRoot) {
        if (entryAtRoot) anchor = entry; // prefer a root-level copy as the anchor
      } else if (entry.relativePath.localeCompare(anchor.relativePath) < 0) {
        anchor = entry; // tie-break: lexicographically-smallest path
      }
    }
    const canonicalId = stableSongId(
      source.shared ? anchor.relativePath : `${source.key}/${anchor.relativePath}`,
    );
    for (const entry of group) entry.song.canonicalId = canonicalId;
  }
}

function buildLibrarySnapshot(
  source: LibrarySource,
  entries: LocalSongEntry[],
  scannedAt = Date.now(),
): LibrarySnapshot {
  assignCanonicalIds(source, entries);
  const songs = entries
    .map((entry) => entry.song)
    .sort((left, right) => {
      const leftKey = `${left.artist} ${left.title}`.toLowerCase();
      const rightKey = `${right.artist} ${right.title}`.toLowerCase();
      return leftKey.localeCompare(rightKey);
    });
  const entriesById = new Map(entries.map((entry) => [entry.song.id, entry] as const));
  const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry] as const));

  return {
    songs,
    entriesById,
    entriesByPath,
    scannedAt,
  };
}

async function readCachedLibrarySnapshot(source: LibrarySource): Promise<LibrarySnapshot | null> {
  const cache = await readPersistentCache(source);
  const entries: LocalSongEntry[] = [];

  for (const [relativePath, cached] of Object.entries(cache.entries)) {
    if (!cached?.song || typeof cached.size !== "number" || typeof cached.mtimeMs !== "number") continue;
    const absolutePath = resolveInside(source.root, relativePath);
    if (!absolutePath) continue;
    entries.push({
      song: cached.song,
      absolutePath,
      relativePath,
      size: cached.size,
      mtimeMs: cached.mtimeMs,
      ino: typeof cached.ino === "number" ? cached.ino : 0,
      dev: typeof cached.dev === "number" ? cached.dev : 0,
    });
  }

  return entries.length ? buildLibrarySnapshot(source, entries) : null;
}

function cachedStatMatches(
  cached: PersistentSongCache["entries"][string] | undefined,
  fileStat: Stats,
  sidecarMtimeMs: number | undefined,
): cached is PersistentSongCache["entries"][string] {
  if (!cached || cached.size !== fileStat.size) return false;
  return (
    Math.trunc(cached.mtimeMs) === Math.trunc(fileStat.mtimeMs) &&
    Math.trunc(cached.sidecarMtimeMs ?? 0) === Math.trunc(sidecarMtimeMs ?? 0)
  );
}

async function scanLibrary(source: LibrarySource, usePersistentCache = true): Promise<LibrarySnapshot> {
  await mkdir(source.root, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const previous: PersistentSongCache = usePersistentCache
    ? await readPersistentCache(source)
    : { version: SCAN_CACHE_VERSION, root: source.root, entries: {} };
  const files = await collectAudioFiles(source.root);
  const directoryCache = new Map<string, Promise<string[]>>();
  const nextCache: PersistentSongCache = {
    version: SCAN_CACHE_VERSION,
    root: source.root,
    entries: {},
  };

  const entries = await mapWithConcurrency(files, 8, async (file): Promise<LocalSongEntry | null> => {
    try {
      const fileStat = await stat(file.absolutePath);
      const sidecarMtimeMs = await stat(sidecarPathForAudio(file.absolutePath))
        .then((sidecarStat) => sidecarStat.mtimeMs)
        .catch(() => undefined);
      const cached = previous.entries[file.relativePath];
      const song =
        cachedStatMatches(cached, fileStat, sidecarMtimeMs)
          ? cached.song
          : await songFromFile(source, file.relativePath, file.absolutePath, fileStat, directoryCache);

      nextCache.entries[file.relativePath] = {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        sidecarMtimeMs,
        ino: fileStat.ino,
        dev: fileStat.dev,
        song,
      };

      return {
        song,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ino: fileStat.ino,
        dev: fileStat.dev,
      };
    } catch (error) {
      // A file can vanish between the directory walk and this stat (e.g. an
      // in-flight download that swaps .m4a for .flac) or be unreadable. Skip it
      // so one bad file never aborts the whole library refresh. ENOENT is the
      // expected transient case and stays quiet; anything else is logged.
      if ((error as { code?: string } | null)?.code !== "ENOENT") {
        console.error(
          `Skipping ${file.relativePath} during library scan: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  });

  const presentEntries = entries.filter((entry): entry is LocalSongEntry => entry !== null);

  await writePersistentCache(source, nextCache).catch(() => {});

  return buildLibrarySnapshot(source, presentEntries);
}

function refreshLibrary(source: LibrarySource, usePersistentCache = true): Promise<LibrarySnapshot> {
  if (!source.shared) {
    const existing = userScanPromises.get(source.key);
    if (existing) return existing;
    const promise = scanLibrary(source, usePersistentCache)
      .then((snapshot) => {
        userLibrarySnapshots.set(source.key, snapshot);
        return snapshot;
      })
      .finally(() => {
        userScanPromises.delete(source.key);
      });
    userScanPromises.set(source.key, promise);
    return promise;
  }

  scanPromise ??= scanLibrary(source, usePersistentCache)
    .then((snapshot) => {
      librarySnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}

async function getLibrary(source: LibrarySource, force = false): Promise<LibrarySnapshot> {
  const now = Date.now();
  const snapshot = source.shared ? librarySnapshot : userLibrarySnapshots.get(source.key) ?? null;
  const activePromise = source.shared ? scanPromise : userScanPromises.get(source.key) ?? null;
  if (!force && snapshot) {
    if (now - snapshot.scannedAt >= scanTtlMs && !activePromise) {
      void refreshLibrary(source, true).catch((error) => {
        console.error(`Spotify local music library refresh failed for ${source.key}: ${error}`);
      });
    }
    return snapshot;
  }
  // `force` only means "scan now instead of serving a (possibly stale) snapshot".
  // The on-disk stat cache must still be honored so unchanged files reuse their
  // parsed metadata; only new/changed/removed files (a stat mismatch) are
  // re-parsed. Passing usePersistentCache=false here would seed an empty cache
  // and re-run music-metadata on the entire library for every mutation.
  return refreshLibrary(source, true);
}

function currentUserIdentityForRequest(request: Request): RequestUserIdentity | null {
  if (hasValidProxyToken(request)) {
    const id = request.headers.get(PROXY_USER_ID_HEADER)?.trim() || "";
    if (!id) return null;
    return {
      id,
      email: request.headers.get(PROXY_USER_EMAIL_HEADER)?.trim() || null,
      name: request.headers.get(PROXY_USER_NAME_HEADER)?.trim() || null,
      local: false,
    };
  }
  return allowsImplicitLocalUser(request)
    ? {
        id: LOCAL_USER.id,
        email: LOCAL_USER.email,
        name: LOCAL_USER.name,
        local: true,
      }
    : null;
}

function currentUserIdForRequest(request: Request): string | null {
  return currentUserIdentityForRequest(request)?.id ?? null;
}

function isLocalLibraryOwner(identity: RequestUserIdentity | null): boolean {
  if (!identity) return false;
  if (identity.local || identity.id === LOCAL_USER.id) return true;
  return (
    listMatchesValue(libraryOwnerUserIds, identity.id) ||
    listMatchesValue(libraryOwnerEmails, identity.email)
  );
}

function librarySourceForIdentity(identity: RequestUserIdentity | null): LibrarySource | null {
  if (!identity) return null;
  return isLocalLibraryOwner(identity) ? sharedLibrarySource() : userLibrarySource(identity.id);
}

function librarySourceForRequest(request: Request): LibrarySource | null {
  return librarySourceForIdentity(currentUserIdentityForRequest(request));
}

function canAccessLocalLibrary(request: Request): boolean {
  return Boolean(librarySourceForRequest(request));
}

function forbiddenLibraryResponse(): Response {
  return json({ error: "This account does not have access to the local music library" }, { status: 403 });
}

function mediaScopeForIdentity(identity: RequestUserIdentity): "shared" | "user" {
  return isLocalLibraryOwner(identity) ? "shared" : "user";
}

function mediaSignature(userId: string, scope: string, pathname: string, expiresAt: string): string {
  return createHmac("sha256", proxyToken)
    .update(userId)
    .update("\0")
    .update(scope)
    .update("\0")
    .update(pathname)
    .update("\0")
    .update(expiresAt)
    .digest("hex")
    .slice(0, 40);
}

function appendMediaSignature(mediaUrl: string | undefined, identity: RequestUserIdentity | null): string | undefined {
  if (!mediaUrl || !proxyToken || !identity || identity.local) return mediaUrl;
  let parsed: URL;
  try {
    parsed = new URL(mediaUrl, "http://spotify.local");
  } catch {
    return mediaUrl;
  }
  if (!parsed.pathname.startsWith("/api/files/local/") && !parsed.pathname.startsWith("/api/artwork/local/")) {
    return mediaUrl;
  }
  const scope = mediaScopeForIdentity(identity);
  const expiresAt = String(Math.floor(Date.now() / 1000) + MEDIA_SIGNATURE_TTL_SECONDS);
  parsed.searchParams.set(MEDIA_USER_SEARCH_PARAM, identity.id);
  parsed.searchParams.set(MEDIA_SCOPE_SEARCH_PARAM, scope);
  parsed.searchParams.set(MEDIA_EXPIRY_SEARCH_PARAM, expiresAt);
  parsed.searchParams.set(
    MEDIA_SIGNATURE_SEARCH_PARAM,
    mediaSignature(identity.id, scope, parsed.pathname, expiresAt),
  );
  return `${parsed.pathname}${parsed.search}`;
}

function songForRequest(song: PlayerSong, request: Request): PlayerSong {
  const identity = currentUserIdentityForRequest(request);
  return {
    ...song,
    imageUrl: appendMediaSignature(song.imageUrl, identity) || song.imageUrl,
    audioUrl: appendMediaSignature(song.audioUrl, identity) || song.audioUrl,
    lyricsUrl: appendMediaSignature(song.lyricsUrl, identity),
  };
}

function songsForRequest(songs: PlayerSong[], request: Request): PlayerSong[] {
  if (!canAccessLocalLibrary(request)) return [];
  return songs.map((song) => songForRequest(song, request));
}

type MediaRefreshItem = Pick<PlayerSong, "id" | "title" | "artist" | "imageUrl" | "audioUrl" | "lyricsUrl">;
const MAX_MEDIA_REFRESH_ITEMS = 40;
const MAX_MEDIA_REFRESH_VALUE_LENGTH = 16_384;

function normalizeMediaRefreshItem(value: unknown): MediaRefreshItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const artist = typeof item.artist === "string" ? item.artist.trim() : "";
  const imageUrl = typeof item.imageUrl === "string" ? item.imageUrl.trim() : "";
  const audioUrl = typeof item.audioUrl === "string" ? item.audioUrl.trim() : "";
  const lyricsUrl = typeof item.lyricsUrl === "string" ? item.lyricsUrl.trim() : "";
  if (!id || !title || !artist || !imageUrl || !audioUrl) return null;
  if (
    id.length > 512 ||
    title.length > 1_024 ||
    artist.length > 1_024 ||
    imageUrl.length > MAX_MEDIA_REFRESH_VALUE_LENGTH ||
    audioUrl.length > MAX_MEDIA_REFRESH_VALUE_LENGTH ||
    lyricsUrl.length > MAX_MEDIA_REFRESH_VALUE_LENGTH
  ) {
    return null;
  }
  return { id, title, artist, imageUrl, audioUrl, lyricsUrl: lyricsUrl || undefined };
}

async function handleMediaRefresh(request: Request): Promise<Response> {
  const identity = currentUserIdentityForRequest(request);
  if (!identity) return json({ error: "Unauthorized" }, { status: 401 });
  const payload = await readJsonBody<{ songs?: unknown }>(request);
  if (!Array.isArray(payload?.songs)) {
    return json({ error: "Songs are required" }, { status: 400 });
  }
  if (payload.songs.length > MAX_MEDIA_REFRESH_ITEMS) {
    return json({ error: `Maximum ${MAX_MEDIA_REFRESH_ITEMS} songs` }, { status: 413 });
  }
  const songs = payload.songs.map(normalizeMediaRefreshItem);
  if (songs.some((song) => song === null)) {
    return json({ error: "Invalid song media" }, { status: 400 });
  }
  const source = librarySourceForIdentity(identity);
  const snapshot = source ? await getLibrary(source) : null;
  const currentByTrack = new Map(
    (snapshot?.songs ?? []).map((song) => [trackKey(song.title, song.artist), song] as const),
  );
  return json(
    {
      songs: (songs as MediaRefreshItem[]).map((song) => {
        // Discover staging is intentionally temporary. Once its cache entry is
        // pruned, listening history may still point at the dead .discover path.
        // Prefer the promoted/current library copy when the same track exists.
        const stagedMedia = song.imageUrl.includes("/.discover/") || song.audioUrl.includes("/.discover/");
        const currentSong = stagedMedia
          ? snapshot?.entriesById.get(song.id)?.song ?? currentByTrack.get(trackKey(song.title, song.artist))
          : null;
        const media = currentSong ?? song;
        return {
          id: song.id,
          imageUrl: appendMediaSignature(media.imageUrl, identity) || media.imageUrl,
          audioUrl: appendMediaSignature(media.audioUrl, identity) || media.audioUrl,
          lyricsUrl: appendMediaSignature(media.lyricsUrl, identity),
        };
      }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function hasValidMediaSignature(url: URL): boolean {
  if (!proxyToken) return false;
  const userId = url.searchParams.get(MEDIA_USER_SEARCH_PARAM)?.trim() || "";
  const scope = url.searchParams.get(MEDIA_SCOPE_SEARCH_PARAM)?.trim() || "";
  const expiresAt = url.searchParams.get(MEDIA_EXPIRY_SEARCH_PARAM)?.trim() || "";
  const signature = url.searchParams.get(MEDIA_SIGNATURE_SEARCH_PARAM)?.trim() || "";
  const expirySeconds = Number(expiresAt);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Boolean(
    userId &&
    (scope === "shared" || scope === "user") &&
    Number.isSafeInteger(expirySeconds) &&
    expirySeconds > nowSeconds &&
    expirySeconds <= nowSeconds + MEDIA_SIGNATURE_TTL_SECONDS + 60 &&
    signature &&
    timingSafeEqualStr(signature, mediaSignature(userId, scope, url.pathname, expiresAt)),
  );
}

function librarySourceForMediaRequest(request: Request, url: URL): LibrarySource | null {
  const requestSource = librarySourceForRequest(request);
  if (requestSource) return requestSource;
  if (!hasValidMediaSignature(url)) return null;
  const userId = url.searchParams.get(MEDIA_USER_SEARCH_PARAM)?.trim() || "";
  const scope = url.searchParams.get(MEDIA_SCOPE_SEARCH_PARAM)?.trim() || "";
  return scope === "shared" ? sharedLibrarySource() : userLibrarySource(userId);
}

function likesCachePath(source: LibrarySource): string {
  return resolve(dirname(source.cachePath), "local-music-likes.json");
}

// Folds the persisted likes set onto content-canonical ids at read time so a
// like recorded under ANY physical copy lights the one logical song
// (like-once-everywhere). Gated so the dark deploy keeps exact legacy behavior
// until the new app ships and the flag is flipped alongside PLAYLISTS_EDITABLE.
const CANONICAL_LIKES_ENABLED = process.env.SPOTIFY_CANONICAL_LIKES === "1";

const canonicalIdOf = (song: PlayerSong): string => song.canonicalId ?? song.id;

function visibleSongIds(songs: PlayerSong[]): Set<string> {
  const ids = new Set<string>();
  for (const song of songs) {
    ids.add(song.id);
    ids.add(canonicalIdOf(song));
  }
  return ids;
}

function filterVisibleLikedSongIds(ids: Iterable<string>, songs: PlayerSong[]): string[] {
  const visible = visibleSongIds(songs);
  return Array.from(new Set(ids)).filter((id) => visible.has(id));
}

// Maps every (possibly legacy) liked id onto its canonical id and keeps only
// those whose canonical song is currently visible — collapsing duplicate copies
// to a single liked id. Idempotent on an already-canonical set.
function canonicalizeLikedIds(ids: Iterable<string>, songs: PlayerSong[]): string[] {
  const toCanonical = new Map(songs.map((song) => [song.id, canonicalIdOf(song)] as const));
  const visibleCanonical = new Set(songs.map(canonicalIdOf));
  const out = new Set<string>();
  for (const id of ids) {
    const canonical = toCanonical.get(id) ?? id;
    if (visibleCanonical.has(canonical)) out.add(canonical);
  }
  return Array.from(out);
}

async function writePersistentLikes(
  source: LibrarySource,
  likedSongIds: Iterable<string>,
  likedAt?: Record<string, number>,
): Promise<void> {
  const path = likesCachePath(source);
  const ids = Array.from(new Set(likedSongIds));
  const cache: PersistentLikesCache = {
    version: LIKES_CACHE_VERSION,
    root: source.root,
    likedSongIds: ids,
  };
  if (likedAt) {
    // Keep only timestamps for ids that are still liked, so unlikes don't leave
    // the map growing forever. Omit the field entirely when empty.
    const idSet = new Set(ids);
    const pruned: Record<string, number> = {};
    for (const [id, ts] of Object.entries(likedAt)) {
      if (idSet.has(id) && Number.isFinite(ts)) pruned[id] = ts;
    }
    if (Object.keys(pruned).length > 0) cache.likedAt = pruned;
  }
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(tempPath, path);
}

// Runs `task` after any pending likes write for this source has settled, so a
// read-modify-write sequence never races another. Returns the task's result.
function withLikeWriteLock<T>(source: LibrarySource, task: () => Promise<T>): Promise<T> {
  const previous = likeWriteChains.get(source.key) ?? Promise.resolve();
  // Run regardless of whether the previous task resolved or rejected.
  const next = previous.then(task, task);
  // The stored tail must never reject (a rejected tail would block the source
  // forever); the caller still observes failures through the returned `next`.
  likeWriteChains.set(source.key, next.catch(() => undefined));
  return next;
}

// Reads the persisted likes set. Returns null when no valid cache exists yet
// (so callers can distinguish "never initialized" from "explicitly empty").
// This is side-effect-free: it never writes a backfill.
async function readPersistentLikes(source: LibrarySource): Promise<string[] | null> {
  try {
    const raw = await readFile(likesCachePath(source), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistentLikesCache> | null;
    if (
      parsed?.version === LIKES_CACHE_VERSION &&
      parsed.root === source.root &&
      Array.isArray(parsed.likedSongIds)
    ) {
      return parsed.likedSongIds.filter((id): id is string => typeof id === "string");
    }
  } catch {}
  return null;
}

// Reads the per-like timestamps (id -> epoch ms). Side-effect-free; returns {}
// when absent (legacy caches) so callers fall back to file createdAt for order.
async function readPersistentLikeTimes(source: LibrarySource): Promise<Record<string, number>> {
  try {
    const raw = await readFile(likesCachePath(source), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistentLikesCache> | null;
    if (
      parsed?.version === LIKES_CACHE_VERSION &&
      parsed.root === source.root &&
      parsed.likedAt &&
      typeof parsed.likedAt === "object"
    ) {
      const out: Record<string, number> = {};
      for (const [id, ts] of Object.entries(parsed.likedAt)) {
        if (typeof ts === "number" && Number.isFinite(ts)) out[id] = ts;
      }
      return out;
    }
  } catch {}
  return {};
}

// One-time migration: if a source has no likes cache yet, seed it with the
// legacy "everything is liked" default. Serialized + write-once so GET requests
// stay side-effect-free and concurrent callers don't double-write.
async function backfillLegacyLikesForSource(source: LibrarySource, songs: PlayerSong[]): Promise<void> {
  if (likesBackfilled.has(source.key)) return;
  await withLikeWriteLock(source, async () => {
    if (likesBackfilled.has(source.key)) return;
    const existing = await readPersistentLikes(source);
    if (existing === null) {
      await writePersistentLikes(source, songs.map((song) => song.id)).catch(() => {});
    }
    likesBackfilled.add(source.key);
  });
}

async function likedSongIdsForSongs(source: LibrarySource, songs: PlayerSong[]): Promise<string[]> {
  const stored = await readPersistentLikes(source);
  if (stored !== null) {
    return CANONICAL_LIKES_ENABLED
      ? canonicalizeLikedIds(stored, songs)
      : filterVisibleLikedSongIds(stored, songs);
  }
  // No cache yet: report the legacy default (all songs liked) WITHOUT writing on
  // this GET path. The shared source is backfilled at startup; per-user sources
  // are created on demand, so kick off their one-time backfill in the
  // background (serialized + write-once) without blocking the response.
  if (!source.shared && !likesBackfilled.has(source.key)) {
    void backfillLegacyLikesForSource(source, songs).catch(() => {});
  }
  return CANONICAL_LIKES_ENABLED
    ? Array.from(new Set(songs.map(canonicalIdOf)))
    : songs.map((song) => song.id);
}

async function setSongLikedForSource(
  source: LibrarySource,
  songs: PlayerSong[],
  songId: string,
  nextLiked: boolean,
): Promise<string[] | null> {
  const visible = visibleSongIds(songs);
  if (!visible.has(songId)) return null;
  // Serialize the whole read-modify-write so concurrent toggles can't clobber
  // each other (the previous version re-read and wrote without a lock).
  return withLikeWriteLock(source, async () => {
    const liked = new Set(await likedSongIdsForSongs(source, songs));
    const likedAt = await readPersistentLikeTimes(source);
    // Stamp under the same id the cache stores (canonical when the fold is on),
    // so ordering can look the timestamp up by either the raw or canonical id.
    const likedSong = songs.find((s) => s.id === songId || canonicalIdOf(s) === songId);
    const storedId = CANONICAL_LIKES_ENABLED && likedSong ? canonicalIdOf(likedSong) : songId;
    if (nextLiked) {
      liked.add(songId);
      likedAt[storedId] = Date.now();
    } else {
      liked.delete(songId);
      delete likedAt[storedId];
      delete likedAt[songId];
    }
    const likedSongIds = CANONICAL_LIKES_ENABLED
      ? canonicalizeLikedIds(liked, songs)
      : filterVisibleLikedSongIds(liked, songs);
    await writePersistentLikes(source, likedSongIds, likedAt);
    // A successful explicit write satisfies the legacy backfill too.
    likesBackfilled.add(source.key);
    return likedSongIds;
  });
}

async function markSongLikedForSource(source: LibrarySource, songs: PlayerSong[], songId: string): Promise<void> {
  await setSongLikedForSource(source, songs, songId, true).catch(() => {});
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function handleLikes(request: Request): Promise<Response> {
  const source = librarySourceForRequest(request);
  const visibleSongs = source ? songsForRequest((await getLibrary(source)).songs, request) : [];
  const likedSongIds = source ? await likedSongIdsForSongs(source, visibleSongs) : [];

  if (request.method === "GET") {
    return jsonCached(request, { likes: likedSongIds, likedSongIds });
  }

  if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed();
  if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
  if (!source) return forbiddenLibraryResponse();

  const payload = await readJsonBody<{ songId?: unknown }>(request);
  const songId = typeof payload?.songId === "string" ? payload.songId : "";
  if (!songId) return json({ error: "Song id is required" }, { status: 400 });
  const nextLikedSongIds = await setSongLikedForSource(source, visibleSongs, songId, request.method === "POST");
  if (!nextLikedSongIds) return notFound("Song not found");

  return json({ ok: true, likes: nextLikedSongIds, likedSongIds: nextLikedSongIds });
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180) || "Unknown";
}

async function uniquePath(basePath: string): Promise<string> {
  if (!existsSync(basePath)) return basePath;
  const ext = extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} ${index}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to create a unique file name");
}

async function saveFile(file: File, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(await file.arrayBuffer()));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSupportedUploadFile(file: File, allowedExtensions: Set<string>, mimePrefix: string): boolean {
  const ext = extname(file.name).toLowerCase();
  const mimeType = file.type.toLowerCase();
  return allowedExtensions.has(ext) || (mimeType ? mimeType.startsWith(mimePrefix) : false);
}

function validateUploadFile(
  file: File,
  label: string,
  maxBytes: number,
  allowedExtensions?: Set<string>,
  mimePrefix?: string,
): Response | null {
  if (file.size > maxBytes) {
    return json({ error: `${label} is too large` }, { status: 413 });
  }
  if (allowedExtensions && mimePrefix && !isSupportedUploadFile(file, allowedExtensions, mimePrefix)) {
    return json({ error: `${label} type is not supported` }, { status: 415 });
  }
  return null;
}

function assertRemoteResponseSize(response: Response, maxBytes: number, label: string): void {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PayloadTooLargeError(`${label} is too large`);
  }
}

function byteLimitTransform(maxBytes: number, label: string): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        callback(new PayloadTooLargeError(`${label} is too large`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function saveResponseBody(response: Response, path: string, maxBytes?: number, label = "File"): Promise<void> {
  if (!response.body) throw new Error("Remote file response had no body");
  if (maxBytes) assertRemoteResponseSize(response, maxBytes, label);
  await mkdir(dirname(path), { recursive: true });
  try {
    const source = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
    if (maxBytes) {
      await pipeline(source, byteLimitTransform(maxBytes, label), createWriteStream(path));
    } else {
      await pipeline(source, createWriteStream(path));
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function songEntryOwnedPaths(source: LibrarySource, entry: LocalSongEntry): Promise<string[]> {
  const sidecar = await readSidecar(entry.absolutePath);
  const paths = new Set<string>([entry.absolutePath, sidecarPathForAudio(entry.absolutePath)]);

  const directory = dirname(entry.absolutePath);
  for (const fileName of [sidecar.coverFile, sidecar.lyricsFile]) {
    if (!fileName) continue;
    const candidate = resolve(directory, fileName);
    if (isPathInside(source.root, candidate)) {
      paths.add(candidate);
    }
  }

  // Auto-detected (non-sidecar) covers follow stem-specific conventions:
  // `${stem}.cover.<ext>` and `${stem}.<ext>`. Delete those too so a replace
  // does not orphan them. Never touch directory-shared cover.*/folder.*/front.*
  // — those belong to sibling tracks in the same directory.
  const stem = basename(entry.absolutePath, extname(entry.absolutePath));
  for (const ext of IMAGE_EXTENSIONS) {
    for (const coverName of [`${stem}.cover${ext}`, `${stem}${ext}`]) {
      const candidate = resolve(directory, coverName);
      if (candidate === entry.absolutePath) continue;
      if (isPathInside(source.root, candidate)) {
        paths.add(candidate);
      }
    }
  }
  return Array.from(paths).filter((path) => existsSync(path));
}

async function deleteSongEntryFiles(source: LibrarySource, entry: LocalSongEntry): Promise<void> {
  const paths = await songEntryOwnedPaths(source, entry);
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
}

type SongEntryBackup = {
  directory: string;
  files: Array<{ original: string; backup: string }>;
};

async function backupSongEntryFiles(source: LibrarySource, entry: LocalSongEntry): Promise<SongEntryBackup> {
  const directory = resolve(
    dirname(entry.absolutePath),
    ".spotify-replacements",
    `${Date.now()}-${process.pid}-${crypto.randomUUID()}`,
  );
  const ownedPaths = await songEntryOwnedPaths(source, entry);
  const files: SongEntryBackup["files"] = [];
  await mkdir(directory, { recursive: true });
  try {
    for (const [index, original] of ownedPaths.entries()) {
      const backup = resolve(directory, `${index}-${basename(original)}`);
      await rename(original, backup);
      files.push({ original, backup });
    }
    return { directory, files };
  } catch (error) {
    for (const file of files.reverse()) {
      await mkdir(dirname(file.original), { recursive: true }).catch(() => undefined);
      await rename(file.backup, file.original).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreSongEntryBackup(
  source: LibrarySource,
  entry: LocalSongEntry,
  replacementPath: string,
  backup: SongEntryBackup,
): Promise<void> {
  await deleteSongEntryFiles(source, { ...entry, absolutePath: replacementPath }).catch(() => undefined);
  for (const file of backup.files.slice().reverse()) {
    await mkdir(dirname(file.original), { recursive: true }).catch(() => undefined);
    await rm(file.original, { force: true }).catch(() => undefined);
    await rename(file.backup, file.original).catch(() => undefined);
  }
  await rm(backup.directory, { recursive: true, force: true }).catch(() => undefined);
  await getLibrary(source, true).catch(() => undefined);
}

async function discardSongEntryBackup(backup: SongEntryBackup): Promise<void> {
  await rm(backup.directory, { recursive: true, force: true });
}

function trackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

async function saveRemoteImage(imageUrl: string, stem: string, audioPath: string): Promise<string | undefined> {
  const parsed = parseHttpUrl(imageUrl);
  if (!parsed) return undefined;

  const response = await fetchPublicHttpUrl(
    parsed,
    { headers: { accept: "image/*,*/*" } },
    20_000,
  );
  if (!response.ok || !response.body) return undefined;

  const contentType = response.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) return undefined;

  const ext = extensionFromRemoteUrl(
    imageUrl,
    IMAGE_EXTENSIONS,
    contentTypeExtension(contentType || "image/jpeg"),
  );
  const coverName = `${stem}.cover${ext}`;
  await saveResponseBody(response, resolve(dirname(audioPath), coverName), MAX_IMAGE_BYTES, "Image file");
  return coverName;
}

async function handleRemoteSongUpload(payload: {
  source: LibrarySource;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  audioUrl?: unknown;
  imageUrl?: unknown;
  lyricsText?: unknown;
  replaceExisting?: unknown;
  outputFormat?: unknown;
}): Promise<Response> {
  const { source } = payload;
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const artist = typeof payload.artist === "string" ? payload.artist.trim() : "";
  const album = typeof payload.album === "string" ? payload.album.trim() : "";
  const audioUrl = typeof payload.audioUrl === "string" ? payload.audioUrl.trim() : "";
  const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl.trim() : "";
  const lyricsText = typeof payload.lyricsText === "string" ? payload.lyricsText.trim() : "";
  const replaceExisting =
    payload.replaceExisting === true ||
    (typeof payload.replaceExisting === "string" && payload.replaceExisting.toLowerCase() === "true");
  const outputFormat = outputFormatFromPayload(payload.outputFormat);

  if (!title || !artist || !audioUrl) {
    return json({ error: "Title, artist, and audio URL are required" }, { status: 400 });
  }
  if (outputFormat !== SERVER_IMPORT_OUTPUT_FORMAT) {
    return json(
      {
        error: `${outputFormat.toUpperCase()} output is only available for browser/local saves. Server imports currently support FLAC/original audio.`,
      },
      { status: 400 },
    );
  }
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }

  const parsedAudioUrl = parseHttpUrl(audioUrl);
  if (!parsedAudioUrl) return json({ error: "Only valid http(s) audio URLs are supported" }, { status: 400 });
  let response: Response;
  try {
    response = await fetchPublicHttpUrl(parsedAudioUrl, { headers: { accept: "audio/*,*/*" } }, 120_000);
  } catch (error) {
    if (error instanceof RemoteUrlError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const snapshot = await getLibrary(source);
  const existingEntry = snapshot.songs
    .map((song) => snapshot.entriesById.get(song.id))
    .find((entry): entry is LocalSongEntry =>
      Boolean(entry && trackKey(entry.song.title, entry.song.artist) === trackKey(title, artist)),
    );

  if (existingEntry && !replaceExisting) {
    // Drain the upstream body we opened before the duplicate check, or the
    // socket stays alive (on Bun) until GC.
    await response.body?.cancel().catch(() => undefined);
    return json(
      {
        error: "Song already exists in your library",
        code: "DUPLICATE_SONG",
        existingSong: {
          id: existingEntry.song.id,
          title: existingEntry.song.title,
          artist: existingEntry.song.artist,
        },
      },
      { status: 409 },
    );
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return json({ error: `Audio server returned ${response.status}` }, { status: 502 });
  }

  const contentType = response.headers.get("content-type") || "";
  const normalizedContentType = contentType.split(";")[0]?.trim().toLowerCase() || "";
  if (
    normalizedContentType &&
    !normalizedContentType.startsWith("audio/") &&
    normalizedContentType !== "application/octet-stream"
  ) {
    return json({ error: "Remote audio URL did not return an audio file" }, { status: 415 });
  }
  const audioExt = extensionFromRemoteUrl(
    audioUrl,
    AUDIO_EXTENSIONS,
    audioExtensionFromContentType(contentType),
  );
  const stem = sanitizeFileName(`${artist} - ${title}`);
  const preferredAudioPath = existingEntry && replaceExisting
    ? resolve(dirname(existingEntry.absolutePath), `${stem}${audioExt}`)
    : resolve(source.root, `${stem}${audioExt}`);
  const audioPath =
    existingEntry &&
    replaceExisting &&
    (!existsSync(preferredAudioPath) || preferredAudioPath === existingEntry.absolutePath)
      ? preferredAudioPath
      : await uniquePath(preferredAudioPath);
  const tempAudioPath = existingEntry && replaceExisting
    ? await uniquePath(resolve(
        dirname(audioPath),
        `.${basename(audioPath, extname(audioPath))}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${audioExt}`,
      ))
    : audioPath;

  try {
    await saveResponseBody(response, tempAudioPath, MAX_AUDIO_BYTES, "Audio file");
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return json({ error: error.message }, { status: 413 });
    }
    if (error instanceof RemoteUrlError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  const replacementBackup = existingEntry && replaceExisting
    ? await backupSongEntryFiles(source, existingEntry)
    : null;
  try {
    if (replacementBackup) {
      await mkdir(dirname(audioPath), { recursive: true });
      await rename(tempAudioPath, audioPath);
    }

    const sidecar: LocalSidecar = {
      version: 1,
      title,
      artist,
      album: album || undefined,
      updatedAt: new Date().toISOString(),
    };

    if (imageUrl) {
      sidecar.coverFile = await saveRemoteImage(imageUrl, basename(audioPath, extname(audioPath)), audioPath).catch(
        () => undefined,
      );
    }

    if (lyricsText) {
      const lyricsName = `${basename(audioPath, extname(audioPath))}.lrc`;
      await writeFile(resolve(dirname(audioPath), lyricsName), `${lyricsText}\n`, "utf8");
      sidecar.lyricsFile = lyricsName;
    }

    await writeSidecar(audioPath, sidecar);
    const nextSnapshot = await getLibrary(source, true);
    const relativePath = relative(source.root, audioPath).split(sep).join("/");
    const entry = nextSnapshot.entriesByPath.get(relativePath);
    if (!entry) throw new Error("Uploaded song could not be scanned");
    if (replacementBackup) await discardSongEntryBackup(replacementBackup);
    if (!existingEntry) await markSongLikedForSource(source, nextSnapshot.songs, entry.song.id);
    return json(entry.song, { status: existingEntry && replaceExisting ? 200 : 201 });
  } catch (error) {
    await rm(tempAudioPath, { force: true }).catch(() => undefined);
    if (replacementBackup && existingEntry) {
      await restoreSongEntryBackup(source, existingEntry, audioPath, replacementBackup);
    }
    throw error;
  }
}

function ffmpegPath(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  // launchd starts the service with a minimal PATH that omits Homebrew, so a
  // bare "ffmpeg" can ENOENT even though it is installed — probe known prefixes.
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "ffmpeg";
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new LicensedSourceDownloadError("Licensed source materialization failed", 502);
  }
}

function ffmpegDecryptionKey(value: string): string {
  const parts = value
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
  return /^[0-9a-fA-F]{32}$/.test(candidate) ? candidate : value.trim();
}

// Caller/provider-supplied stream headers are untrusted; only forward a small
// allowlist so a caller cannot inject Host/Authorization/Cookie headers into
// the SSRF-guarded fetch below.
const ALLOWED_LICENSED_MEDIA_HEADERS = new Set([
  "user-agent",
  "range",
  "accept",
  "accept-language",
  "x-captcha-token",
]);

function licensedMediaRequestHeaders(
  streamHeaders: Record<string, string> | undefined,
  userAgent: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(streamHeaders ?? {})) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = typeof value === "string" ? value.trim() : "";
    if (!normalizedKey || !normalizedValue) continue;
    if (!ALLOWED_LICENSED_MEDIA_HEADERS.has(normalizedKey)) continue;
    headers[normalizedKey] = normalizedValue;
  }
  if (!headers["user-agent"]) headers["user-agent"] = userAgent;
  return headers;
}

async function materializeEncryptedLicensedSourceStream(
  stream: LicensedSourceStream,
  userAgent?: string,
): Promise<Response> {
  const parsedStreamUrl = parseHttpUrl(stream.streamUrl);
  if (!parsedStreamUrl) {
    throw new LicensedSourceDownloadError("Licensed source URL is invalid", 502);
  }
  let response: Response;
  try {
    response = await fetchPublicHttpUrl(
      parsedStreamUrl,
      {
        method: "GET",
        headers: licensedMediaRequestHeaders(
          stream.headers,
          userAgent || "spotify/1.0 (+https://music.streamarena.xyz)",
        ),
      },
      120_000,
    );
  } catch (error) {
    if (error instanceof RemoteUrlError) {
      throw new LicensedSourceDownloadError(error.message, 400);
    }
    throw error;
  }
  if (!response.ok) {
    throw new LicensedSourceDownloadError(`Licensed source audio returned ${response.status}`, response.status);
  }
  assertRemoteResponseSize(response, MAX_AUDIO_BYTES, "Licensed source audio");

  const tempDir = await mkdtemp(resolve(tmpdir(), "spotify-licensed-"));
  const encryptedPath = resolve(tempDir, "source.mp4");
  const outputPath = resolve(tempDir, "output.flac");
  try {
    await saveResponseBody(response, encryptedPath, MAX_AUDIO_BYTES, "Licensed source audio");
    await runFfmpeg([
      "-decryption_key",
      ffmpegDecryptionKey(stream.decryptionKey || ""),
      "-i",
      encryptedPath,
      "-vn",
      "-map_metadata",
      "-1",
      "-compression_level",
      "8",
      outputPath,
    ]);
    const outputBytes = await readFile(outputPath);
    if (outputBytes.byteLength > MAX_AUDIO_BYTES) {
      throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
    }
    return new Response(outputBytes, {
      headers: {
        "content-type": "audio/flac",
        "content-length": String(outputBytes.byteLength),
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Tidal (and any DASH source) materializes to lossless FLAC-in-fMP4 (audio/mp4).
// Remux it to a native .flac container so downloads match the other lossless
// sources (Qobuz/Amazon) instead of an .m4a — the mini has ffmpeg, the Worker
// does not, which is why this lives here.
async function materializeDashStreamToFlac(
  stream: LicensedSourceStream,
  userAgent?: string,
): Promise<Response> {
  const materialized = await materializeLicensedSourceStream(stream, {
    maxBytes: MAX_AUDIO_BYTES,
    userAgent,
  });
  if (!materialized.ok) return materialized;
  const inputBytes = Buffer.from(await materialized.arrayBuffer());
  if (inputBytes.byteLength > MAX_AUDIO_BYTES) {
    throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
  }
  const tempDir = await mkdtemp(resolve(tmpdir(), "spotify-licensed-"));
  const inputPath = resolve(tempDir, "source.mp4");
  const outputPath = resolve(tempDir, "output.flac");
  try {
    await writeFile(inputPath, inputBytes);
    try {
      // Stream-copy the FLAC frames out of the fMP4 — bit-exact, no re-encode.
      await runFfmpeg(["-i", inputPath, "-vn", "-map_metadata", "-1", "-c:a", "copy", "-f", "flac", outputPath]);
    } catch {
      // Fallback for a non-FLAC lossless DASH source: decode + losslessly re-encode.
      await runFfmpeg(["-i", inputPath, "-vn", "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "8", outputPath]);
    }
    const outputBytes = await readFile(outputPath);
    if (outputBytes.byteLength > MAX_AUDIO_BYTES) {
      throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
    }
    return new Response(outputBytes, {
      headers: {
        "content-type": "audio/flac",
        "content-length": String(outputBytes.byteLength),
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function materializeDeezerStream(
  stream: LicensedSourceStream,
  userAgent?: string,
): Promise<Response> {
  const fallbackId =
    stream.deezerId ||
    Number(stream.metadata?.deezerId) ||
    resolveDeezerDecryptionId(stream.streamUrl, 0);
  const response = await materializeLicensedSourceStream(stream, {
    maxBytes: MAX_AUDIO_BYTES,
    userAgent,
  });
  if (!response.ok) return response;
  const encrypted = Buffer.from(await response.arrayBuffer());
  const decrypted = maybeDecryptDeezerBuffer(encrypted, stream.streamUrl, fallbackId);
  return new Response(new Uint8Array(decrypted), {
    headers: {
      "content-type": "audio/flac",
      "content-length": String(decrypted.byteLength),
    },
  });
}

function isDeezerLicensedStream(stream: LicensedSourceStream): boolean {
  if (stream.deezerId || Number(stream.metadata?.deezerId) > 0) return true;
  try {
    const host = new URL(stream.streamUrl).hostname.toLowerCase();
    return host.includes("dzcdn.net") || host.includes("deezer.com");
  } catch {
    return false;
  }
}

// Pick the right materialization strategy for a licensed stream (encrypted MP4,
// DASH→FLAC remux, Deezer BF-CBC, or a plain licensed URL). Shared by the
// on-demand /api/licensed-source/materialize endpoint and Discover staging.
async function materializeLicensedStreamToResponse(
  stream: LicensedSourceStream,
  userAgent?: string,
): Promise<Response> {
  if (stream.decryptionKey) return materializeEncryptedLicensedSourceStream(stream, userAgent);
  if (stream.kind === "dash") return materializeDashStreamToFlac(stream, userAgent);
  if (isDeezerLicensedStream(stream)) return materializeDeezerStream(stream, userAgent);
  return materializeLicensedSourceStream(stream, { maxBytes: MAX_AUDIO_BYTES, userAgent });
}

async function handleLicensedSourceMaterialize(request: Request): Promise<Response> {
  if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const payload = await readJsonBody<{
    stream?: unknown;
    userAgent?: unknown;
  }>(request);
  const stream = payload?.stream;
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
    return json({ error: "Licensed source stream is required" }, { status: 400 });
  }
  try {
    const licensedStream = stream as LicensedSourceStream;
    const userAgent = typeof payload?.userAgent === "string" ? payload.userAgent : undefined;
    const response = await materializeLicensedStreamToResponse(licensedStream, userAgent);
    if (!response.ok || !response.body) return json({ error: `Audio server returned ${response.status}` }, { status: 502 });
    const headers = new Headers();
    headers.set("content-type", response.headers.get("content-type") || "audio/flac");
    const length = response.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(response.body, { headers });
  } catch (error) {
    if (error instanceof LicensedSourceDownloadError) {
      return json({ error: error.message }, { status: error.status });
    }
    if (error instanceof PayloadTooLargeError) {
      return json({ error: error.message }, { status: 413 });
    }
    if (error instanceof RemoteUrlError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

// --- Discover staging (Top-50 pre-download cache) ----------------------------
// A hidden ".discover" folder under the shared music root holds pre-downloaded
// "Top 50" tracks so the client can play them INSTANTLY without adding them to
// the library. collectAudioFiles() skips dot-entries, so staged files never
// appear in the scan / search / liked surfaces — yet /api/files/local/ still
// streams them by path. "Keep" (like / playlist / download) promotes a staged
// file into the visible library tree (handleDiscoverPromote); rotation deletes
// un-kept tracks that fell off the Top 50 more than DISCOVER_STAGING_TTL_MS ago.
const DISCOVER_STAGING_DIRNAME = ".discover";
const DISCOVER_STAGING_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks after leaving the Top 50
const DISCOVER_MANIFEST_VERSION = 1;
const DISCOVER_DEFAULT_USER_AGENT = "spotify/1.0 (+https://music.streamarena.xyz)";

// Mirrors the Worker's ResolvedAudioDownload, shipped over the proxy as JSON.
type DiscoverResolvedCandidate = {
  service?: string;
  streamUrl?: string;
  headers?: Record<string, string>;
  contentType?: string;
  licensedStream?: LicensedSourceStream;
  userAgent?: string;
};
type DiscoverResolved = DiscoverResolvedCandidate & {
  fallbacks?: DiscoverResolvedCandidate[];
};

type DiscoverStageItem = {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl?: string;
  durationMs?: number;
  // Lossless (Add path): the Worker ships a resolved Spotiflac descriptor.
  resolved?: DiscoverResolved;
  // Preview/play path: stage a YouTube Opus copy on the mini instead (no resolver).
  // Preview entries are lossy and must be re-staged via the resolver before promote.
  preview?: boolean;
  // When set (YouTube Music mix tracks), the preview stages THIS exact video's
  // Opus directly — no title/artist search — since we already know the videoId.
  youtubeVideoId?: string;
};

type DiscoverStagingEntry = {
  trackId: string;
  stagedRelPath: string; // ".discover/<trackId>/<stem><ext>" under the shared root
  coverRelPath?: string;
  finalRelPath: string; // "<stem><ext>" — promote target; the library id is derived from this
  finalId: string; // stableSongId(finalRelPath) — stable across promotion
  title: string;
  artist: string;
  album?: string;
  imageUrl?: string;
  durationMs?: number;
  firstSeenAt: number;
  lastSeenAt: number; // last time this track appeared in a Top-50 sync
  // false => YouTube Opus preview (lossy). Such an entry is playable but must be
  // re-staged via the lossless resolver before it can be promoted into the
  // library. Absent/true => lossless (resolver) — safe to promote.
  lossless?: boolean;
};

type DiscoverManifest = {
  version: number;
  entries: Record<string, DiscoverStagingEntry>;
};

function discoverStagingRoot(source: LibrarySource): string {
  return resolve(source.root, DISCOVER_STAGING_DIRNAME);
}
function discoverManifestPath(source: LibrarySource): string {
  return resolve(dirname(source.cachePath), "discover-staging.json");
}

let discoverManifestCache: DiscoverManifest | null = null;
let discoverManifestChain: Promise<unknown> = Promise.resolve();
const discoverInFlight = new Set<string>();

async function readDiscoverManifest(source: LibrarySource): Promise<DiscoverManifest> {
  if (discoverManifestCache) return discoverManifestCache;
  try {
    const raw = await readFile(discoverManifestPath(source), "utf8");
    const parsed = JSON.parse(raw) as DiscoverManifest;
    if (parsed && parsed.version === DISCOVER_MANIFEST_VERSION && parsed.entries && typeof parsed.entries === "object") {
      discoverManifestCache = { version: DISCOVER_MANIFEST_VERSION, entries: parsed.entries };
      return discoverManifestCache;
    }
  } catch {
    // no manifest yet
  }
  discoverManifestCache = { version: DISCOVER_MANIFEST_VERSION, entries: {} };
  return discoverManifestCache;
}

async function writeDiscoverManifest(source: LibrarySource, manifest: DiscoverManifest): Promise<void> {
  discoverManifestCache = manifest;
  const target = discoverManifestPath(source);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tempPath, target);
}

// Serialize read-modify-write so concurrent sync/promote calls can't clobber the manifest.
function withDiscoverManifestLock<T>(task: () => Promise<T>): Promise<T> {
  const run = discoverManifestChain.then(task, task);
  discoverManifestChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// yt-dlp installs into prefixes that launchd's minimal PATH omits, so probe known
// locations (mirrors ffmpegPath()). ~/.local/bin is checked FIRST because that's
// where scripts/install-mini-yt-dlp.sh drops the self-updating standalone binary
// (`yt-dlp -U` weekly) — YouTube breaks extraction often, so the auto-updated copy
// must win over a possibly-stale Homebrew one.
function ytDlpPath(): string {
  const fromEnv = process.env.YT_DLP_PATH?.trim();
  if (fromEnv) return fromEnv;
  for (const candidate of [
    `${homedir()}/.local/bin/yt-dlp`,
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "yt-dlp";
}

// Premium cookies (YouTube Music subscriber session) unlock itag 774 (~257k opus).
// Prefer an explicit env path; otherwise use the standard mini location if present.
// Absent → anonymous (~131k opus). install-mini-yt-dlp.sh refreshes this file.
function youtubeCookiesFile(): string | undefined {
  const fromEnv = process.env.YOUTUBE_COOKIES_FILE?.trim();
  if (fromEnv) return fromEnv;
  const standard = `${homedir()}/.config/spotify/youtube-cookies.txt`;
  return existsSync(standard) ? standard : undefined;
}

function youtubePreviewConfig(): YouTubePreviewConfig {
  return {
    ...DEFAULT_YOUTUBE_PREVIEW_CONFIG,
    ytDlpPath: ytDlpPath(),
    ffmpegLocation: dirname(ffmpegPath()),
    cookiesFile: youtubeCookiesFile(),
    // yt-dlp shells out to deno (Homebrew) to solve YouTube's n-challenge; under
    // launchd the server PATH omits it, so add the likely bin dirs explicitly.
    extraPath: [dirname(ytDlpPath()), dirname(ffmpegPath()), "/opt/homebrew/bin", `${homedir()}/.local/bin`],
  };
}

// Resolve a Smart Shuffle rec to a YouTube video and stage its Opus audio. Returns
// null (caller falls back / skips) when no confident match exists — never stages
// the wrong track. Keeps native Opus (~140k anon); no lossy re-encode.
async function fetchYouTubePreviewAudio(item: DiscoverStageItem): Promise<{ bytes: Buffer; ext: string } | null> {
  const config = youtubePreviewConfig();
  // YouTube Music mix tracks already carry their videoId — download that exact
  // video (no search, more accurate + cheaper). Smart Shuffle recs have only a
  // title/artist, so they match-then-download.
  let videoId = item.youtubeVideoId;
  if (!videoId) {
    const match = await resolveYouTubePreviewMatch(
      { title: item.title, artist: item.artist, durationMs: item.durationMs },
      config,
    ).catch(() => null);
    if (!match) return null;
    videoId = match.videoId;
  }
  try {
    const audio = await downloadYouTubePreviewAudioResilient(videoId, config);
    if (!audio.bytes.byteLength || audio.bytes.byteLength > MAX_AUDIO_BYTES) return null;
    return audio;
  } catch {
    return null;
  }
}

// Walk the resolved descriptor's candidates (best first) materializing/fetching
// until one yields audio bytes. Licensed streams remux locally (ffmpeg); plain
// http(s) candidates are fetched directly with an allowlisted header set.
async function fetchDiscoverCandidateAudio(resolved: DiscoverResolved): Promise<{ bytes: Buffer; ext: string } | null> {
  const candidates = [resolved, ...(Array.isArray(resolved.fallbacks) ? resolved.fallbacks : [])];
  for (const candidate of candidates) {
    try {
      if (candidate.licensedStream) {
        const response = await materializeLicensedStreamToResponse(candidate.licensedStream, candidate.userAgent);
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) continue;
        return { bytes, ext: audioExtensionFromContentType(response.headers.get("content-type") || "audio/flac") };
      }
      const parsed = candidate.streamUrl ? parseHttpUrl(candidate.streamUrl) : null;
      if (!parsed) continue;
      const response = await fetchPublicHttpUrl(
        parsed,
        { headers: licensedMediaRequestHeaders(candidate.headers, candidate.userAgent || DISCOVER_DEFAULT_USER_AGENT) },
        120_000,
      );
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) continue;
      const contentType = response.headers.get("content-type") || candidate.contentType || "audio/flac";
      return {
        bytes,
        ext: extensionFromRemoteUrl(candidate.streamUrl || "", AUDIO_EXTENSIONS, audioExtensionFromContentType(contentType)),
      };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function writeDiscoverStagedFile(
  source: LibrarySource,
  item: DiscoverStageItem,
  audio: { bytes: Buffer; ext: string },
): Promise<DiscoverStagingEntry> {
  const stem = sanitizeFileName(`${item.artist} - ${item.title}`);
  const ext = AUDIO_EXTENSIONS.has(audio.ext) ? audio.ext : ".flac";
  const stagedDir = resolve(discoverStagingRoot(source), sanitizeFileName(item.trackId));
  const stagedAudioPath = resolve(stagedDir, `${stem}${ext}`);
  await mkdir(stagedDir, { recursive: true });
  const tempPath = `${stagedAudioPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, audio.bytes);
  await rename(tempPath, stagedAudioPath);

  const sidecar: LocalSidecar = {
    version: 1,
    title: item.title,
    artist: item.artist,
    album: item.album || undefined,
    updatedAt: new Date().toISOString(),
  };
  let coverRelPath: string | undefined;
  if (item.imageUrl) {
    const coverName = await saveRemoteImage(
      item.imageUrl,
      basename(stagedAudioPath, extname(stagedAudioPath)),
      stagedAudioPath,
    ).catch(() => undefined);
    if (coverName) {
      sidecar.coverFile = coverName;
      coverRelPath = relative(source.root, resolve(stagedDir, coverName)).split(sep).join("/");
    }
  }
  await writeSidecar(stagedAudioPath, sidecar);

  const finalRelPath = `${stem}${ext}`;
  const now = Date.now();
  return {
    trackId: item.trackId,
    stagedRelPath: relative(source.root, stagedAudioPath).split(sep).join("/"),
    coverRelPath,
    finalRelPath,
    finalId: stableSongId(finalRelPath),
    title: item.title,
    artist: item.artist,
    album: item.album,
    imageUrl: item.imageUrl,
    durationMs: item.durationMs,
    firstSeenAt: now,
    lastSeenAt: now,
    lossless: !item.preview,
  };
}

async function stageDiscoverTrack(source: LibrarySource, item: DiscoverStageItem): Promise<DiscoverStagingEntry | null> {
  const manifest = await readDiscoverManifest(source);
  const existing = manifest.entries[item.trackId];
  const existingUsable = existing && existsSync(resolve(source.root, existing.stagedRelPath));
  // Reuse a staged copy when it satisfies the request. A lossy preview does NOT
  // satisfy a lossless (Add) request, so fall through and re-stage as FLAC.
  if (existingUsable && (item.preview || existing.lossless !== false)) return existing;
  if (discoverInFlight.has(item.trackId)) return null;
  discoverInFlight.add(item.trackId);
  try {
    const audio = item.preview
      ? await fetchYouTubePreviewAudio(item)
      : item.resolved
        ? await fetchDiscoverCandidateAudio(item.resolved)
        : null;
    if (!audio) return null;
    const entry = await writeDiscoverStagedFile(source, item, audio);
    return withDiscoverManifestLock(async () => {
      const current = await readDiscoverManifest(source);
      const firstSeenAt = current.entries[item.trackId]?.firstSeenAt ?? entry.firstSeenAt;
      current.entries[item.trackId] = { ...entry, firstSeenAt };
      await writeDiscoverManifest(source, current);
      return current.entries[item.trackId];
    });
  } finally {
    discoverInFlight.delete(item.trackId);
  }
}

async function pruneDiscoverStaging(source: LibrarySource, presentTrackIds: Set<string>): Promise<void> {
  await withDiscoverManifestLock(async () => {
    const manifest = await readDiscoverManifest(source);
    const now = Date.now();
    let changed = false;
    for (const [trackId, entry] of Object.entries(manifest.entries)) {
      if (presentTrackIds.has(trackId)) {
        entry.lastSeenAt = now;
        changed = true;
        continue;
      }
      if (now - entry.lastSeenAt > DISCOVER_STAGING_TTL_MS) {
        await rm(resolve(discoverStagingRoot(source), sanitizeFileName(trackId)), { recursive: true, force: true }).catch(
          () => {},
        );
        delete manifest.entries[trackId];
        changed = true;
      }
    }
    if (changed) await writeDiscoverManifest(source, manifest);
  });
}

async function removeDiscoverEntry(source: LibrarySource, trackId: string): Promise<void> {
  await withDiscoverManifestLock(async () => {
    const manifest = await readDiscoverManifest(source);
    if (manifest.entries[trackId]) {
      delete manifest.entries[trackId];
      await writeDiscoverManifest(source, manifest);
    }
  });
  await rm(resolve(discoverStagingRoot(source), sanitizeFileName(trackId)), { recursive: true, force: true }).catch(() => {});
}

function discoverEntryToSong(entry: DiscoverStagingEntry): PlayerSong {
  return {
    id: entry.finalId,
    title: entry.title,
    artist: entry.artist,
    album: entry.album || undefined,
    imageUrl: entry.coverRelPath
      ? `/api/files/local/${encodeRelativePath(entry.coverRelPath)}`
      : entry.imageUrl || `/api/artwork/local/${encodeURIComponent(entry.finalId)}`,
    audioUrl: `/api/files/local/${encodeRelativePath(entry.stagedRelPath)}`,
    duration: entry.durationMs ? Math.round(entry.durationMs / 1000) : undefined,
    source: "server",
    localPath: entry.stagedRelPath,
    staged: true,
    discoverTrackId: entry.trackId,
  };
}

// Discover staging files live in the shared root but are streamed by clients
// that can't present the proxy token or a session cookie — notably the native
// iOS AVPlayer, which fetches the URL directly (bypassing the Worker). Sign
// their media URLs for the shared scope, exactly as songForRequest does for
// normal library songs, so hasValidMediaSignature() authorizes them. Without
// this the native player gets a 403 and the track silently fails to load.
const DISCOVER_MEDIA_IDENTITY: RequestUserIdentity = {
  id: LOCAL_USER.id,
  email: LOCAL_USER.email,
  name: LOCAL_USER.name,
  local: false,
};
function signDiscoverMediaUrl(mediaUrl: string | undefined): string | undefined {
  return appendMediaSignature(mediaUrl, DISCOVER_MEDIA_IDENTITY) ?? mediaUrl;
}
function signDiscoverSong(song: PlayerSong): PlayerSong {
  return {
    ...song,
    imageUrl: signDiscoverMediaUrl(song.imageUrl) || song.imageUrl,
    audioUrl: signDiscoverMediaUrl(song.audioUrl) || song.audioUrl,
    lyricsUrl: signDiscoverMediaUrl(song.lyricsUrl),
  };
}

function normalizeDiscoverStageItem(raw: unknown): DiscoverStageItem | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const trackId = typeof value.trackId === "string" ? value.trackId.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const artist = typeof value.artist === "string" ? value.artist.trim() : "";
  const preview = value.preview === true;
  const resolved = value.resolved;
  const youtubeVideoId = typeof value.youtubeVideoId === "string" ? value.youtubeVideoId.trim() : "";
  // A direct-videoId preview (YouTube Music mix) needs only a trackId + videoId —
  // we download that exact video, so a clean artist isn't required. Everything else
  // still needs a title + artist to search/label.
  if (!trackId) return null;
  if (youtubeVideoId) {
    if (!title) return null;
  } else if (!title || !artist) {
    return null;
  }
  // A lossless (Add) item must carry a resolver descriptor; a preview item
  // resolves on the mini via YouTube and needs none.
  if (!preview && (!resolved || typeof resolved !== "object")) return null;
  return {
    trackId,
    title,
    artist,
    album: typeof value.album === "string" ? value.album.trim() : undefined,
    imageUrl: typeof value.imageUrl === "string" ? value.imageUrl.trim() : undefined,
    durationMs: typeof value.durationMs === "number" && value.durationMs > 0 ? value.durationMs : undefined,
    preview,
    resolved: resolved && typeof resolved === "object" ? (resolved as DiscoverResolved) : undefined,
    youtubeVideoId: youtubeVideoId || undefined,
  };
}

async function discoverStagingStatusBody(
  source: LibrarySource,
): Promise<{ entries: Array<{ trackId: string; id: string; audioUrl: string; duration?: number }> }> {
  const manifest = await readDiscoverManifest(source);
  const entries = Object.values(manifest.entries)
    .filter((entry) => existsSync(resolve(source.root, entry.stagedRelPath)))
    .map((entry) => {
      const audioUrl = `/api/files/local/${encodeRelativePath(entry.stagedRelPath)}`;
      return {
        trackId: entry.trackId,
        id: entry.finalId,
        audioUrl: signDiscoverMediaUrl(audioUrl) || audioUrl,
        duration: entry.durationMs ? Math.round(entry.durationMs / 1000) : undefined,
      };
    });
  return { entries };
}

async function handleDiscoverStagingStatus(request: Request): Promise<Response> {
  const source = librarySourceForRequest(request);
  if (!source || !source.shared) return jsonCached(request, { entries: [] }, { cacheControl: "private, max-age=10" });
  return jsonCached(request, await discoverStagingStatusBody(source), { cacheControl: "private, max-age=10" });
}

async function handleDiscoverSync(request: Request): Promise<Response> {
  if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const source = librarySourceForRequest(request);
  if (!source || !source.shared) return forbiddenLibraryResponse();
  const payload = await readJsonBody<{ present?: unknown; stage?: unknown }>(request);
  const present = Array.isArray(payload?.present)
    ? payload.present.filter((value): value is string => typeof value === "string")
    : [];
  await pruneDiscoverStaging(source, new Set(present));
  const stageRaw = Array.isArray(payload?.stage) ? payload.stage : [];
  const stageItems = stageRaw
    .map((raw) => normalizeDiscoverStageItem(raw))
    .filter((item): item is DiscoverStageItem => item !== null);
  // Materialize in the background, ONE at a time — the long-running server has no
  // time budget, and serializing keeps the download/remux from spiking CPU and
  // bandwidth (which would stutter active playback). Clients pick newly-ready
  // tracks up on their next status poll.
  if (stageItems.length) {
    void (async () => {
      for (const item of stageItems) {
        await stageDiscoverTrack(source, item).catch(() => {});
      }
    })();
  }
  return json(await discoverStagingStatusBody(source));
}

async function handleDiscoverStageNow(request: Request): Promise<Response> {
  if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const source = librarySourceForRequest(request);
  if (!source || !source.shared) return forbiddenLibraryResponse();
  const item = normalizeDiscoverStageItem(await readJsonBody<unknown>(request));
  if (!item) return json({ error: "trackId, title, artist, and (resolved or preview) are required" }, { status: 400 });
  const entry = await stageDiscoverTrack(source, item);
  if (!entry) return json({ error: "Could not stage this track" }, { status: 502 });
  return json(signDiscoverSong(discoverEntryToSong(entry)));
}

// A yt-dlp flat-playlist fetch costs ~5-15s, so cache the parsed mix in memory and
// only re-run yt-dlp every YT_PLAYLIST_CACHE_TTL_MS. The mix "auto-updates", but a
// short staleness is invisible for a Discover surface — and this keeps repeat opens
// (and the Home card's worker round-trip) instant. The staged-status overlay is
// still computed fresh per request from the live manifest; only the track LIST is
// cached.
const YT_PLAYLIST_CACHE_TTL_MS = 30 * 60 * 1000;
const ytPlaylistCache = new Map<string, { at: number; mix: Awaited<ReturnType<typeof fetchYouTubeMusicPlaylist>> }>();
async function fetchYouTubeMusicPlaylistCached(
  listId: string,
): Promise<Awaited<ReturnType<typeof fetchYouTubeMusicPlaylist>>> {
  const hit = ytPlaylistCache.get(listId);
  if (hit && Date.now() - hit.at < YT_PLAYLIST_CACHE_TTL_MS) return hit.mix;
  const mix = await fetchYouTubeMusicPlaylist(listId, youtubePreviewConfig());
  // Only cache a non-empty result — never poison the cache with a transient
  // empty/failed fetch (the caller treats empty as a 502).
  if (mix.entries.length) ytPlaylistCache.set(listId, { at: Date.now(), mix });
  return mix;
}

const YT_PLAYLIST_SEARCH_LIMIT = 8;
const YT_PLAYLIST_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const YT_PLAYLIST_SEARCH_CACHE_MAX_ENTRIES = 64;
const ytPlaylistSearchCache = new Map<string, { at: number; playlists: YouTubePlaylistSearchResult[] }>();
const ytPlaylistSearchInFlight = new Map<string, Promise<YouTubePlaylistSearchResult[]>>();

function cacheYouTubePlaylistSearch(
  key: string,
  playlists: YouTubePlaylistSearchResult[],
): YouTubePlaylistSearchResult[] {
  // Map insertion order is our LRU order. Refreshing a key moves it to the end;
  // when full, evict the oldest query so arbitrary searches cannot grow memory
  // without bound.
  ytPlaylistSearchCache.delete(key);
  while (ytPlaylistSearchCache.size >= YT_PLAYLIST_SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = ytPlaylistSearchCache.keys().next().value;
    if (typeof oldest !== "string") break;
    ytPlaylistSearchCache.delete(oldest);
  }
  ytPlaylistSearchCache.set(key, { at: Date.now(), playlists });
  return playlists;
}

async function searchYouTubePlaylistsCached(query: string): Promise<YouTubePlaylistSearchResult[]> {
  const key = query.toLowerCase();
  const hit = ytPlaylistSearchCache.get(key);
  if (hit && Date.now() - hit.at < YT_PLAYLIST_SEARCH_CACHE_TTL_MS) {
    ytPlaylistSearchCache.delete(key);
    ytPlaylistSearchCache.set(key, hit);
    return hit.playlists;
  }
  if (hit) ytPlaylistSearchCache.delete(key);

  const pending = ytPlaylistSearchInFlight.get(key);
  if (pending) return pending;

  const work = searchYouTubePlaylists(query, youtubePreviewConfig(), YT_PLAYLIST_SEARCH_LIMIT)
    .then((playlists) => cacheYouTubePlaylistSearch(key, playlists))
    .finally(() => {
      ytPlaylistSearchInFlight.delete(key);
    });
  ytPlaylistSearchInFlight.set(key, work);
  return work;
}

async function handleYouTubePlaylistSearch(request: Request, url: URL): Promise<Response> {
  if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const query = normalizeYouTubePlaylistSearchQuery(url.searchParams.get("q") || "");
  if (!query) {
    return json(
      { error: "q must be between 2 and 100 characters" },
      { status: 400 },
    );
  }

  try {
    const playlists = await searchYouTubePlaylistsCached(query);
    return jsonCached(
      request,
      { provider: "youtube", playlists },
      { cacheControl: "private, max-age=60, stale-while-revalidate=300" },
    );
  } catch {
    // Preserve the distinction between "no matching playlists" (200 + []) and
    // an unavailable yt-dlp/YouTube search surface (502) so the Worker can return
    // partial Spotify results without misreporting an outage as an empty search.
    return json({ error: "Couldn't search YouTube playlists" }, { status: 502 });
  }
}

// A YouTube Music mix (e.g. a "Discover Mix" RDTMAK5uy_* auto-mix) surfaced as a
// read-through playlist. Fetched live via yt-dlp with the owner's Premium cookies,
// so it's their personalized, auto-updating mix. Each track is a placeholder that
// stages its YouTube Opus preview on demand by videoId — nothing is written to the
// library. Owner/shared library only.
async function handleYouTubeMusicPlaylist(request: Request, listId: string): Promise<Response> {
  const userId = currentUserIdForRequest(request);
  if (!userId) return json({ error: "Unauthorized" }, { status: 401 });
  const source = librarySourceForRequest(request);
  if (!source || !source.shared) return forbiddenLibraryResponse();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(listId)) return notFound("Playlist not found");

  let mix: Awaited<ReturnType<typeof fetchYouTubeMusicPlaylist>>;
  try {
    mix = await fetchYouTubeMusicPlaylistCached(listId);
  } catch {
    return json({ error: "Couldn't load this mix" }, { status: 502 });
  }
  if (!mix.entries.length) return json({ error: "This mix is empty right now" }, { status: 502 });

  const manifest = await readDiscoverManifest(source);
  const songs: PlayerSong[] = mix.entries.map((entry) => {
    const trackId = `yt:${entry.videoId}`;
    const cached = manifest.entries[trackId];
    // Already staged (played before) → an instantly-playable real song.
    if (cached && existsSync(resolve(source.root, cached.stagedRelPath))) {
      return signDiscoverSong({ ...discoverEntryToSong(cached), youtubeVideoId: entry.videoId });
    }
    // Not staged → a placeholder the discover-stager materializes on play (by
    // videoId). Empty audioUrl keeps the engine idle until the swap.
    return {
      id: `discover:${trackId}`,
      title: entry.title,
      artist: entry.artist,
      imageUrl: entry.imageUrl,
      audioUrl: "",
      source: "server",
      discoverTrackId: trackId,
      youtubeVideoId: entry.videoId,
    };
  });

  return jsonCached(
    request,
    {
      kind: "curated",
      playlist: {
        id: `yt-mix-${listId}`,
        name: mix.title || "Discover Mix",
        // Prefer a TRACK thumbnail (i.ytimg.com/vi/<id> — stable, always 200) over
        // the playlist-level s_p thumbnail, which yt-dlp sometimes reports at a size
        // that 404s (e.g. maxresdefault for a mix that only has mq/sd) → a broken
        // cover. The first track's art is a fine, reliable mix cover.
        imageUrl: songs.find((song) => song.imageUrl)?.imageUrl || mix.imageUrl || null,
        userId,
        createdAt: new Date().toISOString(),
      },
      songs,
      // A provider playlist is not an authoritative snapshot of the user's
      // global likes. Null tells clients to preserve their hydrated heart set.
      likedSongIds: null,
    },
    { cacheControl: "private, max-age=1800, stale-while-revalidate=3600" },
  );
}

async function handleDiscoverPromote(request: Request): Promise<Response> {
  if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const source = librarySourceForRequest(request);
  if (!source || !source.shared) return forbiddenLibraryResponse();
  const payload = await readJsonBody<{ trackId?: unknown; finalId?: unknown }>(request);
  const trackId = typeof payload?.trackId === "string" ? payload.trackId.trim() : "";
  if (!trackId) return json({ error: "trackId is required" }, { status: 400 });

  const manifest = await readDiscoverManifest(source);
  const entry = manifest.entries[trackId];
  if (!entry) {
    // Idempotent: this track was already promoted (no longer staged). If the
    // client passed the expected final library id and that song exists, return
    // it so "keep" still succeeds instead of erroring.
    const finalId = typeof payload?.finalId === "string" ? payload.finalId.trim() : "";
    if (finalId) {
      const existing = (await getLibrary(source)).entriesById.get(finalId);
      if (existing) return json(signDiscoverSong(existing.song));
    }
    return notFound("Staged track not found");
  }

  // Already owned (same title+artist already in the library)? Keep that, drop the
  // staging copy. Checked BEFORE the lossless guard below so liking / adding a
  // PREVIEW of a song you already own resolves to the owned FLAC instantly — no
  // pointless lossless re-stage (a full resolver round-trip + FLAC download) of a
  // track that's already in the library.
  const snapshot = await getLibrary(source);
  const duplicate = snapshot.songs
    .map((song) => snapshot.entriesById.get(song.id))
    .find((candidate): candidate is LocalSongEntry =>
      Boolean(candidate && trackKey(candidate.song.title, candidate.song.artist) === trackKey(entry.title, entry.artist)),
    );
  if (duplicate) {
    await removeDiscoverEntry(source, trackId);
    return json(signDiscoverSong(duplicate.song));
  }

  // A YouTube preview is lossy — never promote it into the FLAC library. The
  // client must re-stage this track via the lossless resolver first (POST
  // /api/discover/stage WITHOUT preview), which overwrites the entry as
  // lossless; promote then succeeds.
  if (entry.lossless === false) {
    return json(
      {
        error: "preview_not_lossless",
        message: "Re-stage this track losslessly before adding it to the library.",
      },
      { status: 409 },
    );
  }

  const stagedAudioPath = resolve(source.root, entry.stagedRelPath);
  if (!existsSync(stagedAudioPath)) {
    await removeDiscoverEntry(source, trackId);
    return notFound("Staged audio is no longer available");
  }

  // Move the audio (and its cover) out of ".discover" into the visible library
  // tree so the next scan picks it up and it becomes a real, likeable song.
  const audioExt = extname(stagedAudioPath);
  const finalAudioPath = await uniquePath(resolve(source.root, entry.finalRelPath));
  const finalStem = basename(finalAudioPath, audioExt);
  await rename(stagedAudioPath, finalAudioPath);

  const sidecar: LocalSidecar = {
    version: 1,
    title: entry.title,
    artist: entry.artist,
    album: entry.album || undefined,
    updatedAt: new Date().toISOString(),
  };
  if (entry.coverRelPath) {
    const stagedCover = resolve(source.root, entry.coverRelPath);
    if (existsSync(stagedCover)) {
      const coverName = `${finalStem}.cover${extname(stagedCover)}`;
      const finalCover = resolve(dirname(finalAudioPath), coverName);
      await rename(stagedCover, finalCover).catch(() => {});
      if (existsSync(finalCover)) sidecar.coverFile = coverName;
    }
  }
  await writeSidecar(finalAudioPath, sidecar);

  const next = await getLibrary(source, true);
  const finalRel = relative(source.root, finalAudioPath).split(sep).join("/");
  const scanned = next.entriesByPath.get(finalRel);
  await removeDiscoverEntry(source, trackId);
  if (!scanned) return json({ error: "Promoted song could not be scanned" }, { status: 500 });
  return json(signDiscoverSong(scanned.song));
}

// Refetch the CORRECT (studio) version of a library song from YouTube and replace
// its audio file in place. The wrong-version file is backed up to a scan-ignored
// ".wrong-version" folder (reversible). The new file keeps the song's ORIGINAL id
// via a pinned sidecar, so the owner's like + any playlist rows stay valid and the
// song is served live as the new copy. Owner/shared library only.
async function handleRefetchYouTube(source: LibrarySource, id: string, request: Request): Promise<Response> {
  if (!source.shared) return forbiddenLibraryResponse();
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");

  const body = await readJsonBody<{ title?: unknown; artist?: unknown }>(request);
  const title = (typeof body?.title === "string" && body.title.trim()) || entry.song.title;
  const artist = (typeof body?.artist === "string" && body.artist.trim()) || entry.song.artist;
  if (!title || !artist) return json({ error: "title and artist are required" }, { status: 400 });

  // Deliberately NO duration: the current file is the WRONG version, so its length
  // would bias the match toward another wrong cut. The matcher's studio/Topic
  // preference + artist gate pick the canonical version.
  const config = youtubePreviewConfig();
  const match = await resolveYouTubePreviewMatch({ title, artist }, config).catch(() => null);
  if (!match) {
    return json(
      { error: "no_youtube_match", message: "Couldn't find a confident YouTube match for this track." },
      { status: 404 },
    );
  }

  let audio: { bytes: Buffer; ext: string } | null;
  try {
    audio = await downloadYouTubePreviewAudioResilient(match.videoId, config);
  } catch {
    audio = null;
  }
  if (!audio || !audio.bytes.byteLength || audio.bytes.byteLength > MAX_AUDIO_BYTES) {
    return json({ error: "download_failed", message: "Couldn't download audio from YouTube." }, { status: 502 });
  }

  try {
    await replaceLibraryAudioInPlace(source, entry, id, audio, { title, artist });
  } catch (err) {
    console.error("[refetch-youtube] replace failed", err);
    return json(
      { error: "refetch_replace_failed", message: err instanceof Error ? err.message : "Couldn't replace the file." },
      { status: 500 },
    );
  }

  const next = await getLibrary(source, true);
  const updated = next.entriesById.get(id);
  if (!updated) {
    return json({ error: "refetch_rescan_failed", message: "Replaced the file but couldn't rescan it." }, { status: 500 });
  }
  return json(songForRequest(updated.song, request));
}

// Best-effort: if the old file has embedded artwork but no cover sibling, extract
// it to "<stem>.cover.<ext>" so the new (art-less) .opus keeps the album art.
// Returns the cover filename it wrote (for the sidecar), or undefined.
async function preserveEmbeddedCover(oldAbs: string, dir: string, stem: string): Promise<string | undefined> {
  const lowerStem = stem.toLowerCase();
  const names = await readdir(dir).catch(() => [] as string[]);
  const hasCover = names.some(
    (name) =>
      name.toLowerCase().startsWith(`${lowerStem}.cover.`) ||
      (IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) && name.replace(/\.[^.]+$/, "").toLowerCase() === lowerStem),
  );
  if (hasCover) return undefined;
  const parsed = await parseFile(oldAbs, { duration: false, skipCovers: false }).catch(() => null);
  const pic = parsed?.common.picture?.[0];
  if (!pic?.data?.length) return undefined;
  const ext = (pic.format || "").includes("png") ? ".png" : ".jpg";
  const coverName = `${stem}.cover${ext}`;
  await writeFile(resolve(dir, coverName), Buffer.from(pic.data));
  return coverName;
}

async function replaceLibraryAudioInPlace(
  source: LibrarySource,
  entry: LocalSongEntry,
  pinnedId: string,
  audio: { bytes: Buffer; ext: string },
  meta: { title: string; artist: string },
): Promise<void> {
  const oldAbs = entry.absolutePath;
  const dir = dirname(oldAbs);
  const stem = basename(oldAbs, extname(oldAbs));
  const lowerExt = audio.ext.toLowerCase();
  // Only write a container the scanner actually indexes — never write bytes under a
  // mismatched/unknown extension (e.g. raw .webm), which would make the song vanish
  // from the library. The Opus formats yt-dlp -x produces (.opus/.m4a/.ogg) qualify.
  if (!AUDIO_EXTENSIONS.has(lowerExt)) {
    throw new Error(`refetch produced an unsupported audio format: ${lowerExt || "unknown"}`);
  }
  const newAbs = resolve(dir, `${stem}${lowerExt}`);

  // 1) Preserve album art before touching the old file — but only when there is no
  // usable cover already (a valid sidecar ref or a same-stem sibling), to avoid
  // writing an orphaned extract.
  const sidecar = await readSidecar(oldAbs);
  const sidecarCoverValid = !!sidecar.coverFile && existsSync(resolve(dir, sidecar.coverFile));
  const coverName = sidecarCoverValid ? undefined : await preserveEmbeddedCover(oldAbs, dir, stem).catch(() => undefined);

  // 2) Write the new audio to a temp file FIRST and validate it parses. A failed or
  // corrupt download must never destroy the existing file — at this point the old
  // file is still fully intact, so any throw here leaves the library unchanged.
  const tempPath = `${newAbs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, audio.bytes);
  try {
    const probe = await parseFile(tempPath, { duration: true, skipCovers: true });
    if (!probe.format.duration || probe.format.duration <= 1) {
      throw new Error("downloaded audio is too short or unreadable");
    }
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err instanceof Error ? err : new Error("downloaded audio failed validation");
  }

  // 3) Back up the wrong-version audio to a scan-ignored ".wrong-version" dir
  // (reversible; a dot-dir is skipped by the scanner — Trash auto-empties here).
  const backupDir = resolve(dir, ".wrong-version");
  await mkdir(backupDir, { recursive: true });
  const backupPath = await uniquePath(resolve(backupDir, basename(oldAbs)));
  await rename(oldAbs, backupPath);

  // 4) Pin the id in the (stem-shared) sidecar BEFORE swapping the audio in, so a
  // crash can never leave the new audio present with an un-pinned sidecar — which
  // would mint a fresh path-hash id and orphan the like / playlist rows.
  sidecar.version = sidecar.version ?? 1;
  sidecar.songId = pinnedId;
  sidecar.title = meta.title;
  sidecar.artist = meta.artist;
  if (coverName && !sidecar.coverFile) sidecar.coverFile = coverName;
  sidecar.updatedAt = new Date().toISOString();
  await writeSidecar(newAbs, sidecar);

  // 5) Atomically move the validated audio into place (same dir → atomic rename).
  // If this last step fails, restore the original so the song is never left missing.
  try {
    await rename(tempPath, newAbs);
  } catch (err) {
    await rename(backupPath, oldAbs).catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function handleSongUpload(source: LibrarySource, request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("application/json")) {
    const payload = await readJsonBody<{
      title?: unknown;
      artist?: unknown;
      album?: unknown;
      audioUrl?: unknown;
      imageUrl?: unknown;
      lyricsText?: unknown;
      replaceExisting?: unknown;
      outputFormat?: unknown;
    }>(request);
    if (!payload) return json({ error: "Invalid JSON body" }, { status: 400 });
    return handleRemoteSongUpload({ ...payload, source });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid form body" }, { status: 400 });
  const title = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
  const artist = typeof form.get("artist") === "string" ? String(form.get("artist")).trim() : "";
  const album = typeof form.get("album") === "string" ? String(form.get("album")).trim() : "";
  const imageUrl = typeof form.get("imageUrl") === "string" ? String(form.get("imageUrl")).trim() : "";
  const image = form.get("image");
  const audio = form.get("audio");
  if (!title || !artist || !(audio instanceof File)) {
    return json({ error: "Title, artist, and audio are required" }, { status: 400 });
  }
  const invalidAudio = validateUploadFile(audio, "Audio file", MAX_AUDIO_BYTES, AUDIO_EXTENSIONS, "audio/");
  if (invalidAudio) return invalidAudio;
  if (image instanceof File && image.size > 0) {
    const invalidImage = validateUploadFile(image, "Image file", MAX_IMAGE_BYTES, IMAGE_EXTENSIONS, "image/");
    if (invalidImage) return invalidImage;
  }
  const lyricsText = typeof form.get("lyricsText") === "string" ? String(form.get("lyricsText")).trim() : "";
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }
  const replaceExisting =
    form.get("replaceExisting") === "true" ||
    form.get("replaceExisting") === "1" ||
    form.get("replaceExisting") === "yes";

  const currentSnapshot = await getLibrary(source);
  const existingEntry = currentSnapshot.songs
    .map((song) => currentSnapshot.entriesById.get(song.id))
    .find((entry): entry is LocalSongEntry =>
      Boolean(entry && trackKey(entry.song.title, entry.song.artist) === trackKey(title, artist)),
    );

  if (existingEntry && !replaceExisting) {
    return json(
      {
        error: "Song already exists in your library",
        code: "DUPLICATE_SONG",
        existingSong: {
          id: existingEntry.song.id,
          title: existingEntry.song.title,
          artist: existingEntry.song.artist,
        },
      },
      { status: 409 },
    );
  }

  const audioExt = AUDIO_EXTENSIONS.has(extname(audio.name).toLowerCase())
    ? extname(audio.name).toLowerCase()
    : ".mp3";
  const stem = sanitizeFileName(`${artist} - ${title}`);
  const preferredAudioPath = existingEntry && replaceExisting
    ? resolve(dirname(existingEntry.absolutePath), `${stem}${audioExt}`)
    : resolve(source.root, `${stem}${audioExt}`);
  const audioPath =
    existingEntry &&
    replaceExisting &&
    (!existsSync(preferredAudioPath) || preferredAudioPath === existingEntry.absolutePath)
      ? preferredAudioPath
      : await uniquePath(preferredAudioPath);
  const tempAudioPath = existingEntry && replaceExisting
    ? await uniquePath(resolve(
        dirname(audioPath),
        `.${basename(audioPath, extname(audioPath))}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${audioExt}`,
      ))
    : audioPath;
  await saveFile(audio, tempAudioPath);
  const replacementBackup = existingEntry && replaceExisting
    ? await backupSongEntryFiles(source, existingEntry)
    : null;
  try {
    if (replacementBackup) {
      await mkdir(dirname(audioPath), { recursive: true });
      await rename(tempAudioPath, audioPath);
    }

    const sidecar: LocalSidecar = {
      version: 1,
      title,
      artist,
      album: album || undefined,
      updatedAt: new Date().toISOString(),
    };

    if (image instanceof File && image.size > 0) {
      const imageExt = IMAGE_EXTENSIONS.has(extname(image.name).toLowerCase())
        ? extname(image.name).toLowerCase()
        : ".jpg";
      const coverName = `${basename(audioPath, extname(audioPath))}.cover${imageExt}`;
      await saveFile(image, resolve(dirname(audioPath), coverName));
      sidecar.coverFile = coverName;
    } else if (imageUrl) {
      sidecar.coverFile = await saveRemoteImage(imageUrl, basename(audioPath, extname(audioPath)), audioPath).catch(
        () => undefined,
      );
    }

    if (lyricsText) {
      const lyricsName = `${basename(audioPath, extname(audioPath))}.lrc`;
      await writeFile(resolve(dirname(audioPath), lyricsName), `${lyricsText}\n`, "utf8");
      sidecar.lyricsFile = lyricsName;
    }

    await writeSidecar(audioPath, sidecar);
    const snapshot = await getLibrary(source, true);
    const relativePath = relative(source.root, audioPath).split(sep).join("/");
    const entry = snapshot.entriesByPath.get(relativePath);
    if (!entry) throw new Error("Uploaded song could not be scanned");
    if (replacementBackup) await discardSongEntryBackup(replacementBackup);
    if (!existingEntry) await markSongLikedForSource(source, snapshot.songs, entry.song.id);
    return json(entry.song, { status: existingEntry && replaceExisting ? 200 : 201 });
  } catch (error) {
    await rm(tempAudioPath, { force: true }).catch(() => undefined);
    if (replacementBackup && existingEntry) {
      await restoreSongEntryBackup(source, existingEntry, audioPath, replacementBackup);
    }
    throw error;
  }
}

async function handlePatchSong(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const payload = await readJsonBody<{ title?: unknown; artist?: unknown }>(request);
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  const artist = typeof payload?.artist === "string" ? payload.artist.trim() : "";
  if (!title || !artist) return json({ error: "Title and artist are required" }, { status: 400 });

  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");
  const currentSidecar = await readSidecar(entry.absolutePath);
  await writeSidecar(entry.absolutePath, {
    ...currentSidecar,
    version: 1,
    title,
    artist,
    updatedAt: new Date().toISOString(),
  });
  const nextSnapshot = await getLibrary(source, true);
  const updated = nextSnapshot.entriesById.get(id);
  return updated ? json(updated.song) : notFound("Song not found");
}

// --- Lyrics auto-fetch (LRCLIB) ------------------------------------------
// LRCLIB (https://lrclib.net) is a free, crowd-sourced synced-lyrics API.
// We pull the timed .lrc (or plain text) for a track and write it as a sidecar
// next to the audio file so the normal library scan exposes `lyricsUrl`. Lyric
// text only ever flows provider -> sidecar file; it is never logged.
const LRCLIB_API = "https://lrclib.net/api";
const LRCLIB_USER_AGENT = "spotify-streamarena/1.0 (+https://music.streamarena.xyz)";

type ResolvedLyrics = { synced: string | null; plain: string | null };

function pickLyrics(synced: unknown, plain: unknown): ResolvedLyrics | null {
  const s = typeof synced === "string" && synced.trim() ? synced : null;
  const p = typeof plain === "string" && plain.trim() ? plain : null;
  return s || p ? { synced: s, plain: p } : null;
}

async function lrclibFetchJson(path: string, params: URLSearchParams): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${LRCLIB_API}${path}?${params.toString()}`, {
      headers: { "User-Agent": LRCLIB_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLyricsFromProvider(opts: {
  artist: string;
  title: string;
  album?: string | null;
  durationSec?: number | null;
}): Promise<ResolvedLyrics | null> {
  const artist = opts.artist?.trim();
  const title = opts.title?.trim();
  if (!artist || !title) return null;
  const duration = opts.durationSec && opts.durationSec > 0 ? Math.round(opts.durationSec) : null;

  // 1) Exact match — most reliable when the duration is known.
  {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (opts.album?.trim()) params.set("album_name", opts.album.trim());
    if (duration) params.set("duration", String(duration));
    const data = (await lrclibFetchJson("/get", params)) as Record<string, unknown> | null;
    if (data && typeof data === "object" && data.instrumental !== true) {
      const got = pickLyrics(data.syncedLyrics, data.plainLyrics);
      if (got) return got;
    }
  }

  // 2) Search fallback — prefer synced, then the closest duration.
  {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    const list = await lrclibFetchJson("/search", params);
    if (Array.isArray(list) && list.length > 0) {
      const best = list
        .filter(
          (r) =>
            r && typeof r === "object" && r.instrumental !== true && (r.syncedLyrics || r.plainLyrics),
        )
        .map((r) => ({
          r,
          hasSynced: Boolean(r.syncedLyrics),
          delta:
            duration && typeof r.duration === "number"
              ? Math.abs(r.duration - duration)
              : Number.MAX_SAFE_INTEGER,
        }))
        .sort((a, b) => (a.hasSynced === b.hasSynced ? a.delta - b.delta : a.hasSynced ? -1 : 1))[0];
      if (best) return pickLyrics(best.r.syncedLyrics, best.r.plainLyrics);
    }
  }

  return null;
}

// POST /api/songs/:id/lyrics — fetch lyrics from the provider and save the
// sidecar. `?force=1` re-fetches even if the song already has lyrics.
async function handleFetchLyrics(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");

  const force = new URL(request.url).searchParams.get("force") === "1";
  if (entry.song.lyricsUrl && !force) {
    return json(songForRequest(entry.song, request));
  }

  const resolved = await fetchLyricsFromProvider({
    artist: entry.song.artist,
    title: entry.song.title,
    album: entry.song.album ?? null,
    durationSec: entry.song.duration ?? null,
  });
  const body = resolved?.synced || resolved?.plain || "";
  if (!body.trim()) {
    return json({ error: "No lyrics found for this track", code: "LYRICS_NOT_FOUND" }, { status: 404 });
  }
  if (byteLength(body) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics are too large" }, { status: 413 });
  }

  const stem = basename(entry.absolutePath, extname(entry.absolutePath));
  const lyricsName = `${stem}.lrc`;
  await writeFile(resolve(dirname(entry.absolutePath), lyricsName), `${body}\n`, "utf8");
  const sidecar = await readSidecar(entry.absolutePath);
  await writeSidecar(entry.absolutePath, {
    ...sidecar,
    version: 1,
    lyricsFile: lyricsName,
    updatedAt: new Date().toISOString(),
  });

  const next = await getLibrary(source, true);
  const updated = next.entriesById.get(id);
  if (!updated) return json({ error: "Song could not be rescanned" }, { status: 500 });
  return json(songForRequest(updated.song, request));
}

async function handleSongAssets(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");

  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid form body" }, { status: 400 });
  const sidecar = await readSidecar(entry.absolutePath);
  const stem = basename(entry.absolutePath, extname(entry.absolutePath));
  const image = form.get("image");
  const lyricsFile = form.get("lyricsFile");
  const lyricsText = typeof form.get("lyricsText") === "string" ? String(form.get("lyricsText")).trim() : "";
  if (image instanceof File && image.size > 0) {
    const invalidImage = validateUploadFile(image, "Image file", MAX_IMAGE_BYTES, IMAGE_EXTENSIONS, "image/");
    if (invalidImage) return invalidImage;
  }
  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    const invalidLyrics = validateUploadFile(lyricsFile, "Lyrics file", MAX_LYRICS_BYTES, LYRICS_EXTENSIONS, "text/");
    if (invalidLyrics) return invalidLyrics;
  }
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }

  if (image instanceof File && image.size > 0) {
    const imageExt = IMAGE_EXTENSIONS.has(extname(image.name).toLowerCase())
      ? extname(image.name).toLowerCase()
      : ".jpg";
    const coverName = `${stem}.cover${imageExt}`;
    await saveFile(image, resolve(dirname(entry.absolutePath), coverName));
    sidecar.coverFile = coverName;
  }

  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    const lyricsExt = LYRICS_EXTENSIONS.has(extname(lyricsFile.name).toLowerCase())
      ? extname(lyricsFile.name).toLowerCase()
      : ".lrc";
    const lyricsName = `${stem}${lyricsExt}`;
    await saveFile(lyricsFile, resolve(dirname(entry.absolutePath), lyricsName));
    sidecar.lyricsFile = lyricsName;
  } else if (lyricsText) {
    const lyricsName = `${stem}.lrc`;
    await writeFile(resolve(dirname(entry.absolutePath), lyricsName), `${lyricsText}\n`, "utf8");
    sidecar.lyricsFile = lyricsName;
  }

  sidecar.updatedAt = new Date().toISOString();
  await writeSidecar(entry.absolutePath, sidecar);
  const nextSnapshot = await getLibrary(source, true);
  const updated = nextSnapshot.entriesById.get(id);
  return updated ? json(updated.song) : notFound("Song not found");
}

type ItunesArtworkResult = {
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  artworkUrl100?: string;
};

type DownloadedArtwork = {
  data: Uint8Array;
  contentType: string;
  sourceUrl: string;
};

class PayloadTooLargeError extends Error {}

function scoreItunesArtwork(song: PlayerSong, result: ItunesArtworkResult): number {
  if (!result.artworkUrl100) return 0;
  const titleScore = textMatchScore(song.title, result.trackName);
  const artistScore = textMatchScore(song.artist, result.artistName);
  const albumScore = song.album ? textMatchScore(song.album, result.collectionName) : 0;
  return titleScore * 4 + artistScore * 3 + albumScore * 2;
}

function highResolutionItunesArtworkUrl(url: string): string {
  return url.replace(/\/[0-9]+x[0-9]+bb\.(jpg|jpeg|png|webp)$/i, "/600x600bb.$1");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupRemoteArtwork(song: PlayerSong): Promise<DownloadedArtwork | null> {
  if (!remoteArtworkLookupEnabled) return null;

  const searchTerm = [song.artist, song.album || song.title].filter(Boolean).join(" ");
  if (!searchTerm.trim()) return null;

  const searchUrl = new URL("https://itunes.apple.com/search");
  searchUrl.searchParams.set("media", "music");
  searchUrl.searchParams.set("entity", "song");
  searchUrl.searchParams.set("limit", "10");
  searchUrl.searchParams.set("country", artworkLookupCountry);
  searchUrl.searchParams.set("term", searchTerm);

  const searchResponse = await fetchWithTimeout(searchUrl.toString(), {
    headers: { accept: "application/json" },
  });
  if (!searchResponse.ok) {
    await searchResponse.body?.cancel().catch(() => undefined);
    return null;
  }

  const payload = (await searchResponse.json().catch(() => null)) as {
    results?: ItunesArtworkResult[];
  } | null;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const best = results
    .map((result) => ({ result, score: scoreItunesArtwork(song, result) }))
    .sort((left, right) => right.score - left.score)[0];
  if (!best || best.score < 4 || !best.result.artworkUrl100) return null;

  const artworkUrl = highResolutionItunesArtworkUrl(best.result.artworkUrl100);
  const artworkResponse = await fetchWithTimeout(artworkUrl);
  if (!artworkResponse.ok) {
    await artworkResponse.body?.cancel().catch(() => undefined);
    return null;
  }
  const contentType = artworkResponse.headers.get("content-type") || "image/jpeg";
  if (!contentType.toLowerCase().startsWith("image/")) {
    await artworkResponse.body?.cancel().catch(() => undefined);
    return null;
  }

  const data = new Uint8Array(await artworkResponse.arrayBuffer());
  if (data.byteLength < 256) return null;
  return { data, contentType, sourceUrl: artworkUrl };
}

// Response.redirect requires an absolute URL per spec; a 302 with a relative
// `location` header is what we actually want for the fallback icon.
function fallbackArtworkRedirect(): Response {
  return new Response(null, { status: 302, headers: { location: "/apple-icon.png" } });
}

async function handleArtwork(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return fallbackArtworkRedirect();

  // A cover sidecar wins over the extraction cache: clients holding old
  // /api/artwork/local/<id> URLs (play-event snapshots, offline records) start
  // getting real art the moment a sidecar lands next to the audio file.
  const sidecarCoverUrl = entry.song.imageUrl || "";
  if (sidecarCoverUrl.startsWith("/api/files/local/")) {
    try {
      const relativeCover = decodeURIComponent(sidecarCoverUrl.slice("/api/files/local/".length));
      const absoluteCover = resolve(source.root, relativeCover);
      if (isPathInside(source.root, absoluteCover) && existsSync(absoluteCover)) {
        return serveFile(absoluteCover, request, "public, max-age=86400");
      }
    } catch {}
  }

  const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, "_");
  const cacheMetaPath = resolve(source.artworkDir, `${safeId}.json`);
  const signature = `${entry.relativePath}:${entry.size}:${entry.mtimeMs}`;

  try {
    const meta = JSON.parse(await readFile(cacheMetaPath, "utf8")) as {
      version?: number;
      signature?: string;
      contentType?: string;
      fileName?: string;
      empty?: boolean;
      sourceUrl?: string;
    };
    if (meta.version === ARTWORK_CACHE_VERSION && meta.signature === signature) {
      if (meta.empty) return fallbackArtworkRedirect();
      if (meta.fileName) {
        const cachedArtwork = resolve(source.artworkDir, meta.fileName);
        return serveFile(cachedArtwork, request, "public, max-age=86400");
      }
    }
  } catch {}

  await mkdir(source.artworkDir, { recursive: true });
  try {
    const metadata = await parseFile(entry.absolutePath, { skipCovers: false });
    const picture = metadata.common.picture?.[0];
    const embeddedArtwork = picture?.data?.byteLength
      ? {
          data: picture.data,
          contentType: picture.format || "image/jpeg",
          sourceUrl: "embedded",
        }
      : null;
    const artwork = embeddedArtwork || (await lookupRemoteArtwork(entry.song));

    if (artwork) {
      const fileName = `${safeId}${contentTypeExtension(artwork.contentType)}`;
      await writeFile(resolve(source.artworkDir, fileName), artwork.data);
      await writeFile(
        cacheMetaPath,
        `${JSON.stringify({
          version: ARTWORK_CACHE_VERSION,
          signature,
          contentType: artwork.contentType,
          fileName,
          sourceUrl: artwork.sourceUrl,
        })}\n`,
        "utf8",
      );
      return serveFile(resolve(source.artworkDir, fileName), request, "public, max-age=86400");
    }

    await writeFile(
      cacheMetaPath,
      `${JSON.stringify({ version: ARTWORK_CACHE_VERSION, signature, empty: true })}\n`,
      "utf8",
    );
    return fallbackArtworkRedirect();
  } catch {
    await writeFile(
      cacheMetaPath,
      `${JSON.stringify({ version: ARTWORK_CACHE_VERSION, signature, empty: true })}\n`,
      "utf8",
    ).catch(() => {});
    return fallbackArtworkRedirect();
  }
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const pathname = url.pathname;

  if (requestNeedsProxyToken(request) && !hasValidProxyToken(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const unauthorizedMutation = authorizeMutationRequest(request);
  if (unauthorizedMutation) return unauthorizedMutation;

  if (pathname === "/api/auth/session" && request.method === "GET") {
    return json({ user: currentUserIdForRequest(request) ? localUser() : null });
  }
  if (pathname === "/api/auth/me" && request.method === "GET") {
    return json({ user: currentUserIdForRequest(request) ? localUser() : null });
  }
  if (pathname === "/api/auth/signout" && request.method === "POST") {
    return new Response(null, { status: 204 });
  }
  if (pathname === "/api/auth/signin" && request.method === "POST") {
    return json({ user: localUser() });
  }
  if (pathname === "/api/register" && request.method === "POST") {
    return json({ ok: true }, { status: 201 });
  }

  if (pathname.startsWith("/api/profile/image/") && request.method === "GET") {
    const fileName = basename(decodeURIComponent(pathname.slice("/api/profile/image/".length)));
    if (!/^local-user-profile\.(jpe?g|png|webp|gif)$/i.test(fileName)) return notFound("Image not found");
    const imagePath = resolve(profileImageDir, fileName);
    if (!existsSync(imagePath)) return notFound("Image not found");
    const body = await readFile(imagePath);
    return new Response(body, {
      headers: {
        "Content-Type": contentTypeForPath(imagePath),
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  }

  if (pathname === "/api/profile/image" && request.method === "POST") {
    if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
    const form = await request.formData().catch(() => null);
    if (!form) return json({ error: "Invalid form body" }, { status: 400 });
    const image = form.get("image");
    if (!(image instanceof File) || image.size <= 0) {
      return json({ error: "Image file is required" }, { status: 400 });
    }
    const invalidImage = validateUploadFile(image, "Image file", MAX_IMAGE_BYTES, IMAGE_EXTENSIONS, "image/");
    if (invalidImage) return invalidImage;
    const imageExt = IMAGE_EXTENSIONS.has(extname(image.name).toLowerCase())
      ? extname(image.name).toLowerCase()
      : ".jpg";
    await mkdir(profileImageDir, { recursive: true });
    await Promise.all(
      [".jpg", ".jpeg", ".png", ".webp", ".gif"].map((ext) =>
        rm(resolve(profileImageDir, `local-user-profile${ext}`), { force: true }).catch(() => undefined),
      ),
    );
    await saveFile(image, resolve(profileImageDir, `local-user-profile${imageExt}`));
    return json({ user: localUser() });
  }

  if (pathname === "/api/music/source" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) {
      return jsonCached(request, {
        root: null,
        songsCount: 0,
        scannedAt: null,
      }, { cacheControl: "private, max-age=15, stale-while-revalidate=120" });
    }
    const snapshot = await getLibrary(source, url.searchParams.get("refresh") === "1");
    return jsonCached(request, {
      root: source.root,
      songsCount: snapshot.songs.length,
      scannedAt: new Date(snapshot.scannedAt).toISOString(),
    }, { cacheControl: "private, max-age=15, stale-while-revalidate=120" });
  }

  if (pathname === "/api/media/refresh" && request.method === "POST") {
    return handleMediaRefresh(request);
  }

  if (pathname === "/api/home" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) {
      return jsonCached(request, { likedSongIds: [] });
    }
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    // The visible song list is still needed to scope liked ids to what the user
    // can see, but it's no longer shipped in the response — the home screen
    // (web + mobile) only reads likedSongIds. The full list lives at /api/songs
    // and the search projection at /api/search-index.
    return jsonCached(request, {
      likedSongIds: await likedSongIdsForSongs(source, songs),
    });
  }

  if (pathname === "/api/search-index" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) {
      return jsonCached(request, { songs: [] }, { cacheControl: "private, max-age=300, stale-while-revalidate=600" });
    }
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    return jsonCached(request, {
      songs: songs.map((song) => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        imageUrl: song.imageUrl,
        audioUrl: song.audioUrl,
        createdAt: song.createdAt,
        source: song.source,
        localPath: song.localPath,
        lyricsUrl: song.lyricsUrl,
      })),
    }, { cacheControl: "private, max-age=300, stale-while-revalidate=600" });
  }

  if (pathname === "/api/library" && request.method === "GET") {
    const userId = currentUserIdForRequest(request);
    const source = librarySourceForRequest(request);
    if (!source) {
      return jsonCached(request, { playlists: [], userId }, {
        cacheControl: "private, max-age=300, stale-while-revalidate=600",
      });
    }
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    const playlists = [...folderPlaylistGroups(songs).entries()]
      .map(([name, list]) => ({
        id: folderPlaylistId(name),
        name,
        imageUrl: list.find((song) => song.imageUrl)?.imageUrl ?? null,
        userId,
        createdAt: earliestCreatedAt(list),
        songsCount: list.length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return jsonCached(request, { playlists, userId }, {
      cacheControl: "private, max-age=300, stale-while-revalidate=600",
    });
  }

  // Folder-as-playlist read. The Worker only proxies `local-folder-*` ids here
  // (curated + D1-backed playlists stay on the Worker), so this resolves the
  // matching top-level music folder and returns its songs library-playlist shaped.
  if (pathname.startsWith("/api/playlist/") && request.method === "GET") {
    const rest = pathname.slice("/api/playlist/".length);
    if (!rest || rest.includes("/")) return notFound("Playlist not found");
    const id = safeDecode(rest);
    const userId = currentUserIdForRequest(request);
    if (!userId) return json({ error: "Unauthorized" }, { status: 401 });
    const source = librarySourceForRequest(request);
    if (!source) return forbiddenLibraryResponse();
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    let matchName: string | null = null;
    let matchSongs: PlayerSong[] | null = null;
    for (const [name, list] of folderPlaylistGroups(songs).entries()) {
      if (folderPlaylistId(name) === id) {
        matchName = name;
        matchSongs = list;
        break;
      }
    }
    if (!matchName || !matchSongs) return notFound("Playlist not found");
    return jsonCached(request, {
      kind: "library",
      playlist: {
        id,
        name: matchName,
        imageUrl: matchSongs.find((song) => song.imageUrl)?.imageUrl ?? null,
        userId,
        createdAt: earliestCreatedAt(matchSongs),
      },
      songs: matchSongs,
      likedSongIds: await likedSongIdsForSongs(source, matchSongs),
    });
  }

  if (pathname === "/api/liked" && request.method === "GET") {
    if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
    const source = librarySourceForRequest(request);
    if (!source) return forbiddenLibraryResponse();
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    const likedSongIds = await likedSongIdsForSongs(source, songs);
    const likedLookup = new Set(likedSongIds);
    const likeTimes = await readPersistentLikeTimes(source);
    const likeTimeOf = (song: PlayerSong): number | undefined =>
      likeTimes[song.id] ?? likeTimes[canonicalIdOf(song)];
    // With the canonical fold on, likedSongIds are canonical ids; return one
    // song per liked id (the anchor) so collapsed copies don't duplicate.
    const likedSongs = (
      CANONICAL_LIKES_ENABLED
        ? songs.filter((song) => canonicalIdOf(song) === song.id && likedLookup.has(song.id))
        : songs.filter((song) => likedLookup.has(song.id))
    ).map((song) => {
      const ts = likeTimeOf(song);
      // Surface the like time so the client can order by recently-liked. Legacy
      // likes have none → likedAt stays undefined and they fall back to createdAt.
      return ts ? { ...song, likedAt: new Date(ts).toISOString() } : song;
    });
    // Default to most-recently-liked first (Spotify's "Recently added"): real
    // like timestamps win; the 1358 legacy likes order by file createdAt beneath.
    const orderKey = (song: PlayerSong): number => {
      const ts = likeTimeOf(song);
      if (typeof ts === "number") return ts;
      const parsed = Date.parse(song.createdAt ?? "");
      return Number.isFinite(parsed) ? parsed : 0;
    };
    likedSongs.sort((a, b) => orderKey(b) - orderKey(a));
    return jsonCached(request, { songs: likedSongs, likedSongIds });
  }

  if (pathname === "/api/likes") {
    return handleLikes(request);
  }

  if (pathname === "/api/licensed-source/materialize" && request.method === "POST") {
    return handleLicensedSourceMaterialize(request);
  }

  if (pathname === "/api/youtube/search/playlists" && request.method === "GET") {
    return handleYouTubePlaylistSearch(request, url);
  }

  if (pathname.startsWith("/api/youtube/playlists/") && request.method === "GET") {
    return handleYouTubeMusicPlaylist(request, safeDecode(pathname.slice("/api/youtube/playlists/".length)));
  }

  if (pathname === "/api/discover/staging" && request.method === "GET") {
    return handleDiscoverStagingStatus(request);
  }
  if (pathname === "/api/discover/sync" && request.method === "POST") {
    return handleDiscoverSync(request);
  }
  if (pathname === "/api/discover/stage" && request.method === "POST") {
    return handleDiscoverStageNow(request);
  }
  if (pathname === "/api/discover/promote" && request.method === "POST") {
    return handleDiscoverPromote(request);
  }

  if (pathname === "/api/songs" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) return jsonCached(request, []);
    const snapshot = await getLibrary(source);
    return jsonCached(request, songsForRequest(snapshot.songs, request));
  }

  // Content-canonical id map: { legacyId: canonicalId } for every collapsed
  // duplicate copy (song.id !== canonicalId). The app applies this once per
  // map-version at launch to rekey downloads / likes / resume off retired copy
  // ids onto the surviving canonical id. Always available (inert to old
  // clients; the app aborts its remap if this fetch fails). `version` hashes the
  // map CONTENTS so it is stable across no-op rescans and only changes when the
  // mapping actually changes (so the app re-reconciles on a later anchor flip).
  // Must be matched before the "/api/songs/" id catch-all below.
  if (pathname === "/api/songs/id-map" && request.method === "GET") {
    // Tie the id-map to the canonical-likes flag: while it's off the client must
    // NOT expand likes (likes are still per-file), so hand back an empty map.
    // Flipping the flag is what activates like-once on the client — no separate
    // client flag, no app-ships-before-flag leak.
    if (!CANONICAL_LIKES_ENABLED) return jsonCached(request, { version: "empty", map: {} });
    const source = librarySourceForRequest(request);
    if (!source) return jsonCached(request, { version: "empty", map: {} });
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    const map: Record<string, string> = {};
    for (const song of songs) {
      const canonical = song.canonicalId ?? song.id;
      if (canonical !== song.id) map[song.id] = canonical;
    }
    const signature = Object.keys(map)
      .sort()
      .map((legacyId) => `${legacyId}:${map[legacyId]}`)
      .join("|");
    const version = signature ? createHash("sha1").update(signature).digest("hex").slice(0, 16) : "empty";
    return jsonCached(request, { version, map }, { cacheControl: "private, max-age=60" });
  }

  if (pathname === "/api/songs" && request.method === "POST") {
    const source = librarySourceForRequest(request);
    if (!source) return forbiddenLibraryResponse();
    return handleSongUpload(source, request);
  }

  if (pathname.startsWith("/api/songs/")) {
    const rest = pathname.slice("/api/songs/".length);
    if (rest.endsWith("/assets")) {
      const id = safeDecode(rest.slice(0, -"/assets".length));
      const source = librarySourceForRequest(request);
      if (!source) return forbiddenLibraryResponse();
      return request.method === "POST" ? handleSongAssets(source, id, request) : methodNotAllowed();
    }
    if (rest.endsWith("/lyrics")) {
      const id = safeDecode(rest.slice(0, -"/lyrics".length));
      const source = librarySourceForRequest(request);
      if (!source) return forbiddenLibraryResponse();
      return request.method === "POST" ? handleFetchLyrics(source, id, request) : methodNotAllowed();
    }
    if (rest.endsWith("/refetch-youtube")) {
      const id = safeDecode(rest.slice(0, -"/refetch-youtube".length));
      const source = librarySourceForRequest(request);
      if (!source) return forbiddenLibraryResponse();
      return request.method === "POST" ? handleRefetchYouTube(source, id, request) : methodNotAllowed();
    }
    const id = safeDecode(rest);
    if (request.method === "GET") {
      const source = librarySourceForRequest(request);
      if (!source) return notFound("Song not found");
      const snapshot = await getLibrary(source);
      const entry = snapshot.entriesById.get(id);
      return entry ? jsonCached(request, songForRequest(entry.song, request)) : notFound("Song not found");
    }
    if (request.method === "PATCH") {
      const source = librarySourceForRequest(request);
      if (!source) return forbiddenLibraryResponse();
      return handlePatchSong(source, id, request);
    }
    return methodNotAllowed();
  }

  if (pathname.startsWith("/api/files/local/")) {
    const source = librarySourceForMediaRequest(request, url);
    if (!source) return forbiddenLibraryResponse();
    const relativePath = relativeFromUrlPath(pathname, "/api/files/local/");
    const absolutePath = await resolveInsideReal(source.root, relativePath);
    const snapshot = source.shared ? librarySnapshot : userLibrarySnapshots.get(source.key) ?? null;
    const knownEntry = snapshot?.entriesByPath.get(relativePath);
    const knownFileStat = knownEntry
      ? { size: knownEntry.size, mtimeMs: knownEntry.mtimeMs }
      : undefined;
    return absolutePath ? serveFile(absolutePath, request, "public, max-age=3600", knownFileStat) : notFound();
  }

  if (pathname.startsWith("/api/artwork/local/")) {
    const source = librarySourceForMediaRequest(request, url);
    if (!source) return forbiddenLibraryResponse();
    const id = safeDecode(pathname.slice("/api/artwork/local/".length));
    return handleArtwork(source, id, request);
  }

  if (pathname.startsWith("/api/songs/spotify")) {
    return json(
      { error: "Spotify download endpoints are not available in local music server mode." },
      { status: 501 },
    );
  }

  return notFound();
}

async function serveStaticAsset(request: Request, url: URL): Promise<Response> {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const relativePath = requestedPath
    .split("/")
    .filter(Boolean)
    .map(safeDecode)
    .join("/");
  const absolutePath = resolveInside(distDir, relativePath);

  if (absolutePath && existsSync(absolutePath)) {
    const cacheControl =
      relativePath === "index.html"
        ? "no-store"
        : relativePath === "sw.js"
          ? "no-cache"
          : relativePath === "manifest.webmanifest"
            ? "public, max-age=3600"
            : relativePath.startsWith("assets/")
              ? "public, max-age=31536000, immutable"
              : "public, max-age=3600";
    return serveFile(absolutePath, request, cacheControl);
  }

  const indexPath = resolve(distDir, "index.html");
  if (existsSync(indexPath)) {
    return serveFile(indexPath, request, "no-store");
  }

  return text(`Missing built frontend at ${distDir}. Run bun run build first.`, 500);
}

// Credentialed CORS — only our own public site. The <audio> element reads audio
// responses through the Web Audio API to crossfade, fetching with crossOrigin
// set — a credentialed request the browser blocks unless the response echoes the
// exact Origin (never "*") with Allow-Credentials. Mirrors the Worker's allowlist
// (worker/index.ts). Loopback dev origins are allowed in corsAllowOrigin below.
const CORS_ALLOWED_ORIGINS = new Set<string>([
  "https://music.streamarena.xyz",
]);

function corsAllowOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (CORS_ALLOWED_ORIGINS.has(origin)) return origin;
  // Local dev (vite / loopback) on any port.
  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      return origin;
    }
  } catch {}
  return null;
}

function setCorsHeaders(headers: Headers, allowOrigin: string): void {
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  // Range playback needs these visible to the client / Web Audio.
  headers.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
}

// Add CORS headers to a finished response. serveFile/Bun.file responses can carry
// immutable headers, so fall back to rebuilding with a mutable copy.
function applyCors(request: Request, response: Response): Response {
  const allow = corsAllowOrigin(request.headers.get("origin"));
  if (!allow) return response;
  try {
    setCorsHeaders(response.headers, allow);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    setCorsHeaders(headers, allow);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

Bun.serve({
  hostname: host,
  port,
  idleTimeout: idleTimeoutSeconds,
  async fetch(request, server) {
    const url = new URL(request.url);
    rememberRequestPeer(request, server.requestIP(request)?.address ?? null);
    // Credentialed CORS preflight: echo the allowlisted Origin, never "*".
    if (request.method === "OPTIONS") {
      const allow = corsAllowOrigin(request.headers.get("origin"));
      const headers = new Headers();
      if (allow) {
        setCorsHeaders(headers, allow);
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
        headers.set(
          "Access-Control-Allow-Headers",
          request.headers.get("access-control-request-headers") || "Content-Type, Range, Authorization",
        );
        headers.set("Access-Control-Max-Age", "86400");
      }
      return new Response(null, { status: 204, headers });
    }
    try {
      const response = url.pathname.startsWith("/api/")
        ? await handleApi(request, url)
        : await serveStaticAsset(request, url);
      return applyCors(request, response);
    } catch (error) {
      console.error(error);
      return applyCors(
        request,
        json(
          { error: error instanceof Error ? error.message : "Internal server error" },
          { status: 500 },
        ),
      );
    }
  },
});

async function initializeLibrary(): Promise<void> {
  const source = sharedLibrarySource();
  const cachedSnapshot = await readCachedLibrarySnapshot(source);
  if (cachedSnapshot) {
    librarySnapshot = cachedSnapshot;
    console.log(
      `Spotify local music server listening on http://${host}:${port} with ${cachedSnapshot.songs.length} cached tracks from ${source.root}`,
    );
    void refreshLibrary(source, true)
      .then(async (snapshot) => {
        await backfillLegacyLikesForSource(source, snapshot.songs).catch(() => {});
        console.log(`Spotify local music server refreshed ${snapshot.songs.length} tracks from ${source.root}`);
      })
      .catch((error) => {
        console.error(`Spotify local music server started, but background refresh failed: ${error}`);
      });
    return;
  }

  const snapshot = await refreshLibrary(source, true);
  // One-time legacy likes migration at startup keeps GET handlers side-effect-free.
  await backfillLegacyLikesForSource(source, snapshot.songs).catch(() => {});
  console.log(
    `Spotify local music server listening on http://${host}:${port} with ${snapshot.songs.length} tracks from ${source.root}`,
  );
}

void initializeLibrary().catch((error) => {
  console.error(`Spotify local music server started, but initial scan failed: ${error}`);
});
