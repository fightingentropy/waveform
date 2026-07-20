// Durable Spotify→library import queue. Survives leaving the Upload screen and
// app backgrounding: remaining tracks are persisted in MMKV and drained by a
// singleton pump (foreground or background as long as JS stays alive).

import { AppState } from "react-native";
import { storage } from "@/lib/storage";
import { apiFetch } from "@/lib/http";
import { invalidateLibraryApiCache } from "@/lib/api";
import { getOfflineAccountScope } from "@/store/offline";
import type { BatchTrack } from "@/lib/spotify-batch-client";

const QUEUE_KEY = "spotify_import_queue_v1";

export type ImportQueueItem = {
  spotifyUrl: string;
  title: string;
  artist: string;
  album?: string;
};

export type ImportQueueState = {
  items: ImportQueueItem[];
  cursor: number;
  succeeded: number;
  skipped: number;
  failed: number;
  failures: string[];
  running: boolean;
  updatedAt: number;
};

type Listener = (state: ImportQueueState | null) => void;

const listeners = new Set<Listener>();
let pumping = false;
let abortRequested = false;

function emptyState(): ImportQueueState {
  return {
    items: [],
    cursor: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    running: false,
    updatedAt: Date.now(),
  };
}

function readState(): ImportQueueState | null {
  try {
    const raw = storage.getItem(QUEUE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImportQueueState;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(state: ImportQueueState | null): void {
  if (!state || (state.items.length === 0 && !state.running)) {
    storage.removeItem(QUEUE_KEY);
    for (const listener of listeners) listener(null);
    return;
  }
  storage.setItem(QUEUE_KEY, JSON.stringify(state));
  for (const listener of listeners) listener(state);
}

export function getImportQueueState(): ImportQueueState | null {
  return readState();
}

export function subscribeImportQueue(listener: Listener): () => void {
  listeners.add(listener);
  listener(readState());
  return () => {
    listeners.delete(listener);
  };
}

function normalizeTrackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

async function importOne(item: ImportQueueItem): Promise<"done" | "skipped"> {
  const res = await apiFetch("/api/songs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "spotify",
      spotifyUrl: item.spotifyUrl,
      qualityProfile: "max",
      outputFormat: "flac",
      title: item.title,
      artist: item.artist,
      album: item.album || "",
    }),
  });
  if (res.status === 409) return "skipped";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return "done";
}

async function runPump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  abortRequested = false;
  try {
    while (true) {
      if (abortRequested) break;
      const state = readState();
      if (!state || state.cursor >= state.items.length) {
        if (state) {
          writeState({ ...state, running: false, updatedAt: Date.now() });
          if (state.succeeded > 0) invalidateLibraryApiCache(getOfflineAccountScope());
        }
        break;
      }
      const item = state.items[state.cursor]!;
      const label = `${item.artist} - ${item.title}`;
      writeState({ ...state, running: true, updatedAt: Date.now() });
      try {
        const result = await importOne(item);
        const next = readState() ?? state;
        if (result === "skipped") next.skipped += 1;
        else next.succeeded += 1;
        next.cursor += 1;
        next.updatedAt = Date.now();
        writeState(next);
      } catch (error) {
        if (abortRequested) break;
        const next = readState() ?? state;
        next.failed += 1;
        next.failures = [
          ...next.failures,
          `${label}: ${error instanceof Error ? error.message : "Download failed"}`,
        ].slice(-50);
        next.cursor += 1;
        next.updatedAt = Date.now();
        writeState(next);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    pumping = false;
    const final = readState();
    if (final) writeState({ ...final, running: false, updatedAt: Date.now() });
  }
}

export function enqueueImportBatch(tracks: BatchTrack[]): ImportQueueState {
  const existing = readState();
  const seen = new Set(
    (existing?.items ?? []).map((t) => normalizeTrackKey(t.title, t.artist)),
  );
  const additions: ImportQueueItem[] = [];
  for (const track of tracks) {
    const key = normalizeTrackKey(track.title, track.artist);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({
      spotifyUrl: `https://open.spotify.com/track/${track.spotifyId}`,
      title: track.title,
      artist: track.artist,
      album: track.album,
    });
  }
  const filtered = additions.filter((t) => t.spotifyUrl);
  const base = existing && existing.cursor < existing.items.length ? existing : emptyState();
  const next: ImportQueueState = {
    ...base,
    items: [...base.items, ...filtered],
    running: true,
    updatedAt: Date.now(),
  };
  writeState(next);
  void runPump();
  return next;
}

export function cancelImportQueue(): void {
  abortRequested = true;
  const state = readState();
  if (state) writeState({ ...state, running: false, updatedAt: Date.now() });
}

export function clearImportQueue(): void {
  abortRequested = true;
  writeState(null);
}

/** Resume a persisted queue after cold start / foreground. */
export function resumeImportQueueIfNeeded(): void {
  const state = readState();
  if (state && state.cursor < state.items.length) {
    writeState({ ...state, running: true, updatedAt: Date.now() });
    void runPump();
  }
}

let appStateBound = false;
export function initImportQueue(): () => void {
  if (appStateBound) return () => {};
  appStateBound = true;
  resumeImportQueueIfNeeded();
  const sub = AppState.addEventListener("change", (next) => {
    if (next === "active") resumeImportQueueIfNeeded();
  });
  return () => {
    sub.remove();
    appStateBound = false;
  };
}
