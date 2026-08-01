import {
  PRIVATE_PROXY_HEADERS,
  PRIVATE_PROXY_SIGNATURE_TTL_SECONDS,
  PRIVATE_PROXY_SIGNATURE_VERSION,
  normalizePrivateProxyIdentity,
  privateProxySigningPayload,
  stripPrivateProxyHeaders,
  type PrivateProxyIdentity,
} from "@/lib/private-proxy-contract";

export type MacMiniProxyEnv = {
  MAC_MINI_ORIGIN?: string;
  MAC_MINI_REQUEST_SIGNING_SECRET?: string;
  MAC_MINI_MEDIA_SIGNING_SECRET?: string;
};

export type MacMiniProxyUser = PrivateProxyIdentity;

export function isLocalPreviewHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

/**
 * Accept an origin only, never a configured path or embedded credential. Remote
 * private hosts require HTTPS; HTTP remains available solely for local preview.
 */
export function getMacMiniOrigin(env: MacMiniProxyEnv): string {
  const configured = (env.MAC_MINI_ORIGIN ?? "").trim();
  if (!configured) return "";
  try {
    const parsed = new URL(configured);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    if (parsed.pathname !== "/" && parsed.pathname !== "") return "";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalPreviewHost(parsed.hostname))) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

export function getMacMiniRequestSigningSecret(env: MacMiniProxyEnv): string {
  return (env.MAC_MINI_REQUEST_SIGNING_SECRET ?? "").trim();
}

export function getMacMiniMediaSigningSecret(env: MacMiniProxyEnv): string {
  return (env.MAC_MINI_MEDIA_SIGNING_SECRET ?? "").trim();
}

export function isMacMiniMusicConfigured(env: MacMiniProxyEnv): boolean {
  return Boolean(getMacMiniOrigin(env));
}

export function isLocalMacMiniOrigin(env: MacMiniProxyEnv): boolean {
  const origin = getMacMiniOrigin(env);
  return Boolean(origin && isLocalPreviewHost(new URL(origin).hostname));
}

export function canUseMacMiniProxy(env: MacMiniProxyEnv): boolean {
  if (!isMacMiniMusicConfigured(env)) return false;
  return Boolean(getMacMiniRequestSigningSecret(env)) || isLocalMacMiniOrigin(env);
}

export function shouldProxyMusicPathnameToMacMini(
  pathname: string,
  method: string,
  contentType = "",
): boolean {
  const normalizedMethod = method.toUpperCase();

  if (pathname.startsWith("/api/songs/spotify")) return false;
  if (pathname.startsWith("/api/files/local/")) return true;
  if (pathname.startsWith("/api/artwork/local/")) return true;
  if (pathname.startsWith("/api/songs/")) return true;
  if (normalizedMethod === "GET" && pathname.startsWith("/api/playlist/local-folder-")) return true;
  if (
    [
      "/api/music/source",
      "/api/home",
      "/api/search-index",
      "/api/library",
      "/api/liked",
      "/api/likes",
    ].includes(pathname)
  ) {
    return true;
  }
  if (pathname === "/api/songs") {
    if (normalizedMethod === "GET") return true;
    if (normalizedMethod !== "POST") return false;
    return !contentType.toLowerCase().startsWith("application/json");
  }
  return false;
}

const MAC_MINI_USER_CONTEXT_PATHS = new Set([
  "/api/music/source",
  "/api/home",
  "/api/search-index",
  "/api/library",
  "/api/liked",
  "/api/likes",
  "/api/songs",
]);

export function shouldForwardMacMiniUserForPathname(pathname: string): boolean {
  if (MAC_MINI_USER_CONTEXT_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/api/files/local/")) return true;
  if (pathname.startsWith("/api/artwork/local/")) return true;
  if (pathname.startsWith("/api/playlist/")) return true;
  return pathname.startsWith("/api/songs/") && !pathname.startsWith("/api/songs/spotify");
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPrivateProxySignatureHeaders(options: {
  secret: string;
  method: string;
  target: string | URL;
  identity: MacMiniProxyUser | null;
  sourceHeaders?: HeadersInit;
  nowSeconds?: number;
  nonce?: string;
}): Promise<Headers> {
  const secret = options.secret.trim();
  if (!secret) throw new TypeError("Private proxy request signing secret is required");
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError("Invalid private proxy clock");
  }
  const nonce = options.nonce ?? crypto.randomUUID();
  const expiresAt = nowSeconds + PRIVATE_PROXY_SIGNATURE_TTL_SECONDS;
  const identity = normalizePrivateProxyIdentity(options.identity);
  const payload = privateProxySigningPayload({
    method: options.method,
    target: options.target,
    expiresAt,
    nonce,
    identity,
  });
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  const headers = stripPrivateProxyHeaders(new Headers(options.sourceHeaders));
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set(PRIVATE_PROXY_HEADERS.version, PRIVATE_PROXY_SIGNATURE_VERSION);
  headers.set(PRIVATE_PROXY_HEADERS.expiresAt, String(expiresAt));
  headers.set(PRIVATE_PROXY_HEADERS.nonce, nonce);
  headers.set(PRIVATE_PROXY_HEADERS.signature, bytesToHex(digest));
  if (identity) {
    headers.set(PRIVATE_PROXY_HEADERS.userId, identity.id);
    if (identity.email) headers.set(PRIVATE_PROXY_HEADERS.userEmail, identity.email);
    if (identity.name) headers.set(PRIVATE_PROXY_HEADERS.userName, identity.name);
  }
  return headers;
}

export function macMiniTargetUrl(env: MacMiniProxyEnv, target: string | URL): URL {
  const origin = getMacMiniOrigin(env);
  if (!origin) throw new TypeError("Private music origin is not configured safely");
  const source = target instanceof URL ? target : new URL(target, "https://private-proxy.invalid");
  return new URL(`${source.pathname}${source.search}`, origin);
}

export async function createMacMiniProxyHeaders(options: {
  env: MacMiniProxyEnv;
  method: string;
  target: string | URL;
  user: MacMiniProxyUser | null;
  sourceHeaders?: HeadersInit;
}): Promise<Headers> {
  const targetUrl = macMiniTargetUrl(options.env, options.target);
  const secret = getMacMiniRequestSigningSecret(options.env);
  if (!secret) {
    if (!isLocalMacMiniOrigin(options.env)) {
      throw new TypeError("Private proxy request signing is not configured");
    }
    const headers = stripPrivateProxyHeaders(new Headers(options.sourceHeaders));
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("cookie");
    headers.delete("authorization");
    return headers;
  }
  return createPrivateProxySignatureHeaders({
    secret,
    method: options.method,
    target: targetUrl,
    identity: options.user,
    sourceHeaders: options.sourceHeaders,
  });
}

export async function fetchMacMini(options: {
  env: MacMiniProxyEnv;
  target: string | URL;
  method?: string;
  user: MacMiniProxyUser | null;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
  redirect?: RequestRedirect;
}): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const targetUrl = macMiniTargetUrl(options.env, options.target);
  const headers = await createMacMiniProxyHeaders({
    env: options.env,
    method,
    target: targetUrl,
    user: options.user,
    sourceHeaders: options.headers,
  });
  return fetch(targetUrl.toString(), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : options.body,
    signal: options.signal,
    redirect: options.redirect ?? "manual",
  });
}
