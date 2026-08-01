import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  PRIVATE_PROXY_HEADERS,
  PRIVATE_PROXY_SIGNATURE_VERSION,
} from "../src/lib/private-proxy-contract";
import { createPrivateProxyAuthenticator } from "../src/server/proxy-auth";
import {
  canUseMacMiniProxy,
  createPrivateProxySignatureHeaders,
  getMacMiniOrigin,
} from "../src/worker/mac-mini-proxy";

const secret = "request-signing-secret-for-tests";
const now = 1_900_000_000;
const nonce = "test-nonce-000000000001";
const identity = { id: "user-123", email: "person@example.test", name: "Person" };
const target = "https://music.example.test/api/home?refresh=1&view=full";

async function signedHeaders(overrides: { nowSeconds?: number; nonce?: string } = {}) {
  return createPrivateProxySignatureHeaders({
    secret,
    method: "GET",
    target,
    identity,
    nowSeconds: overrides.nowSeconds ?? now,
    nonce: overrides.nonce ?? nonce,
  });
}

function verifier(clock = now) {
  return createPrivateProxyAuthenticator({
    requestSigningSecret: secret,
    nowSeconds: () => clock,
  });
}

describe("short-lived private proxy request signing", () => {
  test("matches an independent HMAC over method, target, expiry, nonce, and identity", async () => {
    const headers = await signedHeaders();
    const expiry = now + 30;
    const expectedPayload = JSON.stringify([
      "spotify-private-proxy",
      PRIVATE_PROXY_SIGNATURE_VERSION,
      "GET",
      "/api/home?refresh=1&view=full",
      expiry,
      nonce,
      identity.id,
      identity.email,
      identity.name,
    ]);
    const expected = createHmac("sha256", secret).update(expectedPayload).digest("hex");

    expect(headers.get(PRIVATE_PROXY_HEADERS.signature)).toBe(expected);
    expect(headers.get(PRIVATE_PROXY_HEADERS.expiresAt)).toBe(String(expiry));
    expect(headers.get(PRIVATE_PROXY_HEADERS.legacyToken)).toBeNull();
  });

  test("accepts one request, caches repeated checks of that Request, and rejects a replay", async () => {
    const headers = await signedHeaders();
    const auth = verifier();
    const request = new Request(target, { headers });

    expect(auth.authenticate(request)).toEqual({ authenticated: true, identity, legacy: false });
    expect(auth.authenticate(request)).toEqual({ authenticated: true, identity, legacy: false });
    expect(auth.replayCacheSize()).toBe(1);
    expect(auth.authenticate(new Request(target, { headers }))).toMatchObject({
      authenticated: false,
      reason: "replayed",
    });
  });

  test("rejects changes to method, path, query, or forwarded user context", async () => {
    const cases: Request[] = [];
    cases.push(new Request(target, { method: "HEAD", headers: await signedHeaders({ nonce: "test-nonce-000000000002" }) }));
    cases.push(new Request("https://music.example.test/api/library?refresh=1&view=full", {
      headers: await signedHeaders({ nonce: "test-nonce-000000000003" }),
    }));
    cases.push(new Request("https://music.example.test/api/home?view=full&refresh=1", {
      headers: await signedHeaders({ nonce: "test-nonce-000000000004" }),
    }));
    const changedIdentity = await signedHeaders({ nonce: "test-nonce-000000000005" });
    changedIdentity.set(PRIVATE_PROXY_HEADERS.userId, "other-user");
    cases.push(new Request(target, { headers: changedIdentity }));

    for (const request of cases) {
      expect(verifier().authenticate(request)).toMatchObject({ authenticated: false, reason: "invalid" });
    }
  });

  test("rejects expired signatures and expiries outside the bounded clock-skew window", async () => {
    const expired = new Request(target, {
      headers: await signedHeaders({ nowSeconds: now - 31, nonce: "test-nonce-000000000006" }),
    });
    expect(verifier().authenticate(expired)).toMatchObject({ authenticated: false, reason: "expired" });

    const future = new Request(target, {
      headers: await signedHeaders({ nowSeconds: now + 6, nonce: "test-nonce-000000000007" }),
    });
    expect(verifier().authenticate(future)).toMatchObject({ authenticated: false, reason: "future-expiry" });
  });

  test("drops caller-supplied credentials and proxy identity before signing", async () => {
    const headers = await createPrivateProxySignatureHeaders({
      secret,
      method: "GET",
      target,
      identity,
      nowSeconds: now,
      nonce: "test-nonce-000000000008",
      sourceHeaders: {
        authorization: "Bearer browser-token",
        cookie: "session=browser-cookie",
        [PRIVATE_PROXY_HEADERS.legacyToken]: "stolen-static-token",
        [PRIVATE_PROXY_HEADERS.userId]: "spoofed-user",
      },
    });

    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get(PRIVATE_PROXY_HEADERS.legacyToken)).toBeNull();
    expect(headers.get(PRIVATE_PROXY_HEADERS.userId)).toBe(identity.id);
  });

  test("keeps the bearer-token migration path opt-in and disabled by default", () => {
    const headers = new Headers({
      [PRIVATE_PROXY_HEADERS.legacyToken]: "legacy-secret",
      [PRIVATE_PROXY_HEADERS.userId]: identity.id,
      [PRIVATE_PROXY_HEADERS.userEmail]: identity.email,
    });
    const request = new Request(target, { headers });
    expect(createPrivateProxyAuthenticator({
      requestSigningSecret: "",
      legacyToken: "legacy-secret",
    }).authenticate(request)).toMatchObject({ authenticated: false, reason: "not-configured" });

    expect(createPrivateProxyAuthenticator({
      requestSigningSecret: "",
      legacyToken: "legacy-secret",
      allowLegacyToken: true,
    }).authenticate(request)).toMatchObject({ authenticated: true, legacy: true });
  });
});

describe("private music origin policy", () => {
  test("requires a clean HTTPS origin except for loopback/local preview", () => {
    expect(getMacMiniOrigin({ MAC_MINI_ORIGIN: "https://music.example.test/" })).toBe("https://music.example.test");
    expect(getMacMiniOrigin({ MAC_MINI_ORIGIN: "http://127.0.0.1:5176" })).toBe("http://127.0.0.1:5176");
    expect(getMacMiniOrigin({ MAC_MINI_ORIGIN: "http://music.example.test" })).toBe("");
    expect(getMacMiniOrigin({ MAC_MINI_ORIGIN: "http://private-host.local:5176" })).toBe("");
    expect(getMacMiniOrigin({ MAC_MINI_ORIGIN: "https://user:pass@music.example.test" })).toBe("");
    expect(getMacMiniOrigin({ MAC_MINI_ORIGIN: "https://music.example.test/private" })).toBe("");
  });

  test("fails closed when a remote origin has no request-signing secret", () => {
    expect(canUseMacMiniProxy({ MAC_MINI_ORIGIN: "https://music.example.test" })).toBe(false);
    expect(canUseMacMiniProxy({
      MAC_MINI_ORIGIN: "https://music.example.test",
      MAC_MINI_REQUEST_SIGNING_SECRET: secret,
    })).toBe(true);
    expect(canUseMacMiniProxy({ MAC_MINI_ORIGIN: "http://localhost:5176" })).toBe(true);
  });
});
