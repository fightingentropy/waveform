import { describe, expect, test } from "bun:test";
import {
  shouldForwardMacMiniUserForPathname,
  shouldProxyMusicPathnameToMacMini,
  spotiflacStatusKeyForEndpoint,
  withSecurityHeaders,
} from "../src/worker/index";

describe("Mac mini proxy user forwarding", () => {
  test("forwards user context for local library reads", () => {
    expect(shouldForwardMacMiniUserForPathname("/api/music/source")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/home")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/liked")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/songs")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/songs/local-server%3Aabc123")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/files/local/Album%2Ftrack.flac")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/artwork/local/local-server%3Aabc123")).toBe(true);
  });

  test("does not steal Spotify import routes from the Worker", () => {
    expect(shouldForwardMacMiniUserForPathname("/api/songs/spotify")).toBe(false);
    expect(shouldForwardMacMiniUserForPathname("/api/songs/spotify/batch")).toBe(false);
  });

  test("does not forward listening-history routes", () => {
    expect(shouldForwardMacMiniUserForPathname("/api/play-events")).toBe(false);
    expect(shouldForwardMacMiniUserForPathname("/api/stats/home")).toBe(false);
  });
});

describe("Mac mini proxy diversion", () => {
  test("keeps proxying local library routes", () => {
    expect(shouldProxyMusicPathnameToMacMini("/api/home", "GET")).toBe(true);
    expect(shouldProxyMusicPathnameToMacMini("/api/music/source", "GET")).toBe(true);
    expect(shouldProxyMusicPathnameToMacMini("/api/songs", "GET")).toBe(true);
    expect(shouldProxyMusicPathnameToMacMini("/api/songs/local-server%3Aabc123", "GET")).toBe(true);
    expect(shouldProxyMusicPathnameToMacMini("/api/songs", "POST", "multipart/form-data")).toBe(true);
    expect(shouldProxyMusicPathnameToMacMini("/api/songs", "POST", "application/json")).toBe(false);
    expect(shouldProxyMusicPathnameToMacMini("/api/songs/spotify/batch", "POST", "application/json")).toBe(false);
  });

  test("listening-history routes stay on the Worker (PlayEvent lives in D1)", () => {
    expect(shouldProxyMusicPathnameToMacMini("/api/play-events", "POST", "application/json")).toBe(false);
    expect(shouldProxyMusicPathnameToMacMini("/api/stats/home", "GET")).toBe(false);
  });

  test("diverts folder-as-playlist reads to the mini but leaves curated/D1 playlists on the Worker", () => {
    // Local folder playlists are filesystem-derived → served by the mini.
    expect(shouldProxyMusicPathnameToMacMini("/api/playlist/local-folder-abc123", "GET")).toBe(true);
    // Reorder (or any mutation) stays on the Worker — only GET reads divert.
    expect(shouldProxyMusicPathnameToMacMini("/api/playlist/local-folder-abc123/reorder", "POST", "application/json")).toBe(false);
    // Curated Spotify playlists are resolved by the Worker before its auth gate.
    expect(shouldProxyMusicPathnameToMacMini("/api/playlist/37i9dQZF1E8MlVyHRy0DWb", "GET")).toBe(false);
    // D1-backed playlist ids (no local-folder prefix) stay on the Worker too.
    expect(shouldProxyMusicPathnameToMacMini("/api/playlist/clx9k2abc0001", "GET")).toBe(false);
  });

  test("forwards user context for folder-as-playlist reads", () => {
    expect(shouldForwardMacMiniUserForPathname("/api/playlist/local-folder-abc123")).toBe(true);
  });
});

describe("security headers on proxied responses", () => {
  test("rebuilds a response whose headers cannot be mutated in place", () => {
    // workerd gives fetch() responses an immutable header guard, so set() throws.
    // The Mac mini proxy returns those responses verbatim; the security-header
    // middleware must not 500 on them (regression: TypeError: Can't modify
    // immutable headers).
    const upstream = new Response("partial-audio", {
      status: 206,
      statusText: "Partial Content",
      headers: { "content-type": "audio/flac", etag: 'W/"abc123"' },
    });
    Object.defineProperty(upstream.headers, "set", {
      value: () => {
        throw new TypeError("Can't modify immutable headers.");
      },
    });

    const secured = withSecurityHeaders(upstream);
    expect(secured).not.toBe(upstream);
    expect(secured.status).toBe(206);
    expect(secured.statusText).toBe("Partial Content");
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff");
    expect(secured.headers.get("x-frame-options")).toBe("DENY");
    // Original upstream headers are preserved.
    expect(secured.headers.get("content-type")).toBe("audio/flac");
    expect(secured.headers.get("etag")).toBe('W/"abc123"');
  });

  test("mutates in place and returns the same response when headers are writable", () => {
    const res = new Response("{}", { headers: { "content-type": "application/json" } });
    const secured = withSecurityHeaders(res);
    expect(secured).toBe(res);
    expect(secured.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("SpotiFLAC status mapping", () => {
  test("maps spotbye resolver hosts to status keys", () => {
    expect(spotiflacStatusKeyForEndpoint("https://qbz-x.spotbye.qzz.io/api/dl")).toBe("qobuz_x");
    expect(spotiflacStatusKeyForEndpoint("https://amz-a.spotbye.qzz.io/api/dl")).toBe("amazon_a");
    expect(spotiflacStatusKeyForEndpoint("https://dzr-e.spotbye.qzz.io/api/dl")).toBe("deezer_e");
    expect(spotiflacStatusKeyForEndpoint("https://am.spotbye.qzz.io/api/dl")).toBe("apple");
    expect(spotiflacStatusKeyForEndpoint("https://provider.example.test/api/dl")).toBe("");
  });
});
