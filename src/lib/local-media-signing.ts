const LOCAL_MEDIA_PATH_PREFIXES = [
  "/api/files/local/",
  "/api/artwork/local/",
] as const;

const LOCAL_MEDIA_AUTH_PARAMS = new Set([
  "spotify_user",
  "spotify_scope",
  "spotify_exp",
  "spotify_sig",
]);

export const LOCAL_MEDIA_SIGNATURE_TTL_SECONDS = 60 * 60;
export const LOCAL_MEDIA_SIGNATURE_BUCKET_SECONDS = 5 * 60;

export type LocalMediaScope = "shared" | "user";

export type LocalMediaSigningOptions = {
  secret: string;
  userId: string;
  scope: LocalMediaScope;
  expiresAt: number;
};

function localMediaPathname(value: string): string | null {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const pathEnd = Math.min(
    queryIndex === -1 ? value.length : queryIndex,
    hashIndex === -1 ? value.length : hashIndex,
  );
  const pathname = value.slice(0, pathEnd);
  return LOCAL_MEDIA_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ? pathname
    : null;
}

function decodedQueryKey(component: string): string {
  const rawKey = component.split("=", 1)[0]?.replace(/\+/g, " ") ?? "";
  try {
    return decodeURIComponent(rawKey);
  } catch {
    return rawKey;
  }
}

/**
 * Removes request-scoped authentication parameters from a local Mac-mini media
 * URL without decoding or otherwise rewriting its signed pathname.
 *
 * Non-local URLs pass through byte-for-byte. Local URL fragments are dropped
 * because they are never sent in the HTTP request or covered by the signature.
 */
export function canonicalizeLocalMediaUrl(value: string): string {
  const pathname = localMediaPathname(value);
  if (!pathname) return value;

  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  if (queryIndex === -1 || (hashIndex !== -1 && hashIndex < queryIndex)) return pathname;
  const rawQuery = value.slice(
    queryIndex + 1,
    hashIndex === -1 ? value.length : hashIndex,
  );
  const retained = rawQuery
    .split("&")
    .filter(Boolean)
    .filter((component) => !LOCAL_MEDIA_AUTH_PARAMS.has(decodedQueryKey(component)));

  return retained.length > 0 ? `${pathname}?${retained.join("&")}` : pathname;
}

/**
 * Returns an expiry shared by every signature generated within the same time
 * bucket. Flooring (rather than ceiling) keeps it within the mini's one-hour
 * acceptance window while preventing response ETags from changing every second.
 */
export function coarseLocalMediaExpiry(
  nowSeconds: number,
  ttlSeconds = LOCAL_MEDIA_SIGNATURE_TTL_SECONDS,
  bucketSeconds = LOCAL_MEDIA_SIGNATURE_BUCKET_SECONDS,
): number {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError("nowSeconds must be a non-negative integer");
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError("ttlSeconds must be a positive integer");
  }
  if (!Number.isSafeInteger(bucketSeconds) || bucketSeconds <= 0 || bucketSeconds >= ttlSeconds) {
    throw new TypeError("bucketSeconds must be a positive integer smaller than ttlSeconds");
  }
  return Math.floor(nowSeconds / bucketSeconds) * bucketSeconds + ttlSeconds;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateSigningOptions(options: LocalMediaSigningOptions): {
  secret: string;
  userId: string;
  expiresAt: string;
} {
  const secret = options.secret;
  const userId = options.userId.trim();
  if (!secret.trim()) throw new TypeError("A media signing secret is required");
  if (!userId) throw new TypeError("A media signing userId is required");
  if (options.scope !== "shared" && options.scope !== "user") {
    throw new TypeError("Media signing scope must be shared or user");
  }
  if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= 0) {
    throw new TypeError("Media signature expiry must be a positive integer");
  }
  return { secret, userId, expiresAt: String(options.expiresAt) };
}

/**
 * Builds a request-scoped signer so a playlist response imports the HMAC key
 * once, even when it contains hundreds of image/audio/lyrics URLs.
 */
export async function createLocalMediaUrlSigner(
  options: LocalMediaSigningOptions,
): Promise<(value: string) => Promise<string>> {
  const { secret, userId, expiresAt } = validateSigningOptions(options);
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return async (value: string): Promise<string> => {
    const canonical = canonicalizeLocalMediaUrl(value);
    const pathname = localMediaPathname(canonical);
    if (!pathname) return value;

    const digest = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${userId}\0${options.scope}\0${pathname}\0${expiresAt}`),
    );
    const signature = bytesToHex(digest).slice(0, 40);
    const separator = canonical.includes("?") ? "&" : "?";
    const auth = new URLSearchParams({
      spotify_user: userId,
      spotify_scope: options.scope,
      spotify_exp: expiresAt,
      spotify_sig: signature,
    });
    return `${canonical}${separator}${auth.toString()}`;
  };
}

/**
 * Signs only local Mac-mini media paths. The HMAC input exactly matches the
 * mini's verifier: userId, scope, encoded pathname, and expiry separated by NUL.
 */
export async function signLocalMediaUrl(
  value: string,
  options: LocalMediaSigningOptions,
): Promise<string> {
  return (await createLocalMediaUrlSigner(options))(value);
}
