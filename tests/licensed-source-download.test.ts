import { afterEach, describe, expect, test } from "bun:test";
import {
  LicensedSourceDownloadError,
  materializeLicensedSourceStream,
  resolveLicensedSourceStreamUrl,
} from "../src/lib/licensed-source-download";

const originalFetch = globalThis.fetch;

describe("licensed source downloader", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts Spotify metadata and reads a JSON stream URL", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        streamUrl: "https://media.example.test/song.flac",
        headers: { "x-provider-token": "stream-token" },
        contentType: "audio/flac",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const stream = await resolveLicensedSourceStreamUrl({
      endpointUrl: "https://provider.example.test/resolve",
      apiKey: "provider-key",
      spotifyId: "0BRwoCBQR3azPbxoIjF0yR",
      spotifyUrl: "https://open.spotify.com/track/0BRwoCBQR3azPbxoIjF0yR",
      region: "us",
      title: "Lola's Theme",
      artist: "The Shapeshifters",
      qualityProfile: "max",
      outputFormat: "flac",
    });

    expect(requestUrl).toBe("https://provider.example.test/resolve");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      spotifyId: "0BRwoCBQR3azPbxoIjF0yR",
      region: "US",
      title: "Lola's Theme",
      artist: "The Shapeshifters",
      qualityProfile: "max",
      outputFormat: "flac",
    });
    expect(stream).toEqual({
      kind: "url",
      streamUrl: "https://media.example.test/song.flac",
      headers: { "x-provider-token": "stream-token" },
      contentType: "audio/flac",
      outputFormat: "flac",
      metadata: {},
      dash: undefined,
    });
  });

  test("accepts a plain signed URL response", async () => {
    globalThis.fetch = (async () =>
      new Response("https://media.example.test/signed.flac", { status: 200 })) as unknown as typeof fetch;

    const stream = await resolveLicensedSourceStreamUrl({
      endpointUrl: "https://provider.example.test/resolve",
      spotifyId: "spotify-track",
      spotifyUrl: "https://open.spotify.com/track/spotify-track",
    });

    expect(stream.kind).toBe("url");
    expect(stream.streamUrl).toBe("https://media.example.test/signed.flac");
  });

  test("preserves provider captcha and lyrics metadata", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        url: "https://amz.squid.wtf/api/stream?asin=B0CLX29FHD&country=US&tier=hd",
        key: "e610cf6f4921905ed2fce0f1977b50c0",
        captcha: "captcha-token",
        lyric: "[00:00.00] synced lyrics",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const stream = await resolveLicensedSourceStreamUrl({
      endpointUrl: "https://amz-x.spotbye.qzz.io/api/dl",
      spotifyId: "spotify-track",
      spotifyUrl: "https://open.spotify.com/track/spotify-track",
      body: { country: "US", id: "B0CLX29FHD", quality: "16" },
    });

    expect(stream.decryptionKey).toBe("e610cf6f4921905ed2fce0f1977b50c0");
    expect(stream.headers["x-captcha-token"]).toBe("captcha-token");
    expect(stream.metadata.lyrics).toBe("[00:00.00] synced lyrics");
    expect(stream.metadata.captchaToken).toBe("captcha-token");
  });

  test("signs SpotiFLAC community HMAC headers for oss hosts", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({
        streamUrl: "https://media.example.test/community.flac",
        contentType: "audio/flac",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await resolveLicensedSourceStreamUrl({
      endpointUrl: "https://tdl-oss.spotbye.qzz.io/api/dl",
      spotifyId: "7gLT8aVOkQkXQk2yTkZzhF",
      spotifyUrl: "https://open.spotify.com/track/7gLT8aVOkQkXQk2yTkZzhF",
      body: { id: "528127333", quality: "16" },
      communitySession: {
        sessionId: "sess-test",
        sessionSecret: "secret-test",
        appVersion: "7.2.2",
        platform: "desktop",
      },
    });

    const headers = new Headers(requestInit?.headers);
    expect(headers.get("user-agent")).toBe("SpotiFLAC/7.2.2");
    expect(headers.get("x-sig-session")).toBe("sess-test");
    expect(headers.get("x-sig-app-version")).toBe("7.2.2");
    expect(headers.get("x-sig-platform")).toBe("desktop");
    expect(headers.get("x-sig-signature")).toBeTruthy();
    expect(JSON.parse(String(requestInit?.body))).toEqual({ id: "528127333", quality: "16" });
  });

  test("fails clearly when the provider is not configured", async () => {
    await expect(resolveLicensedSourceStreamUrl({
      endpointUrl: "",
      spotifyId: "spotify-track",
      spotifyUrl: "https://open.spotify.com/track/spotify-track",
    })).rejects.toMatchObject({
      message: "Licensed source provider is not configured",
      status: 501,
    } satisfies Partial<LicensedSourceDownloadError>);
  });
});

// 203.0.113.0/24 is TEST-NET-3 (documentation) — a public, non-private IP
// literal that the SSRF guard accepts and node:dns resolves locally (no real
// network), so we can drive materialize end-to-end with a mocked fetch.
const MANIFEST_BASE = "https://203.0.113.10/dash/manifest.mpd";

const PADDED_MANIFEST = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <BaseURL>media/</BaseURL>
    <AdaptationSet>
      <SegmentTemplate
        initialization="$RepresentationID$/init.mp4"
        media="$RepresentationID$_$Bandwidth$/seg-$Number%05d$-t$Time$$$end.m4s"
        startNumber="1">
        <SegmentTimeline>
          <S t="0" d="48000" r="1"/>
          <S d="24000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="audio-hi" bandwidth="320000"/>
      <Representation id="audio-lo" bandwidth="96000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe("licensed source DASH materialize", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("substitutes padded/identifier SegmentTemplate tokens end-to-end", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
        status: 200,
        headers: { "content-type": "audio/mp4", "content-length": "4" },
      });
    }) as unknown as typeof fetch;

    const response = await materializeLicensedSourceStream({
      kind: "dash",
      streamUrl: MANIFEST_BASE,
      headers: {},
      contentType: "audio/mp4",
      metadata: {},
      dash: { manifestXml: PADDED_MANIFEST, manifestUrl: MANIFEST_BASE },
    });

    expect(response.status).toBe(200);
    // Three segments: t=0, t=48000, then t=96000 (24000 duration on the last S).
    expect(requestedUrls).toEqual([
      "https://203.0.113.10/dash/media/audio-hi/init.mp4",
      "https://203.0.113.10/dash/media/audio-hi_320000/seg-00001-t0$end.m4s",
      "https://203.0.113.10/dash/media/audio-hi_320000/seg-00002-t48000$end.m4s",
      "https://203.0.113.10/dash/media/audio-hi_320000/seg-00003-t96000$end.m4s",
    ]);
  });

  test("rejects a manifest with an unresolved template token", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0]).buffer, { status: 200 })) as unknown as typeof fetch;

    const badManifest = PADDED_MANIFEST.replace(
      "seg-$Number%05d$-t$Time$$$end.m4s",
      "seg-$Number$-$UnknownToken$.m4s",
    );

    await expect(materializeLicensedSourceStream({
      kind: "dash",
      streamUrl: MANIFEST_BASE,
      headers: {},
      contentType: "audio/mp4",
      metadata: {},
      dash: { manifestXml: badManifest, manifestUrl: MANIFEST_BASE },
    })).rejects.toMatchObject({ status: 502 });
  });

  test("strips caller-injected headers from outbound media fetches", async () => {
    let sentHeaders = new Headers();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(new Uint8Array([1, 2]).buffer, {
        status: 200,
        headers: { "content-type": "audio/flac", "content-length": "2" },
      });
    }) as unknown as typeof fetch;

    await materializeLicensedSourceStream({
      kind: "url",
      streamUrl: "https://203.0.113.10/song.flac",
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc",
        host: "evil.example",
        "user-agent": "provider-agent/1.0",
        range: "bytes=0-100",
      },
      contentType: "audio/flac",
      metadata: {},
    });

    expect(sentHeaders.get("authorization")).toBeNull();
    expect(sentHeaders.get("cookie")).toBeNull();
    expect(sentHeaders.get("host")).toBeNull();
    expect(sentHeaders.get("user-agent")).toBe("provider-agent/1.0");
    expect(sentHeaders.get("range")).toBe("bytes=0-100");
  });

  test("fetchMediaWithRetries honors 429 + Retry-After then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(new Uint8Array([9]).buffer, {
        status: 200,
        headers: { "content-type": "audio/flac", "content-length": "1" },
      });
    }) as unknown as typeof fetch;

    const response = await materializeLicensedSourceStream({
      kind: "url",
      streamUrl: "https://203.0.113.10/retry.flac",
      headers: {},
      contentType: "audio/flac",
      metadata: {},
    });

    expect(calls).toBe(2);
    expect(response.status).toBe(200);
  });

  test("rejects a segment whose Content-Length exceeds the remaining budget", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]).buffer, {
        status: 200,
        headers: { "content-type": "audio/mp4", "content-length": "999999999" },
      })) as unknown as typeof fetch;

    await expect(materializeLicensedSourceStream(
      {
        kind: "dash",
        streamUrl: MANIFEST_BASE,
        headers: {},
        contentType: "audio/mp4",
        metadata: {},
        dash: { manifestXml: PADDED_MANIFEST, manifestUrl: MANIFEST_BASE },
      },
      { maxBytes: 1024 },
    )).rejects.toMatchObject({ status: 413 });
  });
});
