import { withAccountScope } from "@/lib/api";
import { apiFetchWithTimeout } from "@/lib/http";

// Non-destructive canonical RESOLUTION layer. The mini collapses hard-linked
// duplicate files (same inode) under one canonical "anchor" id and exposes the
// retired copy ids via GET /api/songs/id-map → { version, map: { copyId: canonicalId } }.
//
// Nothing on disk or in any store is rewritten. We only read the map to make
// like-state canonical-aware: when a logical song is liked (server returns the
// canonical/anchor id) we also light every retired copy's id so the heart shows
// lit wherever that song appears. Downloads stay keyed by their own file-path id
// (untouched), so there is zero risk to the on-device library.
//
// The map is EMPTY while the server's canonical-likes flag is off, so every
// function here degrades to identity and the app behaves exactly as before.

let idMap = new Map<string, string>(); // copyId -> canonicalId
let reverseMap = new Map<string, string[]>(); // canonicalId -> [copyId, ...]
let loadedKey: string | null = null; // `${scope}:${version}` of the last applied map
let idMapListener: (() => void) | null = null;

// likes.ts registers a callback so an in-flight liked set re-expands the instant
// the map arrives (no "hearts only update after navigating away" glitch).
export function onIdMapChange(listener: (() => void) | null): void {
  idMapListener = listener;
}

export function canonicalOf(id: string): string {
  return idMap.get(id) ?? id;
}

// Expand a liked-id list (the server returns canonical/anchor ids when the flag
// is on) to also include every retired copy id, so direct `likedSongIds[song.id]`
// reads light up on any copy. Identity when the map is empty (flag off / not yet
// loaded) — so it never changes per-file behavior or lights a copy of a song
// that was only liked by its own file id.
export function expandLikedSet(ids: string[]): string[] {
  if (reverseMap.size === 0) return ids;
  const out = new Set(ids);
  for (const id of ids) {
    const copies = reverseMap.get(id);
    if (copies) for (const copy of copies) out.add(copy);
  }
  return out.size === ids.length ? ids : Array.from(out);
}

export async function loadIdMap(scope: string | null | undefined): Promise<void> {
  const value = scope?.trim() || "anonymous";
  try {
    const res = await apiFetchWithTimeout(
      withAccountScope("/api/songs/id-map", value),
      { cache: "no-store" },
      8_000,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { version?: unknown; map?: unknown };
    const version = typeof data.version === "string" ? data.version : "";
    const key = `${value}:${version}`;
    if (key === loadedKey) return; // unchanged map — keep the current expansion

    const nextForward = new Map<string, string>();
    const nextReverse = new Map<string, string[]>();
    const map = data.map && typeof data.map === "object" ? (data.map as Record<string, unknown>) : {};
    for (const [copyId, canonical] of Object.entries(map)) {
      if (typeof canonical !== "string" || !canonical || canonical === copyId) continue;
      nextForward.set(copyId, canonical);
      const list = nextReverse.get(canonical);
      if (list) list.push(copyId);
      else nextReverse.set(canonical, [copyId]);
    }

    idMap = nextForward;
    reverseMap = nextReverse;
    loadedKey = key;
    idMapListener?.();
  } catch {
    // Offline / mini down / pre-flag: leave the last-known map in place and let
    // like-state fall back to exact-id matching. Never throws into the caller.
  }
}
