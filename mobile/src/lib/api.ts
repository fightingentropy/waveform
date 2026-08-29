import { useCallback, useEffect, useRef, useState } from "react";
import {
  getApiAuthScope,
  getApiPath,
  withAccountScope,
} from "@spotify/shared/account-scope";
import { updateLikedIdsInPayload, updateLikedSongsInPayload } from "@spotify/shared/like-cache";
import { apiReadTimeoutMs, isProviderReadThroughRequest } from "@/lib/api-timeout-policy";
import { markOffline } from "@/lib/connectivity";
import { API_AUTH_REQUIRED_EVENT, API_CACHE_CLEARED_EVENT, emit, on } from "@/lib/events";
import { apiFetch } from "@/lib/http";
import { useOnlineStatus } from "@/lib/use-connectivity";
import {
  readOfflineApiSnapshot,
  readOfflineApiSnapshotSync,
  removeOfflineApiSnapshots,
  writeOfflineApiSnapshot,
} from "@/lib/offline-snapshots";
import type { PlayerSong } from "@/types/player";

export { API_AUTH_REQUIRED_EVENT } from "@/lib/events";

// Ported from src/client/api.ts. The cache / ETag / in-flight-dedup / timeout /
// patchLikeApiCache / useApiData logic is preserved. Web-only bits are swapped:
// fetch goes through apiFetch (origin + cookie), the auth-required signal uses the
// event bus instead of window.dispatchEvent, navigator.onLine / serviceWorker /
// Cache API branches are removed, and offline snapshots persist to MMKV.

export type PlaylistEntry = {
  id: string;
  name: string;
  imageUrl?: string | null;
  coverImageUrls?: string[];
  userId?: string;
  createdAt?: string;
  songsCount: number;
  // True for D1-backed playlists the app can edit (native + converted folders).
  // Undefined/false for still-unconverted mini folders (read-only) and pre-flag.
  editable?: boolean;
  // Explicit server capability. When absent on an older payload, clients fall
  // back to editable + the protected local-folder id convention.
  deletable?: boolean;
};

type ApiCacheEntry<T = unknown> = {
  data?: T;
  etag?: string | null;
  fetchedAt: number;
  promise?: Promise<T>;
  promiseStartedAt?: number;
};

const API_SNAPSHOT_READ_TIMEOUT_MS = 1_000;
const apiCache = new Map<string, ApiCacheEntry>();

export { withAccountScope };

function isPersistableApiUrl(url: string): boolean {
  const path = getApiPath(url);
  if (isProviderReadThroughRequest(url)) return false;
  return (
    path === "/api/home" ||
    path === "/api/discover/trending" ||
    path === "/api/discover/playlists" ||
    path === "/api/search-index" ||
    path === "/api/library" ||
    path === "/api/liked" ||
    path === "/api/likes" ||
    path === "/api/music/source" ||
    path === "/api/songs" ||
    path === "/api/stats/home" ||
    path === "/api/stats/listening" ||
    path.startsWith("/api/playlist/")
  );
}

function getCacheEntry<T>(url: string): ApiCacheEntry<T> | undefined {
  const memory = apiCache.get(url) as ApiCacheEntry<T> | undefined;
  if (!memory) return undefined;
  if (memory.promise) {
    const startedAt = memory.promiseStartedAt ?? (memory.fetchedAt > 0 ? memory.fetchedAt : 0);
    if (!startedAt || Date.now() - startedAt > apiReadTimeoutMs(url) + API_SNAPSHOT_READ_TIMEOUT_MS + 1_000) {
      apiCache.set(url, {
        data: memory.data,
        etag: memory.etag,
        fetchedAt: memory.fetchedAt,
      });
      return memory.data === undefined ? undefined : getCacheEntry<T>(url);
    }
    return memory;
  }
  if (memory.data !== undefined) return memory;
  return undefined;
}

async function readStoredApiCache<T>(url: string): Promise<ApiCacheEntry<T> | undefined> {
  if (!isPersistableApiUrl(url)) return undefined;

  const snapshot = await withClientTimeout(
    readOfflineApiSnapshot<T>(url),
    API_SNAPSHOT_READ_TIMEOUT_MS,
    "Offline snapshot read timed out",
  ).catch(() => undefined);
  if (!snapshot || snapshot.data === undefined || typeof snapshot.fetchedAt !== "number") return undefined;
  return {
    data: snapshot.data,
    etag: snapshot.etag ?? null,
    fetchedAt: snapshot.fetchedAt,
  };
}

async function getCacheEntryAsync<T>(url: string): Promise<ApiCacheEntry<T> | undefined> {
  const memory = getCacheEntry<T>(url);
  if (memory?.data !== undefined || memory?.promise) return memory;
  const stored = await readStoredApiCache<T>(url);
  if (stored) apiCache.set(url, stored);
  return stored;
}

function getCachedData<T>(url: string): T | undefined {
  return getCacheEntry<T>(url)?.data;
}

// Synchronously hydrate the in-memory cache from a persisted MMKV snapshot, so
// useApiData can paint cached data on its very first render instead of flashing
// empty and popping in a tick later once the async snapshot read resolves. Only
// touches persistable URLs and never clobbers a live in-memory entry.
function primeFromSnapshotSync<T>(url: string): T | undefined {
  const existing = getCacheEntry<T>(url);
  if (existing?.data !== undefined) return existing.data;
  if (apiCache.has(url) || !isPersistableApiUrl(url)) return undefined;
  const snapshot = readOfflineApiSnapshotSync<T>(url);
  if (!snapshot || snapshot.data === undefined) return undefined;
  apiCache.set(url, { data: snapshot.data, etag: snapshot.etag ?? null, fetchedAt: snapshot.fetchedAt });
  return snapshot.data;
}

function writeApiCache<T>(url: string, data: T, etag?: string | null): T {
  const entry: ApiCacheEntry<T> = { data, etag: etag ?? null, fetchedAt: Date.now() };
  apiCache.set(url, entry);
  if (isPersistableApiUrl(url)) {
    void writeOfflineApiSnapshot(url, data, entry.etag, entry.fetchedAt);
  }
  return data;
}

// Wipe every API cache layer (in-memory entries + ETags + persisted MMKV
// snapshots) so the next fetch ignores the cached copy and pulls fresh. Emits
// API_CACHE_CLEARED_EVENT, which mounted useApiData hooks listen for to re-fetch
// immediately (no need to remount the screen or restart the app). Does NOT touch
// offline downloads, auth, or user settings — only the read-through API cache.
export async function clearApiDataCache(): Promise<void> {
  apiCache.clear();
  await removeOfflineApiSnapshots();
  emit(API_CACHE_CLEARED_EVENT);
}

function offlineCacheMissMessage(url: string): string {
  const path = getApiPath(url);
  if (path === "/api/home") return "Your library has not been cached for offline use yet.";
  if (path === "/api/search-index") return "Search has not been cached for offline use yet.";
  if (path === "/api/library") return "Your library sidebar has not been cached for offline use yet.";
  if (path === "/api/liked" || path === "/api/likes") return "Liked songs have not been cached for offline use yet.";
  if (path.startsWith("/api/playlist/")) return "This playlist has not been cached for offline use yet.";
  return "This data has not been cached for offline use yet.";
}

function apiErrorMessage(url: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  if (/request timed out|abort/i.test(message)) {
    return "Taking too long to load — please retry.";
  }
  if (/offline|network and cache miss|failed to fetch|load failed|network request failed/i.test(message)) {
    return offlineCacheMissMessage(url);
  }
  return message;
}

function dispatchApiAuthRequired(url: string): void {
  emit(API_AUTH_REQUIRED_EVENT, { url });
}

async function withClientTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutMs = apiReadTimeoutMs(url);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = apiFetch(url, {
      ...init,
      signal: controller?.signal ?? init?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        // Core API reads timing out are a reachability signal. Provider
        // read-through routes are different: Spotify/YouTube may be slow while
        // our backend and downloaded playback remain healthy, so never flip the
        // whole player offline for those.
        if (!isProviderReadThroughRequest(url)) markOffline();
        controller?.abort();
        reject(new Error("Request timed out"));
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// A shallow copy is enough for the like-cache patch: updateLikedIdsInPayload /
// updateLikedSongsInPayload only ever REASSIGN top-level arrays (likedSongIds /
// likes / songs) to freshly-built ones — they never mutate existing array
// contents or nested song objects. So we avoid deep-cloning what can be a large
// song list on every heart tap.
function shallowCloneCacheData<T>(value: T): T {
  return (value && typeof value === "object" ? { ...value } : value) as T;
}

export function patchLikeApiCache(
  songId: string,
  nextLiked: boolean,
  song?: PlayerSong,
  accountScope?: string,
): void {
  const scopedAccount = accountScope?.trim();
  for (const [url, entry] of Array.from(apiCache.entries())) {
    if (entry.data === undefined) continue;
    if (scopedAccount && getApiAuthScope(url) !== scopedAccount) continue;
    const path = getApiPath(url);
    if (
      path !== "/api/home" &&
      path !== "/api/liked" &&
      path !== "/api/likes" &&
      !path.startsWith("/api/playlist/")
    ) {
      continue;
    }

    const next = shallowCloneCacheData(entry.data);
    let changed = updateLikedIdsInPayload(next, songId, nextLiked);
    if (path === "/api/liked") {
      changed = updateLikedSongsInPayload(next, { songId, nextLiked, song }) || changed;
    }
    if (changed) writeApiCache(url, next, null);
  }
}

async function fetchApiData<T>(url: string): Promise<T> {
  const cached = await getCacheEntryAsync<T>(url);
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const headers = new Headers({ accept: "application/json" });
    if (cached?.etag && cached.data !== undefined) headers.set("if-none-match", cached.etag);

    const response = await fetchWithTimeout(url, {
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached?.data !== undefined) {
      // Prefer the live cache entry so in-flight optimistic patches
      // (e.g. patchLikeApiCache) made while this request was flying survive.
      const live = apiCache.get(url) as ApiCacheEntry<T> | undefined;
      const current = live?.data !== undefined ? live : cached;
      return writeApiCache(url, current.data as T, current.etag ?? null);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string; offline?: boolean };
      if (response.status === 401) dispatchApiAuthRequired(url);
      if (payload.offline) throw new Error(offlineCacheMissMessage(url));
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return writeApiCache(url, (await response.json()) as T, response.headers.get("etag"));
  })();

  apiCache.set(url, {
    data: cached?.data,
    etag: cached?.etag,
    fetchedAt: cached?.fetchedAt ?? 0,
    promise,
    promiseStartedAt: Date.now(),
  });

  try {
    return await promise;
  } finally {
    const next = apiCache.get(url);
    if (next?.promise === promise) {
      apiCache.set(url, {
        data: next.data,
        etag: next.etag,
        fetchedAt: next.fetchedAt,
      });
    }
  }
}

export function invalidateApiCache(match?: string | RegExp | ((url: string) => boolean)): void {
  if (!match) {
    apiCache.clear();
    void removeOfflineApiSnapshots();
    return;
  }

  for (const key of Array.from(apiCache.keys())) {
    const shouldDelete =
      typeof match === "string"
        ? key === match || key.startsWith(match)
        : match instanceof RegExp
          ? match.test(key)
          : match(key);
    if (shouldDelete) apiCache.delete(key);
  }
  void removeOfflineApiSnapshots(match);
}

export function invalidateLibraryApiCache(accountScope?: string): void {
  const scopedAccount = accountScope?.trim();
  invalidateApiCache((url) => {
    if (scopedAccount && getApiAuthScope(url) !== scopedAccount) return false;
    const path = getApiPath(url);
    return (
      path === "/api/home" ||
      path === "/api/search-index" ||
      path === "/api/songs" ||
      path === "/api/liked" ||
      path === "/api/likes" ||
      path === "/api/stats/home" ||
      path === "/api/stats/listening" ||
      path.startsWith("/api/music/source") ||
      path.startsWith("/api/library") ||
      path.startsWith("/api/playlist/")
    );
  });
}

export function useApiData<T>(
  url: string,
  initialValue: T,
  options?: { enabled?: boolean; keepPreviousData?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const keepPreviousData = options?.keepPreviousData ?? false;
  const isOnline = useOnlineStatus();
  // Prefer the live in-memory cache, then fall back to a synchronous read of the
  // persisted snapshot — both available on the first render, so cached screens
  // paint instantly on launch rather than blanking and popping in.
  const cachedInitial = getCachedData<T>(url) ?? primeFromSnapshotSync<T>(url);
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(enabled && !cachedInitial);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dataUrlRef = useRef(cachedInitial !== undefined ? url : "");
  const initialValueRef = useRef(initialValue);

  useEffect(() => {
    initialValueRef.current = initialValue;
  }, [initialValue]);

  const startLoad = useCallback(
    (background = false) => {
      if (!enabled) {
        setLoading(false);
        return undefined;
      }

      let cancelled = false;

      async function run() {
        const cached = await getCacheEntryAsync<T>(url);
        const cachedData = cached?.data;
        // keepPreviousData should only suppress the spinner/error when data is
        // actually on screen — on a cold load (no visible data yet) it must NOT
        // mask fetch errors, or every page renders an outage as an empty library.
        const hasVisibleData = dataUrlRef.current !== "";
        const canReuseCurrentData = dataUrlRef.current === url || (keepPreviousData && hasVisibleData);

        if (cancelled) return;
        if (cachedData !== undefined) {
          setDataState(cachedData);
          dataUrlRef.current = url;
          setLoading(false);
          setError(null);
        } else if (!background && !canReuseCurrentData) {
          setDataState(initialValueRef.current);
          dataUrlRef.current = "";
          setLoading(true);
        } else {
          setLoading(false);
        }

        if (!isOnline) {
          if (cachedData === undefined && !canReuseCurrentData) {
            setError(offlineCacheMissMessage(url));
          }
          setLoading(false);
          return;
        }

        if (!background || cachedData !== undefined) setError(null);
        try {
          const payload = await fetchApiData<T>(url);
          if (!cancelled) {
            setDataState(payload);
            dataUrlRef.current = url;
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setError(cachedData === undefined && !canReuseCurrentData ? apiErrorMessage(url, err) : null);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      void run();
      return () => {
        cancelled = true;
      };
    },
    [enabled, isOnline, keepPreviousData, url],
  );

  useEffect(() => {
    return startLoad(false);
  }, [startLoad, reloadKey]);

  const retry = useCallback(() => {
    invalidateApiCache(url);
    setReloadKey((value) => value + 1);
  }, [url]);

  // After "Clear cache" wipes the cache layers, re-pull fresh without waiting for
  // a remount so already-mounted screens (Home stays mounted) update in place.
  useEffect(() => {
    let cancelLoad: (() => void) | undefined;
    const unsubscribe = on(API_CACHE_CLEARED_EVENT, () => {
      cancelLoad?.();
      cancelLoad = startLoad(false);
    });
    return () => {
      unsubscribe();
      cancelLoad?.();
    };
  }, [startLoad]);

  return { data, loading, error, retry };
}

export type HomePayload = {
  // /api/home now returns only likedSongIds; the song list was dropped because
  // the home screen never rendered it. Kept optional so older cached snapshots
  // that still carry `songs` stay valid.
  songs?: PlayerSong[];
  likedSongIds: string[] | null;
};

export type StatsHomePayload = {
  recentlyPlayed: PlayerSong[];
  mostPlayed: { song: PlayerSong; playCount: number }[];
};

export type ListeningWeek = {
  weekStart: string;
  weekEnd: string;
  minutesListened: number;
  topSong: PlayerSong | null;
  topArtist: { name: string; image: string | null } | null;
};
export type ListeningStatsPayload = { weeks: ListeningWeek[] };

// A globally-trending track from the Discover row. Not in the library. When
// `staged` is true it's already pre-downloaded into the Mac-mini's hidden
// .discover cache and plays instantly from `audioUrl` (with stable library id
// `audioId`); otherwise a tap materializes it on demand via /api/discover/stage.
export type DiscoverTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  imageUrl: string;
  durationMs: number | null;
  spotifyUrl: string;
  staged?: boolean;
  audioId?: string;
  audioUrl?: string;
};

export type DiscoverPayload = {
  tracks: DiscoverTrack[];
};

// The Home "Discover" first row as clickable, auto-updating playlists (Top 50 +
// the YouTube Music Discover Mix) instead of a scroll of individual tracks. Each
// opens /api/playlist/:id like any other playlist.
export type DiscoverPlaylistsPayload = {
  playlists: PlaylistEntry[];
};

export type SearchIndexPayload = {
  songs: PlayerSong[];
  nextCursor?: string | null;
};

export type CatalogProvider = "spotify" | "youtube";
export type CatalogProviderStatus = "ok" | "unavailable" | "not_configured" | "not_requested";

export type CatalogPlaylist = {
  kind: "playlist";
  provider: CatalogProvider;
  id: string;
  name: string;
  imageUrl: string | null;
  description?: string;
  ownerName?: string;
  trackCount?: number;
  externalUrl: string;
};

export type CatalogArtist = {
  kind: "artist";
  provider: "spotify";
  id: string;
  name: string;
  imageUrl: string | null;
  externalUrl: string;
  genres?: string[];
  followers?: number;
};

// Catalog search is query-specific + transient, so deliberately NOT persisted.
// `results` stays backward-compatible with the original song-only endpoint:
// Spotify songs are Discover-style placeholders that preview on tap and promote
// to lossless on a keep. Entity summaries navigate to read-through catalog pages.
export type SearchCatalogPayload = {
  query: string;
  results: PlayerSong[];
  playlists: CatalogPlaylist[];
  artists: CatalogArtist[];
  providers?: Partial<Record<CatalogProvider, CatalogProviderStatus>>;
};

export type CatalogArtistPayload = {
  provider: "spotify";
  artist: CatalogArtist | null;
  songs: PlayerSong[];
};

export type LibraryPayload = {
  playlists: PlaylistEntry[];
  userId: string | null;
};

export type LikedPayload = {
  songs: PlayerSong[];
  likedSongIds: string[] | null;
};

export type PlaylistPayload = {
  playlist: {
    id: string;
    name: string;
    imageUrl: string | null;
    userId?: string;
    createdAt?: string;
    trackCount?: number;
    description?: string;
    externalUrl?: string;
    // True when served from D1 (editable). Absent for mini-served folders.
    editable?: boolean;
    deletable?: boolean;
  } | null;
  songs: PlayerSong[];
  // null when the owner's mini like set was unreachable — the client must SKIP
  // its non-additive merge on null to avoid wiping hearts (see playlist/[id].tsx).
  likedSongIds: string[] | null;
  page?: {
    offset: number;
    limit: number;
    totalCount: number;
    nextOffset: number | null;
  };
};
