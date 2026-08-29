export const YOUTUBE_PLAYLIST_SEARCH_INCLUDE = "youtube-playlists";

export type CatalogSearchFilter = "top" | "songs" | "artists" | "playlists";
export type CatalogSearchSection = "songs" | "artists" | "playlists";

const SECTION_ORDER: Record<CatalogSearchFilter, readonly CatalogSearchSection[]> = {
  top: ["songs", "artists", "playlists"],
  songs: ["songs"],
  artists: ["artists"],
  playlists: ["playlists"],
};

export function catalogSearchSectionOrder(
  filter: CatalogSearchFilter,
): readonly CatalogSearchSection[] {
  return SECTION_ORDER[filter];
}

export function catalogSearchPath(query: string, filter: CatalogSearchFilter): string {
  const includeYouTube =
    filter === "playlists" ? `&include=${YOUTUBE_PLAYLIST_SEARCH_INCLUDE}` : "";
  return `/api/search/catalog?q=${encodeURIComponent(query)}${includeYouTube}`;
}
