import type { Context } from "hono";
import type { AppEnv } from "./env";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function ifNoneMatchMatches(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === "*" || item === etag);
}

export async function jsonCached(
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

export function requireUser<T>(user: T | null): T {
  if (!user) throw new ApiError("Unauthorized", 401);
  return user;
}
