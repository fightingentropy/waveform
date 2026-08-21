import type { AddTrack } from "react-native-track-player";
import { toAbsoluteApiUrl } from "@/lib/config";
import { isRadioSong } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";

// Prefer downloaded artwork for the lock screen too. The custom native engine
// reads file:// covers directly; HTTP(S) remains the fallback for streamed
// songs. data:/blob: URLs are process-bound and cannot be handed to native code.
export function lockScreenArtwork(song: PlayerSong): string | undefined {
  const localCandidate = song.imageUrl
    ? toAbsoluteApiUrl(song.imageUrl)
    : undefined;
  if (localCandidate && /^file:/i.test(localCandidate)) return localCandidate;
  const candidate = song.networkImageUrl || song.imageUrl;
  if (!candidate) return undefined;
  const resolved = toAbsoluteApiUrl(candidate);
  if (/^(data|blob):/i.test(resolved)) return undefined;
  return resolved;
}

// Convert a PlayerSong into an RNTP track. The signed audioUrl is passed VERBATIM
// (only the origin is prepended for relative URLs) — re-encoding or stripping the
// signature returns 403 and the track silently fails (§1).
export function buildTrack(song: PlayerSong): AddTrack {
  return {
    id: song.id,
    url: toAbsoluteApiUrl(song.audioUrl),
    title: song.title,
    artist: song.artist,
    album: song.album,
    artwork: lockScreenArtwork(song),
    duration: song.duration,
    isLiveStream: isRadioSong(song),
  };
}
