import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fetchPublicHttpUrl } from "../lib/safe-fetch";
import { LOCAL_IMAGE_EXTENSIONS as IMAGE_EXTENSIONS } from "../lib/local-media-path";
import { json } from "./local-http";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const MAX_LYRICS_BYTES = 2 * 1024 * 1024;

export class PayloadTooLargeError extends Error {}

export function contentTypeExtension(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

export function audioExtensionFromContentType(contentType: string): string {
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

export function extensionFromRemoteUrl(value: string, allowed: Set<string>, fallback: string): string {
  try {
    const parsed = new URL(value);
    const ext = extname(parsed.pathname).toLowerCase();
    return allowed.has(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

export function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

export function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180) || "Unknown";
}

export async function uniquePath(basePath: string): Promise<string> {
  if (!existsSync(basePath)) return basePath;
  const ext = extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} ${index}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to create a unique file name");
}

export async function saveFile(file: File, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(await file.arrayBuffer()));
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isSupportedUploadFile(file: File, allowedExtensions: Set<string>, mimePrefix: string): boolean {
  const ext = extname(file.name).toLowerCase();
  const mimeType = file.type.toLowerCase();
  return allowedExtensions.has(ext) || (mimeType ? mimeType.startsWith(mimePrefix) : false);
}

export function validateUploadFile(
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

export function assertRemoteResponseSize(response: Response, maxBytes: number, label: string): void {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PayloadTooLargeError(`${label} is too large`);
  }
}

export function byteLimitTransform(maxBytes: number, label: string): Transform {
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

export async function saveResponseBody(response: Response, path: string, maxBytes?: number, label = "File"): Promise<void> {
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

export function trackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function saveRemoteImage(imageUrl: string, stem: string, audioPath: string): Promise<string | undefined> {
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
