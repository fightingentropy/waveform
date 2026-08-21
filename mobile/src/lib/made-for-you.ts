import type { StatsHomePayload } from "@/lib/api";
import type { PlayerSong } from "@/types/player";

export type MadeForYouKind = "daily" | "rediscover" | "offline" | "deep-cuts";

export type MadeForYouDefinition = {
  kind: MadeForYouKind;
  name: string;
  subtitle: string;
  description: string;
  background: string;
  accent: string;
  glow: string;
};

export const MADE_FOR_YOU_DEFINITIONS: readonly MadeForYouDefinition[] = [
  {
    kind: "daily",
    name: "Daily Mix",
    subtitle: "Favourites and fresh discoveries",
    description: "A daily rotation of music you know and recommendations shaped by your listening.",
    background: "#42268A",
    accent: "#B9A1FF",
    glow: "#7155C8",
  },
  {
    kind: "rediscover",
    name: "Rediscover",
    subtitle: "Worth hearing again",
    description: "Past favourites and library finds that have been out of your recent rotation.",
    background: "#8B3B24",
    accent: "#FFD09A",
    glow: "#C96A3D",
  },
  {
    kind: "offline",
    name: "Offline Mix",
    subtitle: "Downloaded and ready anywhere",
    description: "A rotating mix made only from verified downloads on this device.",
    background: "#145B50",
    accent: "#9CF0D7",
    glow: "#238878",
  },
  {
    kind: "deep-cuts",
    name: "Deep Cuts",
    subtitle: "More from artists you love",
    description: "Less-played songs from artists already established in your listening taste.",
    background: "#713351",
    accent: "#FFC0DE",
    glow: "#A94F7D",
  },
] as const;

export function isMadeForYouKind(value: unknown): value is MadeForYouKind {
  return MADE_FOR_YOU_DEFINITIONS.some((definition) => definition.kind === value);
}

export function madeForYouDefinition(kind: MadeForYouKind): MadeForYouDefinition {
  return MADE_FOR_YOU_DEFINITIONS.find((definition) => definition.kind === kind)!;
}

function uniqueSongs(songs: readonly PlayerSong[]): PlayerSong[] {
  const seenIds = new Set<string>();
  const seenIdentities = new Set<string>();
  return songs.filter((song) => {
    if (!song?.id || seenIds.has(song.id)) return false;
    const identity = `${song.title}\u0000${song.artist}`.normalize("NFKC").trim().toLocaleLowerCase();
    if (identity && seenIdentities.has(identity)) return false;
    seenIds.add(song.id);
    if (identity) seenIdentities.add(identity);
    return true;
  });
}

function normalizedArtist(song: PlayerSong): string {
  return song.artist.trim().toLocaleLowerCase();
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffled<T>(values: readonly T[], seed: string): T[] {
  const result = [...values];
  let state = hashString(seed) || 1;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function alternateFamiliarAndFresh(
  familiar: readonly PlayerSong[],
  fresh: readonly PlayerSong[],
): PlayerSong[] {
  const result: PlayerSong[] = [];
  let familiarIndex = 0;
  let freshIndex = 0;
  while (familiarIndex < familiar.length || freshIndex < fresh.length) {
    for (let count = 0; count < 2 && familiarIndex < familiar.length; count += 1) {
      result.push(familiar[familiarIndex++]);
    }
    if (freshIndex < fresh.length) result.push(fresh[freshIndex++]);
  }
  return uniqueSongs(result);
}

export function madeForYouRotationKey(kind: MadeForYouKind, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  if (kind === "daily" || kind === "offline") return day;
  const dayNumber = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  return `week-${Math.floor(dayNumber / 7)}`;
}

export function dailyMixSeeds(stats: StatsHomePayload): { title: string; artist: string }[] {
  return uniqueSongs([
    ...stats.recentlyPlayed.slice(0, 6),
    ...stats.mostPlayed.slice(0, 6).map((entry) => entry.song),
  ]).map((song) => ({ title: song.title, artist: song.artist }));
}

export function buildMadeForYouSongs(
  kind: MadeForYouKind,
  input: {
    librarySongs: readonly PlayerSong[];
    readyOfflineSongs: readonly PlayerSong[];
    recentlyPlayed: readonly PlayerSong[];
    mostPlayed: Readonly<StatsHomePayload["mostPlayed"]>;
    likedSongIds: ReadonlySet<string>;
    recommendations?: readonly PlayerSong[];
    rotationKey: string;
    limit?: number;
  },
): PlayerSong[] {
  const limit = Math.max(1, input.limit ?? 50);
  const library = uniqueSongs(input.librarySongs);
  const recent = uniqueSongs(input.recentlyPlayed);
  const top = uniqueSongs(input.mostPlayed.map((entry) => entry.song));
  const ready = uniqueSongs(input.readyOfflineSongs);
  const recentIds = new Set(recent.map((song) => song.id));
  const headlineIds = new Set([...recent, ...top].map((song) => song.id));

  if (kind === "offline") {
    const readyIds = new Set(ready.map((song) => song.id));
    const familiarReady = uniqueSongs([...recent, ...top]).filter((song) => readyIds.has(song.id));
    const rest = shuffled(
      ready.filter((song) => !headlineIds.has(song.id)),
      `offline:${input.rotationKey}`,
    );
    return uniqueSongs([...familiarReady, ...rest]).slice(0, limit);
  }

  if (kind === "rediscover") {
    const pastTop = top.filter((song) => !recentIds.has(song.id));
    const likedAway = library.filter(
      (song) => input.likedSongIds.has(song.id) && !recentIds.has(song.id),
    );
    const rest = library.filter((song) => !recentIds.has(song.id));
    return uniqueSongs([
      ...shuffled(pastTop, `rediscover-top:${input.rotationKey}`),
      ...shuffled(likedAway, `rediscover-liked:${input.rotationKey}`),
      ...shuffled(rest, `rediscover-rest:${input.rotationKey}`),
    ]).slice(0, limit);
  }

  const tasteArtists = new Set([...recent, ...top].map(normalizedArtist).filter(Boolean));
  const relatedLibrary = library.filter(
    (song) => tasteArtists.has(normalizedArtist(song)) && !headlineIds.has(song.id),
  );

  if (kind === "deep-cuts") {
    const likedCuts = relatedLibrary.filter((song) => input.likedSongIds.has(song.id));
    const otherCuts = relatedLibrary.filter((song) => !input.likedSongIds.has(song.id));
    const fallback = library.filter((song) => !headlineIds.has(song.id));
    return uniqueSongs([
      ...shuffled(likedCuts, `deep-liked:${input.rotationKey}`),
      ...shuffled(otherCuts, `deep-related:${input.rotationKey}`),
      ...shuffled(fallback, `deep-fallback:${input.rotationKey}`),
    ]).slice(0, limit);
  }

  const familiar = uniqueSongs([
    ...recent,
    ...top,
    ...shuffled(relatedLibrary, `daily-related:${input.rotationKey}`),
    ...shuffled(library, `daily-library:${input.rotationKey}`),
  ]).slice(0, 36);
  const familiarIds = new Set(familiar.map((song) => song.id));
  const fresh = uniqueSongs(input.recommendations ?? []).filter(
    (song) => !familiarIds.has(song.id),
  );
  return alternateFamiliarAndFresh(familiar, fresh).slice(0, limit);
}
