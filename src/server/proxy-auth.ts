import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PRIVATE_PROXY_CLOCK_SKEW_SECONDS,
  PRIVATE_PROXY_HEADERS,
  PRIVATE_PROXY_SIGNATURE_TTL_SECONDS,
  PRIVATE_PROXY_SIGNATURE_VERSION,
  normalizePrivateProxyIdentity,
  privateProxySigningPayload,
  type PrivateProxyIdentity,
} from "../lib/private-proxy-contract";

export type PrivateProxyAuthResult =
  | { authenticated: true; identity: PrivateProxyIdentity | null; legacy: boolean }
  | {
      authenticated: false;
      identity: null;
      legacy: false;
      reason:
        | "not-configured"
        | "missing"
        | "invalid"
        | "expired"
        | "future-expiry"
        | "replayed";
    };

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function identityFromHeaders(headers: Headers): PrivateProxyIdentity | null {
  const id = headers.get(PRIVATE_PROXY_HEADERS.userId)?.trim() ?? "";
  const email = headers.get(PRIVATE_PROXY_HEADERS.userEmail)?.trim() ?? "";
  const name = headers.get(PRIVATE_PROXY_HEADERS.userName)?.trim() ?? "";
  if (!id) {
    if (email || name) throw new TypeError("Proxy identity requires an id");
    return null;
  }
  return normalizePrivateProxyIdentity({ id, email, name: name || null });
}

export function createPrivateProxyAuthenticator(options: {
  requestSigningSecret: string;
  legacyToken?: string;
  allowLegacyToken?: boolean;
  nowSeconds?: () => number;
  maxReplayEntries?: number;
}) {
  const secret = options.requestSigningSecret.trim();
  const legacyToken = options.legacyToken?.trim() ?? "";
  const allowLegacy = options.allowLegacyToken === true && Boolean(legacyToken);
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const maxReplayEntries = Math.max(128, options.maxReplayEntries ?? 10_000);
  const verifiedRequests = new WeakMap<Request, PrivateProxyAuthResult>();
  const seenNonces = new Map<string, number>();

  const pruneNonces = (now: number) => {
    for (const [nonce, expiresAt] of seenNonces) {
      if (expiresAt > now) continue;
      seenNonces.delete(nonce);
    }
    while (seenNonces.size >= maxReplayEntries) {
      const oldest = seenNonces.keys().next().value as string | undefined;
      if (!oldest) break;
      seenNonces.delete(oldest);
    }
  };

  const authenticate = (request: Request): PrivateProxyAuthResult => {
    const cached = verifiedRequests.get(request);
    if (cached) return cached;

    const fail = (reason: Extract<PrivateProxyAuthResult, { authenticated: false }>["reason"]) => {
      const result = { authenticated: false, identity: null, legacy: false, reason } as const;
      verifiedRequests.set(request, result);
      return result;
    };

    if (allowLegacy) {
      const supplied = request.headers.get(PRIVATE_PROXY_HEADERS.legacyToken) ?? "";
      if (supplied && timingSafeEqualText(supplied, legacyToken)) {
        let identity: PrivateProxyIdentity | null;
        try {
          identity = identityFromHeaders(request.headers);
        } catch {
          return fail("invalid");
        }
        const result = { authenticated: true, identity, legacy: true } as const;
        verifiedRequests.set(request, result);
        return result;
      }
    }

    if (!secret) return fail("not-configured");
    const version = request.headers.get(PRIVATE_PROXY_HEADERS.version) ?? "";
    const expiryText = request.headers.get(PRIVATE_PROXY_HEADERS.expiresAt) ?? "";
    const nonce = request.headers.get(PRIVATE_PROXY_HEADERS.nonce) ?? "";
    const signature = request.headers.get(PRIVATE_PROXY_HEADERS.signature) ?? "";
    if (!version && !expiryText && !nonce && !signature) return fail("missing");
    if (
      version !== PRIVATE_PROXY_SIGNATURE_VERSION ||
      !/^\d{1,16}$/.test(expiryText) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      !/^[0-9a-f]{64}$/.test(signature)
    ) {
      return fail("invalid");
    }

    const expiresAt = Number(expiryText);
    const now = nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)) return fail("invalid");
    if (expiresAt <= now) return fail("expired");
    if (expiresAt > now + PRIVATE_PROXY_SIGNATURE_TTL_SECONDS + PRIVATE_PROXY_CLOCK_SKEW_SECONDS) {
      return fail("future-expiry");
    }

    let identity: PrivateProxyIdentity | null;
    let payload: string;
    try {
      identity = identityFromHeaders(request.headers);
      payload = privateProxySigningPayload({
        method: request.method,
        target: request.url,
        expiresAt,
        nonce,
        identity,
      });
    } catch {
      return fail("invalid");
    }
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    if (!timingSafeEqualText(signature, expected)) return fail("invalid");

    pruneNonces(now);
    if (seenNonces.has(nonce)) return fail("replayed");
    seenNonces.set(nonce, expiresAt);

    const result = { authenticated: true, identity, legacy: false } as const;
    verifiedRequests.set(request, result);
    return result;
  };

  return {
    authenticate,
    replayCacheSize: () => seenNonces.size,
    clearReplayCache: () => seenNonces.clear(),
  };
}
