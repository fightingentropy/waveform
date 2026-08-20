import { compare } from "bcryptjs";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Hono } from "hono";
import type { Context } from "hono";
import {
  exclusiveManagedStorageKeys,
  type AccountMediaRow,
} from "@/lib/account-deletion";
import type { UserRow } from "@/lib/db-types";
import { sniffUploadMediaBytes } from "@/lib/upload-media-sniff";
import type { SqlTag } from "@/lib/sql-tag";
import { safePrivatePageNext } from "@/lib/private-web-surface";
import { LOCAL_MAC_MINI_AUTH_USER, type AppEnv, type AuthUser } from "./env";
import { jsonError, requireUser } from "./http";
import {
  isSecureCookieRequest,
  randomToken,
  rateLimit,
  readCookie,
  readJson,
  sha256Hex,
} from "./request";
import { MAX_IMAGE_BYTES, putBuffer, sanitizePathSegment } from "./r2-put";
import { IMAGE_MIME_TYPES } from "./r2-media";
import { toApiFileUrl } from "./storage-urls";
import { envString, toStringValue } from "./values";

export const SESSION_COOKIE = "spotify_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const R2_DELETE_BATCH_SIZE = 1_000;

// A valid bcrypt hash (of a throwaway secret) compared against when no user or
// password hash exists, so a failed signin spends the same CPU as a real one.
const DUMMY_PASSWORD_HASH = "$2b$10$7tXHcDkbjQu2CAfr8lewqezc3JeBLP4fnqpxolFBCCxzclVG0si.K";

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

export function emailBinding(env: CloudflareEnv): EmailBinding | null {
  const binding = (env as unknown as { EMAIL?: EmailBinding }).EMAIL;
  return binding && typeof binding.send === "function" ? binding : null;
}

// Public origin used to build the email verification link. Prefers an explicit
// APP_ORIGIN, then the public app origin (MAC_MINI_ORIGIN), then the request.
export function publicAppOrigin(env: CloudflareEnv, requestUrl: string): string {
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

export async function createEmailVerificationToken(db: SqlTag, email: string): Promise<string> {
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

export async function sendVerificationEmail(
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

export async function getCurrentUser(req: Request, db: SqlTag): Promise<AuthUser | null> {
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

export function publicUser(user: AuthUser) {
  const defaultImage = defaultUserImage(user.email, user.name);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image || defaultImage || null,
    emailVerified: Boolean(user.emailVerified),
  };
}

export async function ensureDefaultProfileImageStored(c: Context<AppEnv>, user: AuthUser): Promise<AuthUser> {
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

export async function publicUserForResponse(c: Context<AppEnv>, user: AuthUser) {
  return publicUser(await ensureDefaultProfileImageStored(c, user));
}

export async function listAccountMediaRows(db: SqlTag, userId: string): Promise<AccountMediaRow[]> {
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

export async function listOtherAccountMediaRows(db: SqlTag, userId: string): Promise<AccountMediaRow[]> {
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

export async function deleteAccountRows(
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

export async function deleteAccountMedia(env: CloudflareEnv, userId: string, keys: string[]): Promise<void> {
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

export function defaultUserImage(_email: string, _name: string | null): string | null {
  // Name-based identity heuristics have been dropped; everyone gets the same
  // generic default avatar (resolved by the normal fallback paths).
  return null;
}


export function registerAuthRoutes(app: Hono<AppEnv>): void {
app.get("/api/auth/session", async (c) => {
  const user = c.get("user");
  return c.json({ user: user ? await publicUserForResponse(c, user) : null });
});

app.get("/api/auth/page-gate", (c) => {
  if (c.get("user")) {
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }
  const next = safePrivatePageNext(c.req.header("x-forwarded-uri"));
  const signIn = new URL("/signin", publicAppOrigin(c.env, c.req.url));
  if (next !== "/") signIn.searchParams.set("next", next);
  return new Response(null, {
    status: 302,
    headers: {
      location: signIn.toString(),
      "cache-control": "no-store",
    },
  });
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
  } else {
    const form = await c.req.formData();
    const image = form.get("image");
    if (!(image instanceof File) || image.size <= 0) {
      return jsonError("Image file is required", 400);
    }
    if (image.size > MAX_IMAGE_BYTES) return jsonError("Image file is too large", 413);
    imageBytes = await image.arrayBuffer();
  }

  const sniffedImage = sniffUploadMediaBytes(new Uint8Array(imageBytes));
  if (!sniffedImage || sniffedImage.kind !== "image") return jsonError("Unsupported image content", 415);
  const imageExt = sniffedImage.extension;
  const key = `users/${sanitizePathSegment(user.id)}/profile/${crypto.randomUUID()}${imageExt}`;
  // Derive the stored content-type solely from the validated extension — never
  // trust the client-supplied contentType. Otherwise a caller could store an
  // avatar as text/html and have our origin serve executable HTML (stored XSS),
  // since /api/files serves profile images without auth.
  const contentType = sniffedImage.contentType;
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
}
