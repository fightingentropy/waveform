import { describe, expect, test } from "bun:test";
import {
  getDownloadControlAction,
  getScopedDownloadStatus,
  getUserDownloadStatus,
  offlineDownloadKey,
  planQueuedDownloads,
  PLAYBACK_CACHE_SCOPE,
  type DownloadStatus,
} from "../src/lib/offline-download-queue";
import type { PlayerSong } from "../src/types/player";

const nowPlayingSource = await Bun.file(
  new URL("../src/components/player/NowPlayingSheet.tsx", import.meta.url),
).text();
const downloadButtonSource = await Bun.file(
  new URL("../src/components/song/DownloadButton.tsx", import.meta.url),
).text();

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

  test("Now Playing reflects any user-owned download but not playback prefetches", () => {
    const item = song(2);
    const key = offlineDownloadKey("user-1", item.id);
    const liked = planQueuedDownloads({}, [item], "liked", "user-1").records[key];
    const playlist = planQueuedDownloads({}, [item], "playlist:mix", "user-1").records[key];
    const direct = planQueuedDownloads({}, [item], `song:${item.id}`, "user-1").records[key];
    const cache = planQueuedDownloads({}, [item], PLAYBACK_CACHE_SCOPE, "user-1").records[key];

    expect(getUserDownloadStatus({ ...liked, status: "ready" })).toBe("ready");
    expect(getUserDownloadStatus({ ...playlist, status: "ready" })).toBe("ready");
    expect(getUserDownloadStatus({ ...direct, status: "ready" })).toBe("ready");
    expect(getUserDownloadStatus({ ...cache, status: "ready" })).toBeUndefined();

    const cachedAndLiked = planQueuedDownloads(
      { [key]: { ...cache, status: "ready" } },
      [item],
      "liked",
      "user-1",
    ).records[key];
    expect(getUserDownloadStatus(cachedAndLiked)).toBe("ready");

    const statuses: DownloadStatus[] = ["queued", "downloading", "ready", "error"];
    for (const status of statuses) {
      expect(getUserDownloadStatus({ ...liked, status })).toBe(status);
    }
  });

  test("wires the user-visible policy into Now Playing", () => {
    expect(nowPlayingSource).toContain("getUserDownloadStatus(record)");
    expect(nowPlayingSource).toContain("const scopedStatus = getScopedDownloadStatus(record, songScope)");
    expect(nowPlayingSource).toContain(
      "getDownloadControlAction(displayStatus, scopedStatus)",
    );
  });

  test("a direct Now Playing download is visibly downloaded in a collection row", () => {
    const item = song(3);
    const key = offlineDownloadKey("user-1", item.id);
    const direct = planQueuedDownloads({}, [item], `song:${item.id}`, "user-1").records[key];
    const ready = { ...direct, status: "ready" as const };

    expect(getUserDownloadStatus(ready)).toBe("ready");
    expect(getScopedDownloadStatus(ready, "liked")).toBeUndefined();
    expect(getDownloadControlAction("ready", undefined)).toBe("status-only");
    expect(downloadButtonSource).toContain("const displayStatus = getUserDownloadStatus(record)");
    expect(downloadButtonSource).toContain(
      "getDownloadControlAction(displayStatus, scopedStatus)",
    );
  });

  test("keeps inherited collection states status-only while direct pins stay actionable", () => {
    const inheritedStatuses: DownloadStatus[] = ["queued", "downloading", "ready", "error"];
    for (const status of inheritedStatuses) {
      expect(getDownloadControlAction(status, undefined)).toBe("status-only");
    }

    expect(getDownloadControlAction("ready", "ready")).toBe("unpin");
    expect(getDownloadControlAction("downloading", "downloading")).toBe("unpin");
    expect(getDownloadControlAction("error", "error")).toBe("queue");
    expect(getDownloadControlAction(undefined, undefined)).toBe("queue");
  });
});
