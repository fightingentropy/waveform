import { getAccountScope, invalidateLibraryApiCache, type PlaylistEntry } from "@/client/api";

async function request<T = { ok: true }>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "include", cache: "no-store" });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  const body = (await response.json()) as T;
  invalidateLibraryApiCache(getAccountScope());
  return body;
}

export function createPlaylist(name: string): Promise<PlaylistEntry> {
  return request<PlaylistEntry>("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() || "New Playlist" }),
  });
}

export function renamePlaylist(id: string, name: string): Promise<{ ok: true }> {
  return request(`/api/playlist/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
}

export function deletePlaylist(id: string): Promise<{ ok: true }> {
  return request(`/api/playlist/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function removeSongFromPlaylist(id: string, songId: string): Promise<{ ok: true }> {
  return request(`/api/playlist/${encodeURIComponent(id)}/songs/${encodeURIComponent(songId)}`, {
    method: "DELETE",
  });
}

export function reorderPlaylist(id: string, songIds: string[]): Promise<{ ok: true; songIds: string[] }> {
  return request(`/api/playlist/${encodeURIComponent(id)}/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songIds }),
  });
}
