import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerSong } from "@/types/player";

// The signed-in account the API cache + optimistic patches are scoped to. Kept
// here (rather than in a player/store module) because api.ts owns withAccountScope
// and patchLikeApiCache, the two things that actually read it. auth.tsx sets it on
// every auth transition; likes.ts reads it before patching cached payloads.
let currentAccountScope = "anonymous";

export function normalizeAccountScope(scope: string | null | undefined): string {
  const value = scope?.trim();
  return value && value !== "loading" ? value : "anonymous";
}

export function getAccountScope(): string {
  return currentAccountScope;
}

export function setAccountScope(scope: string | null | undefined): void {
  currentAccountScope = normalizeAccountScope(scope);
}

export type PlaylistEntry = {
  id: string;
  name: string;
  imageUrl?: string | null;
  userId?: string;
  createdAt?: string;
  songsCount: number;
};

type ApiCacheEntry<T = unknown> = {
  data?: T;
  etag?: string | null;
  fetchedAt: number;
  promise?: Promise<T>;
  promiseStartedAt?: number;
};

export const API_AUTH_REQUIRED_EVENT = "spotify:api-auth-required";
const API_FETCH_TIMEOUT_MS = 5_000;
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

function getCacheEntry<T>(url: string): ApiCacheEntry<T> | undefined {
  const memory = apiCache.get(url) as ApiCacheEntry<T> | undefined;
  if (!memory) return undefined;
  if (memory.promise) {
    const startedAt = memory.promiseStartedAt ?? (memory.fetchedAt > 0 ? memory.fetchedAt : 0);
    if (!startedAt || Date.now() - startedAt > API_FETCH_TIMEOUT_MS + 2_000) {
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

function getCachedData<T>(url: string): T | undefined {
  return getCacheEntry<T>(url)?.data;
}

function writeApiCache<T>(url: string, data: T, etag?: string | null): T {
  apiCache.set(url, { data, etag: etag ?? null, fetchedAt: Date.now() });
  return data;
}

function apiErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  if (/request timed out|abort/i.test(message)) {
    return "Taking too long to load — please retry.";
  }
  if (/failed to fetch|load failed|network connection.*lost|network error/i.test(message)) {
    return "Couldn't load — check your connection and retry.";
  }
  if (/internal server error|request failed with 5\d\d/i.test(message)) {
    return "Something went wrong while loading this page. Please retry.";
  }
  return message;
}

function dispatchApiAuthRequired(url: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { url } }));
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") return fetch(input, init);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId: number | undefined;
  try {
    const request = fetch(input, {
      ...init,
      signal: controller?.signal ?? init?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        controller?.abort();
        reject(new Error("Request timed out"));
      }, API_FETCH_TIMEOUT_MS);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function cloneCacheData<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
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

    const next = cloneCacheData(entry.data);
    let changed = updateLikedIdsInPayload(next, songId, nextLiked);
    if (path === "/api/liked") {
      changed = updateLikedSongsInPayload(next, { songId, nextLiked, song }) || changed;
    }
    if (changed) writeApiCache(url, next, null);
  }
}

async function fetchApiData<T>(url: string): Promise<T> {
  const cached = getCacheEntry<T>(url);
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const headers = new Headers({ accept: "application/json" });
    if (cached?.etag && cached.data !== undefined) headers.set("if-none-match", cached.etag);

    const response = await fetchWithTimeout(url, {
      credentials: "include",
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
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 401) dispatchApiAuthRequired(url);
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
      path.startsWith("/api/music/source") ||
      path.startsWith("/api/library") ||
      path.startsWith("/api/playlist/")
    );
  });
}

export function useApiData<T>(
  url: string,
  initialValue: T,
  options?: { enabled?: boolean; keepPreviousData?: boolean; refreshOnReconnect?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const keepPreviousData = options?.keepPreviousData ?? false;
  const refreshOnReconnect = options?.refreshOnReconnect ?? true;
  const cachedInitial = getCachedData<T>(url);
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(enabled && !cachedInitial);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dataUrlRef = useRef(cachedInitial !== undefined ? url : "");
  const initialValueRef = useRef(initialValue);

  useEffect(() => {
    initialValueRef.current = initialValue;
  }, [initialValue]);

  const startLoad = useCallback((background = false) => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function run() {
      const cached = getCacheEntry<T>(url);
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
          setError(
            cachedData === undefined && !canReuseCurrentData
              ? apiErrorMessage(err)
              : null,
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled, keepPreviousData, url]);

  useEffect(() => {
    return startLoad(false);
  }, [startLoad, reloadKey]);

  const retry = useCallback(() => {
    invalidateApiCache(url);
    setReloadKey((value) => value + 1);
  }, [url]);

  useEffect(() => {
    if (!enabled || !refreshOnReconnect || typeof window === "undefined") return;
    let cancelReconnectLoad: (() => void) | undefined;
    const handleOnline = () => {
      cancelReconnectLoad?.();
      cancelReconnectLoad = startLoad(true);
    };
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
      cancelReconnectLoad?.();
    };
  }, [enabled, startLoad, refreshOnReconnect]);

  return { data, loading, error, retry };
}

export type HomePayload = {
  // /api/home now returns only likedSongIds — the song list was dropped because
  // nothing renders it (kept optional for backward compatibility with old cached
  // snapshots that still carry it).
  songs?: PlayerSong[];
  likedSongIds: string[];
};

export type StatsHomePayload = {
  recentlyPlayed: PlayerSong[];
  mostPlayed: { song: PlayerSong; playCount: number }[];
};

// A globally-trending track from the Discover row. Not in the library. When
// `staged` is true it's already pre-downloaded into the Mac-mini's hidden
// .discover cache and plays instantly from `audioUrl` (with stable library id
// `audioId`); otherwise a tap materializes it on demand via /api/discover/stage.
// The Home "Discover" row: clickable, auto-updating playlists (Top 50 + the
// YouTube Music Discover Mix) instead of a scroll of individual tracks. Each
// opens /api/playlist/:id like any other playlist.
export type DiscoverPlaylistsPayload = {
  playlists: PlaylistEntry[];
};

export type SearchIndexPayload = {
  songs: PlayerSong[];
};

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

// A user-owned playlist backed by DB rows. `kind` is optional for backward
// compatibility with offline snapshots cached before the discriminator existed.
export type LibraryPlaylistPayload = {
  kind?: "library";
  playlist: {
    id: string;
    name: string;
    imageUrl: string | null;
    userId: string;
    createdAt: string;
    editable?: boolean;
  } | null;
  songs: PlayerSong[];
  // null when the server couldn't determine the like set (owner's mini unreachable
  // for a converted folder); SongGrid skips its non-additive merge on null.
  likedSongIds: string[] | null;
};

// An auto-updating playlist streamed read-through (Top 50 / the YouTube Music
// Discover Mix). Its songs aren't library rows — already-staged tracks arrive
// fully playable, the rest are placeholders (empty audioUrl + discoverTrackId)
// that DiscoverQueueStager materializes on demand.
export type CuratedPlaylistPayload = {
  kind: "curated";
  playlist: {
    id: string;
    name: string;
    imageUrl: string;
    description?: string;
  };
  songs: PlayerSong[];
  likedSongIds: string[];
};

export type PlaylistPayload = LibraryPlaylistPayload | CuratedPlaylistPayload;
