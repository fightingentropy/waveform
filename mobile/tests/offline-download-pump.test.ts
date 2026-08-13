import { describe, expect, test } from "bun:test";
import {
  PLAYBACK_CACHE_SCOPE,
  nextQueuedDownload,
  type OfflineDownloadRecord,
} from "../src/lib/offline-download-queue";
import type { PlayerSong } from "../src/types/player";

function song(id: string): PlayerSong {
  return {
    id,
    title: id,
    artist: "Artist",
    imageUrl: "",
    audioUrl: `/api/files/${id}.flac`,
    source: "server",
  };
}

function record(
  overrides: Partial<OfflineDownloadRecord> & Pick<OfflineDownloadRecord, "songId">,
): OfflineDownloadRecord {
  return {
    accountScope: "user-a",
    scopes: ["liked"],
    status: "queued",
    song: song(overrides.songId),
    updatedAt: 1,
    ...overrides,
  };
}

describe("nextQueuedDownload", () => {
  test("returns undefined when nothing is queued for the account", () => {
    expect(
      nextQueuedDownload(
        [
          record({ songId: "ready", status: "ready" }),
          record({ songId: "other", accountScope: "user-b" }),
        ],
        "user-a",
      ),
    ).toBeUndefined();
  });

  test("prefers the playback-ahead cache over bulk liked or playlist pins", () => {
    const liked = record({ songId: "liked", scopes: ["liked"] });
    const cached = record({ songId: "ahead", scopes: [PLAYBACK_CACHE_SCOPE] });
    expect(nextQueuedDownload([liked, cached], "user-a")).toBe(cached);
  });

  test("falls back to the first queued row when nothing is cache-ahead", () => {
    const first = record({ songId: "one" });
    const second = record({ songId: "two", scopes: ["playlist:abc"] });
    expect(nextQueuedDownload([first, second], "user-a")).toBe(first);
  });
});
