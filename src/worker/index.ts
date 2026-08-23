import { Hono, type Context } from "hono";
import { extname } from "node:path";
import { D1_SCHEMA_STATEMENTS } from "@/lib/db-schema";
import type { PlaybackStateRow, PlaylistRow, SongRow } from "@/lib/db-types";
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
import { sniffUploadMediaBytes } from "@/lib/upload-media-sniff";
import { canonicalizeLocalMediaUrl } from "@/lib/local-media-signing";
import {
  isLegacyPublicProfilePath,
  isWorkersDevHost,
} from "@/lib/private-web-surface";
import type { PlayerSong } from "@/types/player";
import { resolveQobuzAvailability } from "@/lib/qobuz-download";
import {
  SpotifyPathfinderError,
  fetchSpotifyArtistCatalog,
  fetchSpotifyAlbumTracks as fetchPathfinderAlbumTracks,
  fetchSpotifyLikedTracks,
  fetchSpotifyPlaylistCatalogPage,
  fetchSpotifyPlaylistTracks as fetchPathfinderPlaylistTracks,
  isSpotifyCatalogId,
  searchSpotifyCatalog,
  searchSpotifyTrackId,
  type SpotifyCatalogArtist,
  type SpotifyCatalogPlaylist,
  type SpotifyBatchTrack,
} from "@/lib/spotify-pathfinder";
import { fetchLastFmSimilarTracks } from "@/lib/recommendations";
import { normalizeSongPart } from "@/lib/song-dedupe";
import {
  LEGACY_LIBRARY_LIST_LIMIT,
  decodeCreatedAtIdCursor,
  decodeOrderIdCursor,
  decodeTitleIdCursor,
  encodeCreatedAtIdCursor,
  encodeTitleIdCursor,
  parsePageLimit,
  wantsLibraryPage,
} from "../../packages/shared/src/cursor-page";
import {
  escapeLikePattern,
  normalizeLibrarySearchQuery,
} from "../../packages/shared/src/library-search";
import { createStreamingMultipartBody } from "./streaming-multipart";
import {
  canUseMacMiniProxy,
  fetchMacMini,
  isLocalPreviewHost,
  isMacMiniMusicConfigured,
  shouldForwardMacMiniUserForPathname,
  shouldProxyMusicPathnameToMacMini,
} from "./mac-mini-proxy";
import {
  mergeRefreshedPlayEventMediaUrls,
  playEventSongHasDeviceLocalUrl,
  type PlayEventMediaUrls,
} from "./play-events";
import { corsAllowOrigin, withSecurityHeaders } from "./security-headers";
import {
  parseYouTubePlaylistSearchPayload,
  type YouTubeCatalogPlaylist,
} from "./youtube-catalog";
import { LOCAL_MAC_MINI_AUTH_USER, type AppEnv, type AuthUser } from "./env";
import { ApiError, jsonCached, jsonError, requireUser } from "./http";
import { IMAGE_MIME_TYPES, registerR2MediaRoutes } from "./r2-media";
import { toApiFileUrl } from "./storage-urls";
import { getCurrentUser, registerAuthRoutes } from "./auth";
import {
  folderServesFromD1,
  isLibraryOwner,
  likedSongIdsForOwnerFromMini,
  listPlaylistSongs,
  listPlaylistSongsPage,
  localMediaUrlSignerFor,
  playlistsEditableEnabled,
  registerPlaylistRoutes,
  signPlaylistArtwork,
  signSongRowMedia,
  userOwnsPlaylist,
} from "./playlists";
import { coercePlayerSongPayload } from "./player-payload";
import { readJson } from "./request";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_LYRICS_BYTES,
  buildOrganizedMusicBasePath,
  putBuffer,
  putStream,
  sanitizeFileName,
} from "./r2-put";
import { envString, toNumberValue, toObject, toStringValue } from "./values";
import {
  DOWNLOAD_REQUEST_TIMEOUT_MS,
  SPOTIFY_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  parseHttpUrl,
  withProviderDeadline,
} from "./fetch";
import {
  type ActionPayload,
  type BatchDownloadPayload,
  type OutputFormat,
  type SongPayload,
  assertServerImportOutputFormat,
  durationSecondsFromPayload,
} from "./payloads";
import {
  type ResolvedAudioDownload,
  type ResolvedAudioDownloadCandidate,
  batchTrackForResponse,
  dedupeBatchTracks,
  determineSpotifyUrlType,
  fetchDeezerTrackInfo,
  fetchEnhancedMetadata,
  fetchLyricsText,
  fetchResolvedAudioDownload,
  fetchResolvedAudioDownloadCandidate,
  fetchSpotifyAlbumTracks,
  fetchSpotifyPlaylistTracks,
  getPlatformLink,
  getPreviewUrl,
  parseDeezerTrackId,
  parseSongLinkMetadata,
  parseSpotifyAlbumId,
  parseSpotifyPlaylistId,
  parseSpotifyTrackId,
  qobuzCredentialsFromEnv,
  resolveStreamUrl,
  resolveTrackPayload,
  validateMinimumQualityResponse,
} from "./provider-download";
import {
  type DiscoverStagedTrack,
  type DiscoverTrendingTrack,
  applyDiscoverStaging,
  discoverStagedToPlayerSong,
  fetchTop50DiscoverTracks,
  macMiniDiscoverFetch,
  markDiscoverStaged,
  readDiscoverStagingStatus,
  registerDiscoverRoutes,
  runDiscoverFill,
} from "./discover";

export { mergeRefreshedPlayEventMediaUrls, playEventSongHasDeviceLocalUrl } from "./play-events";
export { withSecurityHeaders } from "./security-headers";
export { parseYouTubePlaylistSearchPayload } from "./youtube-catalog";
export {
  isSpotiflacCommunityCooldownError,
  parseSpotiflacStatusPayload,
  shouldFallbackLicensedSourceToMacMini,
  spotiflacEndpointIsDown,
  spotiflacStatusKeyForEndpoint,
} from "./provider-download";

type PlaybackStateWritePayload = {
  state?: unknown;
};

const AUDIO_EXT_TYPES = new Map<string, string>([
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp4", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mpeg", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

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
      ON CONFLICT ("id") DO UPDATE SET
        "email" = excluded."email",
        "name" = excluded."name",
        "image" = excluded."image"
    `;
  })().catch((error) => {
    localOwnerUserPromise = null;
    throw error;
  });
  await localOwnerUserPromise;
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
      'ALTER TABLE "Playlist" ADD COLUMN "deletedAt" TEXT',
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

function requirePlaybackStateUser(c: Context<AppEnv>): AuthUser {
  return requireUser(c.get("user") ?? getLocalMacMiniAuthUser(c));
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

async function listSongsPage(
  db: SqlTag,
  userId: string | null,
  options: { limit: number; cursor: { title: string; id: string } | null },
): Promise<{ rows: SongRow[]; nextCursor: string | null }> {
  if (!userId) return { rows: [], nextCursor: null };
  const fetchCount = options.limit + 1;
  const rows = options.cursor
    ? await db<SongRow>`
        SELECT "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
        FROM "Song"
        WHERE "userId" = ${userId}
          AND ("title" > ${options.cursor.title} OR ("title" = ${options.cursor.title} AND "id" > ${options.cursor.id}))
        ORDER BY "title" ASC, "id" ASC
        LIMIT ${fetchCount}
      `
    : await db<SongRow>`
        SELECT "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
        FROM "Song"
        WHERE "userId" = ${userId}
        ORDER BY "title" ASC, "id" ASC
        LIMIT ${fetchCount}
      `;
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? encodeTitleIdCursor(last.title, last.id) : null,
  };
}

async function listSongs(db: SqlTag, userId: string | null) {
  const { rows } = await listSongsPage(db, userId, { limit: LEGACY_LIBRARY_LIST_LIMIT, cursor: null });
  return rows;
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

async function listSearchSongsPage(
  db: SqlTag,
  userId: string | null,
  options: { limit: number; cursor: { createdAt: string; id: string } | null; query: string },
): Promise<{ songs: PlayerSong[]; nextCursor: string | null }> {
  if (!userId) return { songs: [], nextCursor: null };
  const fetchCount = options.limit + 1;
  const needle = normalizeLibrarySearchQuery(options.query);
  const pattern = needle ? `%${escapeLikePattern(needle)}%` : null;
  const rows = pattern
    ? options.cursor
      ? await db<Pick<SongRow, "id" | "title" | "artist" | "imageUrl" | "audioUrl" | "createdAt">>`
          SELECT "id", "title", "artist", "imageUrl", "audioUrl", "createdAt"
          FROM "Song"
          WHERE "userId" = ${userId}
            AND (LOWER("title") LIKE ${pattern} ESCAPE '\' OR LOWER("artist") LIKE ${pattern} ESCAPE '\')
            AND ("createdAt" < ${options.cursor.createdAt} OR ("createdAt" = ${options.cursor.createdAt} AND "id" < ${options.cursor.id}))
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT ${fetchCount}
        `
      : await db<Pick<SongRow, "id" | "title" | "artist" | "imageUrl" | "audioUrl" | "createdAt">>`
          SELECT "id", "title", "artist", "imageUrl", "audioUrl", "createdAt"
          FROM "Song"
          WHERE "userId" = ${userId}
            AND (LOWER("title") LIKE ${pattern} ESCAPE '\' OR LOWER("artist") LIKE ${pattern} ESCAPE '\')
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT ${fetchCount}
        `
    : options.cursor
      ? await db<Pick<SongRow, "id" | "title" | "artist" | "imageUrl" | "audioUrl" | "createdAt">>`
          SELECT "id", "title", "artist", "imageUrl", "audioUrl", "createdAt"
          FROM "Song"
          WHERE "userId" = ${userId}
            AND ("createdAt" < ${options.cursor.createdAt} OR ("createdAt" = ${options.cursor.createdAt} AND "id" < ${options.cursor.id}))
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT ${fetchCount}
        `
      : await db<Pick<SongRow, "id" | "title" | "artist" | "imageUrl" | "audioUrl" | "createdAt">>`
          SELECT "id", "title", "artist", "imageUrl", "audioUrl", "createdAt"
          FROM "Song"
          WHERE "userId" = ${userId}
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT ${fetchCount}
        `;
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    songs: page.map((row) =>
      songToPlayerSong({
        ...row,
        album: null,
        duration: null,
        lyricsUrl: null,
        audioBitDepth: null,
        audioSampleRate: null,
        userId: "",
      } as SongRow),
    ),
    nextCursor: hasMore && last ? encodeCreatedAtIdCursor(String(last.createdAt), last.id) : null,
  };
}

async function listSearchSongs(db: SqlTag, userId: string | null, query = "") {
  const { songs } = await listSearchSongsPage(db, userId, {
    limit: LEGACY_LIBRARY_LIST_LIMIT,
    cursor: null,
    query,
  });
  return songs;
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

function shouldProxyMusicRequest(c: Context<AppEnv>): boolean {
  if (!canUseMacMiniProxy(c.env)) return false;
  return shouldProxyMusicPathnameToMacMini(macMiniProxyPathname(c), c.req.method, c.req.header("content-type") || "");
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

async function proxyToMacMini(c: Context<AppEnv>, user: AuthUser | null): Promise<Response> {
  const sourceUrl = new URL(c.req.url);
  const method = c.req.method.toUpperCase();
  return fetchMacMini({
    env: c.env,
    target: `${sourceUrl.pathname}${sourceUrl.search}`,
    method,
    user,
    headers: c.req.raw.headers,
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
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  return fetchMacMini({
    env: c.env,
    target: path,
    method: "POST",
    user,
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
  return fetchMacMini({
    env: c.env,
    target: "/api/songs",
    method: "POST",
    user,
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
  const headers = new Headers({
    accept: "audio/*,*/*",
    "content-type": "application/json",
  });
  return fetchMacMini({
    env: c.env,
    target: "/api/licensed-source/materialize",
    method: "POST",
    user,
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

const AUTH_OPEN_API_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/page-gate",
  "/api/auth/signin",
  "/api/auth/signout",
  "/api/auth/resend-verification",
  // Kept open only so anonymous callers get an explicit 403 instead of 401.
  "/api/register",
]);

// Native image views do not send the session cookie used by fetch/XHR. Keep
// only the unguessable, image-only profile object shape open; every other R2
// path still reaches the authenticated ownership check in r2-media.
const PUBLIC_PROFILE_IMAGE_API_PATH =
  /^\/api\/files\/users\/[a-zA-Z0-9._-]+\/profile\/[a-zA-Z0-9._-]+\.(?:jpe?g|png|gif|webp)$/i;

export function isAuthOpenApiPath(pathname: string): boolean {
  if (AUTH_OPEN_API_PATHS.has(pathname)) return true;
  if (PUBLIC_PROFILE_IMAGE_API_PATH.test(pathname)) return true;
  return pathname.startsWith("/api/auth/verify/");
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

registerAuthRoutes(app);
registerPlaylistRoutes(app);
registerDiscoverRoutes(app);

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
  const url = new URL(c.req.url);
  const query = normalizeLibrarySearchQuery(url.searchParams.get("q") || "");
  if (!wantsLibraryPage(url.searchParams)) {
    return jsonCached(c, { songs: await listSearchSongs(c.get("db"), user?.id ?? null, query) }, {
      cacheControl: "private, max-age=300, stale-while-revalidate=600",
    });
  }
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? decodeCreatedAtIdCursor(rawCursor) : null;
  if (rawCursor && !cursor) return jsonError("Invalid cursor", 400);
  const page = await listSearchSongsPage(c.get("db"), user?.id ?? null, {
    limit: parsePageLimit(url.searchParams.get("limit")),
    cursor,
    query,
  });
  return jsonCached(c, { songs: page.songs, nextCursor: page.nextCursor }, {
    cacheControl: "private, max-age=300, stale-while-revalidate=600",
  });
});

type CatalogProviderStatus = {
  spotify: "ok" | "unavailable";
  youtube: "ok" | "not_configured" | "unavailable";
};
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

type PlayEventMediaRefreshItem = PlayEventMediaUrls & Pick<PlayerSong, "title" | "artist">;

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
    LIMIT 20000
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
    WHERE "id" = ${id} AND "deletedAt" IS NULL
    LIMIT 1
  `;
  const playlist = playlists[0];
  if (!playlist) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, playlist)) return jsonError("Forbidden", 403);
  const url = new URL(c.req.url);
  const paged = wantsLibraryPage(url.searchParams);
  let songRows: Array<SongRow & { order: number }>;
  let nextCursor: string | null = null;
  if (paged) {
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor ? decodeOrderIdCursor(rawCursor) : null;
    if (rawCursor && !cursor) return jsonError("Invalid cursor", 400);
    const page = await listPlaylistSongsPage(db, id, {
      limit: parsePageLimit(url.searchParams.get("limit")),
      cursor,
    });
    songRows = page.rows;
    nextCursor = page.nextCursor;
  } else {
    songRows = await listPlaylistSongs(db, id);
  }
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
  const signMediaUrl = await localMediaUrlSignerFor(c, user);
  // Sign the raw D1 values before songToPlayerSong sees them. That normalizer
  // deliberately decodes unsigned /api/files paths, which would alter the
  // percent-encoded pathname covered by the mini's HMAC.
  const signedSongRows = await Promise.all(songRows.map((row) => signSongRowMedia(signMediaUrl, row)));
  const rawCoverImageUrls = Array.from(
    new Set(songRows.map((song) => song.imageUrl).filter(Boolean)),
  ).slice(0, 4);
  const signedPlaylist = await signPlaylistArtwork(signMediaUrl, {
    ...playlist,
    imageUrl: playlist.imageUrl ?? rawCoverImageUrls[0] ?? null,
    coverImageUrls: rawCoverImageUrls,
  });
  return jsonCached(c, {
    kind: "library",
    // editable=true: this detail came from D1 (a converted folder or native
    // playlist), so the app may rename / add / remove. Unconverted mini folders
    // are proxied straight to the mini and never reach here.
    playlist: { ...signedPlaylist, editable: true, deletable: true },
    songs: signedSongRows.map(songToPlayerSong),
    likedSongIds,
    ...(paged ? { nextCursor } : {}),
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
  const url = new URL(c.req.url);
  if (!wantsLibraryPage(url.searchParams)) {
    return jsonCached(c, await listSongs(c.get("db"), user?.id ?? null));
  }
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? decodeTitleIdCursor(rawCursor) : null;
  if (rawCursor && !cursor) return jsonError("Invalid cursor", 400);
  const page = await listSongsPage(c.get("db"), user?.id ?? null, {
    limit: parsePageLimit(url.searchParams.get("limit")),
    cursor,
  });
  return jsonCached(c, { songs: page.rows, nextCursor: page.nextCursor });
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
    const imageBytes = await image.arrayBuffer();
    const audioBytes = await audio.arrayBuffer();
    const sniffedImage = sniffUploadMediaBytes(new Uint8Array(imageBytes));
    const sniffedAudio = sniffUploadMediaBytes(new Uint8Array(audioBytes));
    if (!sniffedImage || sniffedImage.kind !== "image") return jsonError("Unsupported image content", 415);
    if (!sniffedAudio || sniffedAudio.kind !== "audio") return jsonError("Unsupported audio content", 415);
    const basePath = buildOrganizedMusicBasePath(title, artist);
    const imageExt = sniffedImage.extension;
    const audioExt = sniffedAudio.extension;
    const imageKey = `${basePath}/cover/${crypto.randomUUID()}${imageExt}`;
    const audioKey = `${basePath}/audio/${crypto.randomUUID()}${audioExt}`;
    await putBuffer(c.env, imageKey, imageBytes, sniffedImage.contentType);
    await putBuffer(c.env, audioKey, audioBytes, sniffedAudio.contentType);
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
    const imageBytes = await image.arrayBuffer();
    const sniffedImage = sniffUploadMediaBytes(new Uint8Array(imageBytes));
    if (!sniffedImage || sniffedImage.kind !== "image") return jsonError("Unsupported image content", 415);
    const imageExt = sniffedImage.extension;
    const imageKey = `${basePath}/cover/${song.id}-${crypto.randomUUID()}${imageExt}`;
    await putBuffer(c.env, imageKey, imageBytes, sniffedImage.contentType);
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
  const audioUrl = canonicalizeLocalMediaUrl(song.audioUrl ?? "");
  const duration = song.duration ?? null;
  const imageUrl = canonicalizeLocalMediaUrl(song.imageUrl ?? "");
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
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  let res: Response;
  try {
    res = await fetchMacMini({
      env: c.env,
      target: `/api/songs/${encodeURIComponent(id)}/refetch-youtube`,
      method: "POST",
      user,
      headers,
      body: JSON.stringify({ title: toStringValue(payload?.title), artist: toStringValue(payload?.artist) }),
      signal: AbortSignal.timeout(150_000),
    });
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

registerR2MediaRoutes(app);

app.get("/api/artwork/*", (c) => c.redirect("/apple-icon.png", 302));

app.all("/api", () => jsonError("Not found", 404));
app.all("/api/*", () => jsonError("Not found", 404));

app.all("*", async (c) => {
  const url = new URL(c.req.url);
  if (isLegacyPublicProfilePath(url.pathname) || isWorkersDevHost(url.hostname)) {
    return jsonError("Not found", 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error) => {
  if (error instanceof ApiError) {
    return jsonError(error.message, error.status);
  }
  console.error("[worker] unhandled error", error);
  return jsonError("Internal server error", 500);
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
