import { invalidateLibraryApiCache, type PlaylistEntry } from "@/lib/api";
import { API_CACHE_CLEARED_EVENT, emit } from "@/lib/events";
import { apiFetchWithTimeout } from "@/lib/http";
import { getOfflineAccountScope } from "@/store/offline";
import type { PlayerSong } from "@/types/player";

// Editable-playlist writes (create / rename / delete / add / remove). They hit
// the worker's D1-backed endpoints (POST /api/playlists, PATCH|DELETE
// /api/playlist/:id, POST|DELETE /api/playlist/:id/songs) and the user is
// resolved server-side from the session cookie — no auth query param, matching
// the existing reorder mutation (store/offline.ts). On success we invalidate the
// library + playlist caches and emit API_CACHE_CLEARED_EVENT so already-mounted
// screens re-pull in place. Online-only for v1; the caller surfaces failures.

export class PlaylistActionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PlaylistActionError";
    this.status = status;
  }
}

async function readError(res: Response): Promise<PlaylistActionError> {
  let message = `Request failed (${res.status})`;
  try {
    const data = (await res.json()) as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) message = data.error;
  } catch {}
  return new PlaylistActionError(message, res.status);
}

function refreshLibrary(): void {
  invalidateLibraryApiCache(getOfflineAccountScope());
  emit(API_CACHE_CLEARED_EVENT);
}

export async function createPlaylist(name: string): Promise<PlaylistEntry> {
  const res = await apiFetchWithTimeout("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() || "New Playlist" }),
    cache: "no-store",
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as PlaylistEntry;
  refreshLibrary();
  return data;
}

export async function renamePlaylist(playlistId: string, name: string): Promise<void> {
  const res = await apiFetchWithTimeout(`/api/playlist/${encodeURIComponent(playlistId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
    cache: "no-store",
  });
  if (!res.ok) throw await readError(res);
  refreshLibrary();
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  const res = await apiFetchWithTimeout(`/api/playlist/${encodeURIComponent(playlistId)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  if (!res.ok) throw await readError(res);
  refreshLibrary();
}

export async function addSongToPlaylist(playlistId: string, song: PlayerSong): Promise<void> {
  const res = await apiFetchWithTimeout(`/api/playlist/${encodeURIComponent(playlistId)}/songs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Always send the full song object: the worker upserts a SongRef from it so
    // the detail read can resolve the membership (a bare id that resolves in
    // neither Song nor SongRef is rejected to avoid a silent add-then-vanish).
    body: JSON.stringify({ song }),
    cache: "no-store",
  });
  if (!res.ok) throw await readError(res);
  refreshLibrary();
}

export async function removeSongFromPlaylist(playlistId: string, songId: string): Promise<void> {
  const res = await apiFetchWithTimeout(
    `/api/playlist/${encodeURIComponent(playlistId)}/songs/${encodeURIComponent(songId)}`,
    { method: "DELETE", cache: "no-store" },
  );
  if (!res.ok) throw await readError(res);
  refreshLibrary();
}
