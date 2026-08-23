import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
import {
  LicensedSourceDownloadError,
  materializeLicensedSourceStream,
  resolveLicensedSourceStreamUrl,
  type LicensedSourceStream,
} from "../lib/licensed-source-download";
import {
  communityUserAgent,
  isSpotiflacCommunityHost,
  type SpotiflacCommunitySession,
} from "../lib/spotiflac-community";
import { SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE } from "../lib/spotify-import-error";
import {
  ensureDesktopSpotiflacCommunitySession,
  forceRefreshDesktopSpotiflacCommunitySession,
  spotiflacProviderRejectedSession,
} from "./spotiflac-community-session";
import { maybeDecryptDeezerBuffer, resolveDeezerDecryptionId } from "../lib/deezer-decrypt";
import {
  isApiPath,
  isLegacyPublicProfilePath,
} from "../lib/private-web-surface";
import {
  RemoteUrlError,
  fetchPublicHttpUrl,
} from "../lib/safe-fetch";
import { sniffUploadFile } from "../lib/upload-media-sniff";
import {
  LOCAL_IMAGE_EXTENSIONS as IMAGE_EXTENSIONS,
  isAllowedLocalMediaRelativePath,
  isSafeRelativeFileName,
} from "../lib/local-media-path";
import type { PlayerSong } from "../types/player";
import {
  decodeOffsetCursor,
  parsePageLimit,
  slicePage,
  wantsLibraryPage,
} from "../../packages/shared/src/cursor-page";
import { songMatchesLibraryQuery } from "../../packages/shared/src/library-search";
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_IMAGE_URL,
  LOCAL_OWNER_NAME,
  LOCAL_OWNER_USER_ID,
} from "../../packages/shared/src/local-owner";
import {
  contentTypeForPath,
  isPathInside,
  relativeFromUrlPath,
  resolveInside,
  resolveInsideReal,
  serveFile,
} from "./local-media-serve";
import {
  allowsImplicitLocalAccess,
  requestRequiresPrivateProxyAuth,
} from "./local-access";
import { createPrivateProxyAuthenticator } from "./proxy-auth";
import { json, jsonCached, text, readJsonBody, withNoIndexHeader } from "./local-http";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  PayloadTooLargeError,
  assertRemoteResponseSize,
  contentTypeExtension,
  parseHttpUrl,
  saveFile,
  saveResponseBody,
  trackKey,
  validateUploadFile,
} from "./local-files";
import {
  configureDiscover,
  handleDiscoverPromote,
  handleDiscoverStageNow,
  handleDiscoverStagingStatus,
  handleDiscoverSync,
  handleYouTubeMusicPlaylist,
  handleYouTubePlaylistSearch,
} from "./local-discover";
import {
  configureUploads,
  handleFetchLyrics,
  handlePatchSong,
  handleRefetchYouTube,
  handleSongAssets,
  handleSongUpload,
} from "./local-uploads";

import {
  type LibrarySource,
  type LocalSongEntry,
  configureLibraryScan,
  getLibrary,
  hydrateSharedLibrarySnapshot,
  readCachedLibrarySnapshot,
  readSidecar,
  refreshLibrary,
  sidecarPathForAudio,
} from "./local-library-scan";

const execFileAsync = promisify(execFile);

type RequestUserIdentity = {
  id: string;
  email: string | null;
  name: string | null;
  local: boolean;
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

type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";

const SIGNED_MEDIA_CACHE_CONTROL = "private, max-age=3600";
const SIGNED_ARTWORK_CACHE_CONTROL = "private, max-age=86400";
const LIKES_CACHE_VERSION = 1;
const ARTWORK_CACHE_VERSION = 2;
const ARTWORK_EMPTY_RETRY_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCAL_USER = {
  id: LOCAL_OWNER_USER_ID,
  email: LOCAL_OWNER_EMAIL,
  name: LOCAL_OWNER_NAME,
  image: LOCAL_OWNER_IMAGE_URL,
};
const MEDIA_USER_SEARCH_PARAM = "spotify_user";
const MEDIA_SCOPE_SEARCH_PARAM = "spotify_scope";
const MEDIA_EXPIRY_SEARCH_PARAM = "spotify_exp";
const MEDIA_SIGNATURE_SEARCH_PARAM = "spotify_sig";
const MEDIA_SIGNATURE_TTL_SECONDS = 60 * 60;
const LEGACY_MEDIA_SIGNATURE_TTL_SECONDS = 24 * 60 * 60;

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
configureLibraryScan({ scanTtlMs });
const configuredIdleTimeoutSeconds = Number(process.env.SPOTIFY_IDLE_TIMEOUT_SECONDS || "120");
const idleTimeoutSeconds = Number.isFinite(configuredIdleTimeoutSeconds)
  ? Math.max(30, configuredIdleTimeoutSeconds)
  : 120;
const remoteArtworkLookupEnabled = process.env.SPOTIFY_ARTWORK_LOOKUP !== "0";
const artworkLookupCountry = process.env.SPOTIFY_ARTWORK_COUNTRY || "GB";
const requestSigningSecret = process.env.SPOTIFY_REQUEST_SIGNING_SECRET || "";
const legacyProxyToken = process.env.SPOTIFY_PROXY_TOKEN || "";
const allowLegacyProxyToken = process.env.SPOTIFY_ALLOW_LEGACY_PROXY_TOKEN === "1";
const mediaSigningSecret =
  process.env.SPOTIFY_MEDIA_SIGNING_SECRET || (allowLegacyProxyToken ? legacyProxyToken : "");
const privateProxyAuthenticator = createPrivateProxyAuthenticator({
  requestSigningSecret,
  legacyToken: legacyProxyToken,
  allowLegacyToken: allowLegacyProxyToken,
});
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
// Serializes likes read-modify-write per source so concurrent toggles don't
// lose updates (last-writer-wins). Keyed by source.key.
const likeWriteChains = new Map<string, Promise<unknown>>();
// Tracks sources whose one-time legacy-likes backfill has already been
// attempted this process, so side-effect-free GETs never re-run the migration.
const likesBackfilled = new Set<string>();

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

function hasValidPrivateProxyRequest(request: Request): boolean {
  return privateProxyAuthenticator.authenticate(request).authenticated;
}

function requestNeedsPrivateProxyAuth(request: Request): boolean {
  return requestRequiresPrivateProxyAuth({
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
  if (hasValidPrivateProxyRequest(request) || allowsImplicitLocalUser(request)) return null;
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

function outputFormatFromPayload(value: unknown): OutputFormat {
  const format = typeof value === "string"
    ? value.trim().toLowerCase() as OutputFormat
    : SERVER_IMPORT_OUTPUT_FORMAT;
  return OUTPUT_FORMATS.has(format) ? format : SERVER_IMPORT_OUTPUT_FORMAT;
}


function currentUserIdentityForRequest(request: Request): RequestUserIdentity | null {
  const proxyAuth = privateProxyAuthenticator.authenticate(request);
  if (proxyAuth.authenticated) {
    const identity = proxyAuth.identity;
    if (!identity) return null;
    return {
      id: identity.id,
      email: identity.email || null,
      name: identity.name,
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

function isAuthorizedLicensedSourceRequest(request: Request): boolean {
  if (currentUserIdForRequest(request)) return true;
  return privateProxyAuthenticator.authenticate(request).authenticated;
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

function mediaSignatureWithSecret(
  secret: string,
  userId: string,
  scope: string,
  pathname: string,
  expiresAt: string,
): string {
  return createHmac("sha256", secret)
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

function mediaSignature(userId: string, scope: string, pathname: string, expiresAt: string): string {
  return mediaSignatureWithSecret(mediaSigningSecret, userId, scope, pathname, expiresAt);
}

function appendMediaSignature(mediaUrl: string | undefined, identity: RequestUserIdentity | null): string | undefined {
  if (!mediaUrl || !mediaSigningSecret || !identity || identity.local) return mediaUrl;
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
  const userId = url.searchParams.get(MEDIA_USER_SEARCH_PARAM)?.trim() || "";
  const scope = url.searchParams.get(MEDIA_SCOPE_SEARCH_PARAM)?.trim() || "";
  const expiresAt = url.searchParams.get(MEDIA_EXPIRY_SEARCH_PARAM)?.trim() || "";
  const signature = url.searchParams.get(MEDIA_SIGNATURE_SEARCH_PARAM)?.trim() || "";
  const expirySeconds = Number(expiresAt);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const structurallyValid = Boolean(
    userId &&
    (scope === "shared" || scope === "user") &&
    Number.isSafeInteger(expirySeconds) &&
    expirySeconds > nowSeconds &&
    signature
  );
  if (!structurallyValid) return false;
  if (
    mediaSigningSecret &&
    expirySeconds <= nowSeconds + MEDIA_SIGNATURE_TTL_SECONDS + 60 &&
    timingSafeEqualStr(signature, mediaSignature(userId, scope, url.pathname, expiresAt))
  ) {
    return true;
  }
  // Rollover-only acceptance for URLs emitted by the former 24-hour bearer-key
  // signer. It disappears as soon as legacy proxy mode is disabled.
  return Boolean(
    allowLegacyProxyToken &&
    legacyProxyToken &&
    expirySeconds <= nowSeconds + LEGACY_MEDIA_SIGNATURE_TTL_SECONDS + 60 &&
    timingSafeEqualStr(
      signature,
      mediaSignatureWithSecret(legacyProxyToken, userId, scope, url.pathname, expiresAt),
    )
  );
}

function hasValidDirectMediaRequest(request: Request, url: URL): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (
    !url.pathname.startsWith("/api/files/local/") &&
    !url.pathname.startsWith("/api/artwork/local/")
  ) {
    return false;
  }
  return hasValidMediaSignature(url);
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

configureUploads({
  forbiddenLibraryResponse,
  notFound,
  songForRequest,
  markSongLikedForSource,
  backupSongEntryFiles,
  restoreSongEntryBackup,
  discardSongEntryBackup,
  outputFormatFromPayload,
  serverImportOutputFormat: SERVER_IMPORT_OUTPUT_FORMAT,
});

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

async function handleLicensedSourceResolve(request: Request): Promise<Response> {
  if (!isAuthorizedLicensedSourceRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const payload = await readJsonBody<{
    endpointUrl?: unknown;
    body?: unknown;
    userAgent?: unknown;
  }>(request);
  const endpointUrl = typeof payload?.endpointUrl === "string" ? payload.endpointUrl.trim() : "";
  if (!endpointUrl || !isSpotiflacCommunityHost(endpointUrl)) {
    return json({ error: "Unsupported community endpoint" }, { status: 400 });
  }
  let session: SpotiflacCommunitySession;
  try {
    session = await ensureDesktopSpotiflacCommunitySession();
  } catch (error) {
    console.error(`SpotiFLAC request-time session refresh failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE }, { status: 503 });
  }
  const body =
    payload?.body && typeof payload.body === "object" && !Array.isArray(payload.body)
      ? (payload.body as Record<string, unknown>)
      : {};
  const userAgent =
    typeof payload?.userAgent === "string" && payload.userAgent.trim()
      ? payload.userAgent.trim()
      : communityUserAgent(session);
  const resolveWithSession = (communitySession: SpotiflacCommunitySession) =>
    resolveLicensedSourceStreamUrl({
      endpointUrl,
      body,
      userAgent,
      communitySession,
      spotifyId: typeof body.spotifyId === "string" ? body.spotifyId : "",
      spotifyUrl: typeof body.spotifyUrl === "string" ? body.spotifyUrl : "",
    });
  try {
    return json(await resolveWithSession(session));
  } catch (error) {
    if (spotiflacProviderRejectedSession(error)) {
      try {
        session = await forceRefreshDesktopSpotiflacCommunitySession();
      } catch (refreshError) {
        console.error(
          `SpotiFLAC rejected the session and request-time renewal failed: ${refreshError instanceof Error ? refreshError.message : "unknown error"}`,
        );
        return json({ error: SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE }, { status: 503 });
      }
      try {
        return json(await resolveWithSession(session));
      } catch (retryError) {
        if (spotiflacProviderRejectedSession(retryError)) {
          return json({ error: SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE }, { status: 503 });
        }
        if (retryError instanceof LicensedSourceDownloadError) {
          return json({ error: retryError.message }, { status: retryError.status });
        }
        throw retryError;
      }
    }
    if (error instanceof LicensedSourceDownloadError) {
      return json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
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

configureDiscover({
  librarySourceForRequest,
  currentUserIdForRequest,
  forbiddenLibraryResponse,
  notFound,
  ffmpegPath,
  materializeLicensedStreamToResponse,
  licensedMediaRequestHeaders,
  signMediaUrl: (mediaUrl) =>
    appendMediaSignature(mediaUrl, {
      id: LOCAL_USER.id,
      email: LOCAL_USER.email,
      name: LOCAL_USER.name,
      local: false,
    }) ?? mediaUrl,
});

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

function missingArtworkResponse(): Response {
  // A missing cover should advance CoverImage's fallback chain. Returning the
  // branded app icon as a successful image made an entire playlist look like a
  // wall of identical Spotify logos whenever artwork auth or lookup failed.
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "private, max-age=3600" },
  });
}

async function handleArtwork(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return missingArtworkResponse();

  // A cover sidecar wins over the extraction cache: clients holding old
  // /api/artwork/local/<id> URLs (play-event snapshots, offline records) start
  // getting real art the moment a sidecar lands next to the audio file.
  const sidecarCoverUrl = entry.song.imageUrl || "";
  if (sidecarCoverUrl.startsWith("/api/files/local/")) {
    try {
      const coverPathname = sidecarCoverUrl.split("?")[0]?.split("#")[0] || "";
      const relativeCover = relativeFromUrlPath(coverPathname, "/api/files/local/");
      if (isAllowedLocalMediaRelativePath(relativeCover, snapshot.entriesByPath)) {
        const absoluteCover = await resolveInsideReal(source.root, relativeCover);
        if (absoluteCover) {
          return serveFile(absoluteCover, request, SIGNED_ARTWORK_CACHE_CONTROL);
        }
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
      checkedAt?: string;
    };
    if (meta.version === ARTWORK_CACHE_VERSION && meta.signature === signature) {
      if (meta.empty) {
        const checkedAt = Date.parse(meta.checkedAt || "");
        if (Number.isFinite(checkedAt) && Date.now() - checkedAt < ARTWORK_EMPTY_RETRY_MS) {
          return missingArtworkResponse();
        }
      }
      if (meta.fileName && isSafeRelativeFileName(meta.fileName)) {
        const cachedArtwork = await resolveInsideReal(source.artworkDir, meta.fileName);
        if (cachedArtwork) {
          return serveFile(cachedArtwork, request, SIGNED_ARTWORK_CACHE_CONTROL);
        }
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
      if (!isSafeRelativeFileName(fileName)) return missingArtworkResponse();
      const artworkPath = resolveInside(source.artworkDir, fileName);
      if (!artworkPath) return missingArtworkResponse();
      await writeFile(artworkPath, artwork.data);
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
      return serveFile(artworkPath, request, SIGNED_ARTWORK_CACHE_CONTROL);
    }

    await writeFile(
      cacheMetaPath,
      `${JSON.stringify({
        version: ARTWORK_CACHE_VERSION,
        signature,
        empty: true,
        checkedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    return missingArtworkResponse();
  } catch {
    await writeFile(
      cacheMetaPath,
      `${JSON.stringify({
        version: ARTWORK_CACHE_VERSION,
        signature,
        empty: true,
        checkedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    ).catch(() => {});
    return missingArtworkResponse();
  }
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const pathname = url.pathname;

  if (
    requestNeedsPrivateProxyAuth(request) &&
    !hasValidPrivateProxyRequest(request) &&
    !hasValidDirectMediaRequest(request, url)
  ) {
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
    return json({ error: "Registration is disabled" }, { status: 403 });
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
    const sniffedImage = await sniffUploadFile(image, "image");
    if (!sniffedImage) return json({ error: "Image file content is not supported" }, { status: 415 });
    const imageExt = sniffedImage.extension;
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
      return jsonCached(
        request,
        wantsLibraryPage(url.searchParams) ? { songs: [], nextCursor: null } : { songs: [] },
        { cacheControl: "private, max-age=300, stale-while-revalidate=600" },
      );
    }
    const snapshot = await getLibrary(source);
    const query = url.searchParams.get("q") || "";
    const songs = songsForRequest(snapshot.songs, request)
      .filter((song) => songMatchesLibraryQuery(song, query))
      .map((song) => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        imageUrl: song.imageUrl,
        audioUrl: song.audioUrl,
        createdAt: song.createdAt,
        source: song.source,
        localPath: song.localPath,
        lyricsUrl: song.lyricsUrl,
      }));
    if (!wantsLibraryPage(url.searchParams)) {
      return jsonCached(request, { songs }, { cacheControl: "private, max-age=300, stale-while-revalidate=600" });
    }
    const rawCursor = url.searchParams.get("cursor");
    const offset = rawCursor ? decodeOffsetCursor(rawCursor) : 0;
    if (rawCursor && offset === null) return json({ error: "Invalid cursor" }, { status: 400 });
    const page = slicePage(songs, offset ?? 0, parsePageLimit(url.searchParams.get("limit")));
    return jsonCached(request, { songs: page.items, nextCursor: page.nextCursor }, {
      cacheControl: "private, max-age=300, stale-while-revalidate=600",
    });
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
      .map(([name, list]) => {
        const coverImageUrls = Array.from(
          new Set(
            list
              .map((song) => song.imageUrl?.trim())
              .filter((imageUrl): imageUrl is string => Boolean(imageUrl)),
          ),
        ).slice(0, 4);
        return {
          id: folderPlaylistId(name),
          name,
          imageUrl: coverImageUrls[0] ?? null,
          coverImageUrls,
          userId,
          createdAt: earliestCreatedAt(list),
          songsCount: list.length,
        };
      })
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

  if (pathname === "/api/licensed-source/resolve" && request.method === "POST") {
    return handleLicensedSourceResolve(request);
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
    if (!source) return jsonCached(request, wantsLibraryPage(url.searchParams) ? { songs: [], nextCursor: null } : []);
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    if (!wantsLibraryPage(url.searchParams)) return jsonCached(request, songs);
    const rawCursor = url.searchParams.get("cursor");
    const offset = rawCursor ? decodeOffsetCursor(rawCursor) : 0;
    if (rawCursor && offset === null) return json({ error: "Invalid cursor" }, { status: 400 });
    const page = slicePage(songs, offset ?? 0, parsePageLimit(url.searchParams.get("limit")));
    return jsonCached(request, { songs: page.items, nextCursor: page.nextCursor });
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
    const snapshot = await getLibrary(source);
    if (!isAllowedLocalMediaRelativePath(relativePath, snapshot.entriesByPath)) {
      return notFound();
    }
    const absolutePath = await resolveInsideReal(source.root, relativePath);
    const knownEntry = snapshot.entriesByPath.get(relativePath);
    const knownFileStat = knownEntry
      ? { size: knownEntry.size, mtimeMs: knownEntry.mtimeMs }
      : undefined;
    return absolutePath
      ? serveFile(absolutePath, request, SIGNED_MEDIA_CACHE_CONTROL, knownFileStat)
      : notFound();
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
  if (isLegacyPublicProfilePath(url.pathname)) return notFound();
  if (url.pathname === "/register" || url.pathname === "/register/") {
    return new Response(null, {
      status: 302,
      headers: { location: "/signin", "cache-control": "no-store" },
    });
  }
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const relativePath = requestedPath
    .split("/")
    .filter(Boolean)
    .map(safeDecode)
    .join("/");
  const absolutePath = await resolveInsideReal(distDir, relativePath);

  if (absolutePath) {
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
  response = withNoIndexHeader(response);
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
      const response = isApiPath(url.pathname)
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
    hydrateSharedLibrarySnapshot(cachedSnapshot);
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
