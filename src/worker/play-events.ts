import type { PlayerSong } from "@/types/player";

function isDeviceLocalMediaUrl(value: string): boolean {
  // Browser-local uploads play from blob: URLs the server can't fetch, so a play
  // event that references one is rejected rather than recorded.
  return /^blob:/i.test(value);
}

export function playEventSongHasDeviceLocalUrl(
  song: Pick<PlayerSong, "audioUrl" | "imageUrl" | "lyricsUrl">,
): boolean {
  return [song.audioUrl, song.imageUrl, song.lyricsUrl].some(
    (value) => !!value && isDeviceLocalMediaUrl(value),
  );
}

export type PlayEventMediaUrls = Pick<PlayerSong, "id" | "imageUrl" | "audioUrl" | "lyricsUrl">;

export function mergeRefreshedPlayEventMediaUrls(
  songs: PlayerSong[],
  refreshed: PlayEventMediaUrls[],
): PlayerSong[] {
  const mediaById = new Map(refreshed.map((song) => [song.id, song] as const));
  return songs.map((song) => {
    const media = mediaById.get(song.id);
    if (!media) return song;
    return {
      ...song,
      imageUrl: media.imageUrl || song.imageUrl,
      audioUrl: media.audioUrl || song.audioUrl,
      lyricsUrl: media.lyricsUrl || undefined,
    };
  });
}
