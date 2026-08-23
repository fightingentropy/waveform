// SpotiFLAC 7.2.2 community request signing.
// Matches public spotbye/SpotiFLAC backend/community_session.go.

const HMAC_LABEL = "SPOTIFLAC-HMAC-V1";
const DEFAULT_APP_VERSION = "7.2.2";
const DEFAULT_PLATFORM = "desktop";
const WINDOW_SECONDS = 300;

export type SpotiflacCommunitySession = {
  sessionId: string;
  sessionSecret: string;
  appVersion: string;
  platform: string;
  expiresAt?: string;
};

export type SpotiflacCommunitySessionInput = {
  session_id?: unknown;
  sessionId?: unknown;
  session_secret?: unknown;
  sessionSecret?: unknown;
  app_version?: unknown;
  appVersion?: unknown;
  platform?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
};

function textEncoder(): TextEncoder {
  return new TextEncoder();
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes)));
  return toHex(digest);
}

async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, bytesToArrayBuffer(message)));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isSpotiflacCommunityHost(endpointUrl: string): boolean {
  try {
    const url = new URL(endpointUrl);
    return /^(?:tdl|qbz|amz)-oss\.spotbye\.qzz\.io$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function parseSpotiflacCommunitySession(
  value: SpotiflacCommunitySessionInput | string | null | undefined,
): SpotiflacCommunitySession | null {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as SpotiflacCommunitySessionInput;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== "object") return null;
  const sessionId = readString(parsed.session_id) || readString(parsed.sessionId);
  const sessionSecret = readString(parsed.session_secret) || readString(parsed.sessionSecret);
  if (!sessionId || !sessionSecret) return null;
  const expiresAt = readString(parsed.expires_at) || readString(parsed.expiresAt);
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now() + 30_000) return null;
  }
  return {
    sessionId,
    sessionSecret,
    appVersion: readString(parsed.app_version) || readString(parsed.appVersion) || DEFAULT_APP_VERSION,
    platform: readString(parsed.platform) || DEFAULT_PLATFORM,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function envValue(env: object, key: string): unknown {
  return (env as Record<string, unknown>)[key];
}

export function communitySessionFromEnv(env: object | undefined | null): SpotiflacCommunitySession | null {
  if (!env) return null;
  const fromJson = parseSpotiflacCommunitySession(readString(envValue(env, "SPOTIFLAC_COMMUNITY_SESSION_JSON")));
  if (fromJson) return fromJson;
  return parseSpotiflacCommunitySession({
    sessionId: envValue(env, "SPOTIFLAC_COMMUNITY_SESSION_ID"),
    sessionSecret: envValue(env, "SPOTIFLAC_COMMUNITY_SESSION_SECRET"),
    appVersion: envValue(env, "SPOTIFLAC_COMMUNITY_APP_VERSION"),
    platform: envValue(env, "SPOTIFLAC_COMMUNITY_PLATFORM"),
    expiresAt: envValue(env, "SPOTIFLAC_COMMUNITY_SESSION_EXPIRES_AT"),
  });
}

export function communityUserAgent(session?: SpotiflacCommunitySession | null): string {
  const version = session?.appVersion?.trim() || DEFAULT_APP_VERSION;
  return version === "Unknown" ? "SpotiFLAC" : `SpotiFLAC/${version}`;
}

export async function signSpotiflacCommunityHeaders(options: {
  method: string;
  pathname: string;
  query?: string;
  body: Uint8Array;
  session: SpotiflacCommunitySession;
  timestamp?: string;
  nonce?: string;
}): Promise<Record<string, string>> {
  const method = options.method.toUpperCase();
  const query = options.query ?? "";
  const timestamp = options.timestamp ?? new Date().toISOString();
  const nonce = options.nonce ?? randomHex(12);
  const bodyHash = await sha256Hex(options.body);
  const parsedTimestamp = Date.parse(timestamp);
  const unixSeconds = Number.isFinite(parsedTimestamp) ? Math.floor(parsedTimestamp / 1000) : Math.floor(Date.now() / 1000);
  const window = Math.floor(unixSeconds / WINDOW_SECONDS);
  const rollingKey = await hmacSha256(
    textEncoder().encode(options.session.sessionSecret),
    textEncoder().encode(`${window}:${options.session.sessionId}`),
  );
  const signingInput = [
    HMAC_LABEL,
    method,
    options.pathname,
    query,
    bodyHash,
    timestamp,
    nonce,
    options.session.sessionId,
    options.session.appVersion,
    options.session.platform,
  ].join("\n");
  const signature = encodeBase64Url(await hmacSha256(rollingKey, textEncoder().encode(signingInput)));
  return {
    "x-sig-session": options.session.sessionId,
    "x-sig-timestamp": timestamp,
    "x-sig-nonce": nonce,
    "x-sig-body-sha256": bodyHash,
    "x-sig-signature": signature,
    "x-sig-app-version": options.session.appVersion,
    "x-sig-platform": options.session.platform,
  };
}

export { DEFAULT_APP_VERSION as SPOTIFLAC_COMMUNITY_APP_VERSION };
