import { afterEach, describe, expect, test } from "bun:test";
import { recordPlayEvent, shouldRecordPlay } from "../src/client/play-events";
import type { PlayerSong } from "../src/types/player";

type PatchedGlobal = "navigator" | "fetch";
const originalDescriptors = new Map<PatchedGlobal, PropertyDescriptor | undefined>();

function captureGlobal(key: PatchedGlobal): void {
  if (!originalDescriptors.has(key)) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
}

function restorePatchedGlobals(): void {
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  originalDescriptors.clear();
}

afterEach(() => {
  restorePatchedGlobals();
});

type RecordedRequest = { url: string; init: RequestInit | undefined };

function installFetchSpy(options: { online?: boolean } = {}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  captureGlobal("navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: options.online ?? true },
  });
  captureGlobal("fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(new Response("{}", { status: 201 }));
    },
  });
  return requests;
}

function makeSong(overrides: Partial<PlayerSong> = {}): PlayerSong {
  return {
    id: "local-server:abc123",
    title: "Test Song",
    artist: "Test Artist",
    imageUrl: "/apple-icon.png",
    audioUrl: "/api/files/local/test.flac",
    ...overrides,
  };
}

describe("recordPlayEvent", () => {
  test("posts a fire-and-forget play event for server songs", () => {
    const requests = installFetchSpy();
    recordPlayEvent(makeSong(), 215_000);
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("/api/play-events");
    expect(requests[0]!.init?.method).toBe("POST");
    expect(requests[0]!.init?.keepalive).toBe(true);
    const body = JSON.parse(String(requests[0]!.init?.body));
    expect(body.song.id).toBe("local-server:abc123");
    expect(body.durationMs).toBe(215_000);
  });

  test("strips the render-only networkImageUrl from snapshots", () => {
    const requests = installFetchSpy();
    recordPlayEvent(
      makeSong({ networkImageUrl: "https://music.streamarena.xyz/api/files/local/cover.jpg" }),
      120_000,
    );
    expect(requests.length).toBe(1);
    const body = JSON.parse(String(requests[0]!.init?.body));
    expect(body.song.networkImageUrl).toBeUndefined();
    expect(body.song.imageUrl).toBe("/apple-icon.png");
  });

  test("skips recording while offline", () => {
    const requests = installFetchSpy({ online: false });
    recordPlayEvent(makeSong());
    expect(requests.length).toBe(0);
  });

  test("skips local-only and radio songs", () => {
    const requests = installFetchSpy();
    recordPlayEvent(makeSong({ id: "browser-local:abc" }));
    recordPlayEvent(makeSong({ id: "picked-file:abc" }));
    recordPlayEvent(makeSong({ source: "browser-local" }));
    recordPlayEvent(makeSong({ source: "picked-file" }));
    recordPlayEvent(makeSong({ source: "radio" }));
    recordPlayEvent(makeSong({ id: "radio:fm-1" }));
    expect(requests.length).toBe(0);
  });

  test("swallows fetch rejections", async () => {
    installFetchSpy();
    captureGlobal("fetch");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: () => Promise.reject(new Error("network down")),
    });
    expect(() => recordPlayEvent(makeSong())).not.toThrow();
    // Let the rejected promise settle; the .catch(() => {}) must absorb it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("shouldRecordPlay", () => {
  test("records once 30 seconds were reached, regardless of duration", () => {
    expect(shouldRecordPlay(30, undefined)).toBe(true);
    expect(shouldRecordPlay(31.4, null)).toBe(true);
    expect(shouldRecordPlay(45, 3_600)).toBe(true);
  });

  test("records short tracks at half their duration", () => {
    expect(shouldRecordPlay(9, 18)).toBe(true);
    expect(shouldRecordPlay(12, 12)).toBe(true);
    expect(shouldRecordPlay(8.9, 18)).toBe(false);
  });

  test("skips quick skips below both thresholds", () => {
    expect(shouldRecordPlay(10, 240)).toBe(false);
    expect(shouldRecordPlay(29.9, undefined)).toBe(false);
    expect(shouldRecordPlay(29.9, 240)).toBe(false);
  });

  test("never records zero or invalid positions (error-skipped tracks)", () => {
    expect(shouldRecordPlay(0, 240)).toBe(false);
    expect(shouldRecordPlay(-5, 240)).toBe(false);
    expect(shouldRecordPlay(Number.NaN, 240)).toBe(false);
    expect(shouldRecordPlay(Number.POSITIVE_INFINITY, 240)).toBe(false);
  });

  test("ignores invalid durations and falls back to the 30 second rule", () => {
    expect(shouldRecordPlay(20, 0)).toBe(false);
    expect(shouldRecordPlay(20, -1)).toBe(false);
    expect(shouldRecordPlay(20, Number.NaN)).toBe(false);
    expect(shouldRecordPlay(30, Number.NaN)).toBe(true);
  });
});
