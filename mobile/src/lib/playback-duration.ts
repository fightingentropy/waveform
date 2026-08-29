import type { PlayerSong } from "@/types/player";

function positiveFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// Provider previews occasionally carry a malformed container duration (for
// example, an ordinary song reported by AVPlayer as eight hours). Keep normal
// native measurements authoritative, but fall back to the catalog duration when
// a Discover/catalog source disagrees by both a large absolute and relative
// margin. The loose threshold still permits normal YouTube-version differences.
export function effectivePlaybackDuration(song: PlayerSong, reportedDuration: number): number {
  const reported = positiveFinite(reportedDuration);
  const catalog = positiveFinite(song.duration);
  if (!reported) return catalog;
  if (!catalog || !song.discoverTrackId) return reported;

  const shorter = Math.min(reported, catalog);
  const longer = Math.max(reported, catalog);
  const wildlyDifferent = longer - shorter >= 30 && longer / shorter >= 1.5;
  return wildlyDifferent ? catalog : reported;
}
