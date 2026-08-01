export const PRIVATE_PROXY_SIGNATURE_VERSION = "v1";
export const PRIVATE_PROXY_SIGNATURE_TTL_SECONDS = 30;
export const PRIVATE_PROXY_CLOCK_SKEW_SECONDS = 5;
export const PRIVATE_PROXY_MAX_TARGET_LENGTH = 16_384;

export const PRIVATE_PROXY_HEADERS = {
  version: "x-spotify-proxy-version",
  expiresAt: "x-spotify-proxy-expiry",
  nonce: "x-spotify-proxy-nonce",
  signature: "x-spotify-proxy-signature",
  userId: "x-spotify-user-id",
  userEmail: "x-spotify-user-email",
  userName: "x-spotify-user-name",
  legacyToken: "x-spotify-proxy-token",
} as const;

export type PrivateProxyIdentity = {
  id: string;
  email: string;
  name: string | null;
};

export type PrivateProxySigningFields = {
  method: string;
  target: string | URL;
  expiresAt: number;
  nonce: string;
  identity: PrivateProxyIdentity | null;
};

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const HTTP_METHOD = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function checkedIdentityField(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length > maxLength || containsControlCharacter(normalized)) {
    throw new TypeError(`Invalid private proxy ${label}`);
  }
  return normalized;
}

export function normalizePrivateProxyIdentity(
  identity: PrivateProxyIdentity | null,
): PrivateProxyIdentity | null {
  if (!identity) return null;
  const id = checkedIdentityField(identity.id, "user id", 256);
  const email = checkedIdentityField(identity.email, "user email", 320);
  const name = checkedIdentityField(identity.name ?? "", "user name", 256);
  if (!id) throw new TypeError("Private proxy user id is required");
  return { id, email, name: name || null };
}

export function normalizePrivateProxyMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  if (!HTTP_METHOD.test(normalized)) throw new TypeError("Invalid private proxy method");
  return normalized;
}

/**
 * Canonical request target covered by the HMAC. It deliberately includes the
 * raw URL search component so changing, adding, or reordering query parameters
 * invalidates the signature. Fragments never cross an HTTP boundary.
 */
export function canonicalPrivateProxyTarget(target: string | URL): string {
  let parsed: URL;
  try {
    parsed = target instanceof URL ? target : new URL(target, "https://private-proxy.invalid");
  } catch {
    throw new TypeError("Invalid private proxy target");
  }
  const canonical = `${parsed.pathname}${parsed.search}`;
  if (!canonical.startsWith("/") || canonical.length > PRIVATE_PROXY_MAX_TARGET_LENGTH) {
    throw new TypeError("Invalid private proxy target");
  }
  return canonical;
}

export function isPrivateProxyNonce(value: string): boolean {
  return NONCE.test(value);
}

/**
 * JSON provides an unambiguous, language-independent field boundary. The user
 * context is covered by the same signature as method and target, so forwarded
 * identity headers cannot be swapped independently.
 */
export function privateProxySigningPayload(fields: PrivateProxySigningFields): string {
  const method = normalizePrivateProxyMethod(fields.method);
  const target = canonicalPrivateProxyTarget(fields.target);
  if (!Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0) {
    throw new TypeError("Invalid private proxy expiry");
  }
  if (!isPrivateProxyNonce(fields.nonce)) throw new TypeError("Invalid private proxy nonce");
  const identity = normalizePrivateProxyIdentity(fields.identity);
  return JSON.stringify([
    "spotify-private-proxy",
    PRIVATE_PROXY_SIGNATURE_VERSION,
    method,
    target,
    fields.expiresAt,
    fields.nonce,
    identity?.id ?? "",
    identity?.email ?? "",
    identity?.name ?? "",
  ]);
}

export function stripPrivateProxyHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const name of Object.values(PRIVATE_PROXY_HEADERS)) sanitized.delete(name);
  return sanitized;
}
