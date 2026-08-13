export type SongKindSource = {
  id: string;
  source?: string | null;
  audioUrl?: string | null;
  discoverTrackId?: string | null;
};

export function isRadioSong(song: SongKindSource | null | undefined): boolean {
  if (!song) return false;
  return song.source === "radio" || song.id.startsWith("radio:");
}

export function isPodcastSong(song: SongKindSource | null | undefined): boolean {
  if (!song) return false;
  return song.source === "podcast" || song.id.startsWith("podcast:");
}

export function isDiscoverTrack(song: SongKindSource | null | undefined): boolean {
  return Boolean(song?.discoverTrackId);
}

export function isOfflinePlaybackSong(song: SongKindSource | null | undefined): boolean {
  if (!song) return false;
  return song.source === "offline" || Boolean(song.audioUrl?.startsWith("file://"));
}

export type SongKind = "podcast" | "radio" | "music";

export function songKind(song: SongKindSource | null | undefined): SongKind {
  if (isPodcastSong(song)) return "podcast";
  if (isRadioSong(song)) return "radio";
  return "music";
}
