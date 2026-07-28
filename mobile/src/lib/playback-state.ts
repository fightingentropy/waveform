import { apiFetch } from "@/lib/http";
import { isRadioSong } from "@/lib/player-song";
import { storage } from "@/lib/storage";
import type { PlayerSong } from "@/types/player";

// Cross-device resume. Ported from src/lib/playback-state.ts +
// src/client/playback-state.ts. localStorage → MMKV; fetch → apiFetch; the
// online-pending-sync queue is simplified (we attempt server writes directly and
// fall back to the local snapshot). Last-write-wins on updatedAt.

export const PLAYBACK_STATE_VERSION = 1;
const PLAYBACK_STATE_STORAGE_KEY = "spotify_player_state";
const PLAYBACK_DEVICE_ID_STORAGE_KEY = "spotify_playback_device_id";

export type PlaybackStateSnapshot = {
  version: typeof PLAYBACK_STATE_VERSION;
  accountScope: string;
  queue: PlayerSong[];
  currentIndex: number;
  queueContextKey: string | null;
  song: PlayerSong;
  currentTime: number;
  isPlaying: boolean;
  updatedAt: number;
  deviceId: string;
};

export function isPersistablePlayerSong(song: PlayerSong | null | undefined): song is PlayerSong {
  if (!song) return false;
  if (isRadioSong(song)) return false;
  // Discover tracks play from the ephemeral .discover staging cache: staging URLs
  // are rebuilt by a cron and the id isn't a library id. Persisting one means a
  // relaunch tries to resume a stale/missing source and jumps off the song — so we
  // never write Discover playback to the resume snapshot. buildSnapshot returns
  // null while one is current, leaving the last REAL-library song as what the phone
  // resumes. Covers both placeholders ("discover:" id) and staged copies.
  if (song.discoverTrackId || song.id.startsWith("discover:")) return false;
  if (song.id.startsWith("browser-local:") || song.id.startsWith("picked-file:")) return false;
  if (
    song.source === "offline" ||
    song.source === "browser-local" ||
    song.source === "picked-file" ||
    /^(file|blob|data):/i.test(song.audioUrl)
  ) {
    return false;
  }
  return true;
}

function toObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coercePlayerSong(value: unknown): PlayerSong | null {
  const payload = toObject(value);
  if (!payload) return null;
  const id = toStringValue(payload.id);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const audioUrl = toStringValue(payload.audioUrl);
  if (!id || !title || !artist || !audioUrl) return null;
  return {
    id,
    title,
    artist,
    album: toStringValue(payload.album) || undefined,
    imageUrl: toStringValue(payload.imageUrl) || "/apple-icon.png",
    audioUrl,
    lyricsUrl: toStringValue(payload.lyricsUrl) || undefined,
    description: toStringValue(payload.description) || undefined,
    link: toStringValue(payload.link) || undefined,
    createdAt: toStringValue(payload.createdAt) || undefined,
    duration: toNumberValue(payload.duration) ?? undefined,
    audioBitDepth: toNumberValue(payload.audioBitDepth) ?? undefined,
    audioSampleRate: toNumberValue(payload.audioSampleRate) ?? undefined,
    source: (toStringValue(payload.source) as PlayerSong["source"]) || undefined,
    localPath: toStringValue(payload.localPath) || undefined,
  };
}

function randomDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    try {
      return crypto.randomUUID();
    } catch {}
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getPlaybackDeviceId(): string {
  try {
    const stored = storage.getItem(PLAYBACK_DEVICE_ID_STORAGE_KEY);
    if (stored) return stored;
    const id = randomDeviceId();
    storage.setItem(PLAYBACK_DEVICE_ID_STORAGE_KEY, id);
    return id;
  } catch {
    return randomDeviceId();
  }
}

export function coercePlaybackState(value: unknown, fallbackUpdatedAt = 0): PlaybackStateSnapshot | null {
  const payload = toObject(value);
  if (!payload) return null;
  if (payload.version !== undefined && payload.version !== PLAYBACK_STATE_VERSION) return null;

  const rawQueue = Array.isArray(payload.queue) ? payload.queue : [];
  const queue = rawQueue.map(coercePlayerSong).filter((song): song is PlayerSong => Boolean(song && isPersistablePlayerSong(song)));
  const payloadSong = coercePlayerSong(payload.song);
  const song =
    payloadSong && isPersistablePlayerSong(payloadSong)
      ? payloadSong
      : queue[Math.max(0, Math.min(queue.length - 1, Math.floor(toNumberValue(payload.currentIndex) ?? 0)))] ?? null;
  if (!song) return null;

  const queueWithSong = queue.some((item) => item.id === song.id) ? queue : [song, ...queue];
  const indexFromPayload = Math.floor(toNumberValue(payload.currentIndex) ?? -1);
  const indexFromSong = queueWithSong.findIndex((item) => item.id === song.id);
  const currentIndex =
    indexFromSong >= 0 ? indexFromSong : Math.max(0, Math.min(queueWithSong.length - 1, indexFromPayload));

  return {
    version: PLAYBACK_STATE_VERSION,
    accountScope: toStringValue(payload.accountScope) || "anonymous",
    queue: queueWithSong,
    currentIndex,
    queueContextKey: toStringValue(payload.queueContextKey) || null,
    song,
    currentTime: Math.max(0, toNumberValue(payload.currentTime) ?? 0),
    isPlaying: payload.isPlaying === true,
    updatedAt: Math.max(0, toNumberValue(payload.updatedAt) ?? fallbackUpdatedAt),
    deviceId: toStringValue(payload.deviceId) || getPlaybackDeviceId(),
  };
}

export function readLocalPlaybackState(): PlaybackStateSnapshot | null {
  try {
    const raw = storage.getItem(PLAYBACK_STATE_STORAGE_KEY);
    return raw ? coercePlaybackState(JSON.parse(raw), 0) : null;
  } catch {
    return null;
  }
}

export function writeLocalPlaybackState(state: PlaybackStateSnapshot): void {
  try {
    storage.setItem(PLAYBACK_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function removeLocalPlaybackState(): void {
  try {
    storage.removeItem(PLAYBACK_STATE_STORAGE_KEY);
  } catch {}
}

export async function fetchServerPlaybackState(): Promise<PlaybackStateSnapshot | null> {
  const response = await apiFetch("/api/playback-state", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error("Could not fetch playback state");
  const payload = (await response.json()) as { state?: unknown };
  return coercePlaybackState(payload.state, 0);
}

export async function writeServerPlaybackState(state: PlaybackStateSnapshot): Promise<PlaybackStateSnapshot | null> {
  const response = await apiFetch("/api/playback-state", {
    method: "PUT",
    cache: "no-store",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error("Could not write playback state");
  const payload = (await response.json()) as { state?: unknown };
  return coercePlaybackState(payload.state, state.updatedAt);
}
