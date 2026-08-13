export const DEFAULT_LIBRARY_PAGE_SIZE = 200;
export const MAX_LIBRARY_PAGE_SIZE = 5_000;
export const LEGACY_LIBRARY_LIST_LIMIT = 5_000;

export type TitleIdCursor = {
  title: string;
  id: string;
};

export type OrderIdCursor = {
  order: number;
  id: string;
};

export function parsePageLimit(
  raw: string | null | undefined,
  fallback = DEFAULT_LIBRARY_PAGE_SIZE,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_LIBRARY_PAGE_SIZE);
}

export function wantsLibraryPage(searchParams: URLSearchParams): boolean {
  return searchParams.has("limit") || searchParams.has("cursor");
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeTitleIdCursor(title: string, id: string): string {
  return toBase64Url(JSON.stringify({ t: title, i: id }));
}

export function decodeTitleIdCursor(cursor: string): TitleIdCursor | null {
  const json = fromBase64Url(cursor.trim());
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const title = "t" in parsed ? parsed.t : undefined;
    const id = "i" in parsed ? parsed.i : undefined;
    if (typeof title !== "string" || typeof id !== "string" || !title || !id) return null;
    return { title, id };
  } catch {
    return null;
  }
}

export function encodeOrderIdCursor(order: number, id: string): string {
  return toBase64Url(JSON.stringify({ o: order, i: id }));
}

export function decodeOrderIdCursor(cursor: string): OrderIdCursor | null {
  const json = fromBase64Url(cursor.trim());
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const order = "o" in parsed ? parsed.o : undefined;
    const id = "i" in parsed ? parsed.i : undefined;
    if (typeof order !== "number" || !Number.isFinite(order) || typeof id !== "string" || !id) {
      return null;
    }
    return { order, id };
  } catch {
    return null;
  }
}

export function encodeOffsetCursor(offset: number): string {
  return String(Math.max(0, Math.floor(offset)));
}

export function decodeOffsetCursor(cursor: string): number | null {
  const parsed = Number(cursor);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export type CreatedAtIdCursor = {
  createdAt: string;
  id: string;
};

export function encodeCreatedAtIdCursor(createdAt: string, id: string): string {
  return toBase64Url(JSON.stringify({ c: createdAt, i: id }));
}

export function decodeCreatedAtIdCursor(cursor: string): CreatedAtIdCursor | null {
  const json = fromBase64Url(cursor.trim());
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const createdAt = "c" in parsed ? parsed.c : undefined;
    const id = "i" in parsed ? parsed.i : undefined;
    if (typeof createdAt !== "string" || typeof id !== "string" || !createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function slicePage<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const start = Math.max(0, offset);
  const page = items.slice(start, start + limit);
  const nextOffset = start + page.length;
  return {
    items: [...page],
    nextCursor: nextOffset < items.length ? encodeOffsetCursor(nextOffset) : null,
  };
}
