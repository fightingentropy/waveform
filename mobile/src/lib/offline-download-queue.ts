import type { PlayerSong } from "@/types/player";

export const PLAYBACK_CACHE_SCOPE = "playback-cache" as const;
export type DownloadScope =
  | "home"
  | "liked"
  | typeof PLAYBACK_CACHE_SCOPE
  | `playlist:${string}`
  | `song:${string}`;
export type DownloadStatus = "queued" | "downloading" | "ready" | "error";

export type OfflineDownloadRecord = {
  songId: string;
  accountScope: string;
  scopes: DownloadScope[]; // reference-counted pins; remove the row when empty
  status: DownloadStatus;
  song: PlayerSong;
  audioPath?: string; // stored relative to the current iOS app container
  coverPath?: string;
  lyricsPath?: string;
  updatedAt: number;
  error?: string;
  // Process-local NSURLSession resume data; deliberately omitted from SQLite.
  resumeData?: string;
};

export function offlineDownloadKey(scope: string, songId: string): string {
  return `${scope}:${songId}`;
}

// A download record can be pinned by several independent surfaces (Liked Songs,
// a playlist, or the one-song button). An indicator must only offer to cancel
// the scope it represents, while still reflecting the shared record's current
// queue state.
export function getScopedDownloadStatus(
  record: Pick<OfflineDownloadRecord, "scopes" | "status"> | null | undefined,
  scope: DownloadScope,
): DownloadStatus | undefined {
  return record?.scopes.includes(scope) ? record.status : undefined;
}

// Plan a whole "Download all" insertion against one working map. The caller can
// publish `records` in one Zustand update instead of cloning/notifying once per
// song. Reading from the working copy also preserves the old duplicate-id
// behavior: the first occurrence inserts, and later copies see that queued row.
export function planQueuedDownloads(
  currentRecords: Readonly<Record<string, OfflineDownloadRecord>>,
  songs: readonly PlayerSong[],
  scope: DownloadScope,
  accountScope: string,
  now: () => number = Date.now,
): {
  records: Record<string, OfflineDownloadRecord>;
  changedRecords: OfflineDownloadRecord[];
} {
  const records = { ...currentRecords };
  const changedRecords: OfflineDownloadRecord[] = [];

  for (const song of songs) {
    const key = offlineDownloadKey(accountScope, song.id);
    const existing = records[key];
    if (existing) {
      const addScope = !existing.scopes.includes(scope);
      const requeue = existing.status === "error";
      if (!addScope && !requeue) continue;
      const updated: OfflineDownloadRecord = {
        ...existing,
        song,
        scopes: addScope ? [...existing.scopes, scope] : existing.scopes,
        status: requeue ? "queued" : existing.status,
        error: requeue ? undefined : existing.error,
        updatedAt: now(),
      };
      records[key] = updated;
      changedRecords.push(updated);
      continue;
    }

    const created: OfflineDownloadRecord = {
      songId: song.id,
      accountScope,
      scopes: [scope],
      status: "queued",
      song,
      updatedAt: now(),
    };
    records[key] = created;
    changedRecords.push(created);
  }

  return {
    records: changedRecords.length > 0 ? records : (currentRecords as Record<string, OfflineDownloadRecord>),
    changedRecords,
  };
}
