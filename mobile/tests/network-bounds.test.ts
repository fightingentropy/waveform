import { describe, expect, test } from "bun:test";
import { readPodcastFeedPrefix } from "../src/lib/podcasts";
import {
  RequestTimeoutError,
  withRequestTimeout,
} from "../src/lib/request-timeout";
import {
  apiReadTimeoutMs,
  isProviderReadThroughRequest,
} from "../src/lib/api-timeout-policy";

describe("request timeout", () => {
  test("rejects a blackholed request and aborts its transport", async () => {
    let requestSignal: AbortSignal | undefined;
    const request = withRequestTimeout(
      (signal) => {
        requestSignal = signal;
        return new Promise<never>(() => {});
      },
      { timeoutMs: 10 },
    );

    await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(requestSignal?.aborted).toBe(true);
  });

  test("forwards caller cancellation without relabeling it as a timeout", async () => {
    const caller = new AbortController();
    const aborted = new Error("cancelled by caller");
    const request = withRequestTimeout(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(aborted), { once: true });
        }),
      { timeoutMs: 1_000, signal: caller.signal },
    );

    caller.abort();
    await expect(request).rejects.toBe(aborted);
  });
});

describe("API read timeout policy", () => {
  test("gives bounded provider read-throughs enough time without classifying them as connectivity failures", () => {
    const search = "/api/search/catalog?q=radiohead&auth=user";
    const playlistSearch = "/api/search/catalog?q=radiohead&include=youtube-playlists&auth=user";
    const spotifyPlaylist = "/api/catalog/spotify/playlists/37i9dQZF1DXcBWIGoYBM5M";
    const youtubePlaylist = "/api/playlist/yt-mix-PL123456789";
    const topFifty = "/api/playlist/discover-top50";

    expect(apiReadTimeoutMs(search)).toBe(9_000);
    expect(apiReadTimeoutMs(playlistSearch)).toBe(9_000);
    expect(apiReadTimeoutMs(spotifyPlaylist)).toBe(15_000);
    expect(apiReadTimeoutMs(youtubePlaylist)).toBe(22_000);
    expect(apiReadTimeoutMs(topFifty)).toBe(15_000);
    expect(isProviderReadThroughRequest(search)).toBe(true);
    expect(isProviderReadThroughRequest(spotifyPlaylist)).toBe(true);
    expect(isProviderReadThroughRequest(youtubePlaylist)).toBe(true);
    expect(isProviderReadThroughRequest(topFifty)).toBe(true);
  });

  test("keeps ordinary API reads on the fast connectivity budget", () => {
    expect(apiReadTimeoutMs("/api/library?auth=user")).toBe(5_000);
    expect(isProviderReadThroughRequest("/api/library?auth=user")).toBe(false);
  });
});

describe("podcast feed streaming bounds", () => {
  test("stops after the requested number of complete items", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    let cancelled = false;
    const chunks = [
      "<rss><channel><title>Show</title><item><title>One</title></item>",
      "<item><title>Two</title></item>",
      "<item><title>Three</title></item></channel></rss>",
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pullCount++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });

    const text = await readPodcastFeedPrefix(new Response(body), { maxItems: 2 });

    expect(text).toContain("<title>Two</title>");
    expect(text).not.toContain("<title>Three</title>");
    expect(cancelled).toBe(true);
  });

  test("retains no more than the byte budget", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("1234567890"));
        controller.enqueue(encoder.encode("abcdefghij"));
        controller.close();
      },
    });

    const text = await readPodcastFeedPrefix(new Response(body), {
      maxBytes: 13,
      maxItems: 1,
    });

    expect(text).toBe("1234567890abc");
    expect(encoder.encode(text).byteLength).toBe(13);
  });
});
