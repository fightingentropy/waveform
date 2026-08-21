import { describe, expect, test } from "bun:test";
import {
  isDeviceLocalLyricsUrl,
  loadLyricsText,
} from "../src/lib/lyrics-source";

describe("offline lyrics source", () => {
  test("reads a downloaded file without touching the network", async () => {
    let remoteReads = 0;
    const text = await loadLyricsText(
      "file:///Documents/offline-media/song-1/lyrics.lrc",
      {
        readLocal: async () => "[00:00.00] local lyrics",
        fetchRemote: async () => {
          remoteReads += 1;
          return { ok: true, text: async () => "remote lyrics" };
        },
      },
    );

    expect(text).toBe("[00:00.00] local lyrics");
    expect(remoteReads).toBe(0);
    expect(isDeviceLocalLyricsUrl("/private/var/mobile/lyrics.lrc")).toBe(true);
  });

  test("uses HTTP for a streamed song and rejects failed responses", async () => {
    let localReads = 0;
    await expect(
      loadLyricsText("https://music.example/lyrics.lrc", {
        readLocal: async () => {
          localReads += 1;
          return "local";
        },
        fetchRemote: async () => ({ ok: false, text: async () => "" }),
      }),
    ).rejects.toThrow("No lyrics available");
    expect(localReads).toBe(0);
  });
});
