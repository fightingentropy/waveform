import { basename, join } from "node:path";
import { inferContentTypeFromKey, normalizeStorageKey } from "@/lib/storage-keys";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const MAX_LYRICS_BYTES = 2 * 1024 * 1024;

export function sanitizeFileName(fileName: string): string {
  const base = basename(fileName || "upload");
  const safe = base.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return safe || "upload";
}

export function sanitizePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9.\-_ ]/g, "_").replace(/\s+/g, " ");
  return safe || "unknown";
}

export function buildOrganizedMusicBasePath(title: string, artist: string): string {
  return join("music", sanitizePathSegment(artist), sanitizePathSegment(title)).replaceAll("\\", "/");
}

export async function putBuffer(env: CloudflareEnv, key: string, buffer: ArrayBuffer | Uint8Array, contentType?: string) {
  await env.MEDIA.put(normalizeStorageKey(key), buffer, {
    httpMetadata: { contentType: contentType || inferContentTypeFromKey(key) },
  });
}

export async function putStream(env: CloudflareEnv, key: string, stream: ReadableStream, contentType?: string) {
  await env.MEDIA.put(normalizeStorageKey(key), stream, {
    httpMetadata: { contentType: contentType || inferContentTypeFromKey(key) },
  });
}
