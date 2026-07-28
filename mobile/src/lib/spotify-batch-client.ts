// Server-side batch resolution for Spotify album/playlist/Liked-Songs URLs.
// The Expo app does NOT port the client-side pathfinder/cookie flow used by the
// web app — it relies on the Worker endpoint POST /api/songs/spotify/batch to
// resolve the track list (see src/worker/index.ts). Types + resolver only.

import { apiFetchWithTimeout } from "@/lib/http";

export type BatchType = "track" | "album" | "playlist";

// Mirror of BatchResponseTrack from the Worker (batchTrackForResponse).
export type BatchTrack = {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  releaseDate: string;
  totalPlays: number;
  durationMs: number;
  imageUrl: string;
  previewUrl: string;
};

export type BatchInfo = {
  type: BatchType;
  title: string;
  artist: string;
  trackCount: number;
  // Server imports stay FLAC; this is display-only and may report other formats.
  format: "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";
  trackIds: string[];
  tracks: BatchTrack[];
};

// A URL is a batch when it points at an album, playlist, or the Liked Songs
// collection — anything else (e.g. /track/) goes through the single-track path.
export function isBatchSpotifyUrl(url: string): boolean {
  return url.includes("/album/") || url.includes("/playlist/") || url.includes("/collection/");
}

// Resolve the batch by asking the Worker for the track list. The server handles
// Spotify auth/pathfinder; we just normalize its response into BatchInfo.
export async function resolveSpotifyBatch(spotifyUrl: string, signal?: AbortSignal): Promise<BatchInfo> {
  const res = await apiFetchWithTimeout("/api/songs/spotify/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spotifyUrl: spotifyUrl.trim(),
      region: "US",
      outputFormat: "flac",
      qualityProfile: "max",
    }),
    signal,
  }, 30_000);
  const data = (await res.json().catch(() => ({}))) as { batchInfo?: BatchInfo; error?: string };
  if (!res.ok || !data.batchInfo) {
    throw new Error(data.error || `Failed to fetch batch info (${res.status})`);
  }
  return data.batchInfo;
}
