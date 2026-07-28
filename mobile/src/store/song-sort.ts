import { create } from "zustand";
import { storage } from "@/lib/storage";
import type { PlayerSong } from "@/types/player";

// Per-collection sort order for song lists (Liked Songs, every playlist, Downloads).
// Persisted to MMKV keyed by a stable context string, read synchronously at creation
// so the chosen order is applied on first paint and survives relaunching the app.
// Mirrors store/library-sort.ts (which sorts the *library* of playlists, not songs).

export type SongSortKey = "custom" | "added" | "title" | "artist" | "album" | "duration";
export type SongSortDir = "asc" | "desc";
export type SongSort = { key: SongSortKey; dir: SongSortDir };

export const SONG_SORT_OPTIONS: { key: SongSortKey; label: string }[] = [
  { key: "custom", label: "Custom order" },
  { key: "added", label: "Date added" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "duration", label: "Duration" },
];

// "custom" is the order the server returned (no client sort). Newest-first feels
// natural for "Date added"; everything else reads best A→Z / shortest-first.
export const DEFAULT_SONG_SORT: SongSort = { key: "custom", dir: "asc" };

export function defaultDirFor(key: SongSortKey): SongSortDir {
  return key === "added" ? "desc" : "asc";
}

export function songSortLabel(sort: SongSort): string {
  return SONG_SORT_OPTIONS.find((o) => o.key === sort.key)?.label ?? "Custom order";
}

const STORAGE_KEY = "spotify_song_sort_v1";

function readAll(): Record<string, SongSort> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, SongSort>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, SongSort>): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

type SongSortState = {
  byContext: Record<string, SongSort>;
  setSort: (context: string, sort: SongSort) => void;
};

export const useSongSortStore = create<SongSortState>((set) => ({
  byContext: readAll(),
  setSort: (context, sort) =>
    set((state) => {
      const next = { ...state.byContext, [context]: sort };
      writeAll(next);
      return { byContext: next };
    }),
}));

// Subscribe a component to one collection's sort (defaults to "custom").
export function useSongSort(context: string): SongSort {
  return useSongSortStore((s) => s.byContext[context] ?? DEFAULT_SONG_SORT);
}

function cmpStr(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function fieldCompare(key: SongSortKey, a: PlayerSong, b: PlayerSong): number {
  switch (key) {
    case "title":
      return cmpStr(a.title ?? "", b.title ?? "");
    case "artist":
      return cmpStr(a.artist ?? "", b.artist ?? "");
    case "album":
      return cmpStr(a.album ?? "", b.album ?? "");
    case "duration":
      return (a.duration ?? 0) - (b.duration ?? 0);
    case "added": {
      // Prefer when the song was LIKED (set on /api/liked) over the FLAC's file
      // date, so "Date added" in Liked Songs means recently-liked. Falls back to
      // createdAt for playlists/library and legacy likes without a timestamp.
      const added = (s: PlayerSong) => Date.parse(s.likedAt ?? s.createdAt ?? "") || 0;
      return added(a) - added(b);
    }
    default:
      return 0;
  }
}

// Primary ordering shared with paged queue hydration. Equal values deliberately
// return zero: sortSongs owns source-order tie handling, while the queue merger
// knows whether an equal-valued incoming page belongs before or after earlier
// provider pages.
export function compareSongsForSort(a: PlayerSong, b: PlayerSong, sort: SongSort): number {
  if (sort.key === "custom") return 0;
  const compared = fieldCompare(sort.key, a, b);
  return sort.dir === "desc" ? -compared : compared;
}

// Pure, non-mutating. "custom" keeps the server order (asc) or reverses it (desc).
// Other keys sort ascending — ties keep their input order (stable) — then flip for
// descending. Returns the input array unchanged for the no-op case so callers can
// memoize cheaply.
export function sortSongs(songs: PlayerSong[], sort: SongSort): PlayerSong[] {
  if (sort.key === "custom") {
    return sort.dir === "desc" ? [...songs].reverse() : songs;
  }
  const indexed = songs.map((song, index) => ({ song, index }));
  indexed.sort((a, b) => {
    const c = fieldCompare(sort.key, a.song, b.song);
    return c !== 0 ? c : a.index - b.index;
  });
  const ascending = indexed.map((entry) => entry.song);
  return sort.dir === "desc" ? ascending.reverse() : ascending;
}
