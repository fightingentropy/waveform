import { apiFetch } from "@/lib/http";
import { stageDiscoverSong } from "@/lib/discover-queue";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

type StagedSongReplacementListener = (previous: PlayerSong, replacement: PlayerSong) => void;

// Ported from src/client/discover-keep.ts. "Keeping" a staged Discover/catalog track
// — liking it, adding it to a playlist, or downloading it — first promotes it out of
// the Mac-mini's hidden .discover staging cache into the real library (so it scans
// and can be liked/owned). Promotion returns the now-real song (stable id, library
// audioUrl); we swap it into the player queue so subsequent loads use the library
// copy. Returns the promoted song, the original song if it wasn't staged, or null if
// promotion failed (callers should abort the keep action in that case).
export async function promoteStagedSong(
  song: PlayerSong,
  onReplacement?: StagedSongReplacementListener,
): Promise<PlayerSong | null> {
  if (!song.discoverTrackId) return song;
  // finalId lets the server stay idempotent: if this track was already promoted (no
  // longer staged), it returns the existing library song.
  const promote = (target: PlayerSong) =>
    apiFetch("/api/discover/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: target.discoverTrackId, finalId: target.id }),
    });
  try {
    let current = song;
    let res = await promote(current);
    // Two reasons a first promote fails and a lossless (re)stage fixes it:
    //   409 preview_not_lossless — the track was played, so it's staged, but only as
    //     a lossy YouTube PREVIEW (catalog search / Discover), which the mini won't
    //     promote into the FLAC library.
    //   404 staged-track-not-found — the track was never played, so there's no
    //     .discover entry to promote at all (e.g. liked straight from a list).
    // Either way, stage it losslessly (resolver → FLAC) once and promote the real
    // source — this keeps the library FLAC-only while playback stays resolver-free.
    // (A song you already own short-circuits to 200 before the 409 when it's staged;
    // a stream-only YouTube-mix track has no lossless source so the retry promote
    // still fails and the keep aborts cleanly.)
    if (res.status === 409 || res.status === 404) {
      const previous = current;
      current = await stageDiscoverSong(song, { preview: false });
      onReplacement?.(previous, current);
      usePlayerStore.getState().replaceStagedSong(previous.id, current);
      res = await promote(current);
    }
    if (!res.ok) return null;
    const promoted = (await res.json()) as PlayerSong;
    if (!promoted?.id || !promoted.audioUrl) return null;
    onReplacement?.(current, promoted);
    usePlayerStore.getState().replaceStagedSong(current.id, promoted);
    return promoted;
  } catch {
    return null;
  }
}
