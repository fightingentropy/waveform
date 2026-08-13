import { extname, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { parseByteRangeHeader } from "../lib/http-range";

export type KnownFileStat = {
  size: number;
  mtimeMs: number;
};

export function ifNoneMatchMatches(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === "*" || item === etag);
}

export function notFound(message = "Not found"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`));
}

export function resolveInside(root: string, relativePath: string): string | null {
  const normalized = relativePath.split("/").filter(Boolean).join("/");
  if (!normalized || normalized.includes("\0")) return null;
  const absolutePath = resolve(root, normalized);
  return isPathInside(root, absolutePath) ? absolutePath : null;
}

export async function resolveInsideReal(root: string, relativePath: string): Promise<string | null> {
  const absolutePath = resolveInside(root, relativePath);
  if (!absolutePath) return null;
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(absolutePath)]);
    return isPathInside(realRoot, realPath) ? absolutePath : null;
  } catch {
    return null;
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function relativeFromUrlPath(pathname: string, prefix: string): string {
  return pathname
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map(decodePathSegment)
    .join("/");
}

export function contentTypeForPath(path: string): string {
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

export async function serveFile(
  path: string,
  request: Request,
  cacheControl = "public, max-age=3600",
  knownFileStat?: KnownFileStat,
): Promise<Response> {
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

  const range = parseByteRangeHeader(request.headers.get("range"), size);
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
