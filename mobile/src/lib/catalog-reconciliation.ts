import type { PlayerSong } from "@/types/player";

export type CatalogRequestState = {
  requestIsCurrent: boolean;
  dataIsCurrent: boolean;
  loading: boolean;
  errorIsCurrent: boolean;
};

// The response payload can only identify successful requests because failed
// requests have no echoed query. Keep request currency separate from payload
// currency so a timeout/offline/validation error can settle into retry UI
// instead of looking like an endless debounce/loading state.
export function catalogRequestState(
  inputQuery: string,
  debouncedQuery: string,
  responseQuery: string,
  loading: boolean,
  error: string | null,
): CatalogRequestState {
  const trimmedQuery = inputQuery.trim();
  const requestEnabled = debouncedQuery.length >= 2;
  const requestIsCurrent = requestEnabled && debouncedQuery === trimmedQuery;
  const dataIsCurrent = requestIsCurrent && responseQuery === debouncedQuery;
  return {
    requestIsCurrent,
    dataIsCurrent,
    loading: trimmedQuery.length >= 2 && (!requestIsCurrent || loading),
    errorIsCurrent: requestIsCurrent && !loading && Boolean(error),
  };
}

export function normalizeCatalogText(value: string): string {
  const folded = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return folded || value.trim().toLocaleLowerCase();
}

export function catalogSongKey(song: Pick<PlayerSong, "title" | "artist">): string {
  return `${normalizeCatalogText(song.title)}|${normalizeCatalogText(song.artist)}`;
}

// Platform catalog rows are provider previews. If the same recording is already
// owned, return the library object instead so the existing download record and
// full-quality URL win in the normal local-first playback path.
export function reconcileCatalogSongs(
  catalogSongs: PlayerSong[],
  librarySongs: PlayerSong[],
  preferredLibrarySongs: PlayerSong[] = [],
): PlayerSong[] {
  const ownedByMetadata = new Map<string, PlayerSong>();
  // Downloaded/current-device copies go first. A library may legitimately hold
  // duplicate files with the same metadata; choosing the first search-index row
  // can otherwise miss a ready copy with a different id and make an apparently
  // downloaded catalog song stream online or disappear offline.
  for (const candidates of [preferredLibrarySongs, librarySongs]) {
    for (const song of candidates) {
      const key = catalogSongKey(song);
      if (key !== "|" && !ownedByMetadata.has(key)) ownedByMetadata.set(key, song);
    }
  }
  return catalogSongs.map((song) => ownedByMetadata.get(catalogSongKey(song)) ?? song);
}
