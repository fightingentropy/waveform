import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { LicensedSourceStream } from "../lib/licensed-source-download";
import { fetchPublicHttpUrl } from "../lib/safe-fetch";
import {
  LOCAL_AUDIO_EXTENSIONS as AUDIO_EXTENSIONS,
  LOCAL_MEDIA_DISCOVER_DIRNAME,
} from "../lib/local-media-path";
import type { PlayerSong } from "../types/player";
import { createDiscoverStageCoordinator } from "./discover-stage-coordinator";
import { json, jsonCached, readJsonBody } from "./local-http";
import {
  MAX_AUDIO_BYTES,
  audioExtensionFromContentType,
  extensionFromRemoteUrl,
  parseHttpUrl,
  sanitizeFileName,
  saveRemoteImage,
  trackKey,
  uniquePath,
} from "./local-files";
import {
  type LibrarySource,
  type LocalSidecar,
  type LocalSongEntry,
  encodeRelativePath,
  getLibrary,
  stableSongId,
  writeSidecar,
} from "./local-library-scan";
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

export type DiscoverDeps = {
  librarySourceForRequest: (request: Request) => LibrarySource | null;
  currentUserIdForRequest: (request: Request) => string | null;
  forbiddenLibraryResponse: () => Response;
  notFound: (message?: string) => Response;
  ffmpegPath: () => string;
  materializeLicensedStreamToResponse: (
    stream: LicensedSourceStream,
    userAgent?: string,
  ) => Promise<Response>;
  licensedMediaRequestHeaders: (
    streamHeaders: Record<string, string> | undefined,
    userAgent: string,
  ) => Record<string, string>;
  signMediaUrl: (mediaUrl: string | undefined) => string | undefined;
};

let librarySourceForRequest: DiscoverDeps["librarySourceForRequest"];
let currentUserIdForRequest: DiscoverDeps["currentUserIdForRequest"];
let forbiddenLibraryResponse: DiscoverDeps["forbiddenLibraryResponse"];
let notFound: DiscoverDeps["notFound"];
let ffmpegPath: DiscoverDeps["ffmpegPath"];
let materializeLicensedStreamToResponse: DiscoverDeps["materializeLicensedStreamToResponse"];
let licensedMediaRequestHeaders: DiscoverDeps["licensedMediaRequestHeaders"];
let signMediaUrl: DiscoverDeps["signMediaUrl"];

export function configureDiscover(deps: DiscoverDeps): void {
  librarySourceForRequest = deps.librarySourceForRequest;
  currentUserIdForRequest = deps.currentUserIdForRequest;
  forbiddenLibraryResponse = deps.forbiddenLibraryResponse;
  notFound = deps.notFound;
  ffmpegPath = deps.ffmpegPath;
  materializeLicensedStreamToResponse = deps.materializeLicensedStreamToResponse;
  licensedMediaRequestHeaders = deps.licensedMediaRequestHeaders;
  signMediaUrl = deps.signMediaUrl;
}

// --- Discover staging (Top-50 pre-download cache) ----------------------------
// A hidden ".discover" folder under the shared music root holds pre-downloaded
// "Top 50" tracks so the client can play them INSTANTLY without adding them to
// the library. collectAudioFiles() skips dot-entries, so staged files never
// appear in the scan / search / liked surfaces — yet /api/files/local/ still
// streams them by path after the media-path allowlist recognizes `.discover/`.
// "Keep" (like / playlist / download) promotes a staged file into the visible
// library tree (handleDiscoverPromote); rotation deletes un-kept tracks that
// fell off the Top 50 more than DISCOVER_STAGING_TTL_MS ago.
const DISCOVER_STAGING_DIRNAME = LOCAL_MEDIA_DISCOVER_DIRNAME;
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
const coordinateDiscoverStage = createDiscoverStageCoordinator<DiscoverStagingEntry>();

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

export function youtubePreviewConfig(): YouTubePreviewConfig {
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
  // Include the source root so two configured libraries cannot block each other
  // merely because they happen to stage the same provider track id.
  const coordinationKey = `${source.root}\0${item.trackId}`;
  return coordinateDiscoverStage(
    coordinationKey,
    async () => {
      const manifest = await readDiscoverManifest(source);
      const existing = manifest.entries[item.trackId];
      const existingUsable = existing && existsSync(resolve(source.root, existing.stagedRelPath));
      // Reuse a staged copy when it satisfies the request. This check runs after
      // any earlier same-track request finishes. A lossy preview does NOT satisfy
      // a lossless (Add) request, so that waiter falls through and upgrades it.
      return existingUsable && (item.preview || existing.lossless !== false) ? existing : null;
    },
    async () => {
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
    },
  );
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
// that can't present private-proxy auth or a session cookie — notably the native
// iOS AVPlayer, which fetches the URL directly (bypassing the Worker). Sign
// their media URLs for the shared scope, exactly as songForRequest does for
// normal library songs, so hasValidMediaSignature() authorizes them. Without
// this the native player gets a 403 and the track silently fails to load.
function signDiscoverMediaUrl(mediaUrl: string | undefined): string | undefined {
  return signMediaUrl(mediaUrl) ?? mediaUrl;
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

export async function handleDiscoverStagingStatus(request: Request): Promise<Response> {
  const source = librarySourceForRequest(request);
  if (!source || !source.shared) return jsonCached(request, { entries: [] }, { cacheControl: "private, max-age=10" });
  return jsonCached(request, await discoverStagingStatusBody(source), { cacheControl: "private, max-age=10" });
}

export async function handleDiscoverSync(request: Request): Promise<Response> {
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

export async function handleDiscoverStageNow(request: Request): Promise<Response> {
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

export async function handleYouTubePlaylistSearch(request: Request, url: URL): Promise<Response> {
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
export async function handleYouTubeMusicPlaylist(request: Request, listId: string): Promise<Response> {
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

export async function handleDiscoverPromote(request: Request): Promise<Response> {
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
