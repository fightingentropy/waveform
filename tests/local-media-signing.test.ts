import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  LOCAL_MEDIA_SIGNATURE_TTL_SECONDS,
  canonicalizeLocalMediaUrl,
  coarseLocalMediaExpiry,
  signLocalMediaUrl,
} from "../src/lib/local-media-signing";

describe("canonicalizeLocalMediaUrl", () => {
  test("strips only local-media auth parameters while preserving the encoded pathname", () => {
    const value =
      "/api/files/local/A%20%2B%20B%20%231%25.flac" +
      "?keep=%2f&spotify_user=old&spotify_scope=shared&spotify_exp=123" +
      "&%73potify_sig=old-signature#not-sent";

    expect(canonicalizeLocalMediaUrl(value)).toBe(
      "/api/files/local/A%20%2B%20B%20%231%25.flac?keep=%2f",
    );
  });

  test("passes non-local media URLs through byte-for-byte", () => {
    const values = [
      "https://i.scdn.co/image/cover.jpg?spotify_sig=provider-value",
      "/api/files/music/Artist/Track/cover.jpg?spotify_sig=r2-value",
      "/apple-icon.png",
      "",
    ];

    for (const value of values) {
      expect(canonicalizeLocalMediaUrl(value)).toBe(value);
    }
  });
});

describe("coarseLocalMediaExpiry", () => {
  test("is stable inside an hour bucket and remains within the 24-hour verifier window", () => {
    const bucketStart = 1_800_000_000;
    const first = coarseLocalMediaExpiry(bucketStart + 1);
    const last = coarseLocalMediaExpiry(bucketStart + 3_599);

    expect(first).toBe(last);
    expect(first).toBe(bucketStart + LOCAL_MEDIA_SIGNATURE_TTL_SECONDS);
    expect(first).toBeGreaterThan(bucketStart + 3_599);
    expect(first).toBeLessThanOrEqual(bucketStart + 3_599 + LOCAL_MEDIA_SIGNATURE_TTL_SECONDS);
  });
});

describe("signLocalMediaUrl", () => {
  test("matches an independent Node HMAC and replaces stale auth without decoding the path", async () => {
    const secret = "test-proxy-secret";
    const userId = "user-123";
    const scope = "shared";
    const expiresAt = 1_900_000_000;
    const pathname = "/api/artwork/local/local-server%3Aabc%23%25%2B%3F%26";
    const signed = await signLocalMediaUrl(
      `${pathname}?spotify_user=old&spotify_scope=user&spotify_sig=legacy`,
      { secret, userId, scope, expiresAt },
    );
    const parsed = new URL(signed, "https://music.example");
    const expected = createHmac("sha256", secret)
      .update(userId)
      .update("\0")
      .update(scope)
      .update("\0")
      .update(pathname)
      .update("\0")
      .update(String(expiresAt))
      .digest("hex")
      .slice(0, 40);

    expect(parsed.pathname).toBe(pathname);
    expect(parsed.searchParams.get("spotify_user")).toBe(userId);
    expect(parsed.searchParams.get("spotify_scope")).toBe(scope);
    expect(parsed.searchParams.get("spotify_exp")).toBe(String(expiresAt));
    expect(parsed.searchParams.get("spotify_sig")).toBe(expected);
    expect(parsed.searchParams.getAll("spotify_sig")).toHaveLength(1);
  });

  test("does not sign external or non-local app media", async () => {
    const options = {
      secret: "test-proxy-secret",
      userId: "user-123",
      scope: "user" as const,
      expiresAt: 1_900_000_000,
    };
    const values = [
      "https://i.scdn.co/image/cover.jpg",
      "/api/files/music/Artist/Track/audio.flac",
      "/apple-icon.png",
    ];

    for (const value of values) {
      expect(await signLocalMediaUrl(value, options)).toBe(value);
    }
  });
});
