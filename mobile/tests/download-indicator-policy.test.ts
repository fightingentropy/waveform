import { describe, expect, test } from "bun:test";
import {
  getScopedDownloadStatus,
  offlineDownloadKey,
  planQueuedDownloads,
  type DownloadStatus,
} from "../src/lib/offline-download-queue";
import type { PlayerSong } from "../src/types/player";

function song(index: number): PlayerSong {
  return {
    id: `song-${index}`,
    title: `Song ${index}`,
    artist: "Artist",
    album: "Album",
    duration: 180,
    imageUrl: `/cover-${index}.jpg`,
    audioUrl: `/audio-${index}.m4a`,
  };
}

describe("collection download indicators", () => {
  test("a Download all batch immediately exposes queued state for every song", () => {
    const songs = Array.from({ length: 1_359 }, (_, index) => song(index));
    const planned = planQueuedDownloads({}, songs, "liked", "user-1");

    expect(planned.changedRecords).toHaveLength(songs.length);
    expect(
      songs.every((item) => {
        const record = planned.records[offlineDownloadKey("user-1", item.id)];
        return getScopedDownloadStatus(record, "liked") === "queued";
      }),
    ).toBe(true);
  });

  test("shows each queue transition only for the collection pin it represents", () => {
    const item = song(1);
    const planned = planQueuedDownloads({}, [item], "playlist:mix", "user-1");
    const queued = planned.records[offlineDownloadKey("user-1", item.id)];
    const statuses: DownloadStatus[] = ["queued", "downloading", "ready", "error"];

    for (const status of statuses) {
      expect(getScopedDownloadStatus({ ...queued, status }, "playlist:mix")).toBe(status);
    }
    expect(getScopedDownloadStatus(queued, `song:${item.id}`)).toBeUndefined();
  });
});
