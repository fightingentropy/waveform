import { toObject, toStringValue } from "@/lib/provider-http";
import { YOUTUBE_PLAYLIST_SEARCH_INCLUDE } from "@spotify/shared/catalog-search";

export type YouTubeCatalogPlaylist = {
  kind: "playlist";
  provider: "youtube";
  id: string;
  name: string;
  imageUrl: string | null;
  ownerName?: string;
  externalUrl: string;
};

export function shouldIncludeYouTubePlaylistSearch(searchParams: URLSearchParams): boolean {
  return searchParams
    .getAll("include")
    .flatMap((value) => value.split(","))
    .some((value) => value.trim().toLowerCase() === YOUTUBE_PLAYLIST_SEARCH_INCLUDE);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

export function parseYouTubePlaylistSearchPayload(payload: unknown): YouTubeCatalogPlaylist[] {
  const rows = Array.isArray(toObject(payload)?.playlists) ? toObject(payload)?.playlists : [];
  const playlists: YouTubeCatalogPlaylist[] = [];
  const seen = new Set<string>();
  for (const row of rows as unknown[]) {
    const item = toObject(row);
    const id = toStringValue(item?.id);
    const name = toStringValue(item?.name);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !name || seen.has(id)) continue;
    const image = parseHttpUrl(toStringValue(item?.imageUrl));
    const imageUrl = image?.protocol === "https:" ? image.toString() : null;
    const ownerName = toStringValue(item?.ownerName);
    seen.add(id);
    playlists.push({
      kind: "playlist",
      provider: "youtube",
      id,
      name,
      imageUrl,
      ...(ownerName ? { ownerName } : {}),
      externalUrl: `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`,
    });
    if (playlists.length >= 8) break;
  }
  return playlists;
}
