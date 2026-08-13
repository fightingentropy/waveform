import type { SqlTag } from "@/lib/sql-tag";

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isSecureCookieRequest(urlString: string): boolean {
  const url = new URL(urlString);
  if (url.protocol === "https:") return true;
  return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

export function readCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValueParts.join("=") || "");
    }
  }
  return "";
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getRequestIp(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return "unknown";
}

// D1-backed so limits are shared across Cloudflare isolates (an in-memory Map
// only constrains a single isolate). Auth mutations fail closed on D1 errors so
// a partial outage cannot bypass the limiter.
export async function rateLimit(
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
    // Fail closed: this helper is only used on auth mutations (signin, account
    // delete, verification resend). Those already need D1 to succeed, and
    // skipping the limiter during a partial outage would leave them unprotected.
    const headers = new Headers();
    headers.set("X-RateLimit-Limit", String(max));
    headers.set("X-RateLimit-Remaining", "0");
    headers.set("Retry-After", "60");
    return { allowed: false, headers, ip };
  }
  const allowed = count <= max;
  const headers = new Headers();
  headers.set("X-RateLimit-Limit", String(max));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, max - count)));
  headers.set("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  if (!allowed) headers.set("Retry-After", String(Math.ceil((resetAt - now) / 1000)));
  return { allowed, headers, ip };
}

export async function readJson<T>(req: Request): Promise<T | null> {
  return (await req.json().catch(() => null)) as T | null;
}
