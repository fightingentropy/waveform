const DEFAULT_READ_TIMEOUT_MS = 5_000;
const CATALOG_SEARCH_TIMEOUT_MS = 9_000;
const SPOTIFY_CATALOG_TIMEOUT_MS = 15_000;
const YOUTUBE_PLAYLIST_TIMEOUT_MS = 22_000;

function apiPath(url: string): string {
  try {
    return new URL(url, "http://spotify.local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

export function isProviderReadThroughRequest(url: string): boolean {
  const path = apiPath(url);
  return (
    path === "/api/search/catalog" ||
    path.startsWith("/api/catalog/") ||
    path.startsWith("/api/playlist/yt-mix-") ||
    path === "/api/playlist/discover-top50"
  );
}

export function apiReadTimeoutMs(url: string): number {
  const path = apiPath(url);
  if (path === "/api/search/catalog") return CATALOG_SEARCH_TIMEOUT_MS;
  if (path.startsWith("/api/catalog/")) return SPOTIFY_CATALOG_TIMEOUT_MS;
  if (path.startsWith("/api/playlist/yt-mix-")) return YOUTUBE_PLAYLIST_TIMEOUT_MS;
  if (path === "/api/playlist/discover-top50") return SPOTIFY_CATALOG_TIMEOUT_MS;
  return DEFAULT_READ_TIMEOUT_MS;
}
