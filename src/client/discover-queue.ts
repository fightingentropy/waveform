import type { PlayerSong } from "@/types/player";

// Player-queue support for the Discover playlists (Top 50 / the YouTube Music
// Discover Mix). Their tracks play read-through like Discover — nothing is
// written to the library. The server already shapes them as PlayerSongs: a
// track that's staged arrives fully playable; one that isn't arrives as a
// PLACEHOLDER (empty audioUrl) carrying the metadata the stager needs to
// materialize it on demand when it becomes the current track. See
// DiscoverQueueStager, which drives that just-in-time staging + prefetch.

// A queue entry that still needs staging before it can play.
export function isUnstagedDiscoverSong(song: PlayerSong | null | undefined): song is PlayerSong {
  return Boolean(song && song.discoverTrackId && !song.audioUrl);
}

// Materialize an un-staged discover track into a playable song via the same
// on-demand endpoint the Discover row uses. The response carries a real
// audioUrl + stable id; we re-attach `discoverTrackId` so the now-playing
// highlight survives the swap even if the server response omits it. Throws on
// failure.
export async function stageDiscoverSong(song: PlayerSong): Promise<PlayerSong> {
  const trackId = song.discoverTrackId;
  if (!trackId) throw new Error("Not a discover track");
  // A YouTube Music mix track carries its exact videoId — the mini stages THAT
  // video's Opus directly (always a preview; there's no Spotify id to resolve).
  // A chart track goes through the Spotify-keyed path (lossless).
  const body = song.youtubeVideoId
    ? {
        trackId,
        youtubeVideoId: song.youtubeVideoId,
        preview: true,
        title: song.title,
        artist: song.artist,
        album: song.album,
        durationMs: song.duration ? Math.round(song.duration * 1000) : undefined,
        imageUrl: song.imageUrl,
      }
    : {
        spotifyUrl: `https://open.spotify.com/track/${trackId}`,
        region: "US",
        title: song.title,
        artist: song.artist,
        album: song.album,
        durationMs: song.duration ? Math.round(song.duration * 1000) : undefined,
        imageUrl: song.imageUrl,
        qualityProfile: "max",
      };
  const res = await fetch("/api/discover/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorBody?.error || `Couldn't load this track (${res.status})`);
  }
  const real = (await res.json()) as PlayerSong;
  return { ...real, discoverTrackId: trackId };
}
