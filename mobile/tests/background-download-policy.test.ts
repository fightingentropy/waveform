import { describe, expect, test } from "bun:test";
import {
  applyBackgroundDownloadTransportState,
  backgroundDownloadPaths,
  backgroundDownloadPriority,
  createBackgroundDownloadTransportJob,
  createDownloadTransferToken,
  restoreRecordFromBackgroundDownloadState,
  type BackgroundDownloadTransportState,
} from "../src/lib/background-download-policy";
import {
  PLAYBACK_CACHE_SCOPE,
  type OfflineDownloadRecord,
} from "../src/lib/offline-download-queue";
import type { PlayerSong } from "../src/types/player";

function song(id = "song-1"): PlayerSong {
  return {
    id,
    title: "Song",
    artist: "Artist",
    audioUrl: `/media/${id}.m4a?signature=abc`,
    imageUrl: `/media/${id}.jpeg`,
    lyricsUrl: `/media/${id}.lrc`,
  };
}

function record(): OfflineDownloadRecord {
  return {
    accountScope: "user-a",
    songId: "song-1",
    scopes: ["liked"],
    status: "queued",
    song: song(),
    transferToken: "attempt-1",
    updatedAt: 1,
  };
}

function state(
  overrides: Partial<BackgroundDownloadTransportState> = {},
): BackgroundDownloadTransportState {
  return {
    key: "user-a:song-1",
    accountScope: "user-a",
    songId: "song-1",
    scopes: ["liked"],
    songJSON: JSON.stringify(song()),
    transferToken: "attempt-1",
    status: "downloading",
    progress: 0.5,
    bytesWritten: 50,
    bytesExpected: 100,
    revision: 2,
    updatedAt: 2,
    ...overrides,
  };
}

describe("native background download policy", () => {
  test("creates stable relative destinations and absolute transport URLs", () => {
    const item = record();
    const job = createBackgroundDownloadTransportJob(
      item,
      "user-a:song-1",
      (url) => `https://music.example${url}`,
    );

    expect(job).toMatchObject({
      transferToken: "attempt-1",
      audioPath: "offline-media/song-1/audio.m4a",
      coverPath: "offline-media/song-1/cover.jpeg",
      lyricsPath: "offline-media/song-1/lyrics.lrc",
      audioURL:
        "https://music.example/media/song-1.m4a?signature=abc",
      refreshURL: "https://music.example/api/songs/song-1",
    });
    expect(backgroundDownloadPaths(song("../unsafe")).audioPath).toStartWith(
      "offline-media/.._unsafe/",
    );
  });

  test("gives playback-ahead work priority over user batches", () => {
    expect(backgroundDownloadPriority([PLAYBACK_CACHE_SCOPE])).toBe(1);
    expect(backgroundDownloadPriority(["song:song-1"])).toBeGreaterThan(
      backgroundDownloadPriority(["liked"]),
    );
  });

  test("ignores a late completion from an obsolete transfer generation", () => {
    expect(
      applyBackgroundDownloadTransportState(
        { ...record(), transferToken: "attempt-2" },
        state({
          status: "ready",
          audioPath: "offline-media/song-1/audio.m4a",
        }),
      ),
    ).toBeNull();
  });

  test("applies a matching completion and restores a missing SQLite row", () => {
    const completed = state({
      status: "ready",
      progress: 1,
      audioPath: "offline-media/song-1/audio.m4a",
      coverPath: "offline-media/song-1/cover.jpeg",
      lyricsPath: "offline-media/song-1/lyrics.lrc",
    });
    expect(
      applyBackgroundDownloadTransportState(record(), completed),
    ).toMatchObject({
      status: "ready",
      audioPath: completed.audioPath,
      transferToken: "attempt-1",
    });
    expect(
      restoreRecordFromBackgroundDownloadState(completed),
    ).toMatchObject({
      status: "ready",
      scopes: ["liked"],
      audioPath: completed.audioPath,
      transferToken: "attempt-1",
    });
  });

  test("creates unique transport generations within the same millisecond", () => {
    const tokens = new Set(
      Array.from({ length: 1_359 }, () =>
        createDownloadTransferToken(
          () => 100,
          () => 0.5,
        ),
      ),
    );
    expect(tokens).toHaveLength(1_359);
  });
});
