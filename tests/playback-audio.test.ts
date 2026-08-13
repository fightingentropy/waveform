import { describe, expect, test } from "bun:test";
import {
  crossOriginForAudioSrc,
  errorName,
  finiteMediaDuration,
  isHlsPlaylistSrc,
  isIosLikePlatform,
  seekIsCloseEnough,
} from "../src/lib/playback-audio";

describe("finiteMediaDuration", () => {
  test("keeps positive finite durations and rejects the rest", () => {
    expect(finiteMediaDuration(214)).toBe(214);
    expect(finiteMediaDuration(0)).toBeNull();
    expect(finiteMediaDuration(-1)).toBeNull();
    expect(finiteMediaDuration(Number.NaN)).toBeNull();
    expect(finiteMediaDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("seekIsCloseEnough", () => {
  test("accepts landings inside the default 0.75s window", () => {
    expect(seekIsCloseEnough(12.2, 12.5)).toBe(true);
    expect(seekIsCloseEnough(10, 12)).toBe(false);
  });
});

describe("isHlsPlaylistSrc", () => {
  test("detects m3u8 playlists without treating query-less audio as HLS", () => {
    expect(isHlsPlaylistSrc("https://cdn.example/track.m3u8")).toBe(true);
    expect(isHlsPlaylistSrc("/api/files/local/track.m3u8?spotify_sig=abc")).toBe(true);
    expect(isHlsPlaylistSrc("/api/files/local/track.flac")).toBe(false);
  });
});

describe("isIosLikePlatform", () => {
  test("treats iPhone and touch Macintosh as iOS-like", () => {
    expect(isIosLikePlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe(true);
    expect(isIosLikePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIosLikePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
  });
});

describe("crossOriginForAudioSrc", () => {
  test("uses credentials only for the app origin and anonymous CORS for third parties", () => {
    expect(crossOriginForAudioSrc("blob:https://music.example/1", "https://music.example")).toBeNull();
    expect(crossOriginForAudioSrc("/api/files/local/a.flac", "https://music.example")).toBeNull();
    expect(crossOriginForAudioSrc("https://music.streamarena.xyz/api/files/local/a.flac", "https://other.example")).toBe(
      "use-credentials",
    );
    expect(crossOriginForAudioSrc("https://radio.example/live.mp3", "https://music.example")).toBe("anonymous");
  });
});

describe("errorName", () => {
  test("reads DOMException-style names and ignores plain values", () => {
    expect(errorName(new DOMException("stopped", "AbortError"))).toBe("AbortError");
    expect(errorName("AbortError")).toBe("");
  });
});
