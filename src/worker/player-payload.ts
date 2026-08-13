import type { PlayerSong } from "@/types/player";
import { toNumberValue, toObject, toStringValue } from "./values";

export function coercePlayerSongPayload(value: unknown): PlayerSong | null {
  const payload = toObject(value);
  if (!payload) return null;
  const id = toStringValue(payload.id);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const audioUrl = toStringValue(payload.audioUrl);
  if (!id || !title || !artist || !audioUrl) return null;
  const imageUrl = toStringValue(payload.imageUrl) || "/apple-icon.png";
  const lyricsUrl = toStringValue(payload.lyricsUrl);
  const description = toStringValue(payload.description);
  const link = toStringValue(payload.link);
  const album = toStringValue(payload.album);
  const createdAt = toStringValue(payload.createdAt);
  const source = toStringValue(payload.source);
  const localPath = toStringValue(payload.localPath);
  const duration = toNumberValue(payload.duration);
  const audioBitDepth = toNumberValue(payload.audioBitDepth);
  const audioSampleRate = toNumberValue(payload.audioSampleRate);
  // Staging identity must survive the round-trip (play events → "Recently played",
  // playback-state restore). Dropping discoverTrackId here made a re-played catalog/
  // Discover track un-promotable: liking it found no track id, so the keep targeted
  // the throwaway "discover:" placeholder id and silently reverted. Keep the fields
  // the stager/promote path depends on.
  const discoverTrackId = toStringValue(payload.discoverTrackId);
  const youtubeVideoId = toStringValue(payload.youtubeVideoId);
  const preview = payload.preview === true;
  return {
    id,
    title,
    artist,
    album: album || undefined,
    imageUrl,
    audioUrl,
    lyricsUrl: lyricsUrl || undefined,
    description: description || undefined,
    link: link || undefined,
    duration: duration ?? undefined,
    audioBitDepth: audioBitDepth ?? undefined,
    audioSampleRate: audioSampleRate ?? undefined,
    createdAt: createdAt || new Date().toISOString(),
    source: source ? (source as PlayerSong["source"]) : undefined,
    localPath: localPath || undefined,
    discoverTrackId: discoverTrackId || undefined,
    youtubeVideoId: youtubeVideoId || undefined,
    preview: preview || undefined,
  };
}
