import type { Hono } from "hono";
import { parseByteRangeHeader } from "@/lib/http-range";
import { inferContentTypeFromKey, normalizeStorageKey } from "@/lib/storage-keys";
import type { SqlTag } from "@/lib/sql-tag";
import type { AppEnv } from "./env";
import { jsonError, requireUser } from "./http";
import {
  parseStorageKeyFromApiPath,
  parseStorageKeyFromPathSuffix,
  toApiFileUrl,
} from "./storage-urls";

export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isProfileImageKey(key: string): boolean {
  return /^users\/[^/]+\/profile\/[^/]+$/.test(key);
}

function parseArtworkWidth(value: string | undefined): number {
  const width = Number(value || 0);
  if (!Number.isFinite(width) || width <= 0) return 256;
  return Math.max(32, Math.min(1024, Math.round(width)));
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

export function registerR2MediaRoutes(app: Hono<AppEnv>): void {
  // Profile avatars are served without auth: plain <img> loads from the native
  // app don't carry session cookies (only fetch/XHR go through the CapacitorHttp
  // bridge), so an authenticated avatar can never render there. The random UUID
  // filename keeps the URL unguessable.
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
      const parsed = parseByteRangeHeader(range, size);
      if (parsed === "unsatisfiable") {
        const headers = new Headers({
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
        });
        return new Response(null, { status: 416, headers });
      }
      if (parsed) {
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
        return new Response(partial.body, { status: 206, headers });
      }
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
}
