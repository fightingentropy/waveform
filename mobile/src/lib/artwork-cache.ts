const LOCAL_ARTWORK_PATH_PREFIX = "/api/artwork/local/";
const ROTATING_PRIVATE_MEDIA_PARAMS = new Set(["spotify_exp", "spotify_sig"]);

function decodedQueryKey(component: string): string {
  const raw = component.split("=", 1)[0]?.replace(/\+/g, " ") ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function pathnameOf(value: string): string | null {
  try {
    return new URL(value, "https://artwork-cache.invalid").pathname;
  } catch {
    return null;
  }
}

// Private Mac-mini artwork URLs receive a fresh one-hour signature as API data
// refreshes. Expo Image otherwise uses that entire rotating URL as its disk-cache
// key, so an already-rendered cover becomes a cache miss the moment the phone is
// offline. Strip only the rotating credential fields; keep account/scope identity
// (so caches remain partitioned) and real image parameters such as `w=320`.
export function stableArtworkCacheKey(value: string): string {
  const raw = value.trim();
  if (!raw) return raw;

  const hashIndex = raw.indexOf("#");
  const request = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryIndex = request.indexOf("?");
  const base = queryIndex >= 0 ? request.slice(0, queryIndex) : request;
  if (!pathnameOf(base)?.startsWith(LOCAL_ARTWORK_PATH_PREFIX)) return request;
  if (queryIndex < 0) return base;

  const retained = request
    .slice(queryIndex + 1)
    .split("&")
    .filter(Boolean)
    .filter((component) => !ROTATING_PRIVATE_MEDIA_PARAMS.has(decodedQueryKey(component)));
  return retained.length > 0 ? `${base}?${retained.join("&")}` : base;
}
