import { afterEach, describe, expect, test } from "bun:test";
import { prepareHistorySongForPlayback, stageDiscoverSong } from "../src/client/discover-queue";
import type { PlayerSong } from "../src/types/player";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const preview: PlayerSong = {
  id: "local-server:preview",
  title: "Stargazing - Moonlight Version",
  artist: "Myles Smith",
  audioUrl: "/api/files/local/.discover/track/preview.opus?signature=old",
  imageUrl: "/api/files/local/.discover/track/cover.jpg",
  discoverTrackId: "6IdFbZkzvaS7apASHareqI",
  duration: 180,
  preview: true,
};

describe("replaying history after the preview cache is pruned", () => {
  test("resolves temporary previews again without changing saved library songs", () => {
    const replay = prepareHistorySongForPlayback(preview);
    expect(replay.audioUrl).toBe("");
    expect(replay.discoverTrackId).toBe(preview.discoverTrackId);
    expect(replay.title).toBe(preview.title);
    expect(preview.audioUrl).not.toBe("");
    const promoted = { ...preview, audioUrl: "/api/files/local/saved.flac" };
    expect(prepareHistorySongForPlayback(promoted)).toBe(promoted);
    const lossless = { ...preview, preview: false };
    expect(prepareHistorySongForPlayback(lossless)).toBe(lossless);
  });

  test("restages a history preview in preview mode and keeps its identity", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      body = JSON.parse(String(options?.body));
      return Response.json({ ...preview, preview: undefined, discoverTrackId: undefined, audioUrl: "/fresh.opus" });
    }) as unknown as typeof fetch;
    const song = await stageDiscoverSong(prepareHistorySongForPlayback(preview));
    expect(body.preview).toBe(true);
    expect(body.durationMs).toBe(180_000);
    expect(song.audioUrl).toBe("/fresh.opus");
    expect(song.preview).toBe(true);
    expect(song.discoverTrackId).toBe(preview.discoverTrackId);
  });
});
