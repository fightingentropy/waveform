import { useCallback, useEffect, useRef, useState } from "react";
import { markOffline } from "@/lib/connectivity";
import { API_AUTH_REQUIRED_EVENT, API_CACHE_CLEARED_EVENT, emit, on } from "@/lib/events";
import { apiFetch } from "@/lib/http";
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
  userId?: string;
  createdAt?: string;
  songsCount: number;
  // True for D1-backed playlists the app can edit (native + converted folders).
  // Undefined/false for still-unconverted mini folders (read-only) and pre-flag.
  editable?: boolean;
};

type ApiCacheEntry<T = unknown> = {
  data?: T;
  etag?: string | null;
  fetchedAt: number;
  promise?: Promise<T>;
  promiseStartedAt?: number;
};

const API_FETCH_TIMEOUT_MS = 5_000;
const API_SNAPSHOT_READ_TIMEOUT_MS = 1_000;
const apiCache = new Map<string, ApiCacheEntry>();

function getApiPath(url: string): string {
  try {
    return new URL(url, "http://spotify.local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

function getApiAuthScope(url: string): string {
  try {
    return new URL(url, "http://spotify.local").searchParams.get("auth")?.trim() || "legacy";
  } catch {
    return "legacy";
  }
}

export function withAccountScope(url: string, scope: string | null | undefined): string {
  const value = scope?.trim() || "anonymous";
  try {
    const parsed = new URL(url, "http://spotify.local");
    parsed.searchParams.set("auth", value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    params.set("auth", value);
    const serialized = params.toString();
    return serialized ? `${path}?${serialized}` : path;
  }
}

function isPersistableApiUrl(url: string): boolean {
  const path = getApiPath(url);
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
    if (!startedAt || Date.now() - startedAt > API_FETCH_TIMEOUT_MS + API_SNAPSHOT_READ_TIMEOUT_MS + 1_000) {
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

// In RN we assume connectivity; offline reads are served from the snapshot cache
// inside getCacheEntryAsync. (A NetInfo-backed online flag can refine this later.)
function canSyncApiData(): boolean {
  return true;
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
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = apiFetch(url, {
      ...init,
      signal: controller?.signal ?? init?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        // iOS can keep reporting a cellular route in a tunnel. A request that
        // cannot reach our backend within the client budget is an offline signal
        // for playback even though the OS route still exists.
        markOffline();
        controller?.abort();
        reject(new Error("Request timed out"));
      }, API_FETCH_TIMEOUT_MS);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// A shallow copy is enough for the like-cache patch: updateLikedIdsInPayload /
// updateLikedSongsInPayload only ever REASSIGN top-level arrays (likedSongIds /
// likes / songs) to freshly-built ones — they never mutate existing array
// contents or nested song objects. So we avoid deep-cloning what can be a large
// song list on every heart tap.
function shallowCloneCacheData<T>(value: T): T {
  return (value && typeof value === "object" ? { ...value } : value) as T;
}

function updateLikedIdsInPayload(data: unknown, songId: string, nextLiked: boolean): boolean {
  if (!data || typeof data !== "object") return false;
  const target = data as { likedSongIds?: unknown; likes?: unknown };
  let changed = false;
  if (hasStringArray(target.likedSongIds)) {
    const set = new Set(target.likedSongIds);
    const had = set.has(songId);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likedSongIds = Array.from(set);
    changed = had !== nextLiked;
  }
  if (hasStringArray(target.likes)) {
    const set = new Set(target.likes);
    const had = set.has(songId);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likes = Array.from(set);
    changed = changed || had !== nextLiked;
  }
  return changed;
}

function updateLikedSongsInPayload(
  data: unknown,
  payload: { songId: string; nextLiked: boolean; song?: PlayerSong },
): boolean {
  if (!data || typeof data !== "object" || !("songs" in data)) return false;
  const target = data as { songs?: unknown };
  if (!Array.isArray(target.songs)) return false;
  const songs = target.songs;
  if (payload.nextLiked) {
    if (!payload.song) return false;
    const exists = songs.some((song) => {
      return song && typeof song === "object" && (song as PlayerSong).id === payload.songId;
    });
    if (exists) return false;
    target.songs = [payload.song, ...songs];
    return true;
  }
  const before = songs.length;
  const nextSongs = songs.filter((song) => {
    return !(song && typeof song === "object" && (song as PlayerSong).id === payload.songId);
  });
  target.songs = nextSongs;
  return before !== nextSongs.length;
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
      if (next.data !== undefined && isPersistableApiUrl(url)) {
        void writeOfflineApiSnapshot(url, next.data, next.etag, next.fetchedAt);
      }
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
  // Prefer the live in-memory cache, then fall back to a synchronous read of the
  // persisted snapshot — both available on the first render, so cached screens
  // paint instantly on launch rather than blanking and popping in.
  const cachedInitial = getCachedData<T>(url) ?? primeFromSnapshotSync<T>(url);
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(enabled && !cachedInitial);
  const [error, setError] = useState<string | null>(null);
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

        if (!canSyncApiData()) {
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
    [enabled, keepPreviousData, url],
  );

  useEffect(() => {
    return startLoad(false);
  }, [startLoad]);

  // After "Clear cache" wipes the cache layers, re-pull fresh without waiting for
  // a remount so already-mounted screens (Home stays mounted) update in place.
  useEffect(() => on(API_CACHE_CLEARED_EVENT, () => startLoad(false)), [startLoad]);

  return { data, loading, error };
}

export type HomePayload = {
  // /api/home now returns only likedSongIds; the song list was dropped because
  // the home screen never rendered it. Kept optional so older cached snapshots
  // that still carry `songs` stay valid.
  songs?: PlayerSong[];
  likedSongIds: string[];
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
};

// Catalog search results (songs NOT in the library) from /api/search/catalog —
// Spotify-sourced, Discover-style placeholders that preview on tap and promote to
// lossless on a keep. Query-specific + transient, so deliberately NOT persisted.
export type SearchCatalogPayload = {
  results: PlayerSong[];
};

export type LibraryPayload = {
  playlists: PlaylistEntry[];
  userId: string | null;
};

export type LikedPayload = {
  songs: PlayerSong[];
  likedSongIds: string[];
};

export type PlaylistPayload = {
  playlist: {
    id: string;
    name: string;
    imageUrl: string | null;
    userId: string;
    createdAt: string;
    // True when served from D1 (editable). Absent for mini-served folders.
    editable?: boolean;
  } | null;
  songs: PlayerSong[];
  // null when the owner's mini like set was unreachable — the client must SKIP
  // its non-additive merge on null to avoid wiping hearts (see playlist/[id].tsx).
  likedSongIds: string[] | null;
};
