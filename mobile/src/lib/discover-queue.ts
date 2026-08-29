import { apiFetch } from "@/lib/http";
import type { DiscoverTrack } from "@/lib/api";
import type { PlayerSong } from "@/types/player";

// Player-queue support for Discover. A whole Discover row can now be queued (not
// just the one tapped track), so there's a real "up next". Tracks play
// read-through like before — nothing is written to the library. A track that's
// already staged becomes a fully playable queue entry; one that isn't becomes a
// PLACEHOLDER (empty audioUrl) carrying the metadata the stager needs to
// materialize it on demand when it becomes the current track. See the
// DiscoverQueueStager (discover-stager.ts), which drives that just-in-time
// staging + one-ahead prefetch. Ported from the web src/client/discover-queue.ts;
// the only change is relative fetch → apiFetch (origin + cookie).

export const DISCOVER_PLACEHOLDER_PREFIX = "discover:";

export function discoverTrackToPlayerSong(track: DiscoverTrack): PlayerSong {
  const duration = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;
  // Already staged: a real, instantly-playable song (stable library id `audioId`).
  if (track.staged && track.audioUrl && track.audioId) {
    return {
      id: track.audioId,
      title: track.title,
      artist: track.artist,
      album: track.album || undefined,
      imageUrl: track.imageUrl,
      audioUrl: track.audioUrl,
      duration,
      source: "server",
      staged: true,
      discoverTrackId: track.id,
    };
  }
  // Not staged: a placeholder. The empty audioUrl marks it for the stager and
  // keeps the engine idle (rather than erroring) until the real source lands.
  return {
    id: `${DISCOVER_PLACEHOLDER_PREFIX}${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    imageUrl: track.imageUrl,
    audioUrl: "",
    duration,
    source: "server",
    discoverTrackId: track.id,
  };
}

// A queue entry that still needs staging before it can play. Returns a plain
// boolean (not a `song is PlayerSong` predicate): callers always gate on
// `song && isUnstagedDiscoverSong(song)`, and a predicate would wrongly narrow
// `song` to `never` in the code after an early `return` in that branch.
export function isUnstagedDiscoverSong(song: PlayerSong | null | undefined): boolean {
  return Boolean(song && song.discoverTrackId && !song.audioUrl);
}

// Materialize an un-staged Discover track into a playable song via the same
// on-demand endpoint a tile tap uses. The response carries a real audioUrl + a
// stable id; we re-attach `discoverTrackId` so the now-playing highlight survives
// the swap even if the server response omits it. Throws on failure.
// `preview: true` stages a cheap YouTube Opus copy on the mini (play/skip) instead
// of resolving a lossless source — used for Smart Shuffle recs. Omit it (the
// default) for the curated Discover row and for the Add-to-library path, which
// need the lossless resolver so the library stays FLAC-only.
export async function stageDiscoverSong(
  song: PlayerSong,
  opts?: { preview?: boolean },
): Promise<PlayerSong> {
  const trackId = song.discoverTrackId;
  if (!trackId) throw new Error("Not a discover track");
  // A YouTube Music mix track carries its exact videoId — the mini stages THAT
  // video's Opus directly (always a preview; there's no Spotify id to resolve). A
  // chart track goes through the Spotify-keyed path (lossless unless preview).
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
        ...(opts?.preview ? { preview: true } : {}),
      };
  const res = await apiFetch("/api/discover/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Couldn't load this track (${res.status})`);
  }
  const real = (await res.json()) as PlayerSong;
  return {
    ...real,
    discoverTrackId: trackId,
    // Preserve staging quality on the queue item. Besides documenting the source,
    // this prevents a late preview response from replacing a lossless upgrade.
    preview: opts?.preview === true || Boolean(song.youtubeVideoId),
  };
}
