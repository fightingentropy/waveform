import type { Hono, Context } from "hono";
import {
  canonicalizeLocalMediaUrl,
  coarseLocalMediaExpiry,
  createLocalMediaUrlSigner,
} from "@/lib/local-media-signing";
import type { PlaylistRow, SongRow } from "@/lib/db-types";
import type { SqlTag } from "@/lib/sql-tag";
import type { PlayerSong } from "@/types/player";
import {
  LEGACY_LIBRARY_LIST_LIMIT,
  encodeOrderIdCursor,
} from "../../packages/shared/src/cursor-page";
import { LOCAL_MAC_MINI_AUTH_USER, type AppEnv, type AuthUser } from "./env";
import { ApiError, jsonCached, jsonError, requireUser } from "./http";
import {
  canUseMacMiniProxy,
  fetchMacMini,
  getMacMiniMediaSigningSecret,
} from "./mac-mini-proxy";
import { coercePlayerSongPayload } from "./player-payload";
import { readJson } from "./request";
import { envStringList, toStringValue } from "./values";

export async function playlistCoverImageUrlsById(db: SqlTag, userId: string): Promise<Map<string, string[]>> {
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
        AND p."deletedAt" IS NULL
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

export async function listPlaylists(db: SqlTag, userId: string | null) {
  if (!userId) return [];
  const rows = await db<PlaylistRow & { songsCount: number; source: string | null }>`
    SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", p."source", COUNT(ps."id") AS "songsCount"
    FROM "Playlist" p
    LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
    WHERE p."userId" = ${userId}
      AND p."deletedAt" IS NULL
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
      editable: true,
      deletable: true,
    };
  });
}


export async function listPlaylistSongsPage(
  db: SqlTag,
  playlistId: string,
  options: { limit: number; cursor: { order: number; id: string } | null },
): Promise<{ rows: Array<SongRow & { order: number }>; nextCursor: string | null }> {
  const fetchCount = options.limit + 1;
  const rows = options.cursor
    ? await db<SongRow & { order: number }>`
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
        WHERE ps."playlistId" = ${playlistId}
          AND (s1."id" IS NOT NULL OR s2."id" IS NOT NULL)
          AND (
            ps."order" > ${options.cursor.order}
            OR (ps."order" = ${options.cursor.order} AND COALESCE(s1."id", s2."id") > ${options.cursor.id})
          )
        ORDER BY ps."order" ASC, COALESCE(s1."id", s2."id") ASC
        LIMIT ${fetchCount}
      `
    : await db<SongRow & { order: number }>`
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
        WHERE ps."playlistId" = ${playlistId}
          AND (s1."id" IS NOT NULL OR s2."id" IS NOT NULL)
        ORDER BY ps."order" ASC, COALESCE(s1."id", s2."id") ASC
        LIMIT ${fetchCount}
      `;
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? encodeOrderIdCursor(last.order, last.id) : null,
  };
}

export async function listPlaylistSongs(db: SqlTag, playlistId: string) {
  const { rows } = await listPlaylistSongsPage(db, playlistId, {
    limit: LEGACY_LIBRARY_LIST_LIMIT,
    cursor: null,
  });
  return rows;
}


export function playlistsEditableEnabled(env: CloudflareEnv): boolean {
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
export function isLibraryOwner(c: Context<AppEnv>, user: AuthUser | null): boolean {
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

type LocalMediaUrlSigner = (value: string) => Promise<string>;

export async function localMediaUrlSignerFor(
  c: Context<AppEnv>,
  user: AuthUser,
): Promise<LocalMediaUrlSigner> {
  const secret = getMacMiniMediaSigningSecret(c.env);
  // Local preview reaches the mini directly and authorizes the implicit local
  // owner. Canonicalize stale persisted query params there, but signatures are
  // only needed for production's direct public Caddy media path.
  if (user.id === LOCAL_MAC_MINI_AUTH_USER.id) {
    return async (value) => canonicalizeLocalMediaUrl(value);
  }
  if (!secret) throw new ApiError("Private media signing is not configured", 503);
  return createLocalMediaUrlSigner({
    secret,
    userId: user.id,
    scope: isLibraryOwner(c, user) ? "shared" : "user",
    expiresAt: coarseLocalMediaExpiry(Math.floor(Date.now() / 1_000)),
  });
}

export async function signSongRowMedia<T extends {
  imageUrl: string;
  audioUrl: string;
  lyricsUrl?: string | null;
}>(sign: LocalMediaUrlSigner, row: T): Promise<T> {
  const [imageUrl, audioUrl, lyricsUrl] = await Promise.all([
    sign(row.imageUrl),
    sign(row.audioUrl),
    row.lyricsUrl ? sign(row.lyricsUrl) : Promise.resolve(null),
  ]);
  return { ...row, imageUrl, audioUrl, lyricsUrl } as T;
}

export async function signPlaylistArtwork<T extends {
  imageUrl?: string | null;
  coverImageUrls?: string[];
}>(sign: LocalMediaUrlSigner, playlist: T): Promise<T> {
  const [imageUrl, coverImageUrls] = await Promise.all([
    playlist.imageUrl ? sign(playlist.imageUrl) : Promise.resolve(playlist.imageUrl),
    Promise.all((playlist.coverImageUrls ?? []).map(sign)),
  ]);
  return { ...playlist, imageUrl, coverImageUrls };
}

// A user owns a playlist if it's theirs by id, or it's an owner-owned folder
// conversion (source='local-folder') and they're the library owner — so the
// owner can always open/edit a converted folder regardless of which id seeded
// the row (real owner uuid in prod vs the local-preview sentinel).
export function userOwnsPlaylist(
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
export function topLevelFolder(localPath: string | null | undefined): string | null {
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
export async function convertedFolderIds(env: CloudflareEnv): Promise<Set<string>> {
  const now = Date.now();
  if (convertedFolderCache && now - convertedFolderCache.at < 30_000) return convertedFolderCache.ids;
  try {
    const result = await env.DB.prepare(
      `SELECT "id" FROM "Playlist"
       WHERE "source" = 'local-folder'
         AND ("convertedAt" IS NOT NULL OR "deletedAt" IS NOT NULL)`,
    ).all<{ id: string }>();
    const ids = new Set((result.results ?? []).map((row) => row.id));
    convertedFolderCache = { ids, at: now };
    return ids;
  } catch {
    return new Set();
  }
}

export async function folderServesFromD1(env: CloudflareEnv, playlistId: string): Promise<boolean> {
  if (!playlistsEditableEnabled(env)) return false;
  return (await convertedFolderIds(env)).has(playlistId);
}

export async function fetchMacMiniJson<T>(c: Context<AppEnv>, user: AuthUser, path: string): Promise<T | null> {
  try {
    const res = await fetchMacMini({
      env: c.env,
      target: path,
      user,
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
export async function likedSongIdsForOwnerFromMini(c: Context<AppEnv>, user: AuthUser): Promise<string[] | null> {
  const data = await fetchMacMiniJson<{ likedSongIds?: unknown }>(c, user, "/api/liked");
  if (data == null || !Array.isArray(data.likedSongIds)) return null;
  return (data.likedSongIds as unknown[]).filter((id): id is string => typeof id === "string");
}

export async function upsertSongRef(db: SqlTag, userId: string, song: PlayerSong): Promise<void> {
  const imageUrl = canonicalizeLocalMediaUrl(song.imageUrl ?? "");
  const audioUrl = canonicalizeLocalMediaUrl(song.audioUrl ?? "");
  const lyricsUrl = song.lyricsUrl ? canonicalizeLocalMediaUrl(song.lyricsUrl) : null;
  await db`
    INSERT INTO "SongRef" (
      "id", "title", "artist", "album", "imageUrl", "audioUrl", "lyricsUrl",
      "duration", "audioBitDepth", "audioSampleRate", "localPath", "userId", "createdAt", "updatedAt"
    ) VALUES (
      ${song.id}, ${song.title}, ${song.artist}, ${song.album ?? null}, ${imageUrl},
      ${audioUrl}, ${lyricsUrl}, ${song.duration ?? null},
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
export async function handleLibraryMerge(c: Context<AppEnv>): Promise<Response> {
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
    deletedAt: string | null;
  }>`
    SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", p."source", p."deletedAt",
      COUNT(ps."id") AS "songsCount"
    FROM "Playlist" p
    LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
    WHERE p."userId" = ${user.id}
      AND (
        p."source" IS NULL
        OR (
          p."source" = 'local-folder'
          AND (p."convertedAt" IS NOT NULL OR p."deletedAt" IS NOT NULL)
        )
      )
    GROUP BY p."id", p."name", p."imageUrl", p."userId", p."createdAt", p."source", p."deletedAt"
    ORDER BY p."createdAt" DESC
  `;
  const coversByPlaylistId = await playlistCoverImageUrlsById(db, user.id);
  // editable=true marks a D1-backed playlist the app can add/remove/rename. The
  // mini's still-unconverted folders are read-only until the seed converts them.
  const d1Playlists = d1Rows.filter((row) => !row.deletedAt).map((row) => {
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
      deletable: true,
    };
  });
  // Tombstoned folder ids still shadow the mini copy. Otherwise a deleted folder
  // would immediately reappear in the merged library on the next request.
  const d1Ids = new Set(d1Rows.map((p) => p.id));
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
          deletable: false,
        }));
    }
  }
  const signMediaUrl = await localMediaUrlSignerFor(c, user);
  const playlists = await Promise.all(
    [...d1Playlists, ...miniPlaylists]
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map((playlist) => signPlaylistArtwork(signMediaUrl, playlist)),
  );
  return c.json({ playlists, userId: user.id });
}


export function registerPlaylistRoutes(app: Hono<AppEnv>): void {
app.get("/api/library", async (c) => {
  // Editable playlists: merge D1 (native + converted folders) with the owner's
  // still-unconverted mini folders. The proxy middleware already skipped the
  // mini proxy for this path when the flag is on, so this is the live handler.
  if (playlistsEditableEnabled(c.env)) return handleLibraryMerge(c);
  const user = c.get("user");
  const playlists = await listPlaylists(c.get("db"), user?.id ?? null);
  let signedPlaylists = playlists;
  if (user) {
    const signMediaUrl = await localMediaUrlSignerFor(c, user);
    signedPlaylists = await Promise.all(
      playlists.map((playlist) => signPlaylistArtwork(signMediaUrl, playlist)),
    );
  }
  return jsonCached(c, { playlists: signedPlaylists, userId: user?.id ?? null }, {
    cacheControl: "private, max-age=300, stale-while-revalidate=600",
  });
});

app.post("/api/playlist/:id/reorder", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const playlistRows = await db<{ id: string; userId: string; source: string | null }>`
    SELECT "id", "userId", "source" FROM "Playlist"
    WHERE "id" = ${id} AND "deletedAt" IS NULL
    LIMIT 1
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


app.post("/api/playlists", async (c) => {
  const user = requireUser(c.get("user"));
  const body = await readJson<{ name?: unknown; imageUrl?: unknown }>(c.req.raw);
  const name = toStringValue(body?.name) || "New Playlist";
  const rawImageUrl = toStringValue(body?.imageUrl);
  const imageUrl = rawImageUrl ? canonicalizeLocalMediaUrl(rawImageUrl) : null;
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
    editable: true,
    deletable: true,
  }, 201);
});

app.patch("/api/playlist/:id", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const rows = await db<{ userId: string; source: string | null }>`
    SELECT "userId", "source" FROM "Playlist"
    WHERE "id" = ${id} AND "deletedAt" IS NULL
    LIMIT 1
  `;
  if (!rows[0]) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, rows[0])) return jsonError("Forbidden", 403);
  const body = await readJson<{ name?: unknown; imageUrl?: unknown }>(c.req.raw);
  const name = toStringValue(body?.name);
  if (name) {
    await db`UPDATE "Playlist" SET "name" = ${name} WHERE "id" = ${id} AND "deletedAt" IS NULL`;
  }
  if (typeof body?.imageUrl === "string") {
    const imageUrl = canonicalizeLocalMediaUrl(body.imageUrl);
    await db`
      UPDATE "Playlist" SET "imageUrl" = ${imageUrl}
      WHERE "id" = ${id} AND "deletedAt" IS NULL
    `;
  }
  return c.json({ ok: true });
});

app.delete("/api/playlist/:id", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const rows = await db<{ userId: string; source: string | null }>`
    SELECT "userId", "source" FROM "Playlist"
    WHERE "id" = ${id} AND "deletedAt" IS NULL
    LIMIT 1
  `;
  if (!rows[0]) return jsonError("Playlist not found", 404);
  if (!userOwnsPlaylist(c, user, rows[0])) return jsonError("Forbidden", 403);
  // A folder-backed playlist is a view over real files on the mini. Tombstone the
  // view so it disappears from every client without deleting membership, songs,
  // or audio. Keeping the row also prevents the live mini merge from resurrecting
  // the same folder on the next library request.
  if (rows[0].source === "local-folder") {
    await db`
      UPDATE "Playlist" SET "deletedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "deletedAt" IS NULL
    `;
    convertedFolderCache = null;
    return c.json({ ok: true, mode: "hidden" });
  }
  await db`DELETE FROM "PlaylistSong" WHERE "playlistId" = ${id}`;
  await db`DELETE FROM "Playlist" WHERE "id" = ${id}`;
  return c.json({ ok: true, mode: "deleted" });
});

app.post("/api/playlist/:id/songs", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const rows = await db<{ userId: string; source: string | null }>`
    SELECT "userId", "source" FROM "Playlist"
    WHERE "id" = ${id} AND "deletedAt" IS NULL
    LIMIT 1
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
    SELECT "userId", "source" FROM "Playlist"
    WHERE "id" = ${id} AND "deletedAt" IS NULL
    LIMIT 1
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
      canonicalizeLocalMediaUrl(song.imageUrl ?? ""),
      canonicalizeLocalMediaUrl(song.audioUrl ?? ""),
      song.lyricsUrl ? canonicalizeLocalMediaUrl(song.lyricsUrl) : null,
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
    const rawImageUrl = folder.imageUrl ?? members.find((s) => s.imageUrl)?.imageUrl ?? null;
    const imageUrl = rawImageUrl ? canonicalizeLocalMediaUrl(rawImageUrl) : null;
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
}
