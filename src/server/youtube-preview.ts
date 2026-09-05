// YouTube-sourced preview audio for Smart Shuffle recommendations.
//
// Smart Shuffle interleaves Last.fm recommendations into the queue. Materializing
// a *lossless* copy of every rec through the Spotiflac resolver chain is slow and
// fragile (the spotbye/GDStudio providers go down or rotate secrets), and most
// recs are skipped before they are ever added to the library. So for the
// PREVIEW/play path we resolve the rec to a YouTube video and stage its Opus
// audio (~140 kbps anonymous) — near-total coverage, small payload, no resolver
// dependency. The lossless resolver is reserved for the "Add to library" path so
// the library stays FLAC-only (see handleDiscoverPromote / the worker stage modes).
//
// Resolution is "confident-match-or-nothing": if we can't find a YouTube result
// whose artist and (Spotify-known) duration line up, we return null so the caller
// can fall back to the resolver or skip — never stage the wrong track. The matcher
// was validated against real recs; the failure mode it guards against is an
// ambiguous title word ("Vetiver") pulling in unrelated uploads, and hour-long
// "Full Album Continuous Mix" uploads scoring as high as the real single.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type YouTubeSearchEntry = {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number | null;
};

export type YouTubePreviewMatch = {
  videoId: string;
  title: string;
  channel: string;
  durationSec?: number;
  confidence: number;
};

export type YouTubePreviewConfig = {
  ytDlpPath: string;
  ffmpegLocation?: string; // dir containing ffmpeg, passed to yt-dlp --ffmpeg-location
  cookiesFile?: string; // optional; anonymous if unset (caps at ~131k opus)
  searchCount: number;
  minConfidence: number;
  // yt-dlp format selector. 774 (~257k opus) is the YouTube Premium tier — it only
  // appears when cookiesFile carries an active-Premium session AND a JS runtime
  // (deno) is available to solve the n-challenge; otherwise this falls through to
  // 251 (~131k opus, anonymous).
  format: string;
  // Extra dirs prepended to PATH for the yt-dlp subprocess. yt-dlp's standalone
  // binary shells out to `deno` (the JS challenge solver) by PATH lookup; under
  // launchd the server's PATH omits Homebrew, so deno must be added explicitly or
  // Premium formats silently vanish (yt-dlp mislabels it as the "SABR experiment").
  extraPath?: string[];
};

export const DEFAULT_YOUTUBE_PREVIEW_CONFIG: YouTubePreviewConfig = {
  ytDlpPath: process.env.YT_DLP_PATH || "yt-dlp",
  ffmpegLocation: process.env.YT_DLP_FFMPEG_LOCATION || undefined,
  cookiesFile: process.env.YOUTUBE_COOKIES_FILE || undefined,
  searchCount: 6,
  minConfidence: 0.5,
  format: "774/251/250/249/bestaudio[acodec=opus]/bestaudio",
};

export type YouTubePlaylistSearchResult = {
  id: string;
  name: string;
  imageUrl?: string;
  ownerName?: string;
};

export type YouTubePlaylistSearchRawEntry = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  webpage_url?: unknown;
  channel?: unknown;
  uploader?: unknown;
  thumbnails?: unknown;
};

const YOUTUBE_PLAYLIST_SEARCH_MIN_QUERY_LENGTH = 2;
const YOUTUBE_PLAYLIST_SEARCH_MAX_QUERY_LENGTH = 100;
const YOUTUBE_PLAYLIST_SEARCH_MAX_RESULTS = 12;
// YouTube's playlist-only search filter. URLSearchParams escapes the percent
// signs once more when serializing, producing the working `EgIQAw%253D%253D`
// query value used by youtube.com.
const YOUTUBE_PLAYLIST_SEARCH_FILTER = "EgIQAw%3D%3D";
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{6,64}$/;
const YOUTUBE_PAGE_HOSTS = new Set(["youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com"]);

export function normalizeYouTubePlaylistSearchQuery(value: string): string | null {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (
    normalized.length < YOUTUBE_PLAYLIST_SEARCH_MIN_QUERY_LENGTH ||
    normalized.length > YOUTUBE_PLAYLIST_SEARCH_MAX_QUERY_LENGTH
  ) {
    return null;
  }
  return normalized;
}

export function isValidYouTubePlaylistId(value: string): boolean {
  return YOUTUBE_PLAYLIST_ID.test(value);
}

export function buildYouTubePlaylistSearchUrl(query: string): string {
  const normalized = normalizeYouTubePlaylistSearchQuery(query);
  if (!normalized) throw new TypeError("YouTube playlist search query must be 2-100 characters");
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", normalized);
  url.searchParams.set("sp", YOUTUBE_PLAYLIST_SEARCH_FILTER);
  return url.toString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function playlistIdFromSearchEntry(entry: YouTubePlaylistSearchRawEntry): string | null {
  const declaredId = stringValue(entry.id);
  for (const candidate of [entry.url, entry.webpage_url]) {
    const raw = stringValue(candidate);
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:" || !YOUTUBE_PAGE_HOSTS.has(parsed.hostname.toLowerCase())) continue;
      if (parsed.pathname !== "/playlist") continue;
      const id = parsed.searchParams.get("list")?.trim() || "";
      // The playlist URL is authoritative. If yt-dlp also supplied an id, the two
      // must agree; this keeps malformed/mixed video results out of the endpoint.
      if (!isValidYouTubePlaylistId(id) || (declaredId && declaredId !== id)) continue;
      return id;
    } catch {
      // Ignore malformed result URLs.
    }
  }
  return null;
}

function trustedYouTubeThumbnail(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "i.ytimg.com" ||
      hostname.endsWith(".ytimg.com") ||
      hostname === "yt3.ggpht.com" ||
      hostname.endsWith(".googleusercontent.com")
    ) {
      return parsed.toString();
    }
  } catch {
    // Ignore malformed thumbnails.
  }
  return null;
}

function bestPlaylistSearchThumbnail(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const candidates = value
    .map((thumbnail, index) => {
      if (!thumbnail || typeof thumbnail !== "object" || Array.isArray(thumbnail)) return null;
      const object = thumbnail as Record<string, unknown>;
      const url = trustedYouTubeThumbnail(object.url);
      if (!url) return null;
      const width = typeof object.width === "number" && Number.isFinite(object.width) ? object.width : 0;
      const height = typeof object.height === "number" && Number.isFinite(object.height) ? object.height : 0;
      return { url, area: width * height, index };
    })
    .filter((candidate): candidate is { url: string; area: number; index: number } => candidate !== null)
    .sort((left, right) => right.area - left.area || right.index - left.index);
  return candidates[0]?.url;
}

export function parseYouTubePlaylistSearchEntries(
  entries: unknown,
  limit = 8,
): YouTubePlaylistSearchResult[] {
  if (!Array.isArray(entries)) return [];
  const boundedLimit = Math.max(1, Math.min(YOUTUBE_PLAYLIST_SEARCH_MAX_RESULTS, Math.floor(limit) || 1));
  const seen = new Set<string>();
  const playlists: YouTubePlaylistSearchResult[] = [];

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as YouTubePlaylistSearchRawEntry;
    const id = playlistIdFromSearchEntry(entry);
    const name = stringValue(entry.title).slice(0, 300);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);

    const imageUrl = bestPlaylistSearchThumbnail(entry.thumbnails);
    const ownerName = (stringValue(entry.channel) || stringValue(entry.uploader)).slice(0, 200);
    playlists.push({
      id,
      name,
      ...(imageUrl ? { imageUrl } : {}),
      ...(ownerName ? { ownerName } : {}),
    });
    if (playlists.length >= boundedLimit) break;
  }

  return playlists;
}

// Build the subprocess env, prepending config.extraPath to PATH so yt-dlp can
// locate deno (JS challenge solver) and ffmpeg under launchd's minimal PATH.
function execEnv(config: YouTubePreviewConfig): NodeJS.ProcessEnv | undefined {
  if (!config.extraPath?.length) return undefined;
  const base = process.env.PATH || "";
  return { ...process.env, PATH: [...config.extraPath, base].filter(Boolean).join(":") };
}

// ---------------------------------------------------------------------------
// Pure scoring (no I/O) — exported so it can be unit-tested against fixtures.
// ---------------------------------------------------------------------------

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(fold(value).split(" ").filter((t) => t.length > 1));
}

function overlap(want: Set<string>, have: Set<string>): number {
  if (want.size === 0) return 0;
  let hit = 0;
  for (const t of want) if (have.has(t)) hit += 1;
  return hit / want.size;
}

// Promo / wrong-version markers that should sink a candidate UNLESS the wanted
// title itself contains the word (e.g. a track literally called "Remix").
const JUNK =
  /\b(cover|live|sped\s*up|slowed|reverb|instrumental|karaoke|reaction|tutorial|8d|nightcore|loop|\d+\s*hour|hour\s+version|full\s+album)\b/i;

export function scoreYouTubeCandidate(
  opts: { title: string; artist: string; durationMs?: number },
  entry: YouTubeSearchEntry,
): number {
  const entryTitle = entry.title || "";
  const channel = entry.uploader || entry.channel || "";
  const artistToks = tokens(opts.artist);
  const titleToks = tokens(opts.title);
  const entryToks = tokens(entryTitle);
  const channelToks = tokens(channel);

  const titleHay = new Set([...entryToks, ...channelToks]);
  const artistOverlap = overlap(artistToks, titleHay);
  const titleOverlap = overlap(titleToks, entryToks);

  let score = artistOverlap * 0.45 + titleOverlap * 0.45;

  // Art Track signal: an "<artist> - Topic" channel is label-provided audio.
  const isTopic = /\btopic\b/i.test(channel);
  if (isTopic && artistOverlap > 0) score += 0.25;
  if (/official\s+(audio|video|music\s+video)/i.test(entryTitle)) score += 0.05;

  // Duration: the worker resolves the rec to a Spotify track first, so durationMs
  // is known. This is what kills the vetiver-farming webinars and album mixes.
  const expected = opts.durationMs ? opts.durationMs / 1000 : null;
  const got = typeof entry.duration === "number" ? entry.duration : null;
  if (expected && got) {
    const diff = Math.abs(got - expected);
    if (diff <= 4) score += 0.15;
    else if (diff <= 12) score += 0.05;
    else if (diff > 25) score -= 0.35;
  } else if (got && got > 900) {
    // No known duration but a >15min upload is almost certainly an album/mix.
    score -= 0.3;
  }

  const junk = JUNK.exec(entryTitle);
  if (junk && !fold(opts.title).includes(fold(junk[0]))) score -= 0.3;

  return score;
}

// Hard gate: the artist must actually appear, otherwise an ambiguous title word
// can match unrelated content with the artist nowhere in sight.
export function passesArtistGate(
  opts: { artist: string },
  entry: YouTubeSearchEntry,
): boolean {
  const artistToks = tokens(opts.artist);
  if (artistToks.size === 0) return true;
  const hay = new Set([...tokens(entry.title || ""), ...tokens(entry.uploader || entry.channel || "")]);
  return overlap(artistToks, hay) >= 0.5;
}

export function pickBestYouTubeMatch(
  opts: { title: string; artist: string; durationMs?: number },
  entries: YouTubeSearchEntry[],
  minConfidence: number,
): YouTubePreviewMatch | null {
  let best: YouTubePreviewMatch | null = null;
  for (const entry of entries) {
    if (!entry.id) continue;
    if (!passesArtistGate(opts, entry)) continue;
    const confidence = scoreYouTubeCandidate(opts, entry);
    if (confidence < minConfidence) continue;
    if (!best || confidence > best.confidence) {
      best = {
        videoId: entry.id,
        title: entry.title || "",
        channel: entry.uploader || entry.channel || "",
        durationSec: typeof entry.duration === "number" ? entry.duration : undefined,
        confidence,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// I/O — search + download via yt-dlp.
// ---------------------------------------------------------------------------

function ytdlpBaseArgs(config: YouTubePreviewConfig): string[] {
  const args = ["--no-warnings", "--no-playlist", "--socket-timeout", "15", "--retries", "2"];
  if (config.cookiesFile) args.push("--cookies", config.cookiesFile);
  return args;
}

export async function searchYouTube(
  opts: { title: string; artist: string },
  config: YouTubePreviewConfig,
): Promise<YouTubeSearchEntry[]> {
  const query = `ytsearch${config.searchCount}:${opts.artist} ${opts.title}`.replace(/\s+/g, " ").trim();
  const { stdout } = await execFileAsync(
    config.ytDlpPath,
    [...ytdlpBaseArgs(config), "--flat-playlist", "-J", query],
    { maxBuffer: 8 * 1024 * 1024, timeout: 45_000, env: execEnv(config) },
  );
  const parsed = JSON.parse(stdout) as { entries?: YouTubeSearchEntry[] };
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

export async function searchYouTubePlaylists(
  query: string,
  config: YouTubePreviewConfig = DEFAULT_YOUTUBE_PREVIEW_CONFIG,
  limit = 8,
): Promise<YouTubePlaylistSearchResult[]> {
  const normalized = normalizeYouTubePlaylistSearchQuery(query);
  if (!normalized) throw new TypeError("YouTube playlist search query must be 2-100 characters");
  const boundedLimit = Math.max(1, Math.min(YOUTUBE_PLAYLIST_SEARCH_MAX_RESULTS, Math.floor(limit) || 1));
  const args = [
    "--no-warnings",
    "--flat-playlist",
    "--dump-single-json",
    "--playlist-end",
    String(boundedLimit),
    "--socket-timeout",
    "8",
    "--retries",
    "1",
  ];
  if (config.cookiesFile) args.push("--cookies", config.cookiesFile);
  args.push(buildYouTubePlaylistSearchUrl(normalized));
  const { stdout } = await execFileAsync(config.ytDlpPath, args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
    env: execEnv(config),
  });
  const parsed = JSON.parse(stdout) as { entries?: unknown };
  return parseYouTubePlaylistSearchEntries(parsed.entries, boundedLimit);
}

export async function resolveYouTubePreviewMatch(
  opts: { title: string; artist: string; durationMs?: number },
  config: YouTubePreviewConfig = DEFAULT_YOUTUBE_PREVIEW_CONFIG,
): Promise<YouTubePreviewMatch | null> {
  const entries = await searchYouTube(opts, config).catch(() => [] as YouTubeSearchEntry[]);
  if (entries.length === 0) return null;
  return pickBestYouTubeMatch(opts, entries, config.minConfidence);
}

const PREVIEW_AUDIO_EXTS = new Set([".opus", ".m4a", ".ogg", ".webm"]);

// Download the chosen video's best audio to a temp dir and return its bytes.
// Keeps the native codec (Opus where available) — no lossy re-encode.
export async function downloadYouTubePreviewAudio(
  videoId: string,
  config: YouTubePreviewConfig = DEFAULT_YOUTUBE_PREVIEW_CONFIG,
): Promise<{ bytes: Buffer; ext: string }> {
  const dir = await mkdtemp(join(tmpdir(), "yt-preview-"));
  try {
    const args = [
      ...ytdlpBaseArgs(config),
      "-f",
      config.format,
      "-x",
      "-o",
      join(dir, "audio.%(ext)s"),
    ];
    if (config.ffmpegLocation) args.push("--ffmpeg-location", config.ffmpegLocation);
    args.push(`https://www.youtube.com/watch?v=${videoId}`);
    await execFileAsync(config.ytDlpPath, args, { maxBuffer: 8 * 1024 * 1024, timeout: 120_000, env: execEnv(config) });

    const files = await readdir(dir);
    const audioFile = files.find((f) => PREVIEW_AUDIO_EXTS.has(extOf(f)));
    if (!audioFile) throw new Error("yt-dlp produced no audio file");
    const bytes = await readFile(join(dir, audioFile));
    if (!bytes.byteLength) throw new Error("yt-dlp produced an empty audio file");
    return { bytes, ext: extOf(audioFile) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

// Download, falling back to anonymous if a cookies (Premium) attempt fails. A
// cookies-authenticated request whose JS n-challenge can't be solved (e.g. deno
// missing) returns NO usable formats — strictly worse than anonymous ~131k opus —
// so dropping the cookies and retrying keeps refetch/preview working.
export async function downloadYouTubePreviewAudioResilient(
  videoId: string,
  config: YouTubePreviewConfig = DEFAULT_YOUTUBE_PREVIEW_CONFIG,
): Promise<{ bytes: Buffer; ext: string }> {
  try {
    return await downloadYouTubePreviewAudio(videoId, config);
  } catch (err) {
    if (!config.cookiesFile) throw err;
    return downloadYouTubePreviewAudio(videoId, { ...config, cookiesFile: undefined });
  }
}

export type YouTubeMusicPlaylistEntry = {
  videoId: string;
  title: string;
  artist: string;
  imageUrl: string;
  duration?: number;
};
export type YouTubeMusicPlaylist = {
  title: string;
  imageUrl: string;
  entries: YouTubeMusicPlaylistEntry[];
};

// Strip the noisy decorations YouTube music-video titles carry so the playlist
// reads cleanly. Cosmetic only — playback downloads by videoId, not by title.
function cleanYouTubeTitle(raw: string): string {
  return raw
    .replace(/\s*[([](?:official\s+)?(?:music\s+)?(?:video(?:\s+clip)?|audio|lyric[s]?(?:\s*video)?|visuali[sz]er|mv|hd|4k)[)\]]\s*/gi, " ")
    .replace(/\s*(?:\||[-–—])\s*(?:official\s+)?(?:music\s+)?(?:video(?:\s+clip)?|audio|lyrics?(?:\s+video)?|visuali[sz]er)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// YouTube music titles are usually "Artist - Title (Official Video)". Split on the
// first " - " so the playlist shows a real artist column; fall back to the mix name
// when there's no separator.
export function splitTitleArtist(raw: string, fallbackArtist: string): { title: string; artist: string } {
  const cleaned = cleanYouTubeTitle(raw);
  const dash = /\s+[-–—]\s+/.exec(cleaned);
  if (dash && dash.index > 0) {
    return { artist: cleaned.slice(0, dash.index).trim(), title: cleaned.slice(dash.index + dash[0].length).trim() || cleaned };
  }
  const quoted = /^(.+?)\s+["“]([^"”]+)["”]$/.exec(cleaned);
  if (quoted) return { artist: quoted[1].trim(), title: quoted[2].trim() };
  return { artist: fallbackArtist, title: cleaned };
}

function bestThumbnail(thumbs: Array<{ url?: string; width?: number }> | undefined): string {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return "";
  // yt-dlp lists thumbnails ascending; take the largest with a url.
  for (let i = thumbs.length - 1; i >= 0; i -= 1) {
    if (typeof thumbs[i]?.url === "string" && thumbs[i].url) return thumbs[i].url as string;
  }
  return "";
}

// Fetch a YouTube Music playlist / auto-mix (e.g. a RDTMAK5uy_* Discover Mix) as a
// flat track list — videoId + title + thumbnail per entry. With Premium cookies the
// mix is the account's personalized, auto-updating one. NO download here (cheap);
// each track's Opus is staged on demand by videoId via downloadYouTubePreviewAudio*.
export async function fetchYouTubeMusicPlaylist(
  listId: string,
  config: YouTubePreviewConfig = DEFAULT_YOUTUBE_PREVIEW_CONFIG,
): Promise<YouTubeMusicPlaylist> {
  const url = `https://music.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  // NOTE: deliberately NOT ytdlpBaseArgs() — that sets --no-playlist, which would
  // collapse the mix to a single track. We want the whole flat list.
  const args = ["--no-warnings", "--flat-playlist", "--dump-single-json", "--socket-timeout", "15", "--retries", "2"];
  if (config.cookiesFile) args.push("--cookies", config.cookiesFile);
  args.push(url);
  const { stdout } = await execFileAsync(config.ytDlpPath, args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    env: execEnv(config),
  });
  const data = JSON.parse(stdout) as {
    title?: string;
    thumbnails?: Array<{ url?: string }>;
    entries?: Array<{
      id?: string; title?: string; track?: string; artist?: string;
      uploader?: string; channel?: string; duration?: number;
      thumbnails?: Array<{ url?: string }>;
    }>;
  };
  const mixTitle = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Discover Mix";
  const entries: YouTubeMusicPlaylistEntry[] = [];
  const seen = new Set<string>();
  for (const entry of data.entries ?? []) {
    const videoId = typeof entry.id === "string" ? entry.id.trim() : "";
    // Dedup by videoId: a mix occasionally repeats a track, and a duplicate id
    // would collide on the staging trackId ("yt:<videoId>") and make the staged-song
    // swap target the wrong queue slot.
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const rawTitle = typeof entry.title === "string" ? entry.title : "";
    const fallbackArtist = entry.artist?.trim() || entry.uploader?.trim() || entry.channel?.trim() || mixTitle;
    const parsed = splitTitleArtist(rawTitle, fallbackArtist.replace(/\s+-\s+Topic$/i, ""));
    const title = entry.track?.trim() || parsed.title;
    const artist = entry.artist?.trim() || parsed.artist;
    entries.push({
      videoId,
      title: title || rawTitle || videoId,
      artist: artist || mixTitle,
      imageUrl: bestThumbnail(entry.thumbnails),
      duration: typeof entry.duration === "number" && Number.isFinite(entry.duration) && entry.duration > 0
        ? Math.round(entry.duration)
        : undefined,
    });
  }
  return { title: mixTitle, imageUrl: bestThumbnail(data.thumbnails), entries };
}

// CLI: `bun src/server/youtube-preview.ts "<artist>" "<title>" [durationSec]`
if (import.meta.main) {
  const [artist, title, durStr] = process.argv.slice(2);
  if (!artist || !title) {
    console.error('usage: bun src/server/youtube-preview.ts "<artist>" "<title>" [durationSec]');
    process.exit(1);
  }
  const durationMs = durStr ? Number(durStr) * 1000 : undefined;
  const match = await resolveYouTubePreviewMatch({ title, artist, durationMs });
  console.log("match:", match);
  if (match && process.argv.includes("--download")) {
    const audio = await downloadYouTubePreviewAudio(match.videoId);
    console.log(`downloaded ${audio.bytes.byteLength} bytes${audio.ext}`);
  }
}
