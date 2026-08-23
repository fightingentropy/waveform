import { describe, expect, test } from "bun:test";
import {
  communitySessionFromEnv,
  communityUserAgent,
  isSpotiflacCommunityHost,
  parseSpotiflacCommunitySession,
  signSpotiflacCommunityHeaders,
} from "../src/lib/spotiflac-community";

const session = {
  sessionId: "sess-test",
  sessionSecret: "secret-test",
  appVersion: "7.2.2",
  platform: "desktop",
};

describe("SpotiFLAC community session", () => {
  test("reads desktop JSON and env aliases", () => {
    expect(
      parseSpotiflacCommunitySession({
        session_id: "abc",
        session_secret: "xyz",
        expires_at: "2099-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      sessionId: "abc",
      sessionSecret: "xyz",
      appVersion: "7.2.2",
      platform: "desktop",
    });
    expect(
      communitySessionFromEnv({
        SPOTIFLAC_COMMUNITY_SESSION_ID: "abc",
        SPOTIFLAC_COMMUNITY_SESSION_SECRET: "xyz",
      }),
    ).toMatchObject({ sessionId: "abc", sessionSecret: "xyz" });
  });

  test("rejects expired sessions", () => {
    expect(
      parseSpotiflacCommunitySession({
        session_id: "abc",
        session_secret: "xyz",
        expires_at: "2020-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("matches SpotiFLAC 7.2.2 hostnames and user-agent", () => {
    expect(isSpotiflacCommunityHost("https://tdl-oss.spotbye.qzz.io/api/dl")).toBe(true);
    expect(isSpotiflacCommunityHost("https://qbz-oss.spotbye.qzz.io/api/dl")).toBe(true);
    expect(isSpotiflacCommunityHost("https://amz-oss.spotbye.qzz.io/api/dl")).toBe(true);
    expect(isSpotiflacCommunityHost("https://tdl-a.spotbye.qzz.io/api/dl")).toBe(false);
    expect(communityUserAgent(session)).toBe("SpotiFLAC/7.2.2");
  });

  test("signs a stable HMAC for a fixed timestamp and nonce", async () => {
    const headers = await signSpotiflacCommunityHeaders({
      method: "POST",
      pathname: "/api/dl",
      query: "",
      body: new TextEncoder().encode(JSON.stringify({ id: "528127333", quality: "16" })),
      session,
      timestamp: "2026-08-23T10:00:00.000Z",
      nonce: "aabbccddeeff001122334455",
    });
    expect(headers["x-sig-session"]).toBe("sess-test");
    expect(headers["x-sig-timestamp"]).toBe("2026-08-23T10:00:00.000Z");
    expect(headers["x-sig-nonce"]).toBe("aabbccddeeff001122334455");
    expect(headers["x-sig-body-sha256"]).toBe(
      "ac55d1345d90be01f4f4e9b48706e0d09c16a95bed00d9902b9c37786aacb8f8",
    );
    expect(headers["x-sig-app-version"]).toBe("7.2.2");
    expect(headers["x-sig-platform"]).toBe("desktop");
    expect(headers["x-sig-signature"]).toMatch(/^[A-Za-z0-9_-]+$/);
    const again = await signSpotiflacCommunityHeaders({
      method: "POST",
      pathname: "/api/dl",
      query: "",
      body: new TextEncoder().encode(JSON.stringify({ id: "528127333", quality: "16" })),
      session,
      timestamp: "2026-08-23T10:00:00.000Z",
      nonce: "aabbccddeeff001122334455",
    });
    expect(again).toEqual(headers);
  });
});
