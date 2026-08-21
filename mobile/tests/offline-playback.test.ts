import { describe, expect, test } from "bun:test";
import {
  catalogRequestState,
  catalogSongKey,
  reconcileCatalogSongs,
} from "../src/lib/catalog-reconciliation";
import { portablePlaybackSong, preferDownloadedPlaybackSong } from "../src/lib/offline-playback";
import type { PlayerSong } from "../src/types/player";

const remoteSong: PlayerSong = {
  id: "song-1",
  title: "Song",
  artist: "Artist",
  imageUrl: "/api/artwork/song-1.jpg",
  lyricsUrl: "/api/lyrics/song-1.lrc",
  audioUrl: "/api/files/song-1.flac",
  source: "server",
};

const readyRecord = {
  status: "ready",
  song: remoteSong,
};

describe("offline playback source preference", () => {
  test("a ready downloaded file wins without consulting connectivity", () => {
    const resolved = preferDownloadedPlaybackSong(remoteSong, readyRecord, {
      audioUrl: "file:///Documents/offline-media/song-1/audio.flac",
      imageUrl: "file:///Documents/offline-media/song-1/cover.jpg",
      lyricsUrl: "file:///Documents/offline-media/song-1/lyrics.lrc",
    });

    expect(resolved.source).toBe("offline");
    expect(resolved.audioUrl).toBe("file:///Documents/offline-media/song-1/audio.flac");
    expect(resolved.imageUrl).toBe("file:///Documents/offline-media/song-1/cover.jpg");
    expect(resolved.networkImageUrl).toBe(remoteSong.imageUrl);
  });

  test("validated audio stays local while artwork or lyrics is being repaired", () => {
    const resolved = preferDownloadedPlaybackSong(
      remoteSong,
      { ...readyRecord, status: "downloading" },
      {
        audioUrl: "file:///Documents/offline-media/song-1/audio.flac",
        imageUrl: null,
        lyricsUrl: null,
      },
    );

    expect(resolved.source).toBe("offline");
    expect(resolved.audioUrl).toStartWith("file://");
  });

  test("a record without a usable local path leaves a server song remote", () => {
    expect(
      preferDownloadedPlaybackSong(remoteSong, readyRecord, {
        audioUrl: "offline-media/song-1/audio.flac",
        imageUrl: null,
        lyricsUrl: null,
      }),
    ).toBe(remoteSong);
  });

  test("an unusable Downloads entry falls back to its saved remote song", () => {
    const downloadsEntry: PlayerSong = {
      ...remoteSong,
      source: "offline",
      audioUrl: "offline-media/song-1/audio.flac",
    };

    expect(
      preferDownloadedPlaybackSong(downloadsEntry, readyRecord, {
        audioUrl: null,
        imageUrl: null,
        lyricsUrl: null,
      }),
    ).toBe(remoteSong);
  });

  test("cross-device persistence converts a downloaded entry back to its remote source", () => {
    const downloaded: PlayerSong = {
      ...remoteSong,
      source: "offline",
      audioUrl: "file:///Documents/offline-media/song-1/audio.flac",
      imageUrl: "file:///Documents/offline-media/song-1/cover.jpg",
    };

    expect(portablePlaybackSong(downloaded, readyRecord)).toBe(remoteSong);
  });

  test("a device-local entry without a backing record stays local for the persistence filter to reject", () => {
    const orphaned: PlayerSong = {
      ...remoteSong,
      source: "offline",
      audioUrl: "file:///old-container/audio.flac",
    };
    expect(portablePlaybackSong(orphaned, null)).toBe(orphaned);
  });
});

describe("catalog playback reconciliation", () => {
  test("an owned library song replaces its provider preview before queueing", () => {
    const preview: PlayerSong = {
      ...remoteSong,
      id: "discover:spotify-track-id",
      audioUrl: "",
      preview: true,
    };
    const [reconciled] = reconcileCatalogSongs([preview], [remoteSong]);

    expect(reconciled).toBe(remoteSong);
  });

  test("Unicode title and artist identities remain distinct and match exactly", () => {
    const japanese: PlayerSong = {
      ...remoteSong,
      id: "jp",
      title: "夜に駆ける",
      artist: "ヨアソビ",
    };
    const arabic: PlayerSong = {
      ...remoteSong,
      id: "ar",
      title: "ليلي",
      artist: "فنان",
    };

    expect(catalogSongKey(japanese)).not.toBe(catalogSongKey(arabic));
    expect(reconcileCatalogSongs([{ ...japanese, id: "discover:jp" }], [japanese])[0]).toBe(japanese);
  });

  test("a ready duplicate is preferred over the first same-metadata library row", () => {
    const firstLibraryCopy = { ...remoteSong, id: "library-copy-a" };
    const downloadedCopy = { ...remoteSong, id: "library-copy-b" };
    const preview = { ...remoteSong, id: "discover:copy", audioUrl: "", preview: true };

    expect(
      reconcileCatalogSongs([preview], [firstLibraryCopy, downloadedCopy], [downloadedCopy])[0],
    ).toBe(downloadedCopy);
  });
});

describe("catalog request presentation", () => {
  test("a current failed request stops loading and exposes retry UI without an echoed response query", () => {
    expect(
      catalogRequestState(
        "Radiohead",
        "Radiohead",
        "",
        false,
        "Taking too long to load — please retry.",
      ),
    ).toEqual({
      requestIsCurrent: true,
      dataIsCurrent: false,
      loading: false,
      errorIsCurrent: true,
    });
  });

  test("a new query remains loading only while its debounce or request is outstanding", () => {
    expect(catalogRequestState("Radiohead", "Radio", "Radio", false, null).loading).toBe(true);
    expect(catalogRequestState("Radiohead", "Radiohead", "", true, null).loading).toBe(true);
  });
});
