import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { compare } from "bcryptjs";
import { basename, extname, join } from "node:path";
import {
  exclusiveManagedStorageKeys,
  type AccountMediaRow,
} from "@/lib/account-deletion";
import { D1_SCHEMA_STATEMENTS } from "@/lib/db-schema";
import type { PlaybackStateRow, PlaylistRow, SongRow, UserRow } from "@/lib/db-types";
import { PLAYBACK_STATE_VERSION, type PlaybackStateSnapshot } from "@/lib/playback-state";
import {
  PODCAST_SHOWS,
  extractPodcastFeedMediaUrls,
  podcastFeedAllowsMediaUrl,
  safePodcastUrl,
  type PodcastShow,
} from "@/lib/podcasts";
import { buildSql, statementReturnsRows, type SqlRow, type SqlTag, type TemplateValue } from "@/lib/sql-tag";
import { songToPlayerSong } from "@/lib/song-utils";
import { inferContentTypeFromKey, normalizeStorageKey } from "@/lib/storage-keys";
import type { PlayerSong } from "@/types/player";
import {
  QobuzDownloadError,
  resolveQobuzAvailability,
  resolveQobuzTrackId,
  resolveQobuzStreamUrl as resolveQobuzProviderStreamUrl,
  type QobuzCredentials,
} from "@/lib/qobuz-download";
import {
  TidalDownloadError,
  resolveTidalStreamUrl as resolveTidalProviderStreamUrl,
} from "@/lib/tidal-download";
import {
  LicensedSourceDownloadError,
  materializeLicensedSourceStream,
  resolveLicensedSourceStreamUrl as resolveLicensedSourceProviderStreamUrl,
  type LicensedSourceStream,
} from "@/lib/licensed-source-download";
import {
  AmazonDownloadError,
  resolveAmazonAsinFromSpotify,
  resolveAmazonStreamUrl,
} from "@/lib/amazon-download";
import { classifyAudioBytes, classifyAudioContentType, type AudioCodecInfo } from "@/lib/audio-codec-detect";
import {
  SpotifyPathfinderError,
  fetchSpotifyArtistCatalog,
  fetchSpotifyAlbumTracks as fetchPathfinderAlbumTracks,
  fetchSpotifyLikedTracks,
  fetchSpotifyPlaylistCatalogPage,
  fetchSpotifyPlaylistTracks as fetchPathfinderPlaylistTracks,
  fetchSpotifyTrackMetadata,
  isSpotifyCatalogId,
  scrapeSpotifyTrackIdsFromHtml,
  searchSpotifyCatalog,
  searchSpotifyTrackId,
  type SpotifyCatalogArtist,
  type SpotifyCatalogPlaylist,
  type SpotifyBatchTrack,
} from "@/lib/spotify-pathfinder";
import { fetchLastFmSimilarTracks } from "@/lib/recommendations";
import { normalizeSongPart } from "@/lib/song-dedupe";
import { resolveTidalTrackIdByIsrc } from "@/lib/tidal-isrc";
import { lookupSoundcharts, soundchartsTokenFromEnv } from "@/lib/soundcharts";
import { createStreamingMultipartBody, peekAndReplayStream } from "./streaming-multipart";

type Variables = {
  user: AuthUser | null;
  db: SqlTag;
};

type AppEnv = {
  Bindings: CloudflareEnv;
  Variables: Variables;
};

type MusicProxyEnv = CloudflareEnv & {
  MAC_MINI_ORIGIN?: string;
  MAC_MINI_PROXY_TOKEN?: string;
};

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified?: string | Date | null;
};

const ERLIN_PROFILE_IMAGE_URL = "/profile.jpg";
const LOCAL_MAC_MINI_AUTH_USER: AuthUser = {
  id: "local-mac-mini",
  email: "erlin@spotify.local",
  name: "Erlin",
  image: ERLIN_PROFILE_IMAGE_URL,
  emailVerified: "owner",
};

type ActionPayload = {
  action?: unknown;
  spotifyUrl?: unknown;
  region?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  batchType?: unknown;
  outputFormat?: unknown;
};

type BatchDownloadPayload = {
  spotifyUrl?: unknown;
  region?: unknown;
  qualityProfile?: unknown;
  service?: unknown;
  outputFormat?: unknown;
  includeMetadata?: unknown;
  includeLyrics?: unknown;
  includeCover?: unknown;
  spotifyCookie?: unknown;
};

type SongPayload = {
  mode?: unknown;
  // Discover staging: when true, stage a cheap YouTube Opus preview (play/skip)
  // instead of resolving a lossless source. The lossless resolver is reserved
  // for the Add-to-library path so the library stays FLAC-only.
  preview?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  duration?: unknown;
  durationMs?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
  spotifyUrl?: unknown;
  service?: unknown;
  quality?: unknown;
  qualityProfile?: unknown;
  outputFormat?: unknown;
  region?: unknown;
  lyricsText?: unknown;
  replaceExisting?: unknown;
};

type BatchResponseTrack = {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  releaseDate: string;
  totalPlays: number;
  durationMs: number;
  imageUrl: string;
  previewUrl: string;
};

type PlaybackStateWritePayload = {
  state?: unknown;
};

type DownloadProviderService =
  | "licensed"
  | "tidal"
  | "tidal_x"
  | "tidal_custom"
  | "qobuz"
  | "qobuz_x"
  | "qobuz_custom"
  | "amazon"
  | "amazon_x"
  | "deezer"
  | "deezer_x"
  | "deezer_custom"
  | "apple";

type ResolvedAudioDownloadCandidate = {
  service: DownloadProviderService;
  streamUrl: string;
  headers?: Record<string, string>;
  contentType?: string;
  licensedStream?: LicensedSourceStream;
  userAgent?: string;
  minimumQuality?: "lossless";
};

type ResolvedAudioDownload = ResolvedAudioDownloadCandidate & {
  fallbacks?: ResolvedAudioDownloadCandidate[];
};

type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";

type EnhancedMetadata = {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  releaseDate?: string;
  trackNumber?: number;
  totalTracks?: number;
  discNumber?: number;
  totalDiscs?: number;
  genre?: string;
  isrc?: string;
  upc?: string;
  composer?: string;
  publisher?: string;
  copyright?: string;
  lyrics?: string;
  duration?: number;
  bitDepth?: number;
  sampleRate?: number;
};

const SESSION_COOKIE = "spotify_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_LYRICS_BYTES = 2 * 1024 * 1024;
const R2_DELETE_BATCH_SIZE = 1_000;
const SPOTIFY_REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 120_000;
const SERVER_IMPORT_OUTPUT_FORMAT: OutputFormat = "flac";
const OUTPUT_FORMATS = new Set<OutputFormat>(["flac", "mp3", "aac", "ogg", "opus", "wav"]);

const IMAGE_EXT_TYPES = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const AUDIO_EXT_TYPES = new Map<string, string>([
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp4", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mpeg", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
]);

// A valid bcrypt hash (of a throwaway secret) compared against when no user or
// password hash exists, so a failed signin spends the same CPU as a real one.
const DUMMY_PASSWORD_HASH = "$2b$10$7tXHcDkbjQu2CAfr8lewqezc3JeBLP4fnqpxolFBCCxzclVG0si.K";

let schemaPromise: Promise<void> | null = null;
let localOwnerUserPromise: Promise<void> | null = null;

// Ensures the synthetic local-preview owner ("local-mac-mini") has a backing
// User row so its editable-playlist writes satisfy the Playlist.userId foreign
// key D1 enforces. Memoized to one write per isolate. Only ever called on
// local-preview hosts (see the /api/* middleware), so it never runs in prod.
async function ensureLocalOwnerUser(db: SqlTag): Promise<void> {
  localOwnerUserPromise ??= (async () => {
    await db`
      INSERT INTO "User" ("id", "email", "name", "emailVerified", "image", "createdAt", "updatedAt")
      VALUES (
        ${LOCAL_MAC_MINI_AUTH_USER.id},
        ${LOCAL_MAC_MINI_AUTH_USER.email},
        ${LOCAL_MAC_MINI_AUTH_USER.name ?? "Library Owner"},
        ${LOCAL_MAC_MINI_AUTH_USER.emailVerified ?? "owner"},
        ${LOCAL_MAC_MINI_AUTH_USER.image ?? null},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("id") DO NOTHING
    `;
  })().catch((error) => {
    localOwnerUserPromise = null;
    throw error;
  });
  await localOwnerUserPromise;
}

class ApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function createD1SqlTag(d1: D1Database): SqlTag {
  const tag = (async function d1Tag<T = SqlRow>(
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): Promise<T[]> {
    const { sql, params } = buildSql(strings, values);
    const statement = d1.prepare(sql).bind(...params);
    if (statementReturnsRows(sql)) {
      const result = await statement.all<T>();
      return result.results ?? [];
    }
    await statement.run();
    return [];
  }) as SqlTag;

  tag.end = async () => {};
  return tag;
}

async function ensureSchema(env: CloudflareEnv): Promise<void> {
  schemaPromise ??= (async () => {
    for (const statement of D1_SCHEMA_STATEMENTS) {
      await env.DB.prepare(statement).bind().run();
    }
    // Columns added to the existing Playlist table after its initial CREATE.
    // Applied on the SAME memoized path everything awaits so the folder routing
    // gate can read source/convertedAt without ever hitting "no such column" on a
    // cold isolate. Idempotent: swallow "duplicate column" so re-runs are no-ops.
    for (const statement of [
      'ALTER TABLE "Playlist" ADD COLUMN "source" TEXT',
      'ALTER TABLE "Playlist" ADD COLUMN "convertedAt" TEXT',
    ]) {
      try {
        await env.DB.prepare(statement).bind().run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) throw error;
      }
    }
    // D1 ENFORCES foreign keys. The original PlaylistSong.songId FK referenced
    // Song, but editable-playlist membership stores ids that live in SongRef (or
    // the mini's filesystem library), never Song — so that FK rejects every
    // add-song / folder-seed insert with SQLITE_CONSTRAINT_FOREIGNKEY. Drop it by
    // rebuilding the table (keeping the playlistId FK). Guarded by a PRAGMA check
    // so it runs at most once; the table is dormant so the row copy is trivial.
    // The atomic batch + catch tolerate a concurrent isolate running the same.
    try {
      const fkList = await env.DB.prepare(`PRAGMA foreign_key_list("PlaylistSong")`).all<{ table?: string }>();
      if ((fkList.results ?? []).some((row) => row.table === "Song")) {
        await env.DB.batch([
          env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS "PlaylistSong_new" (
              "id" TEXT NOT NULL PRIMARY KEY,
              "playlistId" TEXT NOT NULL,
              "songId" TEXT NOT NULL,
              "order" INTEGER NOT NULL DEFAULT 0,
              UNIQUE ("playlistId", "songId"),
              FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE
            )`,
          ),
          env.DB.prepare(
            `INSERT OR IGNORE INTO "PlaylistSong_new" ("id","playlistId","songId","order")
             SELECT "id","playlistId","songId","order" FROM "PlaylistSong"`,
          ),
          env.DB.prepare(`DROP TABLE "PlaylistSong"`),
          env.DB.prepare(`ALTER TABLE "PlaylistSong_new" RENAME TO "PlaylistSong"`),
          env.DB.prepare(
            `CREATE INDEX IF NOT EXISTS "idx_playlistsong_playlist_order" ON "PlaylistSong" ("playlistId", "order")`,
          ),
        ]);
      }
    } catch {
      // A concurrent isolate likely ran the same migration; the post-condition
      // (no songId FK) is what matters and the next request re-checks.
    }
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function envString(env: CloudflareEnv, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function envStringList(env: CloudflareEnv, key: string): string[] {
  return envString(env, key)
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function toNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function durationSecondsFromPayload(payload: SongPayload): number | null {
  const durationMs = toNumberValue(payload.durationMs);
  if (durationMs != null && durationMs > 0) {
    return Math.round(durationMs / 1000);
  }

  const duration = toNumberValue(payload.duration);
  if (duration != null && duration > 0) {
    return Math.round(duration > 1000 ? duration / 1000 : duration);
  }

  return null;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function coercePlayerSongPayload(value: unknown): PlayerSong | null {
  const payload = toObject(value);
  if (!payload) return null;
  const id = toStringValue(payload.id);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const audioUrl = toStringValue(payload.audioUrl);
  if (!id || !title || !artist || !audioUrl) return null;
  const imageUrl = toStringValue(payload.imageUrl) || "/apple-icon.png";
  const lyricsUrl = toStringValue(payload.lyricsUrl);
  const description = toStringValue(payload.description);
  const link = toStringValue(payload.link);
  const album = toStringValue(payload.album);
  const createdAt = toStringValue(payload.createdAt);
  const source = toStringValue(payload.source);
  const localPath = toStringValue(payload.localPath);
  const duration = toNumberValue(payload.duration);
  const audioBitDepth = toNumberValue(payload.audioBitDepth);
  const audioSampleRate = toNumberValue(payload.audioSampleRate);
  // Staging identity must survive the round-trip (play events → "Recently played",
  // playback-state restore). Dropping discoverTrackId here made a re-played catalog/
  // Discover track un-promotable: liking it found no track id, so the keep targeted
  // the throwaway "discover:" placeholder id and silently reverted. Keep the fields
  // the stager/promote path depends on.
  const discoverTrackId = toStringValue(payload.discoverTrackId);
  const youtubeVideoId = toStringValue(payload.youtubeVideoId);
  const preview = payload.preview === true;
  return {
    id,
    title,
    artist,
    album: album || undefined,
    imageUrl,
    audioUrl,
    lyricsUrl: lyricsUrl || undefined,
    description: description || undefined,
    link: link || undefined,
    duration: duration ?? undefined,
    audioBitDepth: audioBitDepth ?? undefined,
    audioSampleRate: audioSampleRate ?? undefined,
    createdAt: createdAt || new Date().toISOString(),
    source: source ? (source as PlayerSong["source"]) : undefined,
    localPath: localPath || undefined,
    discoverTrackId: discoverTrackId || undefined,
    youtubeVideoId: youtubeVideoId || undefined,
    preview: preview || undefined,
  };
}

function isPersistablePlaybackSong(song: PlayerSong | null | undefined): song is PlayerSong {
  if (!song) return false;
  return !(
    song.source === "browser-local" ||
    song.source === "picked-file" ||
    song.source === "radio" ||
    song.id.startsWith("browser-local:") ||
    song.id.startsWith("picked-file:") ||
    song.id.startsWith("radio:") ||
    song.audioUrl.startsWith("blob:")
  );
}

function coercePlaybackStatePayload(value: unknown, fallbackUpdatedAt = Date.now()): PlaybackStateSnapshot | null {
  const payload = toObject(value);
  if (!payload) return null;
  const rawQueue = Array.isArray(payload.queue) ? payload.queue : [];
  const queue = rawQueue
    .map(coercePlayerSongPayload)
    .filter(isPersistablePlaybackSong);
  const payloadSong = coercePlayerSongPayload(payload.song);
  const fallbackIndex = Math.max(0, Math.min(queue.length - 1, Math.floor(toNumberValue(payload.currentIndex) ?? 0)));
  const song = isPersistablePlaybackSong(payloadSong) ? payloadSong : queue[fallbackIndex] ?? null;
  if (!song) return null;
  const queueWithSong = queue.some((item) => item.id === song.id) ? queue : [song, ...queue];
  const currentIndex = Math.max(0, queueWithSong.findIndex((item) => item.id === song.id));
  const currentTime = Math.max(0, toNumberValue(payload.currentTime) ?? 0);
  const updatedAt = Math.max(0, toNumberValue(payload.updatedAt) ?? fallbackUpdatedAt);
  const accountScope = toStringValue(payload.accountScope) || "anonymous";
  const deviceId = toStringValue(payload.deviceId) || "unknown";
  return {
    version: PLAYBACK_STATE_VERSION,
    accountScope,
    queue: queueWithSong,
    currentIndex,
    song,
    currentTime,
    isPlaying: payload.isPlaying === true,
    updatedAt,
    deviceId,
  };
}

function parsePlaybackStateJson(value: string): PlaybackStateSnapshot | null {
  try {
    return coercePlaybackStatePayload(JSON.parse(value), 0);
  } catch {
    return null;
  }
}

function playbackStateFromRow(row: PlaybackStateRow | undefined): PlaybackStateSnapshot | null {
  return row ? parsePlaybackStateJson(row.stateJson) : null;
}

function parsePlayEventSongJson(songJson: string): PlayerSong | null {
  try {
    return coercePlayerSongPayload(JSON.parse(songJson));
  } catch {
    return null;
  }
}

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function ifNoneMatchMatches(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === "*" || item === etag);
}

async function jsonCached(
  c: Context<AppEnv>,
  payload: unknown,
  init?: ResponseInit & { cacheControl?: string },
): Promise<Response> {
  const { cacheControl, ...responseInit } = init ?? {};
  const body = JSON.stringify(payload);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const etag = `W/"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}"`;
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cacheControl || "private, max-age=30, stale-while-revalidate=300");
  headers.set("etag", etag);

  if (ifNoneMatchMatches(c.req.header("if-none-match") ?? null, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { ...responseInit, headers });
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
  const format = toStringValue(value).toLowerCase() as OutputFormat;
  return OUTPUT_FORMATS.has(format) ? format : SERVER_IMPORT_OUTPUT_FORMAT;
}

function assertServerImportOutputFormat(payload: Pick<SongPayload, "outputFormat">): void {
  const outputFormat = outputFormatFromPayload(payload.outputFormat);
  if (outputFormat !== SERVER_IMPORT_OUTPUT_FORMAT) {
    throw new ApiError(
      `${outputFormat.toUpperCase()} output is only available for browser/local saves. Server imports currently support FLAC/original audio.`,
      400,
    );
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSecureCookieRequest(urlString: string): boolean {
  const url = new URL(urlString);
  if (url.protocol === "https:") return true;
  return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function readCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValueParts.join("=") || "");
    }
  }
  return "";
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const VERIFY_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24;
const DEFAULT_EMAIL_FROM = "noreply@streamarena.xyz";

// Cloudflare Email Service binding (public beta). Optional: the feature
// gracefully no-ops when the binding is not configured, so registration still
// works before the sending domain is verified / the binding is added.
type EmailSendMessage = {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
};
type EmailBinding = { send: (message: EmailSendMessage) => Promise<{ messageId: string }> };

function emailBinding(env: CloudflareEnv): EmailBinding | null {
  const binding = (env as unknown as { EMAIL?: EmailBinding }).EMAIL;
  return binding && typeof binding.send === "function" ? binding : null;
}

// Public origin used to build the email verification link. Prefers an explicit
// APP_ORIGIN, then the public app origin (MAC_MINI_ORIGIN), then the request.
function publicAppOrigin(env: CloudflareEnv, requestUrl: string): string {
  const configured = envString(env, "APP_ORIGIN") || envString(env, "MAC_MINI_ORIGIN");
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {}
  }
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "";
  }
}

async function createEmailVerificationToken(db: SqlTag, email: string): Promise<string> {
  const raw = randomToken();
  const tokenHash = await sha256Hex(raw);
  const expires = new Date(Date.now() + VERIFY_TOKEN_MAX_AGE_SECONDS * 1000);
  await db`DELETE FROM "VerificationToken" WHERE "identifier" = ${email}`;
  await db`
    INSERT INTO "VerificationToken" ("identifier", "token", "expires")
    VALUES (${email}, ${tokenHash}, ${expires})
  `;
  return raw;
}

async function sendVerificationEmail(
  env: CloudflareEnv,
  requestUrl: string,
  email: string,
  rawToken: string,
): Promise<boolean> {
  const binding = emailBinding(env);
  if (!binding) return false;
  const from = envString(env, "EMAIL_FROM") || DEFAULT_EMAIL_FROM;
  // Path-based token (no "=" query param): a raw "=" in the URL gets mangled by
  // quoted-printable email encoding, corrupting the link. A hex path segment is safe.
  const link = `${publicAppOrigin(env, requestUrl)}/api/auth/verify/${rawToken}`;
  const subject = "Verify your email";
  const text = `Welcome to Spotify.\n\nConfirm your email address by opening this link:\n${link}\n\nThis link expires in 24 hours. If you did not create this account, you can ignore this email.`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <h1 style="font-size:20px;margin:0 0 12px">Confirm your email</h1>
  <p style="margin:0 0 20px;line-height:1.5">Welcome to Spotify. Tap the button below to verify your email address.</p>
  <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9999px">Verify email</a></p>
  <p style="margin:0 0 8px;font-size:13px;color:#555">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="${link}">${link}</a></p>
  <p style="margin:0;font-size:12px;color:#888">This link expires in 24 hours. If you did not create this account, you can ignore this email.</p>
</div>`;
  try {
    await binding.send({ from, to: email, subject, text, html });
    return true;
  } catch (error) {
    console.error("verification email send failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

function getRequestIp(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return "unknown";
}

// D1-backed so limits are shared across Cloudflare isolates (an in-memory Map
// only constrains a single isolate). Resilient by design: any DB error fails
// OPEN (request allowed) so a transient D1 hiccup cannot lock out the owner.
async function rateLimit(
  db: SqlTag,
  req: Request,
  keyPrefix: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; headers: Headers; ip: string }> {
  const ip = getRequestIp(req);
  const key = `${keyPrefix}:${ip}`;
  const now = Date.now();
  let count = 1;
  let resetAt = now + windowMs;
  try {
    // Opportunistically delete expired windows so the table cannot grow unbounded.
    await db`DELETE FROM "RateLimit" WHERE "resetAt" <= ${now}`;
    const rows = await db<{ count: number; resetAt: number }>`
      SELECT "count", "resetAt" FROM "RateLimit" WHERE "key" = ${key} LIMIT 1
    `;
    const existing = rows[0];
    if (existing && existing.resetAt > now) {
      count = existing.count + 1;
      resetAt = existing.resetAt;
    }
    await db`
      INSERT INTO "RateLimit" ("key", "count", "resetAt")
      VALUES (${key}, ${count}, ${resetAt})
      ON CONFLICT ("key") DO UPDATE SET "count" = ${count}, "resetAt" = ${resetAt}
    `;
  } catch {
    // Fail open: never let a DB problem block legitimate auth attempts.
    const headers = new Headers();
    headers.set("X-RateLimit-Limit", String(max));
    headers.set("X-RateLimit-Remaining", String(max));
    return { allowed: true, headers, ip };
  }
  const allowed = count <= max;
  const headers = new Headers();
  headers.set("X-RateLimit-Limit", String(max));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, max - count)));
  headers.set("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  if (!allowed) headers.set("Retry-After", String(Math.ceil((resetAt - now) / 1000)));
  return { allowed, headers, ip };
}

async function getCurrentUser(req: Request, db: SqlTag): Promise<AuthUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const rows = await db<AuthUser>`
    SELECT u."id", u."email", u."name", u."image", u."emailVerified"
    FROM "Session" s
    INNER JOIN "User" u ON u."id" = s."userId"
    WHERE s."sessionToken" = ${tokenHash}
      AND datetime(s."expires") > datetime('now')
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function publicUser(user: AuthUser) {
  const defaultImage = defaultUserImage(user.email, user.name);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image || defaultImage || null,
    emailVerified: Boolean(user.emailVerified),
  };
}

async function ensureDefaultProfileImageStored(c: Context<AppEnv>, user: AuthUser): Promise<AuthUser> {
  const defaultImage = defaultUserImage(user.email, user.name);
  if (!defaultImage || user.id === LOCAL_MAC_MINI_AUTH_USER.id) return user;
  if (user.image && user.image !== defaultImage) return user;

  const response = await c.env.ASSETS.fetch(new Request(new URL(defaultImage, c.req.url)));
  if (!response.ok) return user;
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
  if (!IMAGE_MIME_TYPES.has(contentType)) return user;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return user;
  const ext =
    contentType === "image/png"
      ? ".png"
      : contentType === "image/gif"
        ? ".gif"
        : contentType === "image/webp"
          ? ".webp"
          : ".jpg";
  const key = `users/${sanitizePathSegment(user.id)}/profile/default${ext}`;
  const imageUrl = toApiFileUrl(key);
  const existing = await c.env.MEDIA.head(key);
  if (!existing) await putBuffer(c.env, key, buffer, contentType);
  await c.get("db")`
    UPDATE "User"
    SET "image" = ${imageUrl}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${user.id}
      AND ("image" IS NULL OR "image" = ${defaultImage})
  `;
  return { ...user, image: imageUrl };
}

async function publicUserForResponse(c: Context<AppEnv>, user: AuthUser) {
  return publicUser(await ensureDefaultProfileImageStored(c, user));
}

async function listAccountMediaRows(db: SqlTag, userId: string): Promise<AccountMediaRow[]> {
  return db<AccountMediaRow>`
    SELECT "image" AS "url"
    FROM "User"
    WHERE "id" = ${userId} AND "image" IS NOT NULL
    UNION ALL
    SELECT "imageUrl" AS "url"
    FROM "Song"
    WHERE "userId" = ${userId} AND "imageUrl" IS NOT NULL
    UNION ALL
    SELECT "audioUrl" AS "url"
    FROM "Song"
    WHERE "userId" = ${userId} AND "audioUrl" IS NOT NULL
    UNION ALL
    SELECT "lyricsUrl" AS "url"
    FROM "Song"
    WHERE "userId" = ${userId} AND "lyricsUrl" IS NOT NULL
    UNION ALL
    SELECT "imageUrl" AS "url"
    FROM "Playlist"
    WHERE "userId" = ${userId} AND "imageUrl" IS NOT NULL
    UNION ALL
    SELECT "imageUrl" AS "url"
    FROM "SongRef"
    WHERE "userId" = ${userId} AND "imageUrl" IS NOT NULL
    UNION ALL
    SELECT "audioUrl" AS "url"
    FROM "SongRef"
    WHERE "userId" = ${userId} AND "audioUrl" IS NOT NULL
    UNION ALL
    SELECT "lyricsUrl" AS "url"
    FROM "SongRef"
    WHERE "userId" = ${userId} AND "lyricsUrl" IS NOT NULL
  `;
}

async function listOtherAccountMediaRows(db: SqlTag, userId: string): Promise<AccountMediaRow[]> {
  return db<AccountMediaRow>`
    SELECT "image" AS "url"
    FROM "User"
    WHERE "id" <> ${userId} AND "image" IS NOT NULL
    UNION ALL
    SELECT "imageUrl" AS "url"
    FROM "Song"
    WHERE "userId" <> ${userId} AND "imageUrl" IS NOT NULL
    UNION ALL
    SELECT "audioUrl" AS "url"
    FROM "Song"
    WHERE "userId" <> ${userId} AND "audioUrl" IS NOT NULL
    UNION ALL
    SELECT "lyricsUrl" AS "url"
    FROM "Song"
    WHERE "userId" <> ${userId} AND "lyricsUrl" IS NOT NULL
    UNION ALL
    SELECT "imageUrl" AS "url"
    FROM "Playlist"
    WHERE "userId" <> ${userId} AND "imageUrl" IS NOT NULL
    UNION ALL
    SELECT "imageUrl" AS "url"
    FROM "SongRef"
    WHERE "userId" <> ${userId} AND "imageUrl" IS NOT NULL
    UNION ALL
    SELECT "audioUrl" AS "url"
    FROM "SongRef"
    WHERE "userId" <> ${userId} AND "audioUrl" IS NOT NULL
    UNION ALL
    SELECT "lyricsUrl" AS "url"
    FROM "SongRef"
    WHERE "userId" <> ${userId} AND "lyricsUrl" IS NOT NULL
  `;
}

async function deleteAccountRows(
  env: CloudflareEnv,
  userId: string,
  email: string,
  deletionRateLimitKey: string,
): Promise<void> {
  // D1 batch() is atomic. Most tables also have ON DELETE CASCADE, but the
  // explicit ordered deletes cover legacy schemas plus PlaybackState/SongRef,
  // which intentionally have no User foreign key.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM "PlaylistSong"
       WHERE "playlistId" IN (SELECT "id" FROM "Playlist" WHERE "userId" = ?)
          OR "songId" IN (SELECT "id" FROM "Song" WHERE "userId" = ?)
          OR "songId" IN (SELECT "id" FROM "SongRef" WHERE "userId" = ?)`,
    ).bind(userId, userId, userId),
    env.DB.prepare(
      `DELETE FROM "Like"
       WHERE "userId" = ?
          OR "songId" IN (SELECT "id" FROM "Song" WHERE "userId" = ?)`,
    ).bind(userId, userId),
    env.DB.prepare(`DELETE FROM "PlaybackState" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "PlayEvent" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "LikeBackfill" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "SongRef" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "Playlist" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "Song" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "Account" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "Session" WHERE "userId" = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM "VerificationToken" WHERE "identifier" = ?`).bind(email),
    env.DB.prepare(`DELETE FROM "RateLimit" WHERE "key" = ?`).bind(deletionRateLimitKey),
    env.DB.prepare(`DELETE FROM "User" WHERE "id" = ?`).bind(userId),
  ]);
}

async function deleteAccountMedia(env: CloudflareEnv, userId: string, keys: string[]): Promise<void> {
  const allKeys = new Set(keys);
  // Older avatars become unreferenced each time a new one is uploaded. They
  // cannot be recovered from D1, so enumerate the account-owned namespace too.
  // Song media is not user-namespaced and remains restricted to the reference
  // snapshot above to avoid deleting a file another account still uses.
  const profilePrefix = `users/${sanitizePathSegment(userId)}/profile/`;
  let cursor: string | undefined;
  try {
    do {
      const page = await env.MEDIA.list({
        prefix: profilePrefix,
        cursor,
        limit: R2_DELETE_BATCH_SIZE,
      });
      for (const object of page.objects) allKeys.add(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    console.error(
      "[account deletion] profile media listing failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const pendingKeys = [...allKeys];
  for (let offset = 0; offset < pendingKeys.length; offset += R2_DELETE_BATCH_SIZE) {
    const batch = pendingKeys.slice(offset, offset + R2_DELETE_BATCH_SIZE);
    if (batch.length > 0) await env.MEDIA.delete(batch);
  }
}

function defaultUserImage(_email: string, _name: string | null): string | null {
  // Name-based identity heuristics have been dropped; everyone gets the same
  // generic default avatar (resolved by the normal fallback paths).
  return null;
}

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) throw new ApiError("Unauthorized", 401);
  return user;
}

function requirePlaybackStateUser(c: Context<AppEnv>): AuthUser {
  return requireUser(c.get("user") ?? getLocalMacMiniAuthUser(c));
}

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName || "upload");
  const safe = base.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return safe || "upload";
}

function sanitizePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9.\-_ ]/g, "_").replace(/\s+/g, " ");
  return safe || "unknown";
}

function buildOrganizedMusicBasePath(title: string, artist: string): string {
  return join("music", sanitizePathSegment(artist), sanitizePathSegment(title)).replaceAll("\\", "/");
}

function toApiFileUrl(key: string): string {
  const parts = key
    .split("/")
    .filter(Boolean)
    .map((part) => {
      let decoded = part;
      for (let i = 0; i < 2; i += 1) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch {
          break;
        }
      }
      return decoded;
    });
  return `/api/files/${parts.join("/")}`;
}

function parseStorageKeyFromPathSuffix(encoded: string): string {
  return encoded
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

function parseStorageKeyFromApiPath(pathname: string): string {
  return parseStorageKeyFromPathSuffix(pathname.slice("/api/files/".length));
}

async function storageKeyBelongsToUser(db: SqlTag, key: string, userId: string): Promise<boolean> {
  const fileUrl = toApiFileUrl(key);
  const userRows = await db<{ id: string }>`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}
      AND "image" = ${fileUrl}
    LIMIT 1
  `;
  if (userRows[0]) return true;
  const rows = await db<{ id: string }>`
    SELECT "id"
    FROM "Song"
    WHERE "userId" = ${userId}
      AND ("audioUrl" = ${fileUrl} OR "imageUrl" = ${fileUrl} OR "lyricsUrl" = ${fileUrl})
    LIMIT 1
  `;
  return Boolean(rows[0]);
}

function parseArtworkWidth(value: string | undefined): number {
  const width = Number(value || 0);
  if (!Number.isFinite(width) || width <= 0) return 256;
  return Math.max(32, Math.min(1024, Math.round(width)));
}

function extensionForStoredFile(kind: "image" | "audio", fileName: string, contentType: string): string {
  const ext = extname(sanitizeFileName(fileName)).toLowerCase();
  if (kind === "image") {
    if (IMAGE_EXT_TYPES.has(ext)) return ext === ".jpeg" ? ".jpg" : ext;
    const normalized = contentType.toLowerCase().split(";")[0]?.trim() || "";
    if (!IMAGE_MIME_TYPES.has(normalized)) throw new ApiError("Unsupported image format", 415);
    if (normalized === "image/png") return ".png";
    if (normalized === "image/gif") return ".gif";
    if (normalized === "image/webp") return ".webp";
    return ".jpg";
  }
  if (AUDIO_EXT_TYPES.has(ext)) return ext;
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() || "";
  if (!AUDIO_MIME_TYPES.has(normalized)) throw new ApiError("Unsupported audio format", 415);
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) return ".m4a";
  return ".flac";
}

async function putBuffer(env: CloudflareEnv, key: string, buffer: ArrayBuffer | Uint8Array, contentType?: string) {
  await env.MEDIA.put(normalizeStorageKey(key), buffer, {
    httpMetadata: { contentType: contentType || inferContentTypeFromKey(key) },
  });
}

async function putStream(env: CloudflareEnv, key: string, stream: ReadableStream, contentType?: string) {
  await env.MEDIA.put(normalizeStorageKey(key), stream, {
    httpMetadata: { contentType: contentType || inferContentTypeFromKey(key) },
  });
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "spotify/1.0 (+https://music.streamarena.xyz)",
        ...(init?.headers || {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("Remote request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseSpotifyTrackId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "spotify.com" && host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const trackIndex = parts.findIndex((part) => part === "track");
  const trackId = trackIndex >= 0 ? parts[trackIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(trackId) ? trackId : null;
}

function parseSpotifyAlbumId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "spotify.com" && host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const albumIndex = parts.findIndex((part) => part === "album");
  const albumId = albumIndex >= 0 ? parts[albumIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(albumId) ? albumId : null;
}

function parseSpotifyPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "spotify.com" && host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const playlistIndex = parts.findIndex((part) => part === "playlist");
  const playlistId = playlistIndex >= 0 ? parts[playlistIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(playlistId) ? playlistId : null;
}

function determineSpotifyUrlType(url: string): "track" | "album" | "playlist" | "collection" | null {
  try {
    const parsed = new URL(url.trim());
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.includes("track")) return "track";
    if (parts.includes("album")) return "album";
    if (parts.includes("playlist")) return "playlist";
    if (parts.includes("collection")) return "collection";
  } catch {}
  return null;
}

function parseTrackIdFromUrl(url: string): string | null {
  return url.match(/\/track\/([A-Za-z0-9]+)/i)?.[1] ?? null;
}

function parsePlatformId(entityUniqueId: string, prefix: string): string {
  return entityUniqueId.startsWith(prefix) ? entityUniqueId.slice(prefix.length).trim() : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJsonObject(url: string, timeoutMs = SPOTIFY_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const maxAttempts = 3;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response | null;
    try {
      response = await fetchWithTimeout(url, timeoutMs);
    } catch {
      response = null;
    }
    if (!response) throw new ApiError("Upstream request failed", 502);
    if (response.ok) {
      const payload = toObject(await response.json().catch(() => null));
      if (!payload) throw new ApiError("Invalid upstream JSON", 502);
      return payload;
    }
    lastStatus = response.status;
    // Retry transient rate-limit / server errors; honor Retry-After when present.
    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : 400 * attempt;
      await delay(backoffMs);
      continue;
    }
    throw new ApiError(`Upstream request returned ${response.status}`, 502);
  }
  throw new ApiError(`Upstream request returned ${lastStatus}`, 502);
}

async function fetchSongLinkPayload(trackId: string, region: string): Promise<Record<string, unknown>> {
  const spotifyUrl = `https://open.spotify.com/track/${trackId}`;
  const params = new URLSearchParams({ url: spotifyUrl });
  if (region) params.set("userCountry", region);
  return fetchJsonObject(`https://api.song.link/v1-alpha.1/links?${params.toString()}`);
}

const SPOTIFY_FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function decodeJsonUnicode(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(["\\/])/g, "$1");
}

// Auth-free title/artist lookup from Spotify's embed page. The embed HTML
// inlines a JSON island with the track entity, which lets us seed a Deezer
// search when the Odesli resolver is unavailable.
async function fetchSpotifyEmbedMetadata(trackId: string): Promise<{ title: string; artist: string }> {
  const response = await fetchWithTimeout(
    `https://open.spotify.com/embed/track/${trackId}`,
    SPOTIFY_REQUEST_TIMEOUT_MS,
    { headers: { "user-agent": SPOTIFY_FALLBACK_USER_AGENT, accept: "text/html" } },
  ).catch(() => null);
  if (!response || !response.ok) return { title: "", artist: "" };
  const html = await response.text().catch(() => "");
  if (!html) return { title: "", artist: "" };
  const title =
    html.match(/"name"\s*:\s*"([^"]+)"\s*,\s*"uri"\s*:\s*"spotify:track:/)?.[1] ||
    html.match(/"title"\s*:\s*"([^"]+)"/)?.[1] ||
    "";
  const artist = html.match(/"artists"\s*:\s*\[\s*\{\s*"name"\s*:\s*"([^"]+)"/)?.[1] || "";
  return { title: decodeJsonUnicode(title), artist: decodeJsonUnicode(artist) };
}

// Find a track on Deezer (auth-free) by artist/title, returning its numeric id.
async function searchDeezerTrackId(title: string, artist: string): Promise<string> {
  const queries = [
    artist && title ? `artist:"${artist}" track:"${title}"` : "",
    [artist, title].filter(Boolean).join(" "),
  ].filter(Boolean);
  for (const query of queries) {
    const payload = await fetchJsonObject(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=1`,
    ).catch(() => null);
    const data = payload && Array.isArray(payload.data) ? payload.data : [];
    const rawId = toObject(data[0])?.id;
    const id = typeof rawId === "number" ? String(rawId) : toStringValue(rawId);
    if (/^\d+$/.test(id)) return id;
  }
  return "";
}

// Build a minimal song.link-shaped payload from a Deezer match so the existing
// metadata / ISRC / Qobuz-availability code keeps working when Odesli is down.
function buildFallbackSongLinkPayload(
  trackId: string,
  deezerId: string,
  title: string,
  artist: string,
  thumbnailUrl = "",
): Record<string, unknown> {
  const spotifyKey = `SPOTIFY_SONG::${trackId}`;
  const deezerKey = `DEEZER_SONG::${deezerId}`;
  const entity = { title, artistName: artist, thumbnailUrl };
  return {
    entityUniqueId: spotifyKey,
    entitiesByUniqueId: { [spotifyKey]: entity, [deezerKey]: entity },
    linksByPlatform: {
      deezer: { url: `https://www.deezer.com/track/${deezerId}`, entityUniqueId: deezerKey },
    },
  };
}

// Resolve a Spotify track to a song.link-shaped payload. Primary source is
// Odesli (which retries on 429); when that is rate-limited or down, fall back
// to an auth-free Spotify-embed -> Deezer lookup so uploads keep working.
// Look up a track on Deezer by its exact ISRC (auth-free), returning the numeric id.
async function deezerIdByIsrc(isrc: string): Promise<string> {
  if (!isrc) return "";
  const payload = await fetchJsonObject(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`).catch(() => null);
  const rawId = payload?.id;
  const id = typeof rawId === "number" ? String(rawId) : toStringValue(rawId);
  return /^\d+$/.test(id) ? id : "";
}

// Resolve via Spotify's authenticated API (sp_dc): canonical metadata + exact
// ISRC, then pin the matching Deezer track by that ISRC so downstream ISRC /
// Qobuz logic works unchanged. Returns null when Spotify is unavailable.
async function resolveViaSpotify(trackId: string, spotifyCookie: string): Promise<Record<string, unknown> | null> {
  const meta = await fetchSpotifyTrackMetadata(trackId, spotifyCookie || undefined).catch(() => null);
  if (!meta || !meta.title) return null;
  let deezerId = meta.isrc ? await deezerIdByIsrc(meta.isrc).catch(() => "") : "";
  if (!deezerId) deezerId = await searchDeezerTrackId(meta.title, meta.artist).catch(() => "");
  if (!deezerId) return null;
  return buildFallbackSongLinkPayload(trackId, deezerId, meta.title, meta.artist, meta.imageUrl);
}

// Resolve a Spotify track to a song.link-shaped payload. Primary source is
// Spotify itself (authenticated via sp_dc) for canonical metadata + exact ISRC;
// then Odesli (retries 429); then an auth-free Spotify-embed -> Deezer lookup.
async function resolveTrackPayload(
  trackId: string,
  region: string,
  spotifyCookie = "",
): Promise<Record<string, unknown>> {
  const viaSpotify = await resolveViaSpotify(trackId, spotifyCookie).catch(() => null);
  if (viaSpotify) return viaSpotify;

  const odesli = await fetchSongLinkPayload(trackId, region).catch(() => null);
  if (odesli && toObject(odesli.entitiesByUniqueId)) return odesli;

  const meta = await fetchSpotifyEmbedMetadata(trackId);
  const deezerId = await searchDeezerTrackId(meta.title, meta.artist);
  if (!deezerId) throw new ApiError("Could not resolve this track on any provider", 502);
  return buildFallbackSongLinkPayload(trackId, deezerId, meta.title, meta.artist);
}

// Best-effort: when a resolved payload has an ISRC (via its Deezer link) but no
// Tidal link, look the Tidal id up by ISRC and inject it so the Hi-Res spotbye
// Tidal source can be used instead of the lossy GDStudio fallback.
async function enrichTidalLink(songLinkPayload: Record<string, unknown>, region: string): Promise<void> {
  if (!songLinkPayload || typeof songLinkPayload !== "object") return;
  if (tidalTrackIdFromSongLinkPayload(songLinkPayload)) return;
  const isrc = await resolveDeezerIsrc(songLinkPayload).catch(() => "");
  if (!isrc) return;
  const tidalId = await resolveTidalTrackIdByIsrc(isrc, region).catch(() => "");
  if (!tidalId) return;
  const links = toObject(songLinkPayload.linksByPlatform) ?? {};
  links.tidal = {
    url: `https://tidal.com/browse/track/${tidalId}`,
    entityUniqueId: `TIDAL_SONG::${tidalId}`,
  };
  songLinkPayload.linksByPlatform = links;
}

function injectPlatformLink(
  songLinkPayload: Record<string, unknown>,
  platform: string,
  url: string,
  entityUniqueId: string,
): void {
  if (getPlatformLink(songLinkPayload, platform)) return;
  const links = toObject(songLinkPayload.linksByPlatform) ?? {};
  links[platform] = { url, entityUniqueId };
  songLinkPayload.linksByPlatform = links;
}

/** Fill missing Tidal/Qobuz/Amazon/Deezer IDs via Soundcharts (Next parity). */
async function enrichSoundchartsLinks(
  env: CloudflareEnv,
  songLinkPayload: Record<string, unknown>,
): Promise<void> {
  if (!songLinkPayload || typeof songLinkPayload !== "object") return;
  const token = soundchartsTokenFromEnv({
    SOUNDCHARTS_TOKEN: envString(env, "SOUNDCHARTS_TOKEN"),
    SOUNDCHARTS_COOKIES_JSON: envString(env, "SOUNDCHARTS_COOKIES_JSON"),
  });
  if (!token) return;
  const missing =
    !getPlatformLink(songLinkPayload, "tidal") ||
    !getPlatformLink(songLinkPayload, "qobuz") ||
    !getPlatformLink(songLinkPayload, "amazonMusic") ||
    !getPlatformLink(songLinkPayload, "amazon") ||
    !getPlatformLink(songLinkPayload, "deezer");
  if (!missing) return;
  const isrc = await resolveDeezerIsrc(songLinkPayload).catch(() => "");
  if (!isrc) return;
  const ids = await lookupSoundcharts(isrc, { token }).catch(() => null);
  if (!ids) return;
  if (ids.tidal) {
    injectPlatformLink(
      songLinkPayload,
      "tidal",
      `https://tidal.com/browse/track/${ids.tidal}`,
      `TIDAL_SONG::${ids.tidal}`,
    );
  }
  if (ids.qobuz) {
    injectPlatformLink(
      songLinkPayload,
      "qobuz",
      `https://open.qobuz.com/track/${ids.qobuz}`,
      `QOBUZ_SONG::${ids.qobuz}`,
    );
  }
  if (ids.deezer) {
    injectPlatformLink(
      songLinkPayload,
      "deezer",
      `https://www.deezer.com/track/${ids.deezer}`,
      `DEEZER_SONG::${ids.deezer}`,
    );
  }
  if (ids.amazon) {
    injectPlatformLink(
      songLinkPayload,
      "amazonMusic",
      `https://music.amazon.com/tracks/${ids.amazon}`,
      `AMAZON_SONG::${ids.amazon}`,
    );
  }
}

function getPlatformLink(
  songLinkPayload: Record<string, unknown>,
  platform: string,
): { url: string; entityUniqueId: string } | null {
  const linksByPlatform = toObject(songLinkPayload.linksByPlatform);
  if (!linksByPlatform) return null;
  const platformData = toObject(linksByPlatform[platform]);
  if (!platformData) return null;
  const url = toStringValue(platformData.url);
  const entityUniqueId = toStringValue(platformData.entityUniqueId);
  if (!url && !entityUniqueId) return null;
  return { url, entityUniqueId };
}

function parseSongLinkMetadata(songLinkPayload: Record<string, unknown>, spotifyTrackId: string) {
  const entities = toObject(songLinkPayload.entitiesByUniqueId);
  if (!entities) return { title: "", artist: "", imageUrl: "" };
  const keys = [toStringValue(songLinkPayload.entityUniqueId), `SPOTIFY_SONG::${spotifyTrackId}`];
  for (const key of keys) {
    if (!key) continue;
    const entity = toObject(entities[key]);
    if (!entity) continue;
    return {
      title: toStringValue(entity.title),
      artist: toStringValue(entity.artistName),
      imageUrl: toStringValue(entity.thumbnailUrl),
    };
  }
  return { title: "", artist: "", imageUrl: "" };
}

function parseDeezerTrackId(songLinkPayload: Record<string, unknown>): string {
  const deezer = getPlatformLink(songLinkPayload, "deezer");
  const entityId = deezer ? parsePlatformId(deezer.entityUniqueId, "DEEZER_SONG::") : "";
  const urlId = deezer?.url ? parseTrackIdFromUrl(deezer.url) : "";
  const id = entityId || urlId || "";
  return /^\d+$/.test(id) ? id : "";
}

async function fetchDeezerTrackInfo(deezerTrackId: string) {
  if (!deezerTrackId) return null;
  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerTrackId}`).catch(() => null);
  if (!deezerPayload) return null;
  const albumObj = toObject(deezerPayload.album);
  const artistObj = toObject(deezerPayload.artist);
  const durationRaw = deezerPayload.duration;
  const playsRaw = deezerPayload.rank;
  const durationSec =
    typeof durationRaw === "number" ? durationRaw : typeof durationRaw === "string" ? Number(durationRaw) : 0;
  const plays = typeof playsRaw === "number" ? playsRaw : typeof playsRaw === "string" ? Number(playsRaw) : 0;
  const genresObj = toObject(deezerPayload.genres);
  const genreItems = Array.isArray(genresObj?.data) ? genresObj.data : [];
  const firstGenre = toObject(genreItems[0]);

  return {
    album: toStringValue(albumObj?.title),
    albumArtist: toStringValue(artistObj?.name),
    coverUrl:
      toStringValue(albumObj?.cover_xl) ||
      toStringValue(albumObj?.cover_big) ||
      toStringValue(albumObj?.cover_medium) ||
      toStringValue(albumObj?.cover) ||
      "",
    releaseDate: toStringValue(deezerPayload.release_date),
    trackNumber: typeof deezerPayload.track_position === "number" ? deezerPayload.track_position : undefined,
    totalTracks: typeof albumObj?.nb_tracks === "number" ? albumObj.nb_tracks : undefined,
    discNumber: typeof deezerPayload.disk_number === "number" ? deezerPayload.disk_number : undefined,
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    plays: Number.isFinite(plays) ? plays : 0,
    isrc: toStringValue(deezerPayload.isrc).toUpperCase(),
    upc: toStringValue(albumObj?.upc),
    genre: toStringValue(firstGenre?.name) || undefined,
  };
}

async function fetchEnhancedMetadata(trackId: string, songLinkPayload: Record<string, unknown>): Promise<EnhancedMetadata> {
  const metadata = parseSongLinkMetadata(songLinkPayload, trackId);
  const deezerInfo = await fetchDeezerTrackInfo(parseDeezerTrackId(songLinkPayload));

  // Try to get additional metadata from MusicBrainz using ISRC
  let musicBrainzData = null;
  if (deezerInfo?.isrc) {
    try {
      const mbResponse = await fetchWithTimeout(
        `https://musicbrainz.org/ws/2/recording?query=isrc:${deezerInfo.isrc}&fmt=json`,
        SPOTIFY_REQUEST_TIMEOUT_MS
      );
      if (mbResponse.ok) {
        const mbPayload = await mbResponse.json();
        const recording = mbPayload?.recordings?.[0];
        if (recording) {
          musicBrainzData = {
            composer: recording.relations
              ?.filter((rel: any) => rel.type === "composer")
              ?.map((rel: any) => rel.artist?.name)
              ?.join(", ") || undefined,
            publisher: recording.relations
              ?.filter((rel: any) => rel.type === "publisher")
              ?.map((rel: any) => rel.label?.name)
              ?.join(", ") || undefined,
          };
        }
      }
    } catch {
      // MusicBrainz lookup failed, continue without composer/publisher data
    }
  }

  return {
    title: metadata.title || "Unknown Title",
    artist: metadata.artist || "Unknown Artist",
    album: deezerInfo?.album || "",
    albumArtist: deezerInfo?.albumArtist,
    releaseDate: deezerInfo?.releaseDate,
    trackNumber: deezerInfo?.trackNumber,
    totalTracks: deezerInfo?.totalTracks,
    discNumber: deezerInfo?.discNumber,
    genre: deezerInfo?.genre,
    isrc: deezerInfo?.isrc,
    upc: deezerInfo?.upc,
    composer: musicBrainzData?.composer,
    publisher: musicBrainzData?.publisher,
    duration: deezerInfo?.durationSec,
  };
}

async function getPreviewUrl(trackId: string): Promise<string> {
  const response = await fetchWithTimeout(`https://open.spotify.com/embed/track/${trackId}`, 20_000).catch(() => null);
  if (!response?.ok) return "";
  const html = await response.text().catch(() => "");
  return html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9?&=._-]+/)?.[0] ?? "";
}

type SpotifyFallbackTrack = {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album?: string;
  releaseDate?: string;
  durationMs?: number;
  imageUrl?: string;
};

async function fetchSpotifyAlbumTracks(albumId: string, spotifyCookie = ""): Promise<SpotifyFallbackTrack[]> {
  try {
    const result = await fetchPathfinderAlbumTracks(albumId, spotifyCookie || undefined);
    return result.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      artists: track.artists.map((name) => ({ name })),
      album: track.album,
      releaseDate: track.releaseDate,
      durationMs: track.durationMs,
      imageUrl: track.imageUrl,
    }));
  } catch {
    try {
      const response = await fetchWithTimeout(`https://open.spotify.com/album/${albumId}`, SPOTIFY_REQUEST_TIMEOUT_MS);
      if (!response.ok) return [];
      const html = await response.text();
      return scrapeSpotifyTrackIdsFromHtml(html).map((id) => ({
        id,
        name: "Unknown Track",
        artists: [{ name: "Unknown Artist" }],
      }));
    } catch {
      return [];
    }
  }
}

async function fetchSpotifyPlaylistTracks(playlistId: string, spotifyCookie = ""): Promise<Array<{ track: SpotifyFallbackTrack }>> {
  try {
    const result = await fetchPathfinderPlaylistTracks(playlistId, spotifyCookie || undefined);
    return result.tracks.map((track) => ({
      track: {
        id: track.id,
        name: track.name,
        artists: track.artists.map((name) => ({ name })),
        album: track.album,
        releaseDate: track.releaseDate,
        durationMs: track.durationMs,
        imageUrl: track.imageUrl,
      },
    }));
  } catch (error) {
    if (error instanceof SpotifyPathfinderError && error.status !== 502) throw error;
    try {
      const response = await fetchWithTimeout(`https://open.spotify.com/playlist/${playlistId}`, SPOTIFY_REQUEST_TIMEOUT_MS);
      if (!response.ok) return [];
      const html = await response.text();
      return scrapeSpotifyTrackIdsFromHtml(html).map((id) => ({
        track: { id, name: "Unknown Track", artists: [{ name: "Unknown Artist" }] },
      }));
    } catch {
      return [];
    }
  }
}

function batchTrackForResponse(track: SpotifyBatchTrack): BatchResponseTrack {
  return {
    spotifyId: track.id,
    title: track.name || "Unknown Track",
    artist: track.artists.filter(Boolean).join(", ") || "Unknown Artist",
    album: track.album || "",
    releaseDate: track.releaseDate || "",
    totalPlays: 0,
    durationMs: track.durationMs || 0,
    imageUrl: track.imageUrl || "",
    previewUrl: "",
  };
}

function dedupeBatchTracks(tracks: SpotifyBatchTrack[]): SpotifyBatchTrack[] {
  const seen = new Set<string>();
  const result: SpotifyBatchTrack[] = [];
  for (const track of tracks) {
    if (!track.id || seen.has(track.id)) continue;
    seen.add(track.id);
    result.push(track);
  }
  return result;
}

function extractLrcFromSpotifyLyricsApi(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  const obj = toObject(payload);
  if (!obj) return "";
  const direct = toStringValue(obj.lyrics || obj.lrc || obj.syncedLyrics);
  if (direct) return direct;
  const linesValue = obj.lines;
  if (!Array.isArray(linesValue)) return "";
  const lines: string[] = [];
  for (const item of linesValue) {
    const line = toObject(item);
    if (!line) continue;
    const words = toStringValue(line.words || line.text);
    if (!words) continue;
    const timeTag = toStringValue(line.timeTag || line.startTimeMs || line.time);
    lines.push(timeTag ? `[${timeTag}]${words}` : words);
  }
  return lines.join("\n").trim();
}

const MUSIXMATCH_BASE = "https://apic-desktop.musixmatch.com/ws/1.1";
const MUSIXMATCH_APP_ID = "web-desktop-app-v1.0";
const MUSIXMATCH_COOKIE = "AWSELB=0; AWSELBCORS=0";

let musixmatchTokenCache: { token: string; expiresAtMs: number } | null = null;

// Musixmatch's desktop API bootstraps an anonymous user token via token.get,
// which is then required for lyrics lookups — no stored credential needed.
async function musixmatchUserToken(): Promise<string> {
  if (musixmatchTokenCache && musixmatchTokenCache.expiresAtMs > Date.now()) {
    return musixmatchTokenCache.token;
  }
  const response = await fetchWithTimeout(
    `${MUSIXMATCH_BASE}/token.get?app_id=${MUSIXMATCH_APP_ID}&format=json`,
    SPOTIFY_REQUEST_TIMEOUT_MS,
    { headers: { cookie: MUSIXMATCH_COOKIE, "user-agent": SPOTIFY_FALLBACK_USER_AGENT } },
  ).catch(() => null);
  if (!response?.ok) return "";
  const payload = toObject(await response.json().catch(() => null));
  const body = toObject(toObject(payload?.message)?.body);
  const token = toStringValue(body?.user_token);
  if (!token || token === "UpgradeOnlyUrlError") return "";
  musixmatchTokenCache = { token, expiresAtMs: Date.now() + 9 * 60 * 1000 };
  return token;
}

// Fetch synced (LRC) lyrics from Musixmatch by track/artist match.
async function fetchMusixmatchLyrics(title: string, artist: string): Promise<string> {
  if (!title || !artist) return "";
  const token = await musixmatchUserToken();
  if (!token) return "";
  const params = new URLSearchParams({
    format: "json",
    app_id: MUSIXMATCH_APP_ID,
    usertoken: token,
    q_track: title,
    q_artist: artist,
    subtitle_format: "lrc",
  });
  const response = await fetchWithTimeout(
    `${MUSIXMATCH_BASE}/matcher.subtitle.get?${params.toString()}`,
    SPOTIFY_REQUEST_TIMEOUT_MS,
    { headers: { cookie: MUSIXMATCH_COOKIE, "user-agent": SPOTIFY_FALLBACK_USER_AGENT } },
  ).catch(() => null);
  if (!response?.ok) return "";
  const payload = toObject(await response.json().catch(() => null));
  const body = toObject(toObject(payload?.message)?.body);
  const subtitle = toObject(body?.subtitle);
  return toStringValue(subtitle?.subtitle_body);
}

async function fetchLyricsText(trackId: string, title: string, artist: string): Promise<string> {
  const spotifyLyricsUrl = `https://spotify-lyrics-api-pi.vercel.app/?trackid=${encodeURIComponent(trackId)}&format=lrc`;
  const spotifyLyricsRes = await fetchWithTimeout(spotifyLyricsUrl, SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (spotifyLyricsRes?.ok) {
    const payload = await spotifyLyricsRes.json().catch(() => null);
    const obj = toObject(payload);
    if (!obj?.error) {
      const lrc = extractLrcFromSpotifyLyricsApi(payload);
      if (lrc) return lrc;
    }
  }
  const musixmatchLyrics = await fetchMusixmatchLyrics(title, artist).catch(() => "");
  if (musixmatchLyrics) return musixmatchLyrics;
  const lrclibUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
  const lrclibRes = await fetchWithTimeout(lrclibUrl, SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (lrclibRes?.ok) {
    const payload = toObject(await lrclibRes.json().catch(() => null));
    return toStringValue(payload?.syncedLyrics) || toStringValue(payload?.plainLyrics);
  }
  return "";
}

async function resolveDeezerIsrc(songLinkPayload: Record<string, unknown>): Promise<string> {
  const deezerId = parseDeezerTrackId(songLinkPayload);
  if (!deezerId) return "";
  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerId}`).catch(() => null);
  return toStringValue(deezerPayload?.isrc).toUpperCase();
}

function qualityLists(payload: SongPayload) {
  const qualityRaw = toStringValue(payload.quality);
  const profileRaw = toStringValue(payload.qualityProfile).toLowerCase();
  const qualityProfile = ["cd", "hires48", "max"].includes(profileRaw) ? profileRaw : "max";
  const qobuz = qualityProfile === "cd"
    ? ["16", "6"]
    : qualityProfile === "hires48"
      ? ["16", "7", "6"]
      : ["24", "27", "16", "7", "6"];
  const tidal =
    qualityProfile === "cd"
      ? ["LOSSLESS"]
      : qualityProfile === "hires48"
        ? ["HI_RES_LOSSLESS", "LOSSLESS"]
        : ["HI_RES_LOSSLESS", "LOSSLESS"];
  return {
    qobuz: qualityRaw ? [qualityRaw] : qobuz,
    tidal: qualityRaw ? [qualityRaw] : tidal,
  };
}

function qobuzCredentialsFromEnv(env: CloudflareEnv): QobuzCredentials | undefined {
  const appId = envString(env, "QOBUZ_APP_ID") || envString(env, "QOBUZ_OPEN_APP_ID");
  const appSecret = envString(env, "QOBUZ_APP_SECRET") || envString(env, "QOBUZ_OPEN_APP_SECRET");
  return appId && appSecret ? { appId, appSecret } : undefined;
}

const DEFAULT_SPOTIFLAC_PROVIDER_ORDER: DownloadProviderService[] = [
  "tidal",
  "tidal_x",
  "tidal_custom",
  "qobuz",
  "qobuz_x",
  "qobuz_custom",
  "amazon",
  "amazon_x",
  "deezer",
  "deezer_x",
  "deezer_custom",
  "apple",
];

const DEFAULT_SPOTIFLAC_CONFIGURED_PROVIDER_URLS: Partial<Record<DownloadProviderService, string[]>> = {
  tidal: [
    "https://tdl-a.spotbye.qzz.io/api/dl",
    "https://tdl-b.spotbye.qzz.io/api/dl",
    "https://tdl-c.spotbye.qzz.io/api/dl",
    "https://tdl-d.spotbye.qzz.io/api/dl",
    "https://tdl-e.spotbye.qzz.io/api/dl",
  ],
  qobuz: [
    "https://qbz-a.spotbye.qzz.io/api/dl",
    "https://qbz-b.spotbye.qzz.io/api/dl",
    "https://qbz-c.spotbye.qzz.io/api/dl",
    "https://qbz-d.spotbye.qzz.io/api/dl",
    "https://qbz-e.spotbye.qzz.io/api/dl",
  ],
  amazon: [
    "https://amz-a.spotbye.qzz.io/api/dl",
    "https://amz-b.spotbye.qzz.io/api/dl",
    "https://amz-c.spotbye.qzz.io/api/dl",
    "https://amz-d.spotbye.qzz.io/api/dl",
    "https://amz-e.spotbye.qzz.io/api/dl",
  ],
  amazon_x: ["https://amz-x.spotbye.qzz.io/api/dl"],
  qobuz_x: ["https://qbz-x.spotbye.qzz.io/api/dl"],
  deezer: [
    "https://dzr-a.spotbye.qzz.io/api/dl",
    "https://dzr-b.spotbye.qzz.io/api/dl",
    "https://dzr-c.spotbye.qzz.io/api/dl",
    "https://dzr-d.spotbye.qzz.io/api/dl",
    "https://dzr-e.spotbye.qzz.io/api/dl",
  ],
  deezer_x: ["https://dzr-x.spotbye.qzz.io/api/dl"],
  apple: ["https://am.spotbye.qzz.io/api/dl"],
};
const DEFAULT_SPOTIFLAC_STATUS_URL = "https://spotbye.qzz.io/api/status";
const SPOTIFLAC_STATUS_CACHE_MS = 30_000;
let spotiflacStatusCache: {
  expiresAt: number;
  url: string;
  promise: Promise<Record<string, string> | null>;
} | null = null;

function normalizeProviderService(value: string): DownloadProviderService | "" {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  return DEFAULT_SPOTIFLAC_PROVIDER_ORDER.includes(normalized as DownloadProviderService) ||
    normalized === "licensed"
    ? normalized as DownloadProviderService
    : "";
}

function spotiflacProviderOrder(env: CloudflareEnv): DownloadProviderService[] {
  const raw =
    envString(env, "SPOTIFLAC_PROVIDER_ORDER") ||
    envString(env, "SPOTIFLAC_AUTO_ORDER") ||
    DEFAULT_SPOTIFLAC_PROVIDER_ORDER.join("-");
  const parsed = raw
    .split(/[-,\s]+/)
    .map(normalizeProviderService)
    .filter((provider): provider is DownloadProviderService => Boolean(provider));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : DEFAULT_SPOTIFLAC_PROVIDER_ORDER;
}

function providerEnvStem(service: DownloadProviderService): string {
  return service.toUpperCase();
}

function isSpotiFlacApiDlHost(hostname: string): boolean {
  return /^(?:tdl|qbz|amz|dzr)-[a-zx]\.spotbye\.qzz\.io$/i.test(hostname) ||
    hostname === "am.spotbye.qzz.io";
}

export function spotiflacStatusKeyForEndpoint(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl);
    if (url.hostname === "am.spotbye.qzz.io") return "apple";
    const match = url.hostname.match(/^(tdl|qbz|amz|dzr)-([a-ex])\.spotbye\.qzz\.io$/i);
    if (!match) return "";
    const provider = {
      tdl: "tidal",
      qbz: "qobuz",
      amz: "amazon",
      dzr: "deezer",
    }[match[1]?.toLowerCase() || ""];
    const slot = match[2]?.toLowerCase() || "";
    return provider && slot ? `${provider}_${slot}` : "";
  } catch {
    return "";
  }
}

function spotiflacStatusChecksEnabled(env: CloudflareEnv): boolean {
  const raw = envString(env, "SPOTIFLAC_STATUS_CHECKS").toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

async function spotiflacStatus(env: CloudflareEnv): Promise<Record<string, string> | null> {
  if (!spotiflacStatusChecksEnabled(env)) return null;
  const url = envString(env, "SPOTIFLAC_STATUS_URL") || DEFAULT_SPOTIFLAC_STATUS_URL;
  const now = Date.now();
  if (spotiflacStatusCache && spotiflacStatusCache.url === url && spotiflacStatusCache.expiresAt > now) {
    return spotiflacStatusCache.promise;
  }
  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(url, 5_000, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0",
        },
      });
      if (!response.ok) return null;
      const payload = toObject(await response.json().catch(() => null));
      const rawStatus = toObject(payload?.status);
      if (!rawStatus) return null;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawStatus)) {
        const normalized = toStringValue(value).toLowerCase();
        if (key && normalized) out[key] = normalized;
      }
      return out;
    } catch {
      return null;
    }
  })();
  spotiflacStatusCache = { expiresAt: now + SPOTIFLAC_STATUS_CACHE_MS, url, promise };
  return promise;
}

function spotiflacEndpointIsDown(status: Record<string, string> | null, endpointUrl: string): string {
  const key = spotiflacStatusKeyForEndpoint(endpointUrl);
  if (!key || !status) return "";
  const state = status[key];
  return state && state !== "up" ? `${key} is ${state}` : "";
}

function normalizeSpotiFlacProviderUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if ((url.pathname === "" || url.pathname === "/") && isSpotiFlacApiDlHost(url.hostname)) {
      url.pathname = "/api/dl";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function configuredProviderUrls(env: CloudflareEnv, service: DownloadProviderService): string[] {
  const stem = providerEnvStem(service);
  const urls = [
    ...envStringList(env, `SPOTIFLAC_${stem}_PROVIDER_URLS`),
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_URL`),
    ...envStringList(env, `${stem}_SOURCE_PROVIDER_URLS`),
    envString(env, `${stem}_SOURCE_PROVIDER_URL`),
    ...envStringList(env, `LICENSED_${stem}_PROVIDER_URLS`),
    envString(env, `LICENSED_${stem}_PROVIDER_URL`),
  ].filter(Boolean);

  if (service === "licensed") {
    urls.push(licensedSourceProviderEndpoint(env));
  } else if (service === "tidal") {
    urls.push(...envStringList(env, "SPOTIFLAC_TIDAL_APIS"));
    urls.push(...envStringList(env, "TIDAL_SPOTBYE_PROVIDER_URLS"));
    urls.push(envString(env, "SPOTIFLAC_ACTIVE_TIDAL_API"));
  } else if (service === "tidal_x") {
    const legacy = licensedSourceProviderEndpoint(env);
    if (legacy && licensedSourceProviderUsesTidalId(legacy)) urls.push(legacy);
  }
  urls.push(...(DEFAULT_SPOTIFLAC_CONFIGURED_PROVIDER_URLS[service] ?? []));

  return Array.from(new Set(urls.map(normalizeSpotiFlacProviderUrl).filter(Boolean)));
}

function configuredProviderApiKey(env: CloudflareEnv, service: DownloadProviderService): string {
  const stem = providerEnvStem(service);
  return (
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_API_KEY`) ||
    envString(env, `${stem}_SOURCE_PROVIDER_API_KEY`) ||
    envString(env, `LICENSED_${stem}_PROVIDER_API_KEY`) ||
    (service === "licensed" || service === "tidal_x" ? licensedSourceProviderApiKey(env) : "")
  );
}

function configuredProviderUserAgent(
  env: CloudflareEnv,
  service: DownloadProviderService,
  endpointUrl: string,
): string {
  const stem = providerEnvStem(service);
  return (
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_USER_AGENT`) ||
    envString(env, `${stem}_SOURCE_PROVIDER_USER_AGENT`) ||
    envString(env, `LICENSED_${stem}_PROVIDER_USER_AGENT`) ||
    ((service === "licensed" || service === "tidal_x") ? licensedSourceProviderUserAgent(env) : "") ||
    (licensedSourceProviderUsesTidalId(endpointUrl) ? "SpotiFLAC-Mobile/4.5.6" : "")
  );
}

function configuredProviderResolveTimeoutMs(env: CloudflareEnv, service: DownloadProviderService): number {
  const stem = providerEnvStem(service);
  const raw =
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_RESOLVE_TIMEOUT_MS`) ||
    envString(env, `${stem}_SOURCE_PROVIDER_RESOLVE_TIMEOUT_MS`) ||
    envString(env, `LICENSED_${stem}_PROVIDER_RESOLVE_TIMEOUT_MS`);
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(30_000, Math.max(1_000, parsed));
  }
  return licensedSourceProviderResolveTimeoutMs(env);
}

async function resolveTidalStreamUrl(
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: SongPayload,
): Promise<string> {
  const tidal = getPlatformLink(songLinkPayload, "tidal");
  const entityTrackId = tidal ? parsePlatformId(tidal.entityUniqueId, "TIDAL_SONG::") : "";
  const urlTrackId = tidal?.url ? parseTrackIdFromUrl(tidal.url) : "";
  try {
    return await resolveTidalProviderStreamUrl({
      tidalTrackId: entityTrackId || urlTrackId || "",
      title: toStringValue(payload.title),
      artist: toStringValue(payload.artist),
      album: toStringValue(payload.album),
      quality: quality || "LOSSLESS",
    });
  } catch (error) {
    if (error instanceof TidalDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Tidal stream", 502);
  }
}

async function resolveQobuzDownload(
  env: CloudflareEnv,
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: SongPayload,
): Promise<ResolvedAudioDownload> {
  const isrc = await resolveDeezerIsrc(songLinkPayload);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const album = toStringValue(payload.album);
  if (!isrc && !title && !artist) throw new ApiError("Qobuz needs an ISRC or title/artist metadata", 400);
  try {
    return {
      service: "qobuz",
      streamUrl: await resolveQobuzProviderStreamUrl({
        isrc,
        title,
        artist,
        album,
        quality: quality || "6",
        credentials: qobuzCredentialsFromEnv(env),
      }),
      minimumQuality: qobuzQualityIsLossless(quality),
    };
  } catch (error) {
    if (error instanceof QobuzDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Qobuz stream", 502);
  }
}

async function resolveAmazonDownload(trackId: string, payload: SongPayload): Promise<ResolvedAudioDownload> {
  try {
    const stream = await resolveAmazonStreamUrl({
      spotifyId: trackId,
      region: toStringValue(payload.region).toUpperCase(),
    });
    return {
      service: "amazon",
      streamUrl: stream.streamUrl,
      headers: stream.headers,
      minimumQuality: "lossless",
    };
  } catch (error) {
    if (error instanceof AmazonDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Amazon Music stream", 502);
  }
}

function qobuzQualityIsLossless(quality: string): "lossless" | undefined {
  return !quality || quality === "6" || quality === "7" || quality === "16" || quality === "24" || quality === "27"
    ? "lossless"
    : undefined;
}

function tidalQualityIsLossless(quality: string): "lossless" | undefined {
  const normalized = quality.trim().toUpperCase();
  return !normalized ||
    normalized === "LOSSLESS" ||
    normalized === "HI_RES_LOSSLESS" ||
    normalized === "HI_RES" ||
    normalized === "MAX" ||
    normalized === "FLAC" ||
    normalized === "CD"
    ? "lossless"
    : undefined;
}

function flattenResolvedAudioDownload(resolved: ResolvedAudioDownload): ResolvedAudioDownloadCandidate[] {
  return [resolved, ...(resolved.fallbacks ?? [])];
}

function resolvedAudioDownloadFromCandidates(candidates: ResolvedAudioDownloadCandidate[]): ResolvedAudioDownload {
  const [first, ...fallbacks] = candidates;
  if (!first) throw new ApiError("No downloadable provider found", 502);
  return { ...first, fallbacks };
}

function audioCodecLabel(info: AudioCodecInfo): string {
  return info.codec || "unknown codec";
}

async function validateMinimumQualityResponse(
  response: Response,
  candidate: ResolvedAudioDownloadCandidate,
  onProgress?: (received: number, total: number) => void,
): Promise<Response | string> {
  const contentType = `${response.headers.get("content-type") || candidate.contentType || ""}`.toLowerCase();
  const contentTypeInfo = classifyAudioContentType(contentType);
  if (candidate.minimumQuality === "lossless" && contentTypeInfo.quality === "lossy") {
    await response.body?.cancel().catch(() => undefined);
    return `${candidate.service} returned a lossy ${audioCodecLabel(contentTypeInfo)} stream`;
  }

  const length = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return "Audio file is too large";
  }
  if (!response.body) return "Audio server returned an empty response";

  // Sniff only a bounded prefix, then replay it into a size-limited stream. This
  // keeps a lossless import off the Worker's heap while preserving validation,
  // progress reporting, and the 100 MB guard for responses without a trustworthy
  // Content-Length header.
  const total = Number.isFinite(length) && length > 0 ? length : 0;
  const replay = await peekAndReplayStream(response.body, {
    maxBytes: MAX_AUDIO_BYTES,
    peekBytes: candidate.minimumQuality === "lossless" ? 64 * 1024 : 1,
    onProgress: onProgress ? (received) => onProgress(received, total) : undefined,
  });
  if (candidate.minimumQuality === "lossless") {
    const byteInfo = classifyAudioBytes(replay.prefix);
    if (byteInfo.quality !== "lossless") {
      await replay.body.cancel().catch(() => undefined);
      return byteInfo.quality === "lossy"
        ? `${candidate.service} returned a lossy ${audioCodecLabel(byteInfo)} stream`
        : `${candidate.service} returned an unverified ${audioCodecLabel(byteInfo)} stream for a lossless request`;
    }
  }
  return new Response(replay.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

function licensedSourceProviderEndpoint(env: CloudflareEnv): string {
  return envString(env, "LICENSED_SOURCE_PROVIDER_URL") || envString(env, "LICENSED_AUDIO_PROVIDER_URL");
}

function licensedSourceProviderApiKey(env: CloudflareEnv): string {
  return envString(env, "LICENSED_SOURCE_PROVIDER_API_KEY") || envString(env, "LICENSED_AUDIO_PROVIDER_API_KEY");
}

function licensedSourceProviderUserAgent(env: CloudflareEnv): string {
  return envString(env, "LICENSED_SOURCE_PROVIDER_USER_AGENT") || envString(env, "LICENSED_AUDIO_PROVIDER_USER_AGENT");
}

function licensedSourceProviderResolveTimeoutMs(env: CloudflareEnv): number {
  const raw =
    envString(env, "LICENSED_SOURCE_PROVIDER_RESOLVE_TIMEOUT_MS") ||
    envString(env, "LICENSED_AUDIO_PROVIDER_RESOLVE_TIMEOUT_MS");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 8_000;
  return Math.min(30_000, Math.max(1_000, parsed));
}

function licensedSourceProviderUsesTidalId(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.hostname === "api.zarz.moe" && url.pathname.includes("/dl/tid")
    ) || (
      /^tdl-[a-z]\.spotbye\.qzz\.io$/i.test(url.hostname) && url.pathname === "/api/dl"
    );
  } catch {
    return false;
  }
}

function licensedSourceProviderQualities(endpoint: string, payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  const profile = toStringValue(payload.qualityProfile).toLowerCase();
  const isSpotbyeTidal = (() => {
    try {
      return /^tdl-[a-z]\.spotbye\.qzz\.io$/i.test(new URL(endpoint).hostname);
    } catch {
      return false;
    }
  })();
  if (isSpotbyeTidal) {
    return profile === "cd" ? ["16"] : ["24", "16"];
  }
  return profile === "cd" ? ["LOSSLESS"] : ["HI_RES_LOSSLESS", "LOSSLESS"];
}

type SpotiFlacApiDlProviderKind = "tidal" | "qobuz" | "amazon" | "deezer" | "apple";

function spotiflacApiDlProviderKind(endpoint: string): SpotiFlacApiDlProviderKind | "" {
  try {
    const url = new URL(endpoint);
    if (url.pathname !== "/api/dl") return "";
    if (/^tdl-[a-z]\.spotbye\.qzz\.io$/i.test(url.hostname)) return "tidal";
    if (/^qbz-[a-zx]\.spotbye\.qzz\.io$/i.test(url.hostname)) return "qobuz";
    if (/^amz-[a-zx]\.spotbye\.qzz\.io$/i.test(url.hostname)) return "amazon";
    if (/^dzr-[a-zx]\.spotbye\.qzz\.io$/i.test(url.hostname)) return "deezer";
    if (url.hostname === "am.spotbye.qzz.io") return "apple";
  } catch {}
  return "";
}

function tidalTrackIdFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const tidal = getPlatformLink(songLinkPayload, "tidal");
  const entityTrackId = tidal ? parsePlatformId(tidal.entityUniqueId, "TIDAL_SONG::") : "";
  const urlTrackId = tidal?.url ? parseTrackIdFromUrl(tidal.url) : "";
  return entityTrackId || urlTrackId || "";
}

function qobuzTrackIdFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const qobuz = getPlatformLink(songLinkPayload, "qobuz");
  const entityTrackId = qobuz ? parsePlatformId(qobuz.entityUniqueId, "QOBUZ_SONG::") : "";
  const urlTrackId = qobuz?.url?.match(/\/track\/(\d+)/i)?.[1] ?? "";
  const id = entityTrackId || urlTrackId || "";
  return /^\d+$/.test(id) ? id : "";
}

function appleMusicTrackIdFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const apple = getPlatformLink(songLinkPayload, "appleMusic") || getPlatformLink(songLinkPayload, "itunes");
  const entityTrackId =
    (apple ? parsePlatformId(apple.entityUniqueId, "APPLE_MUSIC_SONG::") : "") ||
    (apple ? parsePlatformId(apple.entityUniqueId, "ITUNES_SONG::") : "");
  if (/^\d+$/.test(entityTrackId)) return entityTrackId;
  if (!apple?.url) return "";
  try {
    const url = new URL(apple.url);
    const queryId = url.searchParams.get("i") || "";
    if (/^\d+$/.test(queryId)) return queryId;
    return url.pathname.match(/\/(\d+)(?:$|\/)/)?.[1] ?? "";
  } catch {
    return apple.url.match(/\/(\d+)(?:$|[?#/])/)?.[1] ?? "";
  }
}

type ItunesSongSearchResult = {
  trackId?: number | string;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number | string;
};

function normalizeProviderMatchValue(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreAppleMusicSearchResult(result: ItunesSongSearchResult, payload: SongPayload): number {
  const title = normalizeProviderMatchValue(toStringValue(payload.title));
  const artist = normalizeProviderMatchValue(toStringValue(payload.artist));
  const album = normalizeProviderMatchValue(toStringValue(payload.album));
  const resultTitle = normalizeProviderMatchValue(toStringValue(result.trackName));
  const resultArtist = normalizeProviderMatchValue(toStringValue(result.artistName));
  const resultAlbum = normalizeProviderMatchValue(toStringValue(result.collectionName));
  const durationMs = toNumberValue(payload.durationMs);
  const resultDurationMs = toNumberValue(result.trackTimeMillis);
  let score = 0;

  if (title && resultTitle === title) score += 100;
  else if (title && (resultTitle.includes(title) || title.includes(resultTitle))) score += 55;
  if (artist && resultArtist === artist) score += 80;
  else if (artist && (resultArtist.includes(artist) || artist.includes(resultArtist))) score += 40;
  if (album && resultAlbum === album) score += 35;
  else if (album && (resultAlbum.includes(album) || album.includes(resultAlbum))) score += 15;
  if (durationMs != null && resultDurationMs != null) {
    const diff = Math.abs(durationMs - resultDurationMs);
    if (diff <= 2_500) score += 35;
    else if (diff <= 7_500) score += 15;
  }
  return score;
}

async function resolveAppleMusicTrackIdFromPayload(payload: SongPayload): Promise<string> {
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const term = [title, artist].filter(Boolean).join(" ");
  if (!term) return "";
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "10");
  url.searchParams.set("country", toStringValue(payload.region).toUpperCase() || "US");
  url.searchParams.set("term", term);

  const response = await fetchWithTimeout(url.toString(), SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (!response?.ok) return "";
  const searchPayload = toObject(await response.json().catch(() => null));
  const results = Array.isArray(searchPayload?.results) ? searchPayload.results : [];
  const best = results
    .map((candidate) => {
      const result = toObject(candidate) as ItunesSongSearchResult | null;
      return result ? { result, score: scoreAppleMusicSearchResult(result, payload) } : null;
    })
    .filter((item): item is { result: ItunesSongSearchResult; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score)[0];
  const id =
    typeof best?.result.trackId === "number" && Number.isFinite(best.result.trackId)
      ? `${best.result.trackId}`
      : toStringValue(best?.result.trackId);
  return best && best.score >= 140 && /^\d+$/.test(id) ? id : "";
}

function amazonAsinFromValue(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  return (
    decoded.match(/(?:trackAsin=|tracks\/)([A-Z0-9]{10})/)?.[1] ??
    decoded.match(/\b(B[0-9A-Z]{9})\b/)?.[1] ??
    ""
  );
}

function amazonAsinFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const amazon = getPlatformLink(songLinkPayload, "amazonMusic") || getPlatformLink(songLinkPayload, "amazon");
  const entityTrackId =
    (amazon ? parsePlatformId(amazon.entityUniqueId, "AMAZON_SONG::") : "") ||
    (amazon ? parsePlatformId(amazon.entityUniqueId, "AMAZON_MUSIC_SONG::") : "");
  const entityAsin = amazonAsinFromValue(entityTrackId);
  if (entityAsin) return entityAsin;
  return amazon?.url ? amazonAsinFromValue(amazon.url) : "";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueProviderBodies(bodies: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const body of bodies) {
    const key = JSON.stringify(body);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(body);
  }
  return out;
}

function qobuzSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  const profile = toStringValue(payload.qualityProfile).toLowerCase();
  return profile === "cd" ? ["16"] : ["24", "16"];
}

function tidalSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  const profile = toStringValue(payload.qualityProfile).toLowerCase();
  return profile === "cd" ? ["16"] : ["24", "16"];
}

function amazonSpotbyeQualities(service: DownloadProviderService, payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  if (service === "amazon_x") return ["16", "atmos"];
  return ["16"];
}

function deezerSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  return explicit ? [explicit] : ["16"];
}

function appleSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  return explicit ? [explicit] : [];
}

async function spotiflacApiDlProviderBodies(options: {
  env: CloudflareEnv;
  kind: SpotiFlacApiDlProviderKind;
  service: DownloadProviderService;
  trackId: string;
  songLinkPayload: Record<string, unknown>;
  payload: SongPayload;
}): Promise<Array<Record<string, unknown>>> {
  const { env, kind, service, trackId, songLinkPayload, payload } = options;
  if (kind === "tidal") {
    const tidalTrackId = tidalTrackIdFromSongLinkPayload(songLinkPayload);
    return tidalTrackId
      ? tidalSpotbyeQualities(payload).map((quality) => ({ id: tidalTrackId, quality }))
      : [];
  }

  if (kind === "qobuz") {
    const qobuzTrackId =
      qobuzTrackIdFromSongLinkPayload(songLinkPayload) ||
      await resolveQobuzTrackId({
        isrc: await resolveDeezerIsrc(songLinkPayload).catch(() => ""),
        title: toStringValue(payload.title),
        artist: toStringValue(payload.artist),
        album: toStringValue(payload.album),
        credentials: qobuzCredentialsFromEnv(env),
      }).catch(() => "");
    return qobuzTrackId
      ? qobuzSpotbyeQualities(payload).map((quality) => ({ id: qobuzTrackId, quality }))
      : [];
  }

  if (kind === "amazon") {
    const region = toStringValue(payload.region).toUpperCase() || "US";
    const asin =
      amazonAsinFromSongLinkPayload(songLinkPayload) ||
      await resolveAmazonAsinFromSpotify({ spotifyId: trackId, region }).catch(() => "");
    return asin
      ? amazonSpotbyeQualities(service, payload).map((quality) => ({ country: region, id: asin, quality }))
      : [];
  }

  if (kind === "deezer") {
    const ids = uniqueStrings([parseDeezerTrackId(songLinkPayload)]);
    const bodies: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      for (const quality of deezerSpotbyeQualities(payload)) bodies.push({ id, quality });
      bodies.push({ id });
    }
    return uniqueProviderBodies(bodies);
  }

  const ids = uniqueStrings([
    appleMusicTrackIdFromSongLinkPayload(songLinkPayload),
    await resolveAppleMusicTrackIdFromPayload(payload).catch(() => ""),
  ]);
  const bodies: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const qualities = appleSpotbyeQualities(payload);
    if (qualities.length === 0) bodies.push({ id });
    for (const quality of qualities) bodies.push({ id, quality });
    bodies.push({ id });
  }
  return uniqueProviderBodies(bodies);
}

async function resolveConfiguredLicensedProviderDownload(
  env: CloudflareEnv,
  service: DownloadProviderService,
  trackId: string,
  songLinkPayload: Record<string, unknown>,
  payload: SongPayload,
): Promise<ResolvedAudioDownload> {
  const endpoints = configuredProviderUrls(env, service);
  if (endpoints.length === 0) {
    throw new ApiError(`${service} provider is not configured`, 501);
  }

  const errors: string[] = [];
  const candidates: ResolvedAudioDownloadCandidate[] = [];
  const providerBodyCache = new Map<string, Array<Record<string, unknown>>>();
  const status = await spotiflacStatus(env);
  for (const endpointUrl of endpoints) {
    const downReason = spotiflacEndpointIsDown(status, endpointUrl);
    if (downReason) {
      errors.push(downReason);
      continue;
    }

    const providerBodies: Array<Record<string, unknown> | undefined> = [];
    const apiDlKind = spotiflacApiDlProviderKind(endpointUrl);
    if (apiDlKind) {
      const bodyCacheKey = `${service}:${apiDlKind}`;
      let bodies = providerBodyCache.get(bodyCacheKey);
      if (!bodies) {
        bodies = await spotiflacApiDlProviderBodies({
          env,
          kind: apiDlKind,
          service,
          trackId,
          songLinkPayload,
          payload,
        });
        providerBodyCache.set(bodyCacheKey, bodies);
      }
      if (bodies.length === 0) {
        errors.push(`${service} needs a ${apiDlKind} track ID`);
        continue;
      }
      providerBodies.push(...bodies);
    } else if (licensedSourceProviderUsesTidalId(endpointUrl)) {
      const tidalTrackId = tidalTrackIdFromSongLinkPayload(songLinkPayload);
      if (!tidalTrackId) {
        errors.push(`${service} needs a Tidal track ID`);
        continue;
      }
      for (const quality of licensedSourceProviderQualities(endpointUrl, payload)) {
        providerBodies.push({ id: tidalTrackId, quality });
      }
    } else {
      providerBodies.push(undefined);
    }

    for (const providerBody of providerBodies) {
      try {
        const userAgent = configuredProviderUserAgent(env, service, endpointUrl);
        const stream = await resolveLicensedSourceProviderStreamUrl({
          endpointUrl,
          apiKey: configuredProviderApiKey(env, service),
          userAgent,
          spotifyId: trackId,
          spotifyUrl: toStringValue(payload.spotifyUrl),
          region: toStringValue(payload.region).toUpperCase(),
          title: toStringValue(payload.title),
          artist: toStringValue(payload.artist),
          album: toStringValue(payload.album),
          durationMs: toStringValue(payload.durationMs),
          qualityProfile: toStringValue(payload.qualityProfile),
          outputFormat: toStringValue(payload.outputFormat) || SERVER_IMPORT_OUTPUT_FORMAT,
          body: providerBody,
          timeoutMs: configuredProviderResolveTimeoutMs(env, service),
        });
        candidates.push({
          service,
          streamUrl: stream.streamUrl,
          headers: stream.headers,
          contentType: stream.contentType,
          licensedStream: stream,
          userAgent,
          minimumQuality: "lossless",
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `${service} provider failed`);
      }
    }
  }

  if (candidates.length > 0) return resolvedAudioDownloadFromCandidates(candidates);
  throw new ApiError(`${service} provider failed: ${errors.join(" | ")}`, 502);
}

async function fetchResolvedAudioDownloadCandidate(resolved: ResolvedAudioDownloadCandidate): Promise<Response> {
  if (resolved.licensedStream) {
    try {
      return await materializeLicensedSourceStream(resolved.licensedStream, {
        maxBytes: MAX_AUDIO_BYTES,
        userAgent: resolved.userAgent,
      });
    } catch (error) {
      if (error instanceof LicensedSourceDownloadError) throw new ApiError(error.message, error.status);
      throw error;
    }
  }
  return fetchWithTimeout(resolved.streamUrl, DOWNLOAD_REQUEST_TIMEOUT_MS, { headers: resolved.headers });
}

async function fetchResolvedAudioDownload(resolved: ResolvedAudioDownload): Promise<Response> {
  const candidates = [resolved, ...(resolved.fallbacks ?? [])];
  const errors: string[] = [];
  let lastResponse: Response | null = null;
  for (const candidate of candidates) {
    try {
      const response = await fetchResolvedAudioDownloadCandidate(candidate);
      if (response.ok) {
        const validated = await validateMinimumQualityResponse(response, candidate);
        if (validated instanceof Response) return validated;
        errors.push(validated);
        continue;
      }
      errors.push(`${candidate.service} returned ${response.status}`);
      lastResponse = response;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "download failed");
    }
  }
  if (lastResponse) return lastResponse;
  throw new ApiError(`No licensed source fallback succeeded: ${errors.join(" | ")}`, 502);
}

async function resolveProviderDownload(
  env: CloudflareEnv,
  provider: DownloadProviderService,
  trackId: string,
  songLinkPayload: Record<string, unknown>,
  payload: SongPayload,
  qualities: ReturnType<typeof qualityLists>,
): Promise<ResolvedAudioDownload> {
  const candidates: ResolvedAudioDownloadCandidate[] = [];
  const errors: string[] = [];

  const addConfigured = async (service: DownloadProviderService) => {
    if (configuredProviderUrls(env, service).length === 0) return;
    try {
      candidates.push(...flattenResolvedAudioDownload(
        await resolveConfiguredLicensedProviderDownload(env, service, trackId, songLinkPayload, payload),
      ));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${service} failed`);
    }
  };

  if (provider === "licensed") {
    await addConfigured("licensed");
  } else if (provider === "tidal") {
    await addConfigured("tidal");
    for (const quality of qualities.tidal) {
      try {
        candidates.push({
          service: "tidal",
          streamUrl: await resolveTidalStreamUrl(songLinkPayload, quality, payload),
          minimumQuality: tidalQualityIsLossless(quality),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `tidal quality ${quality} failed`);
      }
    }
  } else if (provider === "qobuz") {
    for (const quality of qualities.qobuz) {
      try {
        const resolved = flattenResolvedAudioDownload(await resolveQobuzDownload(env, songLinkPayload, quality, payload));
        if (resolved.length > 0) {
          candidates.push(...resolved);
          // One lossless Qobuz quality is enough — stop so we don't hit the
          // rate-limited qbz-foss community endpoint again for the lower qualities.
          break;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `qobuz quality ${quality} failed`);
      }
    }
  } else if (provider === "amazon") {
    await addConfigured("amazon");
    try {
      candidates.push(...flattenResolvedAudioDownload(await resolveAmazonDownload(trackId, payload)));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "amazon failed");
    }
  } else {
    await addConfigured(provider);
  }

  if (candidates.length > 0) return resolvedAudioDownloadFromCandidates(candidates);

  throw new ApiError(
    `No ${provider} provider candidate found${errors.length > 0 ? `: ${errors.join(" | ")}` : ""}`,
    502,
  );
}

async function resolveSpotiFlacDownloadStack(
  env: CloudflareEnv,
  trackId: string,
  songLinkPayload: Record<string, unknown>,
  payload: SongPayload,
  qualities: ReturnType<typeof qualityLists>,
): Promise<ResolvedAudioDownload> {
  const candidates: ResolvedAudioDownloadCandidate[] = [];
  const errors: string[] = [];

  for (const provider of spotiflacProviderOrder(env)) {
    try {
      candidates.push(...flattenResolvedAudioDownload(
        await resolveProviderDownload(env, provider, trackId, songLinkPayload, payload, qualities),
      ));
      // First provider that yields a candidate wins — stop probing the rest
      // (the dead encrypted spotbye hosts) to cut request pressure / rate-limit
      // load. With Qobuz ordered first, this resolves in one qbz-foss hit.
      if (candidates.length > 0) break;
    } catch (error) {
      errors.push(error instanceof Error ? `${provider}: ${error.message}` : `${provider} failed`);
    }
  }

  if (candidates.length > 0) return resolvedAudioDownloadFromCandidates(candidates);
  throw new ApiError(`No downloadable provider found. ${errors.join(" | ")}`, 502);
}

async function resolveStreamUrl(env: CloudflareEnv, payload: SongPayload): Promise<ResolvedAudioDownload> {
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl));
  if (!trackId) throw new ApiError("Invalid Spotify track URL or ID", 400);
  const songLinkPayload = await resolveTrackPayload(
    trackId,
    toStringValue(payload.region).toUpperCase(),
    envString(env, "SPOTIFY_SP_DC"),
  ).catch(() => ({}));
  await enrichTidalLink(songLinkPayload, toStringValue(payload.region).toUpperCase());
  await enrichSoundchartsLinks(env, songLinkPayload);
  const service = toStringValue(payload.service).toLowerCase();
  const qualities = qualityLists(payload);

  if (service === "licensed") {
    return await resolveProviderDownload(env, "licensed", trackId, songLinkPayload, payload, qualities);
  }
  const providerService = normalizeProviderService(service);
  if (providerService) {
    return await resolveProviderDownload(env, providerService, trackId, songLinkPayload, payload, qualities);
  }
  if (service) {
    throw new ApiError(
      'Unsupported service. Use "licensed", "tidal", "qobuz", "amazon", "deezer", or "apple".',
      400,
    );
  }

  return await resolveSpotiFlacDownloadStack(env, trackId, songLinkPayload, payload, qualities);
}

function extensionFromResponse(response: Response, streamUrl: string): string {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("flac")) return ".flac";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
  try {
    const urlExt = extname(new URL(streamUrl).pathname).toLowerCase();
    if (AUDIO_EXT_TYPES.has(urlExt)) return urlExt;
  } catch {}
  return ".flac";
}

async function uploadRemoteCover(env: CloudflareEnv, title: string, artist: string, imageUrl: string): Promise<string> {
  if (!imageUrl) return "/apple-icon.png";
  const parsed = parseHttpUrl(imageUrl);
  if (!parsed) return "/apple-icon.png";
  const response = await fetchWithTimeout(parsed.toString(), SPOTIFY_REQUEST_TIMEOUT_MS, {
    redirect: "manual",
  });
  if (!response.ok) return "/apple-icon.png";
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
  if (!IMAGE_MIME_TYPES.has(contentType)) return "/apple-icon.png";
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return "/apple-icon.png";
  const ext = contentType === "image/png" ? ".png" : contentType === "image/gif" ? ".gif" : contentType === "image/webp" ? ".webp" : ".jpg";
  const key = `${buildOrganizedMusicBasePath(title, artist)}/cover/${crypto.randomUUID()}${ext}`;
  await putBuffer(env, key, buffer, contentType);
  return toApiFileUrl(key);
}

async function storeLyrics(env: CloudflareEnv, title: string, artist: string, songId: string, lyricsText: string): Promise<string | null> {
  const text = lyricsText.trim();
  if (!text) return null;
  const buffer = new TextEncoder().encode(text);
  if (buffer.byteLength > MAX_LYRICS_BYTES) throw new ApiError("Lyrics text is too large", 413);
  const key = `${buildOrganizedMusicBasePath(title, artist)}/lyrics/${songId}-${crypto.randomUUID()}.lrc`;
  await putBuffer(env, key, buffer, "text/plain; charset=utf-8");
  return toApiFileUrl(key);
}

async function readJson<T>(req: Request): Promise<T | null> {
  return (await req.json().catch(() => null)) as T | null;
}

async function playlistCoverImageUrlsById(db: SqlTag, userId: string): Promise<Map<string, string[]>> {
  const rows = await db<{ playlistId: string; imageUrl: string; position: number }>`
    WITH cover_candidates AS (
      SELECT
        ps."playlistId" AS "playlistId",
        COALESCE(NULLIF(s1."imageUrl", ''), NULLIF(s2."imageUrl", '')) AS "imageUrl",
        MIN(ps."order") AS "firstOrder"
      FROM "PlaylistSong" ps
      JOIN "Playlist" p ON p."id" = ps."playlistId"
      LEFT JOIN "Song" s1 ON s1."id" = ps."songId"
      LEFT JOIN "SongRef" s2 ON s2."id" = ps."songId"
      WHERE p."userId" = ${userId}
        AND COALESCE(NULLIF(s1."imageUrl", ''), NULLIF(s2."imageUrl", '')) IS NOT NULL
      GROUP BY
        ps."playlistId",
        COALESCE(NULLIF(s1."imageUrl", ''), NULLIF(s2."imageUrl", ''))
    ),
    ranked_covers AS (
      SELECT
        "playlistId",
        "imageUrl",
        ROW_NUMBER() OVER (
          PARTITION BY "playlistId"
          ORDER BY "firstOrder" ASC, "imageUrl" ASC
        ) AS "position"
      FROM cover_candidates
    )
    SELECT "playlistId", "imageUrl", "position"
    FROM ranked_covers
    WHERE "position" <= 4
    ORDER BY "playlistId" ASC, "position" ASC
  `;
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const covers = result.get(row.playlistId);
    if (covers) covers.push(row.imageUrl);
    else result.set(row.playlistId, [row.imageUrl]);
  }
  return result;
}

async function listPlaylists(db: SqlTag, userId: string | null) {
  if (!userId) return [];
  const rows = await db<PlaylistRow & { songsCount: number; source: string | null }>`
    SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", p."source", COUNT(ps."id") AS "songsCount"
    FROM "Playlist" p
    LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
    WHERE p."userId" = ${userId}
    GROUP BY p."id", p."name", p."imageUrl", p."userId", p."createdAt", p."source"
    ORDER BY p."createdAt" DESC
  `;
  const coversByPlaylistId = await playlistCoverImageUrlsById(db, userId);
  return rows.map((row) => {
    const { source, ...playlist } = row;
    const songCoverImageUrls = coversByPlaylistId.get(row.id) ?? [];
    const coverImageUrls = row.imageUrl && source !== "local-folder" ? [] : songCoverImageUrls;
    return {
      ...playlist,
      imageUrl: row.imageUrl ?? songCoverImageUrls[0] ?? null,
      coverImageUrls,
      songsCount: Number(row.songsCount ?? 0),
    };
  });
}

async function listSongs(db: SqlTag, userId: string | null) {
  if (!userId) return [];
  return db<SongRow>`
    SELECT "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
    FROM "Song"
    WHERE "userId" = ${userId}
    ORDER BY "title" ASC
    LIMIT 5000
  `;
}

async function ensureLegacyLikedSongsForUser(db: SqlTag, userId: string): Promise<void> {
  const backfilled = await db<{ userId: string }>`
    SELECT "userId"
    FROM "LikeBackfill"
    WHERE "userId" = ${userId}
    LIMIT 1
  `;
  if (backfilled[0]) return;

  const rows = await db<{ likeCount: number }>`
    SELECT COUNT(*) AS "likeCount"
    FROM "Like"
    WHERE "userId" = ${userId}
  `;
  if (Number(rows[0]?.likeCount ?? 0) === 0) {
    await db`
      INSERT INTO "Like" ("id", "userId", "songId", "createdAt")
      SELECT ${userId} || ':' || s."id", ${userId}, s."id", COALESCE(s."createdAt", CURRENT_TIMESTAMP)
      FROM "Song" s
      WHERE s."userId" = ${userId}
      ON CONFLICT ("userId", "songId") DO NOTHING
    `;
  }

  await db`
    INSERT INTO "LikeBackfill" ("userId", "completedAt")
    VALUES (${userId}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId") DO NOTHING
  `;
}

async function likeSong(db: SqlTag, userId: string, songId: string): Promise<void> {
  await db`
    INSERT INTO "Like" ("id", "userId", "songId", "createdAt")
    VALUES (${crypto.randomUUID()}, ${userId}, ${songId}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "songId") DO NOTHING
  `;
}

async function listLikedSongIds(db: SqlTag, userId: string | null): Promise<string[]> {
  if (!userId) return [];
  await ensureLegacyLikedSongsForUser(db, userId);
  const rows = await db<{ songId: string }>`
    SELECT l."songId" AS "songId"
    FROM "Like" l
    INNER JOIN "Song" s ON s."id" = l."songId"
    WHERE l."userId" = ${userId}
      AND s."userId" = ${userId}
    ORDER BY l."createdAt" DESC
    LIMIT 5000
  `;
  return rows.map((row) => row.songId);
}

async function listLikedSongs(db: SqlTag, userId: string): Promise<SongRow[]> {
  await ensureLegacyLikedSongsForUser(db, userId);
  return db<SongRow>`
    SELECT s."id", s."title", s."artist", s."album", s."duration", s."imageUrl", s."audioUrl", s."lyricsUrl", s."audioBitDepth", s."audioSampleRate", s."userId", s."createdAt"
    FROM "Like" l
    INNER JOIN "Song" s ON s."id" = l."songId"
    WHERE l."userId" = ${userId}
      AND s."userId" = ${userId}
    ORDER BY l."createdAt" DESC
    LIMIT 5000
  `;
}

async function listSearchSongs(db: SqlTag, userId: string | null) {
  if (!userId) return [];
  const rows = await db<Pick<SongRow, "id" | "title" | "artist" | "imageUrl" | "audioUrl" | "createdAt">>`
    SELECT "id", "title", "artist", "imageUrl", "audioUrl", "createdAt"
    FROM "Song"
    WHERE "userId" = ${userId}
    ORDER BY "createdAt" DESC
    LIMIT 5000
  `;
  return rows.map((row) =>
    songToPlayerSong({
      ...row,
      album: null,
      duration: null,
      lyricsUrl: null,
      audioBitDepth: null,
      audioSampleRate: null,
      userId: "",
    } as SongRow),
  );
}

function parseRangeHeader(rangeHeader: string, size: number): { start: number; end: number } | null {
  if (!rangeHeader.startsWith("bytes=") || size <= 0) return null;
  const rangeValue = rangeHeader.slice("bytes=".length).trim();
  if (!rangeValue || rangeValue.includes(",")) return null;
  const dashIndex = rangeValue.indexOf("-");
  if (dashIndex === -1) return null;
  const startStr = rangeValue.slice(0, dashIndex);
  const endStr = rangeValue.slice(dashIndex + 1);
  if (!startStr) {
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  let end = endStr ? Number(endStr) : size - 1;
  if (!Number.isFinite(end) || end < 0) return null;
  if (end >= size) end = size - 1;
  if (end < start) return null;
  return { start, end };
}

function getMacMiniOrigin(env: CloudflareEnv): string {
  const origin = ((env as MusicProxyEnv).MAC_MINI_ORIGIN || "").trim();
  return origin.replace(/\/+$/, "");
}

function getMacMiniProxyToken(env: CloudflareEnv): string {
  return ((env as MusicProxyEnv).MAC_MINI_PROXY_TOKEN || "").trim();
}

function isMacMiniMusicConfigured(env: CloudflareEnv): boolean {
  const origin = getMacMiniOrigin(env);
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isLocalMacMiniOrigin(env: CloudflareEnv): boolean {
  const origin = getMacMiniOrigin(env);
  if (!origin) return false;
  try {
    return isLocalPreviewHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function canUseMacMiniProxy(env: CloudflareEnv): boolean {
  if (!isMacMiniMusicConfigured(env)) return false;
  return Boolean(getMacMiniProxyToken(env)) || isLocalMacMiniOrigin(env);
}

function isLocalPreviewHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".local")
  );
}

function getLocalMacMiniAuthUser(c: Context<AppEnv>): AuthUser | null {
  if (!canUseMacMiniProxy(c.env)) return null;
  try {
    return isLocalPreviewHost(new URL(c.req.url).hostname) ? LOCAL_MAC_MINI_AUTH_USER : null;
  } catch {
    return null;
  }
}

function macMiniProxyPathname(c: Context<AppEnv>): string {
  return new URL(c.req.url).pathname;
}

export function shouldProxyMusicPathnameToMacMini(pathname: string, method: string, contentType = ""): boolean {
  const normalizedMethod = method.toUpperCase();

  if (pathname.startsWith("/api/songs/spotify")) return false;
  if (pathname.startsWith("/api/files/local/")) return true;
  if (pathname.startsWith("/api/artwork/local/")) return true;
  if (pathname.startsWith("/api/songs/")) return true;
  // Folder-as-playlist reads live on the Mac mini (its library is the filesystem
  // scan). Curated + D1-backed playlist ids don't carry this prefix, so they
  // fall through to the Worker's own /api/playlist/:id handler.
  if (normalizedMethod === "GET" && pathname.startsWith("/api/playlist/local-folder-")) return true;
  if (["/api/music/source", "/api/home", "/api/search-index", "/api/library", "/api/liked", "/api/likes"].includes(pathname)) {
    return true;
  }
  if (pathname === "/api/songs") {
    if (normalizedMethod === "GET") return true;
    if (normalizedMethod !== "POST") return false;
    return !contentType.toLowerCase().startsWith("application/json");
  }
  return false;
}

function shouldProxyMusicRequest(c: Context<AppEnv>): boolean {
  if (!canUseMacMiniProxy(c.env)) return false;
  return shouldProxyMusicPathnameToMacMini(macMiniProxyPathname(c), c.req.method, c.req.header("content-type") || "");
}

const MAC_MINI_USER_CONTEXT_PATHS = new Set([
  "/api/music/source",
  "/api/home",
  "/api/search-index",
  "/api/library",
  "/api/liked",
  "/api/likes",
  "/api/songs",
]);

export function shouldForwardMacMiniUserForPathname(pathname: string): boolean {
  if (MAC_MINI_USER_CONTEXT_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/api/playlist/")) return true;
  return pathname.startsWith("/api/songs/") && !pathname.startsWith("/api/songs/spotify");
}

function shouldForwardMacMiniUser(c: Context<AppEnv>): boolean {
  return shouldForwardMacMiniUserForPathname(macMiniProxyPathname(c));
}

function isMacMiniMutation(c: Context<AppEnv>): boolean {
  const method = c.req.method.toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

async function getMacMiniProxyUser(c: Context<AppEnv>): Promise<AuthUser | null> {
  if (isLocalPreviewHost(new URL(c.req.url).hostname)) await ensureSchema(c.env);
  const db = createD1SqlTag(c.env.DB);
  return (await getCurrentUser(c.req.raw, db)) ?? getLocalMacMiniAuthUser(c);
}

function macMiniProxyHeaders(c: Context<AppEnv>, user: AuthUser | null): Headers {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-spotify-proxy-token");
  headers.delete("x-spotify-user-id");
  headers.delete("x-spotify-user-email");
  headers.delete("x-spotify-user-name");
  const token = getMacMiniProxyToken(c.env);
  if (token) headers.set("x-spotify-proxy-token", token);
  if (user) {
    headers.set("x-spotify-user-id", user.id);
    headers.set("x-spotify-user-email", user.email);
    if (user.name) headers.set("x-spotify-user-name", user.name);
  }
  return headers;
}

async function proxyToMacMini(c: Context<AppEnv>, user: AuthUser | null): Promise<Response> {
  const sourceUrl = new URL(c.req.url);
  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, getMacMiniOrigin(c.env));
  const method = c.req.method.toUpperCase();
  return fetch(targetUrl.toString(), {
    method,
    headers: macMiniProxyHeaders(c, user),
    body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
    redirect: "manual",
  });
}

function authorizeMacMiniMutation(c: Context<AppEnv>, user: AuthUser | null): Response | null {
  if (!isMacMiniMutation(c)) return null;
  if (!user) return jsonError("Unauthorized", 401);
  return null;
}

async function postJsonToMacMini(
  c: Context<AppEnv>,
  user: AuthUser,
  payload: Record<string, unknown>,
  path = "/api/songs",
): Promise<Response> {
  const targetUrl = new URL(path, getMacMiniOrigin(c.env));
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  const token = getMacMiniProxyToken(c.env);
  if (token) headers.set("x-spotify-proxy-token", token);
  headers.set("x-spotify-user-id", user.id);
  headers.set("x-spotify-user-email", user.email);
  if (user.name) headers.set("x-spotify-user-name", user.name);
  return fetch(targetUrl.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

function macMiniSongFields(
  payload: SongPayload,
  values: {
    title: string;
    artist: string;
    album: string;
    duration: number | null;
    replaceExisting: boolean;
  },
  resolved?: ResolvedAudioDownload,
): Record<string, string> {
  const fields: Record<string, string> = {
    title: values.title,
    artist: values.artist,
  };
  if (values.album) fields.album = values.album;
  const durationMs = toNumberValue(payload.durationMs) ?? (values.duration ? values.duration * 1000 : undefined);
  if (typeof durationMs === "number") fields.durationMs = String(durationMs);
  const imageUrl = toStringValue(payload.imageUrl) || coverUrlFromResolvedDownload(resolved);
  if (imageUrl) fields.imageUrl = imageUrl;
  const lyricsText = toStringValue(payload.lyricsText) || lyricsTextFromResolvedDownload(resolved);
  if (lyricsText) fields.lyricsText = lyricsText;
  if (values.replaceExisting) fields.replaceExisting = "true";
  return fields;
}

async function postAudioStreamToMacMini(
  c: Context<AppEnv>,
  user: AuthUser,
  payload: SongPayload,
  values: {
    title: string;
    artist: string;
    album: string;
    duration: number | null;
    replaceExisting: boolean;
  },
  resolved: ResolvedAudioDownload,
  response: Response,
): Promise<Response> {
  if (!response.body) throw new ApiError("Audio server returned an empty response", 502);
  const targetUrl = new URL("/api/songs", getMacMiniOrigin(c.env));
  const responseType = response.headers.get("content-type") || resolved.contentType || "audio/flac";
  const ext = extensionFromResponse(response, resolved.streamUrl);
  const fileName = `${sanitizeFileName(`${values.artist} - ${values.title}`)}${ext}`;
  const multipart = createStreamingMultipartBody({
    fields: macMiniSongFields(payload, values, resolved),
    file: {
      fieldName: "audio",
      fileName,
      contentType: responseType,
      body: response.body,
    },
  });
  const headers = new Headers({
    accept: "application/json",
    "content-type": multipart.contentType,
  });
  const token = getMacMiniProxyToken(c.env);
  if (token) headers.set("x-spotify-proxy-token", token);
  headers.set("x-spotify-user-id", user.id);
  headers.set("x-spotify-user-email", user.email);
  if (user.name) headers.set("x-spotify-user-name", user.name);
  return fetch(targetUrl.toString(), {
    method: "POST",
    headers,
    body: multipart.body,
  });
}

async function materializeLicensedStreamOnMacMini(
  c: Context<AppEnv>,
  user: AuthUser,
  resolved: ResolvedAudioDownloadCandidate,
): Promise<Response | null> {
  if (!resolved.licensedStream || !canUseMacMiniProxy(c.env)) return null;
  const targetUrl = new URL("/api/licensed-source/materialize", getMacMiniOrigin(c.env));
  const headers = new Headers({
    accept: "audio/*,*/*",
    "content-type": "application/json",
  });
  const token = getMacMiniProxyToken(c.env);
  if (token) headers.set("x-spotify-proxy-token", token);
  headers.set("x-spotify-user-id", user.id);
  headers.set("x-spotify-user-email", user.email);
  if (user.name) headers.set("x-spotify-user-name", user.name);
  return fetch(targetUrl.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      stream: resolved.licensedStream,
      userAgent: resolved.userAgent,
    }),
  });
}

async function fetchResolvedAudioDownloadForRequest(
  c: Context<AppEnv>,
  user: AuthUser,
  resolved: ResolvedAudioDownload,
  onProgress?: (received: number, total: number) => void,
): Promise<Response> {
  const candidates = [resolved, ...(resolved.fallbacks ?? [])];
  const errors: string[] = [];
  let lastResponse: Response | null = null;

  for (const candidate of candidates) {
    try {
      const macMiniResponse = await materializeLicensedStreamOnMacMini(c, user, candidate);
      if (macMiniResponse) {
        if (macMiniResponse.ok) {
          const validated = await validateMinimumQualityResponse(macMiniResponse, candidate, onProgress);
          if (validated instanceof Response) return validated;
          errors.push(validated);
          continue;
        }
        errors.push(`${candidate.service} returned ${macMiniResponse.status}`);
        lastResponse = macMiniResponse;
        continue;
      }

      const response = await fetchResolvedAudioDownloadCandidate(candidate);
      if (response.ok) {
        const validated = await validateMinimumQualityResponse(response, candidate, onProgress);
        if (validated instanceof Response) return validated;
        errors.push(validated);
        continue;
      }
      errors.push(`${candidate.service} returned ${response.status}`);
      lastResponse = response;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "download failed");
    }
  }

  if (lastResponse) return lastResponse;
  throw new ApiError(`No downloadable provider fallback succeeded: ${errors.join(" | ")}`, 502);
}

function resolvedDownloadCandidates(resolved?: ResolvedAudioDownload): ResolvedAudioDownloadCandidate[] {
  return resolved ? [resolved, ...(resolved.fallbacks ?? [])] : [];
}

function metadataString(metadata: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = toStringValue(metadata[key]);
    if (value) return value;
  }
  return "";
}

function lyricsTextFromResolvedDownload(resolved?: ResolvedAudioDownload): string {
  for (const candidate of resolvedDownloadCandidates(resolved)) {
    const metadata = candidate.licensedStream?.metadata;
    if (!metadata) continue;
    const lyrics =
      metadataString(metadata, "lyrics", "lyric", "lrc", "syncedLyrics", "unsyncedLyrics") ||
      metadataString(toObject(metadata.lyrics) ?? {}, "synced", "unsynced", "text");
    if (lyrics) return lyrics;
  }
  return "";
}

function coverUrlFromResolvedDownload(resolved?: ResolvedAudioDownload): string {
  for (const candidate of resolvedDownloadCandidates(resolved)) {
    const metadata = candidate.licensedStream?.metadata;
    if (!metadata) continue;
    const cover = metadataString(metadata, "cover", "coverUrl", "imageUrl", "artworkUrl");
    if (cover && parseHttpUrl(cover)) return cover;
  }
  return "";
}

// Opt-in: the single-track Upload page sets this header to receive an NDJSON
// progress stream instead of a one-shot JSON response.
function wantsImportProgressStream(c: Context<AppEnv>): boolean {
  return c.req.header("x-progress-stream") === "1";
}

// Stream a Spotify single-track import as NDJSON progress events so the client
// can render a real download %. Each line is one JSON event:
//   {stage:"resolving"} | {stage:"downloading",received,total} | {stage:"saving"}
//   | {stage:"done"} | {stage:"duplicate",existingSong} | {stage:"error",error}
// The HTTP status is always 200 once streaming begins; the outcome lives in the
// final event, so the client must read the stream to learn success/failure.
function streamMacMiniSpotifyImport(
  c: Context<AppEnv>,
  user: AuthUser,
  payload: SongPayload,
  values: { title: string; artist: string; album: string; duration: number | null; replaceExisting: boolean },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      try {
        emit({ stage: "resolving" });
        const resolved = await resolveStreamUrl(c.env, payload);
        emit({ stage: "downloading", received: 0, total: 0 });
        // The reporter follows the provider stream as it is forwarded directly
        // to the Mac mini. ~96 KB granularity keeps the NDJSON response compact.
        let lastEmitted = 0;
        let lastTotal = 0;
        let receivedBytes = 0;
        const reportDownload = (received: number, total: number) => {
          receivedBytes = received;
          if (total > 0) lastTotal = total;
          if (received - lastEmitted >= 98_304 || (lastTotal > 0 && received >= lastTotal)) {
            lastEmitted = received;
            emit({ stage: "downloading", received, total: lastTotal });
          }
        };
        const response = await fetchResolvedAudioDownloadForRequest(c, user, resolved, reportDownload);
        if (!response.ok || !response.body) {
          emit({ stage: "error", error: `Audio server returned ${response.status}` });
          finish();
          return;
        }
        const miniResp = await postAudioStreamToMacMini(c, user, payload, values, resolved, response);
        emit({ stage: "downloading", received: receivedBytes, total: lastTotal || receivedBytes });
        emit({ stage: "saving" });
        const data = (await miniResp.json().catch(() => ({}))) as Record<string, unknown>;
        if (miniResp.status === 409 && data?.code === "DUPLICATE_SONG") {
          emit({ stage: "duplicate", existingSong: data.existingSong ?? null });
          finish();
          return;
        }
        if (!miniResp.ok) {
          const message = typeof data?.error === "string" ? data.error : `Audio server returned ${miniResp.status}`;
          emit({ stage: "error", error: message });
          finish();
          return;
        }
        emit({ stage: "done" });
        finish();
      } catch (err) {
        emit({ stage: "error", error: err instanceof Error ? err.message : "Import failed" });
        finish();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // SAFE SUBSET ONLY: no default-src/script-src/connect-src so the SPA keeps working.
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
};

function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}

// Origins allowed to read audio cross-origin WITH credentials — only our own
// public site. The <audio> element (crossOrigin="use-credentials", needed to
// route through the Web Audio API for real iOS crossfade) must see a
// credentialed-CORS-clean response. Credentialed CORS forbids "*", so we echo
// the exact request Origin only when it's this surface — never an arbitrary
// site. The native app uses native fetch / AVPlayer, not browser CORS, so it
// needs no allowlist entry; loopback dev origins are allowed in corsAllowOrigin.
const CORS_ALLOWED_ORIGINS = new Set<string>([
  "https://music.streamarena.xyz",
]);

// Auth endpoints that must stay reachable without a session. Everything else
// under /api requires a signed-in user so the personal library is not public.
const AUTH_OPEN_API_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/signin",
  "/api/auth/signout",
  "/api/auth/resend-verification",
  // Kept open only so anonymous callers get an explicit 403 instead of 401.
  "/api/register",
]);

function isAuthOpenApiPath(pathname: string): boolean {
  if (AUTH_OPEN_API_PATHS.has(pathname)) return true;
  return pathname.startsWith("/api/auth/verify/");
}

function corsAllowOrigin(origin: string | undefined | null): string | null {
  if (!origin) return null;
  if (CORS_ALLOWED_ORIGINS.has(origin)) return origin;
  // Local dev (vite / local music server) on any loopback port.
  try {
    const url = new URL(origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return origin;
    }
  } catch {}
  return null;
}

function applyCorsHeaders(headers: Headers, allowOrigin: string): void {
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  // Append, don't overwrite: a cache-keying Vary may already be present.
  headers.append("Vary", "Origin");
  // Range playback needs these visible to the client / Web Audio.
  headers.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
}

// Attach security headers in place when possible. Proxied/upstream responses
// (e.g. streamed back from the Mac mini) carry immutable headers, so set()
// throws — in that case rebuild with a mutable copy so the headers are never
// dropped and a proxy response can't take down the whole API with a 500. When
// the request carries an allowlisted Origin, credentialed CORS headers are added
// the same way so cross-origin audio (native app) is readable by Web Audio.
export function withSecurityHeaders(res: Response, corsAllow: string | null = null): Response {
  try {
    applySecurityHeaders(res.headers);
    if (corsAllow) applyCorsHeaders(res.headers, corsAllow);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    applySecurityHeaders(headers);
    if (corsAllow) applyCorsHeaders(headers, corsAllow);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  const corsAllow = corsAllowOrigin(c.req.header("Origin"));
  const secured = withSecurityHeaders(c.res, corsAllow);
  if (secured !== c.res) c.res = secured;
});

app.use("/api/*", async (c, next) => {
  // Production schema changes are applied explicitly with Wrangler migrations.
  // The runtime bootstrap remains only for disposable local-preview databases.
  if (isLocalPreviewHost(new URL(c.req.url).hostname)) await ensureSchema(c.env);
  const db = createD1SqlTag(c.env.DB);
  c.set("db", db);
  const resolvedUser = (await getCurrentUser(c.req.raw, db)) ?? getLocalMacMiniAuthUser(c);
  // The synthetic local-owner identity only ever resolves on local-preview hosts
  // (never prod). Back it with a real User row so its editable-playlist writes
  // satisfy the Playlist.userId -> User foreign key D1 enforces. No-op in prod.
  if (resolvedUser && resolvedUser.id === LOCAL_MAC_MINI_AUTH_USER.id) {
    await ensureLocalOwnerUser(db);
  }
  c.set("user", resolvedUser);
  const pathname = new URL(c.req.url).pathname;
  if (!resolvedUser && !isAuthOpenApiPath(pathname)) {
    return jsonError("Unauthorized", 401);
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  // When editable playlists are on, the worker (not the mini) owns two GET reads:
  // the /api/library merge, and the detail read for any folder that's been
  // converted to D1. Skip the proxy and fall through to the D1 handlers; an
  // un-converted folder still proxies to the mini below.
  if (playlistsEditableEnabled(c.env) && c.req.method.toUpperCase() === "GET") {
    const path = macMiniProxyPathname(c);
    if (path === "/api/library") {
      await next();
      return;
    }
    if (
      path.startsWith("/api/playlist/local-folder-") &&
      (await folderServesFromD1(c.env, path.slice("/api/playlist/".length)))
    ) {
      await next();
      return;
    }
  }
  if (shouldProxyMusicRequest(c)) {
    const needsUser = isMacMiniMutation(c) || shouldForwardMacMiniUser(c);
    const user = needsUser ? (c.get("user") ?? (await getMacMiniProxyUser(c))) : null;
    const unauthorized = authorizeMacMiniMutation(c, user);
    if (unauthorized) return unauthorized;
    return proxyToMacMini(c, user);
  }
  await next();
});

app.get("/api/auth/session", async (c) => {
  const user = c.get("user");
  return c.json({ user: user ? await publicUserForResponse(c, user) : null });
});

app.post("/api/auth/signin", async (c) => {
  const db = c.get("db");
  const limited = await rateLimit(db, c.req.raw, "auth", 20, 5 * 60 * 1000);
  if (!limited.allowed) return c.json({ error: "Too many requests" }, { status: 429, headers: limited.headers });
  const body = await readJson<{ email?: unknown; password?: unknown }>(c.req.raw);
  const email = toStringValue(body?.email).toLowerCase();
  const password = toStringValue(body?.password);
  if (!email || !password) return jsonError("Email and password are required", 400);
  const users = await db<UserRow>`
    SELECT "id", "email", "name", "image", "passwordHash", "emailVerified"
    FROM "User"
    WHERE "email" = ${email}
    LIMIT 1
  `;
  const user = users[0];
  // Always run a bcrypt compare (against a fixed dummy hash when the account or
  // its hash is absent) so signin timing doesn't reveal whether an email exists.
  const passwordMatches = await compare(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user?.passwordHash || !passwordMatches) {
    return jsonError("Invalid email or password", 401);
  }
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await db`
    INSERT INTO "Session" ("id", "sessionToken", "userId", "expires")
    VALUES (${crypto.randomUUID()}, ${tokenHash}, ${user.id}, ${expires})
  `;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureCookieRequest(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires,
  });
  return c.json({ user: await publicUserForResponse(c, user) });
});

app.post("/api/auth/signout", async (c) => {
  const token = readCookie(c.req.raw, SESSION_COOKIE);
  if (token) {
    await c.get("db")`
      DELETE FROM "Session"
      WHERE "sessionToken" = ${await sha256Hex(token)}
    `;
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});

app.delete("/api/account", async (c) => {
  const user = requireUser(c.get("user"));
  if (user.id === LOCAL_MAC_MINI_AUTH_USER.id) {
    return jsonError("The local library owner cannot be deleted from preview mode", 403);
  }

  const db = c.get("db");
  const limited = await rateLimit(db, c.req.raw, `account-delete:${user.id}`, 5, 10 * 60 * 1000);
  if (!limited.allowed) {
    return c.json({ error: "Too many requests" }, { status: 429, headers: limited.headers });
  }

  const body = await readJson<{ password?: unknown; confirmation?: unknown }>(c.req.raw);
  const password = toStringValue(body?.password);
  const confirmation = toStringValue(body?.confirmation);
  if (confirmation !== "DELETE") {
    return jsonError('Type "DELETE" to confirm account deletion', 400);
  }
  if (!password) return jsonError("Password is required", 400);

  const rows = await db<{ id: string; email: string; passwordHash: string | null }>`
    SELECT "id", "email", "passwordHash"
    FROM "User"
    WHERE "id" = ${user.id}
    LIMIT 1
  `;
  const account = rows[0];
  // Preserve the sign-in endpoint's constant-cost failure behavior.
  const passwordMatches = await compare(password, account?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!account?.passwordHash || !passwordMatches) {
    return jsonError("Password is incorrect", 401);
  }

  // Snapshot managed media URLs before deleting their rows. A key referenced by
  // another account is retained; arbitrary/external URLs are never passed to R2.
  const [accountMedia, otherAccountMedia] = await Promise.all([
    listAccountMediaRows(db, user.id),
    listOtherAccountMediaRows(db, user.id),
  ]);
  const mediaKeys = exclusiveManagedStorageKeys(accountMedia, otherAccountMedia);

  await deleteAccountRows(
    c.env,
    user.id,
    account.email,
    `account-delete:${user.id}:${limited.ip}`,
  );
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  // Database deletion is the compliance-critical operation and has completed
  // atomically. Object cleanup is bounded, idempotent, and allowed to finish
  // after the response; a transient R2 failure cannot resurrect the account.
  c.executionCtx.waitUntil(
    deleteAccountMedia(c.env, user.id, mediaKeys).catch((error) => {
      console.error(
        "[account deletion] media cleanup failed",
        error instanceof Error ? error.message : String(error),
      );
    }),
  );

  return c.body(null, 204);
});

app.get("/api/auth/verify/:token?", async (c) => {
  const db = c.get("db");
  const origin = publicAppOrigin(c.env, c.req.url);
  const redirectTo = (status: string) => c.redirect(`${origin}/?verified=${status}`, 302);
  // Prefer the path token; keep query support for any older links already sent.
  const raw = toStringValue(c.req.param("token")) || toStringValue(c.req.query("token"));
  if (!raw) return redirectTo("invalid");
  const tokenHash = await sha256Hex(raw);
  const rows = await db<{ identifier: string; expires: string }>`
    SELECT "identifier", "expires"
    FROM "VerificationToken"
    WHERE "token" = ${tokenHash}
    LIMIT 1
  `;
  const record = rows[0];
  if (!record) return redirectTo("invalid");
  // Single-use: consume the token regardless of outcome.
  await db`DELETE FROM "VerificationToken" WHERE "token" = ${tokenHash}`;
  if (new Date(record.expires).getTime() < Date.now()) return redirectTo("expired");
  await db`
    UPDATE "User"
    SET "emailVerified" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "email" = ${record.identifier} AND "emailVerified" IS NULL
  `;
  return redirectTo("success");
});

app.post("/api/auth/resend-verification", async (c) => {
  const db = c.get("db");
  const limited = await rateLimit(db, c.req.raw, "verify-resend", 5, 10 * 60 * 1000);
  if (!limited.allowed) return c.json({ error: "Too many requests" }, { status: 429, headers: limited.headers });
  const user = c.get("user");
  if (!user) return jsonError("Unauthorized", 401);
  const rows = await db<{ emailVerified: string | null }>`
    SELECT "emailVerified" FROM "User" WHERE "id" = ${user.id} LIMIT 1
  `;
  // Generic OK whether or not we actually send (already verified / unknown user).
  if (rows[0] && !rows[0].emailVerified) {
    try {
      const rawToken = await createEmailVerificationToken(db, user.email);
      await sendVerificationEmail(c.env, c.req.url, user.email, rawToken);
    } catch (error) {
      console.error("verification resend failed:", error instanceof Error ? error.message : String(error));
    }
  }
  return c.json({ ok: true });
});

app.post("/api/profile/image", async (c) => {
  const user = requireUser(c.get("user"));
  let imageBytes: ArrayBuffer;
  let imageName = "profile.jpg";
  let imageType: string;

  if ((c.req.header("content-type") || "").toLowerCase().startsWith("application/json")) {
    // The native app's HTTP bridge can't send multipart bodies reliably, so it
    // uploads the image as base64 JSON.
    const body = await readJson<{ image?: unknown; filename?: unknown; contentType?: unknown }>(c.req.raw);
    const base64 = toStringValue(body?.image);
    if (!base64) return jsonError("Image file is required", 400);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    } catch {
      return jsonError("Image data is not valid base64", 400);
    }
    if (bytes.byteLength <= 0) return jsonError("Image file is required", 400);
    if (bytes.byteLength > MAX_IMAGE_BYTES) return jsonError("Image file is too large", 413);
    imageBytes = bytes.buffer as ArrayBuffer;
    imageName = toStringValue(body?.filename) || imageName;
    imageType = toStringValue(body?.contentType);
  } else {
    const form = await c.req.formData();
    const image = form.get("image");
    if (!(image instanceof File) || image.size <= 0) {
      return jsonError("Image file is required", 400);
    }
    if (image.size > MAX_IMAGE_BYTES) return jsonError("Image file is too large", 413);
    imageBytes = await image.arrayBuffer();
    imageName = image.name || imageName;
    imageType = image.type;
  }

  const imageExt = extensionForStoredFile("image", imageName, imageType || "image/jpeg");
  const key = `users/${sanitizePathSegment(user.id)}/profile/${crypto.randomUUID()}${imageExt}`;
  // Derive the stored content-type solely from the validated extension — never
  // trust the client-supplied contentType. Otherwise a caller could store an
  // avatar as text/html and have our origin serve executable HTML (stored XSS),
  // since /api/files serves profile images without auth.
  const contentType = inferContentTypeFromKey(key);
  await putBuffer(c.env, key, imageBytes, contentType);
  const imageUrl = toApiFileUrl(key);
  const rows = await c.get("db")<UserRow>`
    UPDATE "User"
    SET "image" = ${imageUrl}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${user.id}
    RETURNING "id", "email", "name", "image", "passwordHash", "emailVerified", "createdAt", "updatedAt"
  `;
  return c.json({ user: publicUser(rows[0] ?? { ...user, image: imageUrl }) });
});

app.post("/api/register", async (_c) => {
  // Private personal deployment: public self-registration is disabled.
  return jsonError("Registration is disabled", 403);
});

app.get("/api/home", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  // Home only needs the liked-song ids (to hydrate the likes store / heart
  // states). Both the mobile app and the web app stopped rendering the full
  // song list here, so we no longer ship it — that array was up to 5000 full
  // song objects nobody displayed, plus the DB query + JSON + ETag hash to
  // build it on every request. The full library still lives at /api/songs and
  // the search projection at /api/search-index.
  const likedSongIds = await listLikedSongIds(db, user?.id ?? null);
  return jsonCached(c, { likedSongIds });
});

// Spotify's editorial "Top 50 - Global" playlist — globally trending tracks right
// now. Fetched via the pathfinder (works anonymously for public playlists). Each
// track carries its Spotify id; tapping a track plays it instantly from the
// Mac-mini's hidden ".discover" staging cache (pre-downloaded in the background)
// without adding it to the library. See the staging endpoints below + the
// matching handlers in local-music-server.ts.
const TOP_50_GLOBAL_PLAYLIST_ID = "37i9dQZEVXbMDoHDwVN2tF";
// How many not-yet-staged Top-50 tracks to resolve + enqueue per cron tick.
// Resolution walks many providers and is slow, so this is bounded; the rest
// fill in over subsequent ticks.
const DISCOVER_STAGE_BATCH = 6;

type DiscoverTrendingTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  imageUrl: string;
  durationMs: number | null;
  spotifyUrl: string;
};
type DiscoverStagingStatusEntry = { trackId: string; id: string; audioUrl: string; duration?: number };

// Call a Mac-mini /api/discover/* endpoint as the library owner (staging is a
// single shared cache owned by the library owner, regardless of who is viewing).
async function macMiniDiscoverFetch(
  env: CloudflareEnv,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  timeoutMs = 15_000,
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  const token = getMacMiniProxyToken(env);
  if (token) headers.set("x-spotify-proxy-token", token);
  headers.set("x-spotify-user-id", LOCAL_MAC_MINI_AUTH_USER.id);
  headers.set("x-spotify-user-email", LOCAL_MAC_MINI_AUTH_USER.email);
  if (LOCAL_MAC_MINI_AUTH_USER.name) headers.set("x-spotify-user-name", LOCAL_MAC_MINI_AUTH_USER.name);
  return fetch(new URL(path, getMacMiniOrigin(env)).toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Background: resolve up to DISCOVER_STAGE_BATCH missing tracks and hand the
// Mac-mini the current Top-50 (to refresh + prune) plus the resolved descriptors
// to materialize into staging. The Mac-mini does the heavy download async, so
// this returns as soon as the resolves + one sync POST complete.
async function fillDiscoverStaging(
  env: CloudflareEnv,
  presentIds: string[],
  missing: DiscoverTrendingTrack[],
): Promise<void> {
  const stage: unknown[] = [];
  for (const track of missing) {
    try {
      const resolved = await resolveStreamUrl(env, {
        mode: "spotify",
        spotifyUrl: track.spotifyUrl,
        region: "US",
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs ?? undefined,
        qualityProfile: "max",
      });
      stage.push({
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        imageUrl: track.imageUrl,
        durationMs: track.durationMs ?? undefined,
        resolved,
      });
    } catch {
      // Skip this track; a later cron tick retries it.
    }
  }
  await macMiniDiscoverFetch(env, "/api/discover/sync", "POST", { present: presentIds, stage }, 10_000).catch(() => {});
}

// Fetch + normalize a Spotify playlist's tracks into the Discover shape. Shared
// by the trending chart, the cron fill, and curated-playlist detail views.
async function fetchDiscoverTracksForPlaylist(
  env: CloudflareEnv,
  playlistId: string,
  limit: number,
): Promise<DiscoverTrendingTrack[]> {
  try {
    // Catalog-page metadata + contents are fetched in parallel and the outer
    // deadline bounds token acquisition too. The legacy playlist helper fetched
    // those two surfaces serially, which could exceed the mobile 15s budget on a
    // cold Top 50 open.
    const { tracks } = await withProviderDeadline(
      fetchSpotifyPlaylistCatalogPage(playlistId, envString(env, "SPOTIFY_SP_DC") || undefined, 0, limit),
      12_000,
    );
    return tracks
      .filter((track) => track.id && track.name && track.artists.length > 0)
      .map((track) => ({
        id: track.id,
        title: track.name,
        artist: track.artists.join(", "),
        album: track.album || "",
        imageUrl: track.imageUrl || "/apple-icon.png",
        durationMs: typeof track.durationMs === "number" && track.durationMs > 0 ? track.durationMs : null,
        spotifyUrl: `https://open.spotify.com/track/${track.id}`,
      }));
  } catch {
    return [];
  }
}

// The current "Top 50 - Global" chart (shared by the trending endpoint and the
// cron fill).
function fetchTop50DiscoverTracks(env: CloudflareEnv): Promise<DiscoverTrendingTrack[]> {
  return fetchDiscoverTracksForPlaylist(env, TOP_50_GLOBAL_PLAYLIST_ID, 50);
}

type DiscoverStagedTrack = DiscoverTrendingTrack & { staged: boolean; audioId?: string; audioUrl?: string };

async function readDiscoverStagingStatus(
  env: CloudflareEnv,
  timeoutMs = 4_000,
): Promise<Map<string, DiscoverStagingStatusEntry>> {
  const staged = new Map<string, DiscoverStagingStatusEntry>();
  if (isMacMiniMusicConfigured(env)) {
    try {
      const res = await macMiniDiscoverFetch(env, "/api/discover/staging", "GET", undefined, timeoutMs);
      if (res.ok) {
        const body = (await res.json()) as { entries?: DiscoverStagingStatusEntry[] };
        for (const entry of body.entries ?? []) staged.set(entry.trackId, entry);
      }
    } catch {
      // Staging status is best-effort; fall back to "not staged".
    }
  }
  return staged;
}

function applyDiscoverStaging(
  tracks: DiscoverTrendingTrack[],
  staged: Map<string, DiscoverStagingStatusEntry>,
): DiscoverStagedTrack[] {
  return tracks.map((track) => {
    const ready = staged.get(track.id);
    return ready
      ? { ...track, staged: true, audioId: ready.id, audioUrl: ready.audioUrl }
      : { ...track, staged: false };
  });
}

// Ask the Mac-mini which of these tracks are already staged (instantly playable
// from .discover) and fold that status into each track. Best-effort: on any
// failure (or when staging isn't configured) every track is reported unstaged,
// which just means a tap materializes it on demand. Shared by the Discover row
// and curated-playlist detail views.
async function markDiscoverStaged(
  env: CloudflareEnv,
  tracks: DiscoverTrendingTrack[],
  timeoutMs = 4_000,
): Promise<DiscoverStagedTrack[]> {
  return applyDiscoverStaging(tracks, await readDiscoverStagingStatus(env, timeoutMs));
}

// The YouTube Music auto-updating "Discover Mix" surfaced as a Home playlist card —
// personalized to the library owner's Premium account (the mini fetches it with the
// owner's cookies). Playlist id is "yt-mix-<listId>"; tracks stream as Opus preview.
const YT_DISCOVER_MIX_LIST_ID = "RDTMAK5uy_n_5IN6hzAOwdCnM8D8rzrs3vDl12UcZpA";

// Convert a Discover chart track (with staged status) into a player song — a real,
// instantly-playable song when staged, else a placeholder the discover-stager
// materializes on play. Mirrors the mobile discoverTrackToPlayerSong so the Top-50
// playlist detail renders + plays exactly like the old Discover row (lossless).
function discoverStagedToPlayerSong(track: DiscoverStagedTrack): PlayerSong {
  const duration = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;
  if (track.staged && track.audioUrl && track.audioId) {
    return {
      id: track.audioId,
      title: track.title,
      artist: track.artist,
      album: track.album || undefined,
      imageUrl: track.imageUrl,
      audioUrl: track.audioUrl,
      duration,
      source: "server",
      staged: true,
      discoverTrackId: track.id,
    };
  }
  return {
    id: `discover:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    imageUrl: track.imageUrl,
    audioUrl: "",
    duration,
    source: "server",
    discoverTrackId: track.id,
  };
}

// Build the Home "Discover Mix" card from the mini's YT playlist. Best-effort: a
// short timeout keeps Home fast, and on a miss the card still shows with a fallback
// name so opening it can retry the live fetch.
async function youtubeDiscoverMixCard(
  env: CloudflareEnv,
): Promise<{ id: string; name: string; imageUrl: string; songsCount: number; resolved: boolean }> {
  const fallback = { id: `yt-mix-${YT_DISCOVER_MIX_LIST_ID}`, name: "Discover Mix", imageUrl: "", songsCount: 0, resolved: false };
  try {
    const res = await macMiniDiscoverFetch(
      env,
      `/api/youtube/playlists/${YT_DISCOVER_MIX_LIST_ID}`,
      "GET",
      undefined,
      12_000,
    );
    if (!res.ok) return fallback;
    const body = (await res.json()) as { playlist?: { name?: string; imageUrl?: string | null }; songs?: unknown[] };
    const songsCount = Array.isArray(body.songs) ? body.songs.length : 0;
    return {
      id: fallback.id,
      name: body.playlist?.name || "Discover Mix",
      imageUrl: body.playlist?.imageUrl || "",
      songsCount,
      // Resolved when we actually got the mix back (tracks present): the card then
      // has a real cover + count and is safe to cache for longer.
      resolved: songsCount > 0,
    };
  } catch {
    return fallback;
  }
}

// Cron-driven background fill: stage a batch of not-yet-cached Top-50 tracks and
// hand the Mac-mini the current chart so it refreshes lastSeen + prunes stale
// entries. Runs on a Cron Trigger because per-track resolution can take tens of
// seconds — too slow for a request's post-response waitUntil budget.
async function runDiscoverFill(env: CloudflareEnv): Promise<void> {
  if (!isMacMiniMusicConfigured(env)) return;
  const discover = await fetchTop50DiscoverTracks(env);
  if (!discover.length) return;
  const staged = new Set<string>();
  try {
    const res = await macMiniDiscoverFetch(env, "/api/discover/staging", "GET", undefined, 8_000);
    if (res.ok) {
      const body = (await res.json()) as { entries?: DiscoverStagingStatusEntry[] };
      for (const entry of body.entries ?? []) staged.add(entry.trackId);
    }
  } catch {
    // best-effort
  }
  const missing = discover.filter((track) => !staged.has(track.id)).slice(0, DISCOVER_STAGE_BATCH);
  const presentIds = discover.map((track) => track.id);
  await fillDiscoverStaging(env, presentIds, missing);
}

app.get("/api/discover/trending", async (c) => {
  const discover = await fetchTop50DiscoverTracks(c.env);
  if (!discover.length) {
    return jsonCached(c, { tracks: [] }, { cacheControl: "public, max-age=120" });
  }
  if (!isMacMiniMusicConfigured(c.env)) {
    return jsonCached(c, { tracks: discover }, {
      cacheControl: "public, max-age=1800, stale-while-revalidate=7200",
    });
  }

  // Mark which tracks are already staged (instantly playable from .discover).
  // The actual fill happens on the cron (runDiscoverFill); this endpoint only
  // reads status, so it stays fast.
  const tracks = await markDiscoverStaged(c.env, discover);

  // Short cache: a track's staged status changes as the cron fill completes.
  return jsonCached(c, { tracks }, { cacheControl: "private, max-age=30, stale-while-revalidate=300" });
});

// The Home "Discover" first row as clickable, auto-updating PLAYLISTS (instead of a
// horizontal scroll of individual tracks): Top 50 (lossless chart) + the YouTube
// Music Discover Mix (Opus preview, owner's Premium). Each card opens
// /api/playlist/:id ("discover-top50" / "yt-mix-<listId>").
app.get("/api/discover/playlists", async (c) => {
  const playlists: Array<{ id: string; name: string; imageUrl: string; songsCount: number }> = [];
  // Run the two cards concurrently so the mix's worst-case mini round-trip doesn't
  // stack on top of the Top-50 fetch.
  // The mix card is the OWNER's personalized YouTube mix (fetched as the owner on
  // the mini) — like its detail route, only show it to authenticated callers.
  const [top, mix] = await Promise.all([
    fetchTop50DiscoverTracks(c.env).catch(() => [] as DiscoverTrendingTrack[]),
    isMacMiniMusicConfigured(c.env) && c.get("user") ? youtubeDiscoverMixCard(c.env) : Promise.resolve(null),
  ]);
  playlists.push({ id: "discover-top50", name: "Top 50", imageUrl: top[0]?.imageUrl || "", songsCount: top.length });
  if (mix) {
    const { resolved, ...card } = mix;
    playlists.push(card);
    // If the mix card fell back (mini cold / slow), cache only briefly so the next
    // load picks up the now-warm mini cache (with the real cover); cache longer once
    // it resolved.
    if (!resolved) {
      return jsonCached(c, { playlists }, { cacheControl: "private, max-age=30, stale-while-revalidate=120" });
    }
  }
  return jsonCached(c, { playlists }, { cacheControl: "private, max-age=600, stale-while-revalidate=3600" });
});

// Tap a not-yet-staged Discover track: resolve + materialize ONE track into the
// staging cache (blocking, like a normal import) and return a playable song. The
// song is NOT in the library until a "keep" action promotes it.
app.post("/api/discover/stage", async (c) => {
  requireUser(c.get("user"));
  if (!isMacMiniMusicConfigured(c.env)) return jsonError("Discover streaming is not available", 503);
  const payload = await readJson<SongPayload & { trackId?: unknown; youtubeVideoId?: unknown }>(c.req.raw);
  if (!payload) return jsonError("Invalid JSON body", 400);
  // A YouTube Music mix track carries its exact videoId (no Spotify id). The mini
  // stages THAT video's Opus directly — always a preview, never resolver-backed.
  const youtubeVideoId = toStringValue(payload.youtubeVideoId);
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl)) || toStringValue(payload.trackId);
  if (!trackId) return jsonError("Invalid Spotify track URL or ID", 400);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  // A direct-videoId mix track needs only a title (artist is best-effort); a
  // Spotify-keyed track needs both to search/label.
  if (!title || (!artist && !youtubeVideoId)) return jsonError("Title and artist are required", 400);
  // Preview (play/skip): the mini stages a YouTube Opus copy itself — skip the
  // expensive, outage-prone lossless resolver entirely. Lossless (Add): resolve
  // a FLAC descriptor as before. The mini enforces that a preview can't be
  // promoted into the library (409 preview_not_lossless).
  const preview = payload.preview === true || Boolean(youtubeVideoId);
  const resolved = preview ? undefined : await resolveStreamUrl(c.env, payload);
  const res = await macMiniDiscoverFetch(
    c.env,
    "/api/discover/stage",
    "POST",
    {
      trackId,
      title,
      artist,
      album: toStringValue(payload.album),
      imageUrl: toStringValue(payload.imageUrl),
      durationMs: toNumberValue(payload.durationMs) ?? undefined,
      ...(preview ? { preview: true } : { resolved }),
      ...(youtubeVideoId ? { youtubeVideoId } : {}),
    },
    120_000,
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});

// Promote a staged Discover track into the real library (move it out of
// .discover so it scans + can be liked). Returns the now-real song; the client
// then performs the actual keep action (like / add-to-playlist / download).
app.post("/api/discover/promote", async (c) => {
  requireUser(c.get("user"));
  if (!isMacMiniMusicConfigured(c.env)) return jsonError("Discover streaming is not available", 503);
  const payload = await readJson<{ trackId?: unknown; finalId?: unknown }>(c.req.raw);
  const trackId = toStringValue(payload?.trackId);
  if (!trackId) return jsonError("trackId is required", 400);
  const finalId = toStringValue(payload?.finalId);
  const res = await macMiniDiscoverFetch(
    c.env,
    "/api/discover/promote",
    "POST",
    { trackId, finalId },
    30_000,
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});

// Smart Shuffle: given the listening context's seeds (+ exclude sets), return a
// batch of recommended tracks shaped exactly like /api/discover/trending so the
// client can stream them through the existing Discover staging pipeline. The
// worker stays stateless — the client owns the seed/exclude/blocklist sets.
// Recommendations come from Last.fm "similar tracks", resolved name→Spotify id.
const SMART_SHUFFLE_DEFAULT_LIMIT = 12;
const SMART_SHUFFLE_RESOLVE_CONCURRENCY = 3;

type SmartShuffleRequest = {
  contextKey?: unknown;
  seeds?: unknown;
  exclude?: unknown;
  excludeIds?: unknown;
  limit?: unknown;
};

function smartShuffleSeedList(value: unknown): { title: string; artist: string }[] {
  if (!Array.isArray(value)) return [];
  const seeds: { title: string; artist: string }[] = [];
  for (const entry of value) {
    const record = entry as { title?: unknown; artist?: unknown } | null;
    const title = toStringValue(record?.title);
    const artist = toStringValue(record?.artist);
    if (title && artist) seeds.push({ title, artist });
  }
  return seeds;
}

function smartShuffleKey(title: string, artist: string): string {
  return `${normalizeSongPart(title)}::${normalizeSongPart(artist)}`;
}

app.post("/api/smart-shuffle/recommend", async (c) => {
  requireUser(c.get("user"));
  if (!isMacMiniMusicConfigured(c.env)) return jsonError("Smart Shuffle is not available", 503);

  const payload = await readJson<SmartShuffleRequest>(c.req.raw);
  if (!payload) return jsonError("Invalid JSON body", 400);

  const seeds = smartShuffleSeedList(payload.seeds);
  const limit = Math.min(25, Math.max(1, toNumberValue(payload.limit) ?? SMART_SHUFFLE_DEFAULT_LIMIT));
  const apiKey = envString(c.env, "LAST_FM_API_KEY");
  if (!apiKey) return jsonCached(c, { tracks: [], reason: "no-recommender-configured" });
  if (seeds.length === 0) return jsonCached(c, { tracks: [] });

  const contextKey = toStringValue(payload.contextKey);
  const exclude = smartShuffleSeedList(payload.exclude);
  const excludeIds = new Set(
    (Array.isArray(payload.excludeIds) ? payload.excludeIds : []).map((id) => toStringValue(id)).filter(Boolean),
  );

  // Daily-refresh cache: stable across the same seed set + context within a UTC
  // day, so a session keeps getting a consistent batch but fresh recs roll in
  // each day. Keyed without a binding via the Cache API (like other routes).
  const cache = await caches.open("smart-shuffle-v1");
  const seedKeys = seeds.map((seed) => smartShuffleKey(seed.title, seed.artist)).sort();
  const dayStamp = new Date().toISOString().slice(0, 10);
  const cacheSignature = `${dayStamp}|${contextKey}|${limit}|${seedKeys.join(",")}`;
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = `?key=${encodeURIComponent(cacheSignature)}`;
  const cacheRequest = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await cache.match(cacheRequest).catch(() => null);
  if (cached) return cached;

  // Exclude the user's own context songs (seeds ∪ exclude) by normalized key so
  // recommendations never echo a track the playlist already contains.
  const excludeKeys = new Set<string>();
  for (const seed of seeds) excludeKeys.add(smartShuffleKey(seed.title, seed.artist));
  for (const entry of exclude) excludeKeys.add(smartShuffleKey(entry.title, entry.artist));

  let tracks: DiscoverStagedTrack[];
  try {
    const candidates = (await fetchLastFmSimilarTracks(seeds, apiKey, limit)).filter(
      (candidate) => !excludeKeys.has(smartShuffleKey(candidate.title, candidate.artist)),
    );

    // Resolve name→Spotify id, capped at SMART_SHUFFLE_RESOLVE_CONCURRENCY so we
    // don't hammer the search surface. Drop misses, excluded ids, and id dupes.
    const spotifyCookie = envString(c.env, "SPOTIFY_SP_DC");
    const resolved: DiscoverTrendingTrack[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < candidates.length && resolved.length < limit; i += SMART_SHUFFLE_RESOLVE_CONCURRENCY) {
      const batch = candidates.slice(i, i + SMART_SHUFFLE_RESOLVE_CONCURRENCY);
      const hits = await Promise.all(
        batch.map((candidate) =>
          searchSpotifyTrackId({ title: candidate.title, artist: candidate.artist }, spotifyCookie || undefined).catch(
            () => null,
          ),
        ),
      );
      for (const hit of hits) {
        if (!hit || excludeIds.has(hit.id) || seenIds.has(hit.id)) continue;
        seenIds.add(hit.id);
        resolved.push({
          id: hit.id,
          title: hit.name,
          artist: hit.artists.join(", "),
          album: hit.album || "",
          imageUrl: hit.imageUrl || "/apple-icon.png",
          durationMs: typeof hit.durationMs === "number" && hit.durationMs > 0 ? hit.durationMs : null,
          spotifyUrl: `https://open.spotify.com/track/${hit.id}`,
        });
        if (resolved.length >= limit) break;
      }
    }

    // Flag already-staged recs so they play instantly (same as Discover).
    tracks = (await markDiscoverStaged(c.env, resolved)).slice(0, limit);
  } catch {
    // Tolerate Last.fm/search failures: return whatever resolved (possibly none)
    // rather than throwing to the client.
    tracks = [];
  }

  const response = await jsonCached(c, { tracks }, {
    cacheControl: "private, max-age=120, stale-while-revalidate=600",
  });
  // Cache the materialized batch for ~12h (the day-stamped key rolls it over).
  // The Cache API needs a cacheable response, so the stored copy gets a plain
  // max-age; the client copy keeps the private short-cache headers above.
  const toCache = new Response(response.clone().body, {
    status: response.status,
    headers: new Headers(response.headers),
  });
  toCache.headers.set("cache-control", "max-age=43200");
  await cache.put(cacheRequest, toCache).catch(() => {});
  return response;
});

app.get("/api/search-index", async (c) => {
  const user = c.get("user");
  return jsonCached(c, { songs: await listSearchSongs(c.get("db"), user?.id ?? null) }, {
    cacheControl: "private, max-age=300, stale-while-revalidate=600",
  });
});

type YouTubeCatalogPlaylist = {
  kind: "playlist";
  provider: "youtube";
  id: string;
  name: string;
  imageUrl: string | null;
  ownerName?: string;
  externalUrl: string;
};

type CatalogProviderStatus = {
  spotify: "ok" | "unavailable";
  youtube: "ok" | "not_configured" | "unavailable";
};

async function withProviderDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SpotifyPathfinderError("Provider request timed out", 504)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function parseYouTubePlaylistSearchPayload(payload: unknown): YouTubeCatalogPlaylist[] {
  const rows = Array.isArray(toObject(payload)?.playlists) ? toObject(payload)?.playlists : [];
  const playlists: YouTubeCatalogPlaylist[] = [];
  const seen = new Set<string>();
  for (const row of rows as unknown[]) {
    const item = toObject(row);
    const id = toStringValue(item?.id);
    const name = toStringValue(item?.name);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !name || seen.has(id)) continue;
    const image = parseHttpUrl(toStringValue(item?.imageUrl));
    const imageUrl = image?.protocol === "https:" ? image.toString() : null;
    const ownerName = toStringValue(item?.ownerName);
    seen.add(id);
    playlists.push({
      kind: "playlist",
      provider: "youtube",
      id,
      name,
      imageUrl,
      ...(ownerName ? { ownerName } : {}),
      externalUrl: `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`,
    });
    if (playlists.length >= 8) break;
  }
  return playlists;
}

function spotifyBatchTracksToCatalogSongs(tracks: SpotifyBatchTrack[]): DiscoverTrendingTrack[] {
  return tracks
    .filter((track) => isSpotifyCatalogId(track.id) && track.name && track.artists.length > 0)
    .map((track) => ({
      id: track.id,
      title: track.name,
      artist: track.artists.join(", "),
      album: track.album || "",
      imageUrl: track.imageUrl || "/apple-icon.png",
      durationMs: typeof track.durationMs === "number" && track.durationMs > 0 ? track.durationMs : null,
      spotifyUrl: `https://open.spotify.com/track/${track.id}`,
    }));
}

async function searchYouTubeCatalogPlaylists(
  env: CloudflareEnv,
  query: string,
): Promise<{ status: CatalogProviderStatus["youtube"]; playlists: YouTubeCatalogPlaylist[] }> {
  if (!canUseMacMiniProxy(env)) return { status: "not_configured", playlists: [] };
  try {
    const response = await macMiniDiscoverFetch(
      env,
      `/api/youtube/search/playlists?q=${encodeURIComponent(query)}`,
      "GET",
      undefined,
      6_000,
    );
    if (response.status === 404 || response.status === 501) {
      return { status: "not_configured", playlists: [] };
    }
    if (!response.ok) return { status: "unavailable", playlists: [] };
    return {
      status: "ok",
      playlists: parseYouTubePlaylistSearchPayload(await response.json().catch(() => null)),
    };
  } catch {
    return { status: "unavailable", playlists: [] };
  }
}

// Mixed catalog search. `results` remains the backward-compatible song array.
// Spotify playlists/artists and YouTube playlists are provider-authored metadata;
// failures are reported per provider rather than masquerading as "no matches".
app.get("/api/search/catalog", async (c) => {
  if (!c.get("user")) return jsonError("Unauthorized", 401);
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  if (q.length < 2) {
    const providers: CatalogProviderStatus = {
      spotify: "ok",
      youtube: canUseMacMiniProxy(c.env) ? "ok" : "not_configured",
    };
    return jsonCached(c, { query: q, results: [], playlists: [], artists: [], providers }, {
      cacheControl: "private, max-age=30",
    });
  }

  const stagingStatus = readDiscoverStagingStatus(c.env, 4_000);
  const [spotify, youtube, stagedById] = await Promise.all([
    (async () => {
      try {
        return {
          status: "ok" as const,
          catalog: await withProviderDeadline(
            searchSpotifyCatalog(q, envString(c.env, "SPOTIFY_SP_DC") || undefined, {
              tracks: 24,
              playlists: 8,
              artists: 8,
            }),
            6_000,
          ),
        };
      } catch {
        return {
          status: "unavailable" as const,
          catalog: { tracks: [], playlists: [], artists: [] },
        };
      }
    })(),
    searchYouTubeCatalogPlaylists(c.env, q),
    stagingStatus,
  ]);

  const resolved = spotifyBatchTracksToCatalogSongs(spotify.catalog.tracks);
  const seenKeys = new Set<string>();
  const uniqueTracks = resolved.filter((track) => {
    const key = smartShuffleKey(track.title, track.artist);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  const staged = applyDiscoverStaging(uniqueTracks, stagedById);
  const results: PlayerSong[] = staged.map((track) => ({ ...discoverStagedToPlayerSong(track), preview: true }));
  const playlists: Array<SpotifyCatalogPlaylist | YouTubeCatalogPlaylist> = [
    ...spotify.catalog.playlists,
    ...youtube.playlists,
  ];
  const artists: SpotifyCatalogArtist[] = spotify.catalog.artists;
  const providers: CatalogProviderStatus = {
    spotify: spotify.status,
    youtube: youtube.status,
  };

  return jsonCached(c, { query: q, results, playlists, artists, providers }, {
    cacheControl: "private, max-age=60, stale-while-revalidate=120",
  });
});

app.get("/api/catalog/spotify/playlists/:id", async (c) => {
  if (!c.get("user")) return jsonError("Unauthorized", 401);
  const id = c.req.param("id");
  if (!isSpotifyCatalogId(id)) return jsonError("Invalid Spotify playlist ID", 400);
  const offset = Math.min(10_000, Math.max(0, Math.floor(toNumberValue(c.req.query("offset")) ?? 0)));
  const limit = Math.min(100, Math.max(1, Math.floor(toNumberValue(c.req.query("limit")) ?? 100)));
  try {
    const spotifyCookie = envString(c.env, "SPOTIFY_SP_DC");
    const stagingStatus = readDiscoverStagingStatus(c.env, 6_000);
    const catalog = await withProviderDeadline(
      fetchSpotifyPlaylistCatalogPage(id, spotifyCookie || undefined, offset, limit),
      12_000,
    );
    const tracks = applyDiscoverStaging(
      spotifyBatchTracksToCatalogSongs(catalog.tracks),
      await stagingStatus,
    );
    return jsonCached(
      c,
      {
        kind: "catalog",
        provider: "spotify",
        playlist: { ...catalog.playlist, editable: false },
        songs: tracks.map((track) => ({ ...discoverStagedToPlayerSong(track), preview: true })),
        // Catalog playlists do not own the caller's complete like set.
        likedSongIds: null,
        page: {
          offset: catalog.offset,
          limit,
          totalCount: catalog.totalCount,
          nextOffset: catalog.nextOffset,
        },
      },
      { cacheControl: "private, max-age=60, stale-while-revalidate=300" },
    );
  } catch (error) {
    if (error instanceof SpotifyPathfinderError) return jsonError(error.message, error.status);
    return jsonError("Could not load Spotify playlist", 502);
  }
});

app.get("/api/catalog/spotify/artists/:id", async (c) => {
  if (!c.get("user")) return jsonError("Unauthorized", 401);
  const id = c.req.param("id");
  if (!isSpotifyCatalogId(id)) return jsonError("Invalid Spotify artist ID", 400);
  try {
    const stagingStatus = readDiscoverStagingStatus(c.env, 6_000);
    const catalog = await withProviderDeadline(
      fetchSpotifyArtistCatalog(id, envString(c.env, "SPOTIFY_SP_DC") || undefined, "US"),
      12_000,
    );
    const tracks = applyDiscoverStaging(
      spotifyBatchTracksToCatalogSongs(catalog.tracks),
      await stagingStatus,
    );
    return jsonCached(
      c,
      {
        provider: "spotify",
        market: "US",
        artist: catalog.artist,
        songs: tracks.map((track) => ({ ...discoverStagedToPlayerSong(track), preview: true })),
      },
      { cacheControl: "private, max-age=300, stale-while-revalidate=900" },
    );
  } catch (error) {
    if (error instanceof SpotifyPathfinderError) return jsonError(error.message, error.status);
    return jsonError("Could not load Spotify artist", 502);
  }
});

app.get("/api/library", async (c) => {
  // Editable playlists: merge D1 (native + converted folders) with the owner's
  // still-unconverted mini folders. The proxy middleware already skipped the
  // mini proxy for this path when the flag is on, so this is the live handler.
  if (playlistsEditableEnabled(c.env)) return handleLibraryMerge(c);
  const user = c.get("user");
  return jsonCached(c, { playlists: await listPlaylists(c.get("db"), user?.id ?? null), userId: user?.id ?? null }, {
    cacheControl: "private, max-age=300, stale-while-revalidate=600",
  });
});

const PODCAST_FEED_CACHE_TTL_MS = 5 * 60 * 1000;
const PODCAST_FEED_FETCH_ATTEMPTS = 3;
// The client only renders the newest ~50 episodes (parsePodcastFeed slices to
// 50), so the proxy trims the feed to a little more than that. This is what
// makes the proxy reliable: the Workers runtime truncates these multi-megabyte
// chunked feed bodies at ~2.2MB when an isolate reads several concurrently (the
// page loads the feed next to one image proxy per visible episode), mangling
// the back half. RSS lists newest first, so the episodes we keep always sit in
// the clean leading slice that arrives intact — dropping the long tail makes
// the truncation irrelevant and keeps the served/re-read document small.
const PODCAST_FEED_MAX_ITEMS = 60;
const podcastFeedXmlCache = new Map<string, { fetchedAt: number; xml: string }>();
const podcastFeedInFlight = new Map<string, Promise<string>>();

// Rebuild a compact, well-formed RSS document from at most `limit` <item>
// elements. The Worker has no XML parser, so this works on the raw — and
// possibly tail-truncated — feed text: everything before the first <item> is
// the channel preamble (show title, description, cover art), which is kept
// verbatim, then the leading items, then the closing tags are reattached.
// Returns null when not even one complete item is present (a read that
// truncated unusually early) so the caller can retry.
function trimPodcastFeed(xmlText: string, limit: number): string | null {
  const firstItem = xmlText.search(/<item[\s>]/i);
  if (firstItem === -1) return null;
  const preamble = xmlText.slice(0, firstItem);
  const itemPattern = /<item[\s>][\s\S]*?<\/item\s*>/gi;
  itemPattern.lastIndex = firstItem;
  let items = "";
  let count = 0;
  let match: RegExpExecArray | null;
  while (count < limit && (match = itemPattern.exec(xmlText)) !== null) {
    items += match[0];
    count += 1;
  }
  if (count === 0) return null;
  return `${preamble}${items}\n  </channel>\n</rss>\n`;
}

async function fetchPodcastFeedXmlUncached(
  show: PodcastShow,
  cached: { fetchedAt: number; xml: string } | undefined,
): Promise<string> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < PODCAST_FEED_FETCH_ATTEMPTS; attempt++) {
    // Accept-Encoding: identity requests the raw, uncompressed feed. The hosts
    // (megaphone, libsyn) honor it, and it opts this subrequest out of the
    // runtime's transparent decompression. A truncated read then cuts cleanly
    // mid-document instead of garbling, so the leading items we keep stay intact.
    const response = await fetchWithTimeout(show.feedUrl, SPOTIFY_REQUEST_TIMEOUT_MS, {
      headers: { "accept-encoding": "identity" },
    });
    if (!response.ok) {
      lastStatus = response.status;
      continue;
    }
    const trimmed = trimPodcastFeed(await response.text(), PODCAST_FEED_MAX_ITEMS);
    if (trimmed) {
      podcastFeedXmlCache.set(show.feedUrl, { fetchedAt: Date.now(), xml: trimmed });
      return trimmed;
    }
  }

  // Every attempt errored or came back unusable: serve the last good copy
  // (even if past its TTL) rather than surface a parse error to the client.
  if (cached) return cached.xml;
  throw new ApiError(
    lastStatus ? `Podcast feed returned ${lastStatus}` : "Podcast feed could not be loaded",
    502,
  );
}

// Per-isolate feed cache: /api/podcast-media validates every request (including
// each playback range request) against the feed, so it can't refetch a
// multi-megabyte RSS document from the podcast host every time.
async function fetchPodcastFeedXml(show: PodcastShow): Promise<string> {
  const cached = podcastFeedXmlCache.get(show.feedUrl);
  if (cached && Date.now() - cached.fetchedAt < PODCAST_FEED_CACHE_TTL_MS) return cached.xml;

  // Collapse the burst a cold isolate sees — the feed request plus one
  // /api/podcast-media validation per visible episode — into a single upstream
  // fetch, so callers share one document instead of each re-fetching their own.
  const existing = podcastFeedInFlight.get(show.feedUrl);
  if (existing) return existing;

  const work = fetchPodcastFeedXmlUncached(show, cached);
  podcastFeedInFlight.set(show.feedUrl, work);
  try {
    return await work;
  } finally {
    podcastFeedInFlight.delete(show.feedUrl);
  }
}

app.get("/api/podcast-feeds/:id", async (c) => {
  const podcastShow = PODCAST_SHOWS.find((show) => show.id === c.req.param("id"));
  if (!podcastShow) return jsonError("Podcast not found", 404);
  const body = await fetchPodcastFeedXml(podcastShow);
  return new Response(body, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=1800",
    },
  });
});

const PODCAST_MEDIA_PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

app.get("/api/podcast-media/:id", async (c) => {
  const podcastShow = PODCAST_SHOWS.find((show) => show.id === c.req.param("id"));
  if (!podcastShow) return jsonError("Podcast not found", 404);
  const mediaUrl = safePodcastUrl(c.req.query("url") ?? "");
  if (!mediaUrl) return jsonError("Invalid podcast media URL", 400);

  // Only relay URLs that appear in the show's feed (or its cover art) so this
  // endpoint can't be used as an open proxy.
  const allowedUrls = extractPodcastFeedMediaUrls(await fetchPodcastFeedXml(podcastShow), podcastShow);
  if (!podcastFeedAllowsMediaUrl(allowedUrls, mediaUrl)) {
    return jsonError("Unknown podcast media URL", 403);
  }

  const range = c.req.header("range");
  const upstream = await fetchWithTimeout(mediaUrl, SPOTIFY_REQUEST_TIMEOUT_MS, {
    headers: range ? { range } : undefined,
  });
  if (!upstream.ok) throw new ApiError(`Podcast media returned ${upstream.status}`, 502);

  const headers = new Headers({ "cache-control": "public, max-age=3600" });
  for (const name of PODCAST_MEDIA_PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
});

app.get("/api/playback-state", async (c) => {
  const user = requirePlaybackStateUser(c);
  const rows = await c.get("db")<PlaybackStateRow>`
    SELECT "id", "userId", "deviceId", "stateJson", "clientUpdatedAt", "createdAt", "updatedAt"
    FROM "PlaybackState"
    WHERE "userId" = ${user.id}
    LIMIT 1
  `;
  return c.json(
    { state: playbackStateFromRow(rows[0]) },
    { headers: { "cache-control": "no-store" } },
  );
});

app.put("/api/playback-state", async (c) => {
  const user = requirePlaybackStateUser(c);
  const payload = await readJson<PlaybackStateWritePayload>(c.req.raw);
  const state = coercePlaybackStatePayload(payload?.state);
  if (!state) return jsonError("Invalid playback state", 400);
  const stateJson = JSON.stringify(state);
  if (stateJson.length > 512_000) return jsonError("Playback state is too large", 413);

  const db = c.get("db");
  const existingRows = await db<PlaybackStateRow>`
    SELECT "id", "userId", "deviceId", "stateJson", "clientUpdatedAt", "createdAt", "updatedAt"
    FROM "PlaybackState"
    WHERE "userId" = ${user.id}
    LIMIT 1
  `;
  const existing = existingRows[0];
  const existingState = playbackStateFromRow(existing);
  if (existingState && existingState.updatedAt > state.updatedAt) {
    return c.json(
      { state: existingState },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (existing) {
    await db`
      UPDATE "PlaybackState"
      SET "deviceId" = ${state.deviceId}, "stateJson" = ${stateJson}, "clientUpdatedAt" = ${state.updatedAt}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${existing.id}
    `;
  } else {
    await db`
      INSERT INTO "PlaybackState" ("id", "userId", "deviceId", "stateJson", "clientUpdatedAt", "createdAt", "updatedAt")
      VALUES (${crypto.randomUUID()}, ${user.id}, ${state.deviceId}, ${stateJson}, ${state.updatedAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
  }

  return c.json(
    { state },
    { headers: { "cache-control": "no-store" } },
  );
});

function isDeviceLocalMediaUrl(value: string): boolean {
  // Browser-local uploads play from blob: URLs the server can't fetch, so a play
  // event that references one is rejected rather than recorded.
  return /^blob:/i.test(value);
}

export function playEventSongHasDeviceLocalUrl(song: Pick<PlayerSong, "audioUrl" | "imageUrl" | "lyricsUrl">): boolean {
  return [song.audioUrl, song.imageUrl, song.lyricsUrl].some((value) => !!value && isDeviceLocalMediaUrl(value));
}

type PlayEventMediaUrls = Pick<PlayerSong, "id" | "imageUrl" | "audioUrl" | "lyricsUrl">;
type PlayEventMediaRefreshItem = PlayEventMediaUrls & Pick<PlayerSong, "title" | "artist">;

export function mergeRefreshedPlayEventMediaUrls(
  songs: PlayerSong[],
  refreshed: PlayEventMediaUrls[],
): PlayerSong[] {
  const mediaById = new Map(refreshed.map((song) => [song.id, song] as const));
  return songs.map((song) => {
    const media = mediaById.get(song.id);
    if (!media) return song;
    return {
      ...song,
      imageUrl: media.imageUrl || song.imageUrl,
      audioUrl: media.audioUrl || song.audioUrl,
      lyricsUrl: media.lyricsUrl || undefined,
    };
  });
}

async function refreshPlayEventMediaUrls(
  c: Context<AppEnv>,
  user: AuthUser,
  songs: PlayerSong[],
): Promise<PlayerSong[]> {
  if (songs.length === 0 || !canUseMacMiniProxy(c.env)) return songs;

  const uniqueMedia = Array.from(
    new Map(
      songs.map((song) => [
        song.id,
        {
          id: song.id,
          title: song.title,
          artist: song.artist,
          imageUrl: song.imageUrl,
          audioUrl: song.audioUrl,
          lyricsUrl: song.lyricsUrl,
        } satisfies PlayEventMediaRefreshItem,
      ]),
    ).values(),
  );

  try {
    const response = await postJsonToMacMini(
      c,
      user,
      { songs: uniqueMedia },
      "/api/media/refresh",
    );
    if (!response.ok) return songs;
    const payload = (await response.json()) as { songs?: unknown };
    if (!Array.isArray(payload.songs)) return songs;
    const refreshed = (payload.songs as unknown[])
      .map((value) => {
        const item = toObject(value);
        if (!item) return null;
        const id = toStringValue(item.id);
        const imageUrl = toStringValue(item.imageUrl);
        const audioUrl = toStringValue(item.audioUrl);
        const lyricsUrl = toStringValue(item.lyricsUrl);
        if (!id || !imageUrl || !audioUrl) return null;
        const media: PlayEventMediaUrls = { id, imageUrl, audioUrl };
        if (lyricsUrl) media.lyricsUrl = lyricsUrl;
        return media;
      })
      .filter((item): item is PlayEventMediaUrls => item !== null);
    return mergeRefreshedPlayEventMediaUrls(songs, refreshed);
  } catch {
    // Listening history should remain available when the mini is temporarily
    // unreachable. CoverImage will use its normal placeholder for stale URLs.
    return songs;
  }
}

app.post("/api/play-events", async (c) => {
  const user = requireUser(c.get("user"));
  // The local-dev pseudo-user has no User row, so the FK insert would fail.
  if (user.id === LOCAL_MAC_MINI_AUTH_USER.id) return c.json({ ok: true }, 201);
  const payload = await readJson<{ song?: unknown; durationMs?: unknown }>(c.req.raw);
  const song = coercePlayerSongPayload(payload?.song);
  if (!song) return jsonError("Invalid song", 400);
  if (playEventSongHasDeviceLocalUrl(song)) return jsonError("Song references a device-local URL", 400);
  // Songs are stored as JSON snapshots (no FK to Song) because production song
  // ids live on the mac mini and do not exist in D1.
  const songJson = JSON.stringify(song);
  if (songJson.length > 512_000) return jsonError("Song payload is too large", 413);
  const durationMs = toNumberValue(payload?.durationMs);

  const db = c.get("db");
  // Opportunistically prune old events so the table cannot grow unbounded.
  await db`
    DELETE FROM "PlayEvent"
    WHERE "userId" = ${user.id} AND "createdAt" < datetime('now', '-180 days')
  `;
  await db`
    INSERT INTO "PlayEvent" ("id", "userId", "songId", "songJson", "durationMs")
    VALUES (${crypto.randomUUID()}, ${user.id}, ${song.id}, ${songJson}, ${durationMs})
  `;
  return c.json({ ok: true }, 201);
});

app.get("/api/stats/home", async (c) => {
  const user = requireUser(c.get("user"));
  if (user.id === LOCAL_MAC_MINI_AUTH_USER.id) {
    return jsonCached(c, { recentlyPlayed: [], mostPlayed: [] });
  }

  const db = c.get("db");
  // MAX("createdAt") in the SELECT makes SQLite pick songJson from the newest
  // row of each group (bare-column-with-MAX); do not simplify it away.
  const recentRows = await db<{ songId: string; songJson: string; lastPlayedAt: string }>`
    SELECT "songId", "songJson", MAX("createdAt") AS "lastPlayedAt"
    FROM "PlayEvent"
    WHERE "userId" = ${user.id}
    GROUP BY "songId"
    ORDER BY "lastPlayedAt" DESC
    LIMIT 20
  `;
  const topRows = await db<{ songId: string; songJson: string; playCount: number; lastPlayedAt: string }>`
    SELECT "songId", "songJson", COUNT(*) AS "playCount", MAX("createdAt") AS "lastPlayedAt"
    FROM "PlayEvent"
    WHERE "userId" = ${user.id}
    GROUP BY "songId"
    ORDER BY "playCount" DESC, "lastPlayedAt" DESC
    LIMIT 20
  `;

  const parsedRecentlyPlayed = recentRows
    .map((row) => parsePlayEventSongJson(row.songJson))
    .filter((song): song is PlayerSong => song !== null);
  const parsedMostPlayed = topRows
    .map((row) => {
      const song = parsePlayEventSongJson(row.songJson);
      return song ? { song, playCount: Number(row.playCount) || 0 } : null;
    })
    .filter((item): item is { song: PlayerSong; playCount: number } => item !== null);
  const refreshedSongs = await refreshPlayEventMediaUrls(c, user, [
    ...parsedRecentlyPlayed,
    ...parsedMostPlayed.map((item) => item.song),
  ]);
  const refreshedById = new Map(refreshedSongs.map((song) => [song.id, song] as const));
  const recentlyPlayed = parsedRecentlyPlayed.map((song) => refreshedById.get(song.id) ?? song);
  const mostPlayed = parsedMostPlayed.map((item) => ({
    ...item,
    song: refreshedById.get(item.song.id) ?? item.song,
  }));
  return jsonCached(c, { recentlyPlayed, mostPlayed });
});

// --- Live Events: Ticketmaster Discovery proxy ------------------------------
// Keeps the API key server-side (TICKETMASTER_API_KEY secret). Returns the same
// { sections } shape the mobile Live Events screen expects; on missing key/error
// it returns empty sections and the app falls back to its sample list.
type TicketmasterImage = { url: string; width?: number; ratio?: string };
type TicketmasterEvent = {
  id: string;
  name: string;
  url?: string;
  images?: TicketmasterImage[];
  dates?: { start?: { localDate?: string } };
  classifications?: { genre?: { name?: string } }[];
  _embedded?: {
    venues?: { name?: string; city?: { name?: string } }[];
    attractions?: { name?: string }[];
  };
};
type LiveEventDto = { id: string; artists: string; venue: string; date: string; imageUrl: string; url?: string; genre?: string };

function pickTicketmasterImage(images?: TicketmasterImage[]): string {
  if (!images || images.length === 0) return "";
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const wide = sorted.find((i) => (i.width ?? 0) >= 600 && (i.ratio === "16_9" || i.ratio === "4_3"));
  return (wide ?? sorted[0]).url;
}

// Ticketmaster lists promoters/series and ticket tiers as "attractions" (e.g.
// "American Express Presents BST Hyde Park", "OVO Arena Wembley - Premium
// Packages"). Drop them so card titles show the real acts.
const PROMOTER_NOISE = /\b(Presents|Premium Packages?|VIP Packages?|Hospitality)\b/i;

function mapTicketmasterEvent(ev: TicketmasterEvent): LiveEventDto | null {
  const date = ev.dates?.start?.localDate;
  if (!date) return null;
  const venue = ev._embedded?.venues ?? [];
  const venueLabel = [venue[0]?.name, venue[0]?.city?.name].filter(Boolean).join(", ");
  const attractions = (ev._embedded?.attractions ?? [])
    .map((a) => a.name)
    .filter((n): n is string => !!n && !PROMOTER_NOISE.test(n));
  const artists = attractions.length ? attractions.slice(0, 3).join(", ") : ev.name;
  const imageUrl = pickTicketmasterImage(ev.images);
  if (!imageUrl) return null;
  return {
    id: ev.id,
    artists,
    venue: venueLabel,
    date,
    imageUrl,
    url: ev.url,
    genre: ev.classifications?.[0]?.genre?.name,
  };
}

const artistKey = (e: LiveEventDto): string =>
  (e.artists.split(",")[0] || e.artists).trim().toLowerCase();

// Ticketmaster lists one event per tour date, so a multi-night stadium run
// (e.g. Harry Styles × 6 nights at Wembley) floods a section with the same
// lineup. Keep only the first card per artist so each row shows a variety of
// acts; the shared `seen` set also stops one act appearing in two sections.
function dedupeByArtist(events: LiveEventDto[], seen: Set<string>): LiveEventDto[] {
  return events.filter((e) => {
    const key = artistKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

app.get("/api/events", async (c) => {
  const apiKey = envString(c.env, "TICKETMASTER_API_KEY");
  if (!apiKey) return jsonCached(c, { sections: [] });

  const city = (new URL(c.req.url).searchParams.get("city") || "London").slice(0, 60);
  const startDateTime = `${new Date().toISOString().slice(0, 19)}Z`; // only upcoming events
  const base = "https://app.ticketmaster.com/discovery/v2/events.json";
  // Over-fetch (size=40) so per-artist dedup still leaves a full row of acts.
  const common = `apikey=${encodeURIComponent(apiKey)}&segmentName=Music&countryCode=GB&size=40&startDateTime=${startDateTime}&city=${encodeURIComponent(city)}`;

  const fetchEvents = async (extra: string): Promise<LiveEventDto[]> => {
    try {
      const res = await fetch(`${base}?${common}&${extra}`, { headers: { accept: "application/json" } });
      if (!res.ok) return [];
      const data = (await res.json()) as { _embedded?: { events?: TicketmasterEvent[] } };
      return (data._embedded?.events ?? []).map(mapTicketmasterEvent).filter((e): e is LiveEventDto => e !== null);
    } catch {
      return [];
    }
  };

  const [upcoming, popular] = await Promise.all([fetchEvents("sort=date,asc"), fetchEvents("sort=relevance,desc")]);
  // Cap each row at 12 distinct acts. Popular leads and is the canonical list
  // (first pick of acts); "Coming up" then excludes acts *visible* in Popular
  // — not its hidden tail — so a trending act soon on the calendar still leads.
  const popularDedup = dedupeByArtist(popular, new Set<string>()).slice(0, 12);
  const seen = new Set(popularDedup.map(artistKey));
  const upcomingDedup = dedupeByArtist(upcoming, seen).slice(0, 12);

  const sections: { key: string; eyebrow: string; title: string; events: LiveEventDto[] }[] = [];
  if (popularDedup.length) sections.push({ key: "popular", eyebrow: "What’s trending right now", title: `Popular in ${city}`, events: popularDedup });
  if (upcomingDedup.length) sections.push({ key: "upcoming", eyebrow: `More concerts in ${city}`, title: "Coming up", events: upcomingDedup });

  return jsonCached(c, { sections });
});

// Weekly listening stats (Spotify "Listening stats" screen): minutes listened,
// top artist, and top song per Monday-anchored week, aggregated from PlayEvent.
app.get("/api/stats/listening", async (c) => {
  const user = requireUser(c.get("user"));
  if (user.id === LOCAL_MAC_MINI_AUTH_USER.id) {
    return jsonCached(c, { weeks: [] });
  }
  const db = c.get("db");
  const WEEKS = 6;
  const rows = await db<{ songJson: string; createdAt: string; durationMs: number | null }>`
    SELECT "songJson", "createdAt", "durationMs"
    FROM "PlayEvent"
    WHERE "userId" = ${user.id} AND "createdAt" >= datetime('now', ${`-${WEEKS * 7} days`})
    ORDER BY "createdAt" DESC
  `;

  // Monday-anchored ISO date (YYYY-MM-DD) for a PlayEvent timestamp. createdAt is
  // SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC); normalize to ISO-UTC so
  // the worker runtime parses it as UTC rather than local time.
  const mondayOf = (raw: string): string => {
    let s = raw.includes("T") ? raw : raw.replace(" ", "T");
    if (!s.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(s)) s += "Z";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "";
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    return monday.toISOString().slice(0, 10);
  };

  type Bucket = {
    weekStart: string;
    seconds: number;
    songs: Map<string, { song: PlayerSong; count: number }>;
    artists: Map<string, { name: string; image: string | null; count: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const song = parsePlayEventSongJson(row.songJson);
    if (!song) continue;
    const wk = mondayOf(row.createdAt);
    if (!wk) continue;
    let b = buckets.get(wk);
    if (!b) {
      b = { weekStart: wk, seconds: 0, songs: new Map(), artists: new Map() };
      buckets.set(wk, b);
    }
    // Prefer the actual listened time (durationMs); fall back to the track length
    // (song.duration is in seconds) when an event predates duration reporting.
    const playedMs = Number(row.durationMs);
    b.seconds +=
      Number.isFinite(playedMs) && playedMs > 0
        ? playedMs / 1000
        : typeof song.duration === "number" && song.duration > 0
          ? song.duration
          : 0;
    const sEntry = b.songs.get(song.id);
    if (sEntry) sEntry.count += 1;
    else b.songs.set(song.id, { song, count: 1 });
    const artistName = (song.artist || "Unknown Artist").trim();
    const aEntry = b.artists.get(artistName);
    if (aEntry) aEntry.count += 1;
    else b.artists.set(artistName, { name: artistName, image: song.imageUrl ?? null, count: 1 });
  }

  const weeks = [...buckets.values()]
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
    .map((b) => {
      const topSong = [...b.songs.values()].sort((x, y) => y.count - x.count)[0]?.song ?? null;
      const topArtist = [...b.artists.values()].sort((x, y) => y.count - x.count)[0] ?? null;
      const start = new Date(`${b.weekStart}T00:00:00Z`);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      return {
        weekStart: b.weekStart,
        weekEnd: end.toISOString().slice(0, 10),
        minutesListened: Math.round(b.seconds / 60),
        topSong,
        topArtist: topArtist ? { name: topArtist.name, image: topArtist.image } : null,
      };
    });

  return jsonCached(c, { weeks });
});

app.get("/api/liked", async (c) => {
  const user = requireUser(c.get("user"));
  const rows = await listLikedSongs(c.get("db"), user.id);
  return jsonCached(c, { songs: rows.map(songToPlayerSong), likedSongIds: rows.map((row) => row.id) });
});

app.get("/api/playlist/:id", async (c) => {
  const id = c.req.param("id");

  // The Top 50 chart as an openable playlist (the Home "Top 50" card). Same data as
  // /api/discover/trending, shaped as a playlist of player songs so the detail
  // screen renders + plays it like any other playlist (lossless, via discover
  // staging). Public read-through (the global chart), before the auth gate.
  if (id === "discover-top50") {
    // Spotify and the mini staging manifest are independent reads. Start both
    // immediately so the 4s best-effort staging lookup never stacks on top of
    // the bounded Spotify page fetch.
    const [discover, stagedById] = await Promise.all([
      fetchTop50DiscoverTracks(c.env),
      readDiscoverStagingStatus(c.env, 4_000),
    ]);
    const tracks = applyDiscoverStaging(discover, stagedById);
    return jsonCached(
      c,
      {
        kind: "curated",
        playlist: {
          id,
          name: "Top 50",
          imageUrl: tracks[0]?.imageUrl || "",
          description: "The most-played tracks globally, refreshed daily.",
        },
        songs: tracks.map(discoverStagedToPlayerSong),
        likedSongIds: null,
      },
      { cacheControl: "private, max-age=30, stale-while-revalidate=300" },
    );
  }

  // A YouTube Music mix (the auto-updating "Discover Mix"). Fetched + shaped on the
  // mini (it has yt-dlp + the owner's Premium cookies); stream-only Opus preview.
  // The mini returns an already-playlist-shaped body — proxy it straight through.
  // Unlike discover-top50 (genuinely public: the global chart), this mix is the
  // OWNER's personalized recommendations and the
  // proxy fetches it AS the owner — so it MUST require an authenticated caller, else
  // any anonymous request would receive the owner's mix + replayable signed media.
  if (id.startsWith("yt-mix-")) {
    if (!c.get("user")) return jsonError("Unauthorized", 401);
    if (!isMacMiniMusicConfigured(c.env)) return jsonError("This mix isn't available", 503);
    const listId = id.slice("yt-mix-".length);
    const res = await macMiniDiscoverFetch(
      c.env,
      `/api/youtube/playlists/${encodeURIComponent(listId)}`,
      "GET",
      undefined,
      20_000,
    );
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  }

  const db = c.get("db");
  const user = c.get("user");
  if (!user) return jsonError("Unauthorized", 401);
  const playlists = await db<PlaylistRow & { source: string | null }>`
    SELECT "id", "name", "imageUrl", "userId", "createdAt", "source"
    FROM "Playlist"
    WHERE "id" = ${id}
    LIMIT 1
  `;
  const playlist = playlists[0];
  if (!playlist) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, playlist)) return jsonError("Forbidden", 403);
  // LEFT JOIN both Song and SongRef + COALESCE: converted folders + in-app adds
  // live in SongRef; any legacy native row lives in Song. Neither side silently
  // drops a track.
  const songRows = await db<SongRow & { order: number }>`
    SELECT
      COALESCE(s1."id", s2."id") AS "id",
      COALESCE(s1."title", s2."title") AS "title",
      COALESCE(s1."artist", s2."artist") AS "artist",
      COALESCE(s1."album", s2."album") AS "album",
      COALESCE(s1."duration", s2."duration") AS "duration",
      COALESCE(s1."imageUrl", s2."imageUrl") AS "imageUrl",
      COALESCE(s1."audioUrl", s2."audioUrl") AS "audioUrl",
      COALESCE(s1."lyricsUrl", s2."lyricsUrl") AS "lyricsUrl",
      COALESCE(s1."audioBitDepth", s2."audioBitDepth") AS "audioBitDepth",
      COALESCE(s1."audioSampleRate", s2."audioSampleRate") AS "audioSampleRate",
      COALESCE(s1."userId", s2."userId") AS "userId",
      COALESCE(s1."createdAt", s2."createdAt") AS "createdAt",
      ps."order" AS "order"
    FROM "PlaylistSong" ps
    LEFT JOIN "Song" s1 ON s1."id" = ps."songId"
    LEFT JOIN "SongRef" s2 ON s2."id" = ps."songId"
    WHERE ps."playlistId" = ${id}
      AND (s1."id" IS NOT NULL OR s2."id" IS NOT NULL)
    ORDER BY ps."order" ASC
  `;
  // The owner's local-server hearts live on the mini (the D1 Like table is empty
  // for them); native/uploaded-song hearts live in D1. Returning only one source
  // would make the client's non-additive merge wipe the other, so UNION them for
  // the owner. Non-owners just use their D1 likes.
  let likedSongIds: string[] | null;
  if (isLibraryOwner(c, user) && canUseMacMiniProxy(c.env)) {
    const miniLiked = await likedSongIdsForOwnerFromMini(c, user); // null = mini UNREACHABLE
    // Fail CLOSED: if the owner's mini like set is unreachable, return null (not
    // []) so the client SKIPS its non-additive merge and keeps existing hearts.
    // The songs still serve from D1, so the playlist loads — only the heart state
    // is deferred to the next successful liked/library load (must-fix #6).
    likedSongIds =
      miniLiked === null ? null : Array.from(new Set([...miniLiked, ...(await listLikedSongIds(db, user.id))]));
  } else {
    likedSongIds = await listLikedSongIds(db, user.id);
  }
  return jsonCached(c, {
    kind: "library",
    // editable=true: this detail came from D1 (a converted folder or native
    // playlist), so the app may rename / add / remove. Unconverted mini folders
    // are proxied straight to the mini and never reach here.
    playlist: { ...playlist, editable: true },
    songs: songRows.map(songToPlayerSong),
    likedSongIds,
  });
});

app.post("/api/songs/spotify/file", async (c) => {
  const user = requireUser(c.get("user"));
  const payload = await readJson<SongPayload>(c.req.raw);
  if (!payload) return jsonError("Invalid JSON body", 400);
  const resolved = await resolveStreamUrl(c.env, payload);
  const response = await fetchResolvedAudioDownloadForRequest(c, user, resolved);
  if (!response.ok || !response.body) throw new ApiError(`Audio server returned ${response.status}`, 502);
  const ext = extensionFromResponse(response, resolved.streamUrl);
  const title = sanitizeFileName(toStringValue(payload.title) || "Track");
  const artist = sanitizeFileName(toStringValue(payload.artist) || "Unknown Artist");
  const headers = new Headers();
  headers.set("content-type", response.headers.get("content-type") || resolved.contentType || "audio/flac");
  headers.set("content-disposition", `attachment; filename="${`${artist} - ${title}${ext}`.replaceAll('"', "'")}"`);
  const length = response.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(response.body, { headers });
});

app.post("/api/songs/spotify/batch", async (c) => {
  requireUser(c.get("user"));
  const payload = await readJson<BatchDownloadPayload>(c.req.raw);
  if (!payload) return jsonError("Invalid JSON body", 400);

  const spotifyUrl = toStringValue(payload.spotifyUrl);
  const urlType = determineSpotifyUrlType(spotifyUrl);

  if (!urlType) {
    return jsonError("Invalid Spotify URL. Must be a track, album, playlist, or Liked Songs URL.", 400);
  }

  const region = toStringValue(payload.region).toUpperCase() || "US";
  const outputFormat = toStringValue(payload.outputFormat).toLowerCase() as OutputFormat;
  const format = ["flac", "mp3", "aac", "ogg", "opus", "wav"].includes(outputFormat) ? outputFormat : "flac";
  const spotifyCookie = toStringValue(payload.spotifyCookie);

  let batchTracks: SpotifyBatchTrack[] = [];
  let batchTitle = "";
  let batchArtist = "";

  try {
    if (urlType === "track") {
      const trackId = parseSpotifyTrackId(spotifyUrl);
      if (!trackId) return jsonError("Invalid track ID", 400);
      const songLinkPayload = await resolveTrackPayload(trackId, region, envString(c.env, "SPOTIFY_SP_DC") || spotifyCookie);
      const metadata = await fetchEnhancedMetadata(trackId, songLinkPayload);
      batchTracks = [{
        id: trackId,
        name: metadata.title,
        artists: [metadata.artist],
        album: metadata.album,
        releaseDate: metadata.releaseDate,
        durationMs: metadata.duration ? metadata.duration * 1000 : 0,
      }];
      batchTitle = metadata.title;
      batchArtist = metadata.artist;
    } else if (urlType === "album") {
      const albumId = parseSpotifyAlbumId(spotifyUrl);
      if (!albumId) return jsonError("Invalid album ID", 400);
      const albumResult = await fetchPathfinderAlbumTracks(albumId, spotifyCookie || undefined).catch(async () => {
        const albumTracks = await fetchSpotifyAlbumTracks(albumId, spotifyCookie);
        return {
          title: albumTracks[0]?.name || "Unknown Album",
          artist: albumTracks[0]?.artists[0]?.name || "Unknown Artist",
          tracks: albumTracks.map((track) => ({
            id: track.id,
            name: track.name,
            artists: track.artists.map((artist) => artist.name),
            album: track.album,
            releaseDate: track.releaseDate,
            durationMs: track.durationMs,
            imageUrl: track.imageUrl,
          })),
        };
      });
      batchTracks = albumResult.tracks;
      batchTitle = albumResult.title;
      batchArtist = albumResult.artist;
    } else if (urlType === "playlist") {
      const playlistId = parseSpotifyPlaylistId(spotifyUrl);
      if (!playlistId) return jsonError("Invalid playlist ID", 400);
      const playlistResult = await fetchPathfinderPlaylistTracks(playlistId, spotifyCookie || undefined).catch(async () => {
        const playlistTracks = await fetchSpotifyPlaylistTracks(playlistId, spotifyCookie);
        return {
          title: "Playlist",
          tracks: playlistTracks.map((item) => ({
            id: item.track.id,
            name: item.track.name,
            artists: item.track.artists.map((artist) => artist.name),
            album: item.track.album,
            releaseDate: item.track.releaseDate,
            durationMs: item.track.durationMs,
            imageUrl: item.track.imageUrl,
          })),
        };
      });
      batchTracks = playlistResult.tracks;
      batchTitle = playlistResult.title;
      batchArtist = "Various Artists";
    } else if (urlType === "collection") {
      if (!spotifyCookie) {
        return jsonError(
          "Liked Songs import requires a Spotify sp_dc cookie.",
          400,
        );
      }
      const likedResult = await fetchSpotifyLikedTracks(spotifyCookie);
      batchTracks = likedResult.tracks;
      batchTitle = likedResult.title;
      batchArtist = "Various Artists";
    }

    batchTracks = dedupeBatchTracks(batchTracks);
    const trackIds = batchTracks.map((track) => track.id);

    if (trackIds.length === 0) {
      return jsonError("No tracks found", 404);
    }

    if (trackIds.length > 10_000) {
      return jsonError("Maximum 10,000 tracks per batch", 400);
    }

    return c.json({
      batchInfo: {
        type: urlType === "collection" ? "playlist" : urlType,
        title: batchTitle,
        artist: batchArtist,
        trackCount: trackIds.length,
        format,
        trackIds,
        tracks: batchTracks.map(batchTrackForResponse),
      },
      message: `Found ${trackIds.length} tracks. Click Download All to start.`,
    });

  } catch (error) {
    if (error instanceof SpotifyPathfinderError) {
      return jsonError(error.message, error.status);
    }
    // Don't echo internal error messages; match the global onError behavior.
    return jsonError("Failed to process batch", 500);
  }
});

app.post("/api/songs/spotify", async (c) => {
  requireUser(c.get("user"));
  const payloadRaw = await readJson<ActionPayload>(c.req.raw);
  const payload = toObject(payloadRaw) as ActionPayload | null;
  if (!payload) return jsonError("Invalid JSON body", 400);
  const action = toStringValue(payload.action).toLowerCase();
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl));
  if (!trackId) return jsonError("Invalid Spotify track URL or ID", 400);

  if (action === "lyrics") {
    let title = toStringValue(payload.title);
    let artist = toStringValue(payload.artist);
    if (!title || !artist) {
      const songLinkPayload = await resolveTrackPayload(
        trackId,
        toStringValue(payload.region).toUpperCase(),
        envString(c.env, "SPOTIFY_SP_DC"),
      );
      const metadata = parseSongLinkMetadata(songLinkPayload, trackId);
      title ||= metadata.title;
      artist ||= metadata.artist;
    }
    if (!title || !artist) return jsonError("Missing title/artist for lyrics lookup", 400);
    const lyrics = await fetchLyricsText(trackId, title, artist);
    if (!lyrics) return jsonError("Lyrics not found for this track", 404);
    return c.json({ lyrics, fileName: `${title} - ${artist}.lrc`.replace(/[\\/:*?"<>|]/g, "_") });
  }

  const songLinkPayload = await resolveTrackPayload(
    trackId,
    toStringValue(payload.region).toUpperCase(),
    envString(c.env, "SPOTIFY_SP_DC"),
  );
  const metadata = parseSongLinkMetadata(songLinkPayload, trackId);
  const deezerInfo = await fetchDeezerTrackInfo(parseDeezerTrackId(songLinkPayload));

  if (action === "availability") {
    const qobuz = await resolveQobuzAvailability({
      isrc: deezerInfo?.isrc || "",
      title: toStringValue(payload.title) || metadata.title,
      artist: toStringValue(payload.artist) || metadata.artist,
      album: toStringValue(payload.album) || deezerInfo?.album || "",
      credentials: qobuzCredentialsFromEnv(c.env),
    });
    const tidal = getPlatformLink(songLinkPayload, "tidal");
    return c.json({
      availability: {
        tidal: Boolean(tidal?.url),
        qobuz: qobuz.available,
        tidalUrl: tidal?.url || "",
        qobuzUrl: qobuz.qobuzUrl,
      },
    });
  }

  if (action !== "fetch") {
    return jsonError('Invalid action. Use "fetch", "availability", or "lyrics".', 400);
  }

  const qobuz = await resolveQobuzAvailability({
    isrc: deezerInfo?.isrc || "",
    title: toStringValue(payload.title) || metadata.title,
    artist: toStringValue(payload.artist) || metadata.artist,
    album: toStringValue(payload.album) || deezerInfo?.album || "",
    credentials: qobuzCredentialsFromEnv(c.env),
  });
  const tidal = getPlatformLink(songLinkPayload, "tidal");
  const previewUrl = await getPreviewUrl(trackId);
  return c.json({
    track: {
      spotifyId: trackId,
      title: metadata.title || "Unknown Title",
      artist: metadata.artist || "Unknown Artist",
      album: deezerInfo?.album || "",
      releaseDate: deezerInfo?.releaseDate || "",
      totalPlays: deezerInfo?.plays || 0,
      durationMs: (deezerInfo?.durationSec || 0) * 1000,
      imageUrl: metadata.imageUrl || deezerInfo?.coverUrl || "",
      previewUrl,
    },
    availability: {
      tidal: Boolean(tidal?.url),
      qobuz: qobuz.available,
      tidalUrl: tidal?.url || "",
      qobuzUrl: qobuz.qobuzUrl,
    },
  });
});

app.get("/api/songs", async (c) => {
  const user = c.get("user");
  return jsonCached(c, await listSongs(c.get("db"), user?.id ?? null));
});

app.post("/api/songs", async (c) => {
  const user = requireUser(c.get("user"));
  const db = c.get("db");
  const contentType = c.req.header("content-type") || "";
  let title: string;
  let artist: string;
  let album = "";
  let duration: number | null = null;
  let imageUrl: string;
  let audioUrl: string;
  let lyricsText = "";
  const audioBitDepth: number | null = null;
  const audioSampleRate: number | null = null;
  let replaceExisting = false;

  if (contentType.toLowerCase().startsWith("application/json")) {
    const payload = await readJson<SongPayload>(c.req.raw);
    if (!payload) return jsonError("Invalid JSON body", 400);
    replaceExisting = payload.replaceExisting === true || toStringValue(payload.replaceExisting).toLowerCase() === "true";
    assertServerImportOutputFormat(payload);
    title = toStringValue(payload.title);
    artist = toStringValue(payload.artist);
    album = toStringValue(payload.album);
    duration = durationSecondsFromPayload(payload);
    if (!title || !artist) return jsonError("Title and artist are required", 400);

    if (isMacMiniMusicConfigured(c.env)) {
      const isSpotifyImport = toStringValue(payload.mode).toLowerCase() === "spotify" || Boolean(toStringValue(payload.spotifyUrl));
      const remoteAudioUrl = toStringValue(payload.audioUrl);
      if (isSpotifyImport && wantsImportProgressStream(c)) {
        return streamMacMiniSpotifyImport(c, user, payload, { title, artist, album, duration, replaceExisting });
      }
      const resolved = isSpotifyImport ? await resolveStreamUrl(c.env, payload) : null;
      if (resolved) {
        const response = await fetchResolvedAudioDownloadForRequest(c, user, resolved);
        if (!response.ok || !response.body) throw new ApiError(`Audio server returned ${response.status}`, 502);
        return postAudioStreamToMacMini(
          c,
          user,
          payload,
          { title, artist, album, duration, replaceExisting },
          resolved,
          response,
        );
      }
      if (!remoteAudioUrl) return jsonError("Audio URL is required", 400);
      return postJsonToMacMini(c, user, {
        title,
        artist,
        album,
        durationMs: toNumberValue(payload.durationMs) ?? (duration ? duration * 1000 : undefined),
        imageUrl: toStringValue(payload.imageUrl),
        audioUrl: remoteAudioUrl,
        lyricsText: toStringValue(payload.lyricsText),
        replaceExisting,
      });
    }

    const duplicateRows = await db<{ id: string; title: string; artist: string }>`
      SELECT "id", "title", "artist"
      FROM "Song"
      WHERE "userId" = ${user.id}
        AND lower("title") = lower(${title})
        AND lower("artist") = lower(${artist})
      LIMIT 1
    `;
    if (duplicateRows[0] && !replaceExisting) {
      return c.json(
        { error: "Song already exists in your library", code: "DUPLICATE_SONG", existingSong: duplicateRows[0] },
        409,
      );
    }

    if (toStringValue(payload.mode).toLowerCase() === "spotify" || toStringValue(payload.spotifyUrl)) {
      const resolved = await resolveStreamUrl(c.env, payload);
      const response = await fetchResolvedAudioDownload(resolved);
      if (!response.ok || !response.body) throw new ApiError(`Audio server returned ${response.status}`, 502);
      const responseType = response.headers.get("content-type") || resolved.contentType || "audio/flac";
      const ext = extensionFromResponse(response, resolved.streamUrl);
      const audioKey = `${buildOrganizedMusicBasePath(title, artist)}/audio/${crypto.randomUUID()}${ext}`;
      await putStream(c.env, audioKey, response.body, responseType);
      audioUrl = toApiFileUrl(audioKey);
      imageUrl = await uploadRemoteCover(
        c.env,
        title,
        artist,
        toStringValue(payload.imageUrl) || coverUrlFromResolvedDownload(resolved),
      );
      lyricsText = toStringValue(payload.lyricsText) || lyricsTextFromResolvedDownload(resolved);
    } else {
      const remoteAudioUrl = toStringValue(payload.audioUrl);
      const remoteAudio = parseHttpUrl(remoteAudioUrl);
      if (!remoteAudio) return jsonError("Only valid http(s) audio URLs are allowed", 400);
      const response = await fetchWithTimeout(remoteAudio.toString(), DOWNLOAD_REQUEST_TIMEOUT_MS, {
        redirect: "manual",
      });
      if (!response.ok || !response.body) throw new ApiError(`Audio server returned ${response.status}`, 502);
      const responseType = response.headers.get("content-type") || "audio/flac";
      const responseMime = responseType.split(";")[0]?.trim().toLowerCase() || "";
      if (!AUDIO_MIME_TYPES.has(responseMime)) {
        return jsonError("Unsupported audio format", 415);
      }
      const remoteAudioLength = Number(response.headers.get("content-length") || "0");
      if (Number.isFinite(remoteAudioLength) && remoteAudioLength > MAX_AUDIO_BYTES) {
        return jsonError("Audio file is too large", 413);
      }
      const ext = extensionFromResponse(response, remoteAudio.toString());
      const audioKey = `${buildOrganizedMusicBasePath(title, artist)}/audio/${crypto.randomUUID()}${ext}`;
      await putStream(c.env, audioKey, response.body, responseType);
      audioUrl = toApiFileUrl(audioKey);
      imageUrl = await uploadRemoteCover(c.env, title, artist, toStringValue(payload.imageUrl));
      lyricsText = toStringValue(payload.lyricsText);
    }
  } else {
    const form = await c.req.formData();
    title = toStringValue(form.get("title"));
    artist = toStringValue(form.get("artist"));
    const image = form.get("image");
    const audio = form.get("audio");
    if (!title || !artist || !(image instanceof File) || !(audio instanceof File)) {
      return jsonError("Title, artist, image, and audio are required", 400);
    }
    if (image.size > MAX_IMAGE_BYTES) return jsonError("Image file is too large", 413);
    if (audio.size > MAX_AUDIO_BYTES) return jsonError("Audio file is too large", 413);
    const basePath = buildOrganizedMusicBasePath(title, artist);
    const imageExt = extensionForStoredFile("image", image.name, image.type);
    const audioExt = extensionForStoredFile("audio", audio.name, audio.type);
    const imageKey = `${basePath}/cover/${crypto.randomUUID()}${imageExt}`;
    const audioKey = `${basePath}/audio/${crypto.randomUUID()}${audioExt}`;
    await putBuffer(c.env, imageKey, await image.arrayBuffer(), image.type || inferContentTypeFromKey(imageKey));
    await putBuffer(c.env, audioKey, await audio.arrayBuffer(), audio.type || inferContentTypeFromKey(audioKey));
    imageUrl = toApiFileUrl(imageKey);
    audioUrl = toApiFileUrl(audioKey);
  }

  const existingRows = await db<{ id: string; title: string; artist: string }>`
    SELECT "id", "title", "artist"
    FROM "Song"
    WHERE "userId" = ${user.id}
      AND lower("title") = lower(${title})
      AND lower("artist") = lower(${artist})
    LIMIT 1
  `;
  const existingSong = existingRows[0] ?? null;
  if (existingSong && !replaceExisting) {
    return c.json(
      { error: "Song already exists in your library", code: "DUPLICATE_SONG", existingSong },
      409,
    );
  }

  const songId = existingSong?.id ?? crypto.randomUUID();
  const lyricsUrl = await storeLyrics(c.env, title, artist, songId, lyricsText);
  const rows = existingSong
    ? await db<SongRow>`
        UPDATE "Song"
        SET "title" = ${title}, "artist" = ${artist}, "album" = ${album || null}, "duration" = ${duration}, "imageUrl" = ${imageUrl}, "audioUrl" = ${audioUrl}, "lyricsUrl" = ${lyricsUrl}, "audioBitDepth" = ${audioBitDepth}, "audioSampleRate" = ${audioSampleRate}
        WHERE "id" = ${songId}
        RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
      `
    : await db<SongRow>`
        INSERT INTO "Song" ("id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId")
        VALUES (${songId}, ${title}, ${artist}, ${album || null}, ${duration}, ${imageUrl}, ${audioUrl}, ${lyricsUrl}, ${audioBitDepth}, ${audioSampleRate}, ${user.id})
        RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
      `;
  if (!existingSong) await likeSong(db, user.id, songId);
  return c.json(rows[0], existingSong ? 200 : 201);
});

app.get("/api/songs/:id", async (c) => {
  const user = requireUser(c.get("user"));
  const rows = await c.get("db")<SongRow>`
    SELECT "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
    FROM "Song"
    WHERE "id" = ${c.req.param("id")}
      AND "userId" = ${user.id}
    LIMIT 1
  `;
  if (!rows[0]) return jsonError("Song not found", 404);
  return jsonCached(c, songToPlayerSong(rows[0]));
});

app.patch("/api/songs/:id", async (c) => {
  const user = requireUser(c.get("user"));
  const payload = await readJson<{ title?: unknown; artist?: unknown }>(c.req.raw);
  const title = toStringValue(payload?.title);
  const artist = toStringValue(payload?.artist);
  if (!title || !artist) return jsonError("Title and artist are required", 400);
  const db = c.get("db");
  const existing = await db<{ id: string; userId: string }>`
    SELECT "id", "userId" FROM "Song" WHERE "id" = ${c.req.param("id")} LIMIT 1
  `;
  if (!existing[0]) return jsonError("Song not found", 404);
  if (existing[0].userId !== user.id) return jsonError("Forbidden", 403);
  const rows = await db<SongRow>`
    UPDATE "Song"
    SET "title" = ${title}, "artist" = ${artist}
    WHERE "id" = ${c.req.param("id")}
    RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
  `;
  return c.json(songToPlayerSong(rows[0]));
});

app.post("/api/songs/:id/assets", async (c) => {
  const user = requireUser(c.get("user"));
  const db = c.get("db");
  const songs = await db<{ id: string; title: string; artist: string; imageUrl: string; lyricsUrl: string | null; userId: string }>`
    SELECT "id", "title", "artist", "imageUrl", "lyricsUrl", "userId"
    FROM "Song"
    WHERE "id" = ${c.req.param("id")}
    LIMIT 1
  `;
  const song = songs[0];
  if (!song) return jsonError("Song not found", 404);
  if (song.userId !== user.id) return jsonError("Forbidden", 403);
  const form = await c.req.formData();
  const image = form.get("image");
  const lyricsFile = form.get("lyricsFile");
  const lyricsText = toStringValue(form.get("lyricsText"));
  let imageUrl = song.imageUrl;
  let lyricsUrl = song.lyricsUrl;
  const basePath = buildOrganizedMusicBasePath(song.title, song.artist);
  if (image instanceof File && image.size > 0) {
    if (image.size > MAX_IMAGE_BYTES) return jsonError("Image exceeds max upload size", 413);
    const imageExt = extensionForStoredFile("image", image.name, image.type);
    const imageKey = `${basePath}/cover/${song.id}-${crypto.randomUUID()}${imageExt}`;
    await putBuffer(c.env, imageKey, await image.arrayBuffer(), image.type || inferContentTypeFromKey(imageKey));
    imageUrl = toApiFileUrl(imageKey);
  }
  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    if (lyricsFile.size > MAX_LYRICS_BYTES) return jsonError("Lyrics file is too large", 413);
    const text = await lyricsFile.text();
    lyricsUrl = await storeLyrics(c.env, song.title, song.artist, song.id, text);
  } else if (lyricsText) {
    lyricsUrl = await storeLyrics(c.env, song.title, song.artist, song.id, lyricsText);
  }
  if (imageUrl === song.imageUrl && lyricsUrl === song.lyricsUrl) {
    return jsonError("Provide an image, lyrics file, or lyrics text", 400);
  }
  const rows = await db<SongRow>`
    UPDATE "Song"
    SET "imageUrl" = ${imageUrl}, "lyricsUrl" = ${lyricsUrl}
    WHERE "id" = ${song.id}
    RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
  `;
  return c.json(songToPlayerSong(rows[0]));
});

// Best-effort refresh of any D1 metadata copy of a local song after its file was
// replaced on the mini (id unchanged — pinned). Covers an editable-playlist
// SongRef / legacy Song row; a 0-row no-op when the owner's song lives only on the
// mini. Wrapped per-statement so a missing table/column can't fail the request.
async function refreshLocalSongRowAudio(db: SqlTag, userId: string, song: PlayerSong): Promise<void> {
  const audioUrl = song.audioUrl ?? "";
  const duration = song.duration ?? null;
  const imageUrl = song.imageUrl ?? "";
  const bitDepth = song.audioBitDepth ?? null;
  const sampleRate = song.audioSampleRate ?? null;
  try {
    await db`
      UPDATE "SongRef" SET "audioUrl" = ${audioUrl}, "duration" = ${duration}, "imageUrl" = ${imageUrl},
        "audioBitDepth" = ${bitDepth}, "audioSampleRate" = ${sampleRate}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${song.id} AND "userId" = ${userId}`;
  } catch {
    /* table/columns may not exist — ignore */
  }
  try {
    await db`
      UPDATE "Song" SET "audioUrl" = ${audioUrl}, "duration" = ${duration}, "imageUrl" = ${imageUrl},
        "audioBitDepth" = ${bitDepth}, "audioSampleRate" = ${sampleRate}
      WHERE "id" = ${song.id} AND "userId" = ${userId}`;
  } catch {
    /* ignore */
  }
}

// Refetch the correct (studio) version of a library song from YouTube as Opus and
// replace its file on the mini. The mini keeps the song's id stable (pinned
// sidecar) so the owner's like + playlist rows survive; the mini also enforces
// shared-library ownership (non-owners get 403). We just refresh any D1 copy.
app.post("/api/songs/:id/refetch-youtube", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  // Only mini library songs can be refetched (defense-in-depth: don't proxy junk to
  // the mini, and make the contract explicit alongside the mini's ownership check).
  if (!id.startsWith("local-server:")) return jsonError("This song can't be refetched", 400);
  const payload = await readJson<{ title?: unknown; artist?: unknown }>(c.req.raw);
  const headers = macMiniProxyHeaders(c, user);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  let res: Response;
  try {
    res = await fetch(
      new URL(`/api/songs/${encodeURIComponent(id)}/refetch-youtube`, getMacMiniOrigin(c.env)).toString(),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ title: toStringValue(payload?.title), artist: toStringValue(payload?.artist) }),
        signal: AbortSignal.timeout(150_000),
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return jsonError("The music server took too long to refetch this song", 504);
    }
    return jsonError("Couldn't reach the music server", 502);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return new Response(text || JSON.stringify({ error: "refetch_failed" }), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  let song: PlayerSong;
  try {
    song = JSON.parse(text) as PlayerSong;
  } catch {
    return jsonError("Malformed response from the music server", 502);
  }
  // The client swaps the live queue audio from this response — reject a structurally
  // invalid song rather than letting a silent no-op masquerade as success.
  if (!song || typeof song.id !== "string" || typeof song.audioUrl !== "string" || !song.audioUrl) {
    return jsonError("The music server returned an invalid song", 502);
  }
  await refreshLocalSongRowAudio(c.get("db"), user.id, song);
  return c.json(song);
});

app.get("/api/likes", async (c) => {
  const user = c.get("user");
  if (!user) return jsonCached(c, { likes: [], likedSongIds: [] });
  const likedSongIds = await listLikedSongIds(c.get("db"), user.id);
  return jsonCached(c, { likes: likedSongIds, likedSongIds });
});

app.post("/api/likes", async (c) => {
  const user = requireUser(c.get("user"));
  const payload = await readJson<{ songId?: unknown }>(c.req.raw);
  const songId = toStringValue(payload?.songId);
  if (!songId) return jsonError("Missing songId", 400);
  const song = await c.get("db")<{ id: string }>`
    SELECT "id" FROM "Song" WHERE "id" = ${songId} AND "userId" = ${user.id} LIMIT 1
  `;
  if (!song[0]) return jsonError("Song not found", 404);
  await likeSong(c.get("db"), user.id, songId);
  return c.json({ ok: true });
});

app.delete("/api/likes", async (c) => {
  const user = requireUser(c.get("user"));
  const payload = await readJson<{ songId?: unknown }>(c.req.raw);
  const songId = toStringValue(payload?.songId);
  if (!songId) return jsonError("Missing songId", 400);
  const song = await c.get("db")<{ id: string }>`
    SELECT "id" FROM "Song" WHERE "id" = ${songId} AND "userId" = ${user.id} LIMIT 1
  `;
  if (!song[0]) return jsonError("Song not found", 404);
  await ensureLegacyLikedSongsForUser(c.get("db"), user.id);
  await c.get("db")`
    DELETE FROM "Like"
    WHERE "userId" = ${user.id}
      AND "songId" = ${songId}
  `;
  return c.json({ ok: true });
});

app.post("/api/playlist/:id/reorder", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const playlistRows = await db<{ id: string; userId: string; source: string | null }>`
    SELECT "id", "userId", "source" FROM "Playlist" WHERE "id" = ${id} LIMIT 1
  `;
  const playlist = playlistRows[0];
  if (!playlist) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, playlist)) return jsonError("Forbidden", 403);
  const payload = await readJson<{ songIds?: unknown }>(c.req.raw);
  if (!Array.isArray(payload?.songIds)) return jsonError("songIds must be an array", 400);
  const requested = [...new Set(payload.songIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
  const existingRows = await db<{ songId: string; order: number }>`
    SELECT "songId", "order" FROM "PlaylistSong" WHERE "playlistId" = ${id} ORDER BY "order" ASC
  `;
  const existingIds = existingRows.map((row) => row.songId);
  const existingSet = new Set(existingIds);
  const orderedRequested = requested.filter((songId) => existingSet.has(songId));
  const requestedSet = new Set(orderedRequested);
  const finalOrder = [...orderedRequested, ...existingIds.filter((songId) => !requestedSet.has(songId))];
  if (finalOrder.length > 0) {
    const orderJson = JSON.stringify(finalOrder);
    await db`
      UPDATE "PlaylistSong"
      SET "order" = (
        SELECT key FROM json_each(${orderJson})
        WHERE value = "PlaylistSong"."songId"
      )
      WHERE "playlistId" = ${id}
        AND "songId" IN (SELECT value FROM json_each(${orderJson}))
    `;
  }
  return c.json({ ok: true, songIds: finalOrder });
});

// ---------------------------------------------------------------------------
// Editable playlists (convert-everything). All gated behind PLAYLISTS_EDITABLE
// so the worker ships dark until the seed has run + the app update is live.
// ---------------------------------------------------------------------------

function playlistsEditableEnabled(env: CloudflareEnv): boolean {
  const value = (env as unknown as Record<string, unknown>).PLAYLISTS_EDITABLE;
  return value === "1" || value === "true" || value === true;
}

// Mirror the mini's isLocalLibraryOwner (local-music-server.ts:1206) so the
// worker resolves "is this the library owner" identically: the local-preview
// sentinel, or a session user matched against the SPOTIFY_LIBRARY_OWNER_* env
// lists. Display names are deliberately excluded because they are mutable and
// non-unique. The production owner is a real D1 user
// with a UUID id — never the "local-mac-mini" sentinel — so every owner gate
// MUST go through here, not `user.id === LOCAL_MAC_MINI_AUTH_USER.id`.
function isLibraryOwner(c: Context<AppEnv>, user: AuthUser | null): boolean {
  if (!user) return false;
  if (user.id === LOCAL_MAC_MINI_AUTH_USER.id) return true;
  const ids = envStringList(c.env, "SPOTIFY_LIBRARY_OWNER_USER_IDS");
  const emails = envStringList(c.env, "SPOTIFY_LIBRARY_OWNER_EMAILS");
  const email = user.email?.trim().toLowerCase() ?? "";
  return (
    ids.some((value) => value.trim() === user.id) ||
    (!!email && emails.some((value) => value.trim().toLowerCase() === email))
  );
}

// A user owns a playlist if it's theirs by id, or it's an owner-owned folder
// conversion (source='local-folder') and they're the library owner — so the
// owner can always open/edit a converted folder regardless of which id seeded
// the row (real owner uuid in prod vs the local-preview sentinel).
function userOwnsPlaylist(
  c: Context<AppEnv>,
  user: AuthUser,
  row: { userId: string; source: string | null },
): boolean {
  if (row.userId === user.id) return true;
  return row.source === "local-folder" && isLibraryOwner(c, user);
}

// The mini derives a folder-playlist's membership from the first path segment of
// each song's localPath (its top-level music folder). Root-level songs (no "/")
// are not in any folder playlist.
function topLevelFolder(localPath: string | null | undefined): string | null {
  if (!localPath) return null;
  const slash = localPath.indexOf("/");
  return slash > 0 ? localPath.slice(0, slash) : null;
}

// Cached set of folder-playlist ids that are fully converted (source='local-folder'
// AND convertedAt set). TTL-cached so the routing gate doesn't pay a D1 round-trip
// per folder GET. On a D1 error it FAILS CLOSED — returns an EMPTY set so the
// routing gate proxies the folder to the mini (which still has the files) rather
// than serving a possibly-stale/empty D1 playlist (must-fix #7).
let convertedFolderCache: { ids: Set<string>; at: number } | null = null;
async function convertedFolderIds(env: CloudflareEnv): Promise<Set<string>> {
  const now = Date.now();
  if (convertedFolderCache && now - convertedFolderCache.at < 30_000) return convertedFolderCache.ids;
  try {
    const result = await env.DB.prepare(
      `SELECT "id" FROM "Playlist" WHERE "source" = 'local-folder' AND "convertedAt" IS NOT NULL`,
    ).all<{ id: string }>();
    const ids = new Set((result.results ?? []).map((row) => row.id));
    convertedFolderCache = { ids, at: now };
    return ids;
  } catch {
    return new Set();
  }
}

async function folderServesFromD1(env: CloudflareEnv, playlistId: string): Promise<boolean> {
  if (!playlistsEditableEnabled(env)) return false;
  return (await convertedFolderIds(env)).has(playlistId);
}

async function fetchMacMiniJson<T>(c: Context<AppEnv>, user: AuthUser, path: string): Promise<T | null> {
  try {
    const res = await fetch(new URL(path, getMacMiniOrigin(c.env)).toString(), {
      headers: macMiniProxyHeaders(c, user),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// The owner's likes live on the mini (the D1 Like table holds no local-server
// ids). Returning the empty D1 set would make the client's non-additive
// mergeInitial wipe every local-server heart, so source the owner's liked set
// from the mini for any D1 playlist detail read.
// Returns the owner's mini-side liked ids, or NULL when the mini's like set is
// UNREACHABLE (fetch failed / malformed). Null must be propagated as "unknown" —
// never collapsed to [] — so a transient mini outage can't make the client wipe
// every local-server heart via its non-additive merge (must-fix #6).
async function likedSongIdsForOwnerFromMini(c: Context<AppEnv>, user: AuthUser): Promise<string[] | null> {
  const data = await fetchMacMiniJson<{ likedSongIds?: unknown }>(c, user, "/api/liked");
  if (data == null || !Array.isArray(data.likedSongIds)) return null;
  return (data.likedSongIds as unknown[]).filter((id): id is string => typeof id === "string");
}

async function upsertSongRef(db: SqlTag, userId: string, song: PlayerSong): Promise<void> {
  await db`
    INSERT INTO "SongRef" (
      "id", "title", "artist", "album", "imageUrl", "audioUrl", "lyricsUrl",
      "duration", "audioBitDepth", "audioSampleRate", "localPath", "userId", "createdAt", "updatedAt"
    ) VALUES (
      ${song.id}, ${song.title}, ${song.artist}, ${song.album ?? null}, ${song.imageUrl ?? ""},
      ${song.audioUrl ?? ""}, ${song.lyricsUrl ?? null}, ${song.duration ?? null},
      ${song.audioBitDepth ?? null}, ${song.audioSampleRate ?? null}, ${song.localPath ?? null},
      ${userId}, ${song.createdAt ?? null}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("id") DO UPDATE SET
      "title" = excluded."title", "artist" = excluded."artist", "album" = excluded."album",
      "imageUrl" = excluded."imageUrl", "audioUrl" = excluded."audioUrl", "lyricsUrl" = excluded."lyricsUrl",
      "duration" = excluded."duration", "audioBitDepth" = excluded."audioBitDepth",
      "audioSampleRate" = excluded."audioSampleRate", "localPath" = excluded."localPath",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

// /api/library merge — when PLAYLISTS_EDITABLE is on, the existing /api/library
// route delegates here instead of returning D1-only (or proxying to the mini).
// Merge: D1 playlists (native + fully-converted folders) win; the owner's
// still-unconverted mini folders fill in. A half-written folder row (convertedAt
// NULL) is EXCLUDED so it can't shadow the mini's full copy with an empty tile.
// NOT a route (a second app.get for the same path is dead code in Hono).
async function handleLibraryMerge(c: Context<AppEnv>): Promise<Response> {
  const db = c.get("db");
  const user = c.get("user");
  if (!user) return jsonError("Unauthorized", 401);
  const d1Rows = await db<{
    id: string;
    name: string;
    imageUrl: string | null;
    userId: string;
    createdAt: string;
    songsCount: number;
    source: string | null;
  }>`
    SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", p."source", COUNT(ps."id") AS "songsCount"
    FROM "Playlist" p
    LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
    WHERE p."userId" = ${user.id}
      AND (p."source" IS NULL OR (p."source" = 'local-folder' AND p."convertedAt" IS NOT NULL))
    GROUP BY p."id", p."name", p."imageUrl", p."userId", p."createdAt", p."source"
    ORDER BY p."createdAt" DESC
  `;
  const coversByPlaylistId = await playlistCoverImageUrlsById(db, user.id);
  // editable=true marks a D1-backed playlist the app can add/remove/rename. The
  // mini's still-unconverted folders are read-only until the seed converts them.
  const d1Playlists = d1Rows.map((row) => {
    const songCoverImageUrls = coversByPlaylistId.get(row.id) ?? [];
    const coverImageUrls = row.imageUrl && row.source !== "local-folder" ? [] : songCoverImageUrls;
    return {
      id: row.id,
      name: row.name,
      imageUrl: row.imageUrl ?? songCoverImageUrls[0] ?? null,
      coverImageUrls,
      userId: row.userId,
      createdAt: row.createdAt,
      songsCount: Number(row.songsCount ?? 0),
      editable: true,
    };
  });
  const d1Ids = new Set(d1Playlists.map((p) => p.id));
  let miniPlaylists: typeof d1Playlists = [];
  if (isLibraryOwner(c, user) && canUseMacMiniProxy(c.env)) {
    // No query string forwarded: the merged mini set must be deterministic and
    // not vary with client sort/cache-bust params the worker's D1 read ignores.
    const data = await fetchMacMiniJson<{
      playlists?: Array<
        Omit<(typeof d1Playlists)[number], "editable" | "coverImageUrls"> & {
          coverImageUrls?: string[];
        }
      >;
    }>(
      c,
      user,
      "/api/library",
    );
    if (data?.playlists) {
      miniPlaylists = data.playlists
        .filter((p) => !d1Ids.has(p.id))
        .map((p) => ({
          ...p,
          coverImageUrls: Array.isArray(p.coverImageUrls)
            ? p.coverImageUrls.filter(Boolean).slice(0, 4)
            : p.imageUrl
              ? [p.imageUrl]
              : [],
          editable: false,
        }));
    }
  }
  const playlists = [...d1Playlists, ...miniPlaylists].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return c.json({ playlists, userId: user.id });
}

app.post("/api/playlists", async (c) => {
  const user = requireUser(c.get("user"));
  const body = await readJson<{ name?: unknown; imageUrl?: unknown }>(c.req.raw);
  const name = toStringValue(body?.name) || "New Playlist";
  const imageUrl = toStringValue(body?.imageUrl) || null;
  const id = crypto.randomUUID();
  const db = c.get("db");
  await db`
    INSERT INTO "Playlist" ("id", "name", "imageUrl", "userId", "createdAt")
    VALUES (${id}, ${name}, ${imageUrl}, ${user.id}, CURRENT_TIMESTAMP)
  `;
  return c.json({
    id,
    name,
    imageUrl,
    coverImageUrls: [],
    userId: user.id,
    createdAt: new Date().toISOString(),
    songsCount: 0,
  }, 201);
});

app.patch("/api/playlist/:id", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const rows = await db<{ userId: string; source: string | null }>`
    SELECT "userId", "source" FROM "Playlist" WHERE "id" = ${id} LIMIT 1
  `;
  if (!rows[0]) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, rows[0])) return jsonError("Forbidden", 403);
  const body = await readJson<{ name?: unknown; imageUrl?: unknown }>(c.req.raw);
  const name = toStringValue(body?.name);
  if (name) await db`UPDATE "Playlist" SET "name" = ${name} WHERE "id" = ${id}`;
  if (typeof body?.imageUrl === "string") {
    await db`UPDATE "Playlist" SET "imageUrl" = ${body.imageUrl} WHERE "id" = ${id}`;
  }
  return c.json({ ok: true });
});

app.delete("/api/playlist/:id", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const rows = await db<{ userId: string; source: string | null }>`
    SELECT "userId", "source" FROM "Playlist" WHERE "id" = ${id} LIMIT 1
  `;
  if (!rows[0]) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, rows[0])) return jsonError("Forbidden", 403);
  // A folder-backed playlist is still real files on the mini — deleting it in-app
  // must never delete those. Removing songs / renaming / reordering is allowed.
  if (rows[0].source === "local-folder") {
    return jsonError("Folder-backed playlists can't be deleted in-app", 400);
  }
  await db`DELETE FROM "PlaylistSong" WHERE "playlistId" = ${id}`;
  await db`DELETE FROM "Playlist" WHERE "id" = ${id}`;
  return c.json({ ok: true });
});

app.post("/api/playlist/:id/songs", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const rows = await db<{ userId: string; source: string | null }>`
    SELECT "userId", "source" FROM "Playlist" WHERE "id" = ${id} LIMIT 1
  `;
  if (!rows[0]) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, rows[0])) return jsonError("Forbidden", 403);
  const body = await readJson<{ song?: unknown; songId?: unknown }>(c.req.raw);
  const song = coercePlayerSongPayload(body?.song);
  // Defense-in-depth for the FLAC-only library invariant: a Discover / preview track
  // plays from the hidden `.discover` staging cache (a lossy YouTube-mix Opus, or a
  // chart track not yet promoted). It must be promoted via /api/discover/promote
  // before owning a library row — persisting a staging-path SongRef would put a lossy
  // reference in the library AND leave a dead entry once the cache is TTL-pruned. The
  // mobile add path promotes first; reject here in case any client doesn't.
  if (song && song.audioUrl.includes(".discover")) {
    return jsonError("Promote this track before adding it to a playlist", 409);
  }
  const songId = (song?.id || toStringValue(body?.songId)).trim();
  if (!songId) return jsonError("song or songId is required", 400);
  if (song) {
    await upsertSongRef(db, user.id, song);
  } else {
    // Add-by-id only: the detail read LEFT JOINs Song + SongRef and filters out
    // rows backed by neither, so a bare id that resolves nowhere would insert a
    // PlaylistSong that silently never appears. Reject it loudly instead of
    // succeeding-then-vanishing — callers must pass the full song object.
    const known = await db<{ id: string }>`
      SELECT "id" FROM "Song" WHERE "id" = ${songId}
      UNION ALL SELECT "id" FROM "SongRef" WHERE "id" = ${songId}
      LIMIT 1
    `;
    if (!known[0]) return jsonError("Unknown song — pass the full song object", 400);
  }
  // Race-safe append: MAX(order)+1 in one statement; idempotent on re-add.
  await db`
    INSERT INTO "PlaylistSong" ("id", "playlistId", "songId", "order")
    SELECT ${crypto.randomUUID()}, ${id}, ${songId}, COALESCE(MAX("order"), -1) + 1
    FROM "PlaylistSong" WHERE "playlistId" = ${id}
    ON CONFLICT ("playlistId", "songId") DO NOTHING
  `;
  return c.json({ ok: true });
});

app.delete("/api/playlist/:id/songs/:songId", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const songId = c.req.param("songId");
  const db = c.get("db");
  const rows = await db<{ userId: string; source: string | null }>`
    SELECT "userId", "source" FROM "Playlist" WHERE "id" = ${id} LIMIT 1
  `;
  if (!rows[0]) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, rows[0])) return jsonError("Forbidden", 403);
  await db`DELETE FROM "PlaylistSong" WHERE "playlistId" = ${id} AND "songId" = ${songId}`;
  return c.json({ ok: true });
});

// Owner-only, idempotent, re-runnable seed: mirror every mini folder playlist into
// editable D1 playlists. Membership stores the EXACT per-file song.id the mini
// serves today (NOT canonicalId) so no phone download is ever re-keyed, and one
// row per file (no canonical dedup) so a folder never shrinks.
app.post("/api/admin/convert-folders", async (c) => {
  const user = requireUser(c.get("user"));
  // Owner-only. Run this in PRODUCTION as the logged-in owner so Playlist.userId
  // is the owner's real D1 id (the detail read checks ownership against it).
  if (!isLibraryOwner(c, user)) return jsonError("Forbidden", 403);
  if (!canUseMacMiniProxy(c.env)) return jsonError("Mac mini not configured", 503);
  const db = c.get("db");
  const lib = await fetchMacMiniJson<{
    playlists?: { id: string; name: string; imageUrl?: string | null; createdAt?: string }[];
  }>(c, user, "/api/library");
  const songs = await fetchMacMiniJson<PlayerSong[]>(c, user, "/api/songs");
  if (!lib?.playlists || !Array.isArray(songs)) return jsonError("Mac mini read failed", 502);

  const folderById = new Map(lib.playlists.map((p) => [p.name, p] as const));
  // Group songs by their top-level folder, preserving the mini's (sorted) order so
  // PlaylistSong.order matches the mini's folder read exactly.
  const groups = new Map<string, PlayerSong[]>();
  for (const song of songs) {
    const folder = topLevelFolder(song.localPath);
    if (!folder) continue;
    const list = groups.get(folder);
    if (list) list.push(song);
    else groups.set(folder, [song]);
  }

  // Bound each D1 batch well under the 30s whole-batch cap. A folder under this
  // size rebuilds in ONE atomic batch; a larger one spans batches but still only
  // flips convertedAt in the FINAL batch, so a crash mid-rebuild leaves it
  // proxying to the mini (never an empty D1 playlist) and a re-run heals it.
  const SONG_CHUNK = 400;
  const songStatements = (id: string, song: PlayerSong, order: number) => [
    c.env.DB.prepare(
      `INSERT INTO "SongRef" ("id","title","artist","album","imageUrl","audioUrl","lyricsUrl","duration","audioBitDepth","audioSampleRate","localPath","userId","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT ("id") DO UPDATE SET "title"=excluded."title","artist"=excluded."artist","album"=excluded."album","imageUrl"=excluded."imageUrl","audioUrl"=excluded."audioUrl","lyricsUrl"=excluded."lyricsUrl","duration"=excluded."duration","audioBitDepth"=excluded."audioBitDepth","audioSampleRate"=excluded."audioSampleRate","localPath"=excluded."localPath","updatedAt"=CURRENT_TIMESTAMP`,
    ).bind(
      song.id,
      song.title,
      song.artist,
      song.album ?? null,
      song.imageUrl ?? "",
      song.audioUrl ?? "",
      song.lyricsUrl ?? null,
      song.duration ?? null,
      song.audioBitDepth ?? null,
      song.audioSampleRate ?? null,
      song.localPath ?? null,
      user.id,
      song.createdAt ?? null,
    ),
    c.env.DB.prepare(
      `INSERT INTO "PlaylistSong" ("id","playlistId","songId","order") VALUES (?,?,?,?)
       ON CONFLICT ("playlistId","songId") DO NOTHING`,
    ).bind(crypto.randomUUID(), id, song.id, order),
  ];

  const results: { id: string; name: string; count: number; expected: number; ok: boolean }[] = [];
  for (const [name, rawMembers] of groups) {
    const folder = folderById.get(name);
    if (!folder) continue; // not in the live library list (race) — re-run will catch it
    const id = folder.id;
    const now = new Date().toISOString();
    // Per-file ids are unique per file; dedupe defensively so `order` is
    // contiguous and the verify count matches the distinct membership.
    const seen = new Set<string>();
    const members = rawMembers.filter((song) => (seen.has(song.id) ? false : (seen.add(song.id), true)));
    const imageUrl = folder.imageUrl ?? members.find((s) => s.imageUrl)?.imageUrl ?? null;
    const createdAt = folder.createdAt ?? now;

    // Build the batches. Batch 0 resets the row + clears membership (convertedAt
    // NULL); song inserts chunk across batches; the LAST batch sets convertedAt.
    const head = [
      c.env.DB.prepare(`UPDATE "Playlist" SET "convertedAt" = NULL WHERE "id" = ?`).bind(id),
      c.env.DB
        .prepare(
          `INSERT INTO "Playlist" ("id","name","imageUrl","userId","createdAt","source","convertedAt")
           VALUES (?,?,?,?,?, 'local-folder', NULL)
           ON CONFLICT ("id") DO UPDATE SET "name"=excluded."name", "imageUrl"=excluded."imageUrl", "source"='local-folder', "convertedAt"=NULL`,
        )
        .bind(id, name, imageUrl, user.id, createdAt),
      c.env.DB.prepare(`DELETE FROM "PlaylistSong" WHERE "playlistId" = ?`).bind(id),
    ];
    const batches: ReturnType<typeof c.env.DB.prepare>[][] = [];
    for (let i = 0; i < Math.max(members.length, 1); i += SONG_CHUNK) {
      const statements = i === 0 ? head : [];
      members.slice(i, i + SONG_CHUNK).forEach((song, j) => statements.push(...songStatements(id, song, i + j)));
      batches.push(statements);
    }
    batches[batches.length - 1].push(
      c.env.DB.prepare(`UPDATE "Playlist" SET "convertedAt" = ? WHERE "id" = ?`).bind(now, id),
    );
    for (const statements of batches) await c.env.DB.batch(statements);

    const expected = members.length;
    const countRows = await db<{ n: number }>`SELECT COUNT(*) AS "n" FROM "PlaylistSong" WHERE "playlistId" = ${id}`;
    const count = Number(countRows[0]?.n ?? 0);
    results.push({ id, name, count, expected, ok: count === expected });
  }

  convertedFolderCache = null; // force the routing gate to re-read the new converted set
  const allOk = results.every((r) => r.ok);
  return c.json({ ok: allOk, converted: results.length, results }, allOk ? 200 : 207);
});

// Profile avatars are served without auth: plain <img> loads from the native
// app don't carry session cookies (only fetch/XHR go through the CapacitorHttp
// bridge), so an authenticated avatar can never render there. The random UUID
// filename keeps the URL unguessable.
function isProfileImageKey(key: string): boolean {
  return /^users\/[^/]+\/profile\/[^/]+$/.test(key);
}

app.get("/api/files/*", async (c) => {
  const key = normalizeStorageKey(parseStorageKeyFromApiPath(new URL(c.req.url).pathname));
  if (!isProfileImageKey(key)) {
    const user = requireUser(c.get("user"));
    if (!(await storageKeyBelongsToUser(c.get("db"), key, user.id))) {
      return jsonError("Not found", 404);
    }
  }
  const object = await c.env.MEDIA.head(key);
  if (!object) return jsonError("Not found", 404);
  const size = Number(object.size || 0);
  let contentType = object.httpMetadata?.contentType || inferContentTypeFromKey(key);
  let contentDisposition: string | null = null;
  if (isProfileImageKey(key)) {
    // The avatar path is unauthenticated and same-origin, so never trust stored
    // metadata: pin the type to a known image (from the sanitized extension) and
    // force anything else to download rather than render in the page.
    const derived = inferContentTypeFromKey(key).split(";")[0]?.trim().toLowerCase() || "";
    if (IMAGE_MIME_TYPES.has(derived)) {
      contentType = derived;
    } else {
      contentType = "application/octet-stream";
      contentDisposition = "attachment";
    }
  }
  const range = c.req.header("range");
  if (range) {
    const parsed = parseRangeHeader(range, size);
    if (!parsed) {
      const headers = new Headers({
        "Content-Range": `bytes */${size}`,
        "Accept-Ranges": "bytes",
      });
      applySecurityHeaders(headers);
      return new Response(null, { status: 416, headers });
    }
    const length = parsed.end - parsed.start + 1;
    const partial = await c.env.MEDIA.get(key, { range: { offset: parsed.start, length } });
    if (!partial?.body) return jsonError("Not found", 404);
    const headers = new Headers({
      "Content-Type": contentType,
      "Content-Length": String(length),
      "Content-Range": `bytes ${parsed.start}-${parsed.end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    if (contentDisposition) headers.set("Content-Disposition", contentDisposition);
    applySecurityHeaders(headers);
    return new Response(partial.body, { status: 206, headers });
  }
  const full = await c.env.MEDIA.get(key);
  if (!full?.body) return jsonError("Not found", 404);
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  if (contentDisposition) headers.set("Content-Disposition", contentDisposition);
  applySecurityHeaders(headers);
  return new Response(full.body, { headers });
});

app.get("/api/artwork/r2/*", async (c) => {
  const url = new URL(c.req.url);
  const key = normalizeStorageKey(parseStorageKeyFromPathSuffix(url.pathname.slice("/api/artwork/r2/".length)));
  const user = requireUser(c.get("user"));
  if (!(await storageKeyBelongsToUser(c.get("db"), key, user.id))) {
    return jsonError("Not found", 404);
  }
  const width = parseArtworkWidth(c.req.query("w"));
  const contentType = inferContentTypeFromKey(key).split(";")[0]?.trim() || "";
  if (!IMAGE_MIME_TYPES.has(contentType)) return jsonError("Unsupported artwork format", 415);

  const cacheKey = new Request(url.toString(), c.req.raw);
  const artworkCache = await caches.open("spotify-artwork-v1");
  const cached = await artworkCache.match(cacheKey).catch(() => undefined);
  if (cached) return cached;

  const object = await c.env.MEDIA.get(key);
  if (!object?.body) return jsonError("Not found", 404);

  try {
    const transformed = await c.env.IMAGES
      .input(object.body)
      .transform({ width, fit: "cover" })
      .output({ format: "image/webp", quality: 82, anim: false });
    const response = transformed.response();
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
    headers.set("Content-Type", transformed.contentType());
    const finalResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    await artworkCache.put(cacheKey, finalResponse.clone()).catch(() => undefined);
    return finalResponse;
  } catch {
    const fallback = await c.env.MEDIA.get(key);
    return new Response(fallback?.body ?? null, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  }
});

app.get("/api/artwork/*", (c) => c.redirect("/apple-icon.png", 302));

app.onError((error) => {
  if (error instanceof ApiError) {
    return jsonError(error.message, error.status);
  }
  console.error("[worker] unhandled error", error);
  return jsonError("Internal server error", 500);
});

app.all("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(assetResponse.headers);
  applySecurityHeaders(headers);
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
});

export default {
  fetch: app.fetch,
  // Cron Trigger (see wrangler.jsonc "triggers.crons"): keep the Discover
  // ".discover" staging cache filled + pruned. Runs with a real time budget,
  // unlike a request's post-response waitUntil (where slow resolution is killed).
  async scheduled(_event: unknown, env: CloudflareEnv, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    ctx.waitUntil(runDiscoverFill(env).catch(() => {}));
  },
};
