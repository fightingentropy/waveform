import type { PlayerSong } from "@/types/player";

// Small, platform-free playback-source policy. Keeping this separate from the
// SQLite/FileSystem store makes the important invariant testable: a ready local
// file wins regardless of connectivity, while an offline-shaped queue entry can
// still fall back to the record's original remote song when the file is absent.
export type OfflinePlaybackRecordLike = {
  status: string;
  song: PlayerSong;
};

export type ResolvedOfflineMedia = {
  audioUrl: string | null;
  imageUrl: string | null;
  lyricsUrl: string | null;
};

export function preferDownloadedPlaybackSong(
  song: PlayerSong,
  record: OfflinePlaybackRecordLike | null | undefined,
  media: ResolvedOfflineMedia,
): PlayerSong {
  // Songs constructed by the Downloads screen carry the local path directly.
  // If that path is no longer usable, recover the original remote source saved
  // in the download record instead of returning an unplayable relative path.
  const fallback = song.source === "offline" && record?.song.audioUrl ? record.song : song;
  const localAudioUrl =
    typeof media.audioUrl === "string" &&
    (/^file:\/\//i.test(media.audioUrl) || media.audioUrl.startsWith("/"))
      ? media.audioUrl
      : null;
  if (!record || record.status !== "ready" || !localAudioUrl) return fallback;

  return {
    ...song,
    source: "offline",
    audioUrl: localAudioUrl,
    imageUrl: media.imageUrl ?? song.imageUrl,
    networkImageUrl: song.networkImageUrl ?? fallback.networkImageUrl ?? fallback.imageUrl,
    lyricsUrl: media.lyricsUrl ?? song.lyricsUrl,
  };
}

// Playback snapshots are synced to another device, so the inverse source
// transformation is required when a queue was opened from the Downloads screen:
// replace its file:// entry with the original server song stored in the record.
// If no record exists, leave it unchanged and let isPersistablePlayerSong reject
// the device-local source rather than publishing an unusable container path.
export function portablePlaybackSong(
  song: PlayerSong,
  record: OfflinePlaybackRecordLike | null | undefined,
): PlayerSong {
  const deviceLocal =
    song.source === "offline" ||
    song.source === "browser-local" ||
    song.source === "picked-file" ||
    /^(file|blob|data):/i.test(song.audioUrl);
  return deviceLocal && record?.song.audioUrl ? record.song : song;
}
