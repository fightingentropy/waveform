import type { PlayerSong } from "@/types/player";

export function isSameLogicalPlaybackSong(
  first: PlayerSong | null | undefined,
  second: PlayerSong | null | undefined,
): boolean {
  if (!first || !second) return false;
  if (first.id === second.id) return true;
  return Boolean(
    first.discoverTrackId && first.discoverTrackId === second.discoverTrackId,
  );
}

// A preview and its lossless replacement can have different local-server ids
// because their file extensions differ. Match the provider track id as a logical
// fallback so a keep request can still replace a preview that won the queue race.
export function isStagedSongReplacementTarget(
  candidate: PlayerSong | null | undefined,
  oldId: string,
  replacement: PlayerSong,
): boolean {
  if (!candidate) return false;
  if (candidate.id === oldId) return true;
  const sameLogicalTrack = Boolean(
    replacement.discoverTrackId && candidate.discoverTrackId === replacement.discoverTrackId,
  );
  if (!sameLogicalTrack) return false;
  // A preview request may have started first but its response can reach the app
  // after the queued lossless upgrade. Never downgrade that newer queue item.
  if (replacement.preview === true && candidate.preview === false) return false;
  return true;
}

export function findStagedSongReplacementIndex(
  queue: PlayerSong[],
  oldId: string,
  replacement: PlayerSong,
): number {
  return queue.findIndex((candidate) =>
    isStagedSongReplacementTarget(candidate, oldId, replacement));
}
