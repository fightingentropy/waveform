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
  // Stable generation for the native iOS transport. Late callbacks are ignored
  // unless this token still matches the SQLite/Zustand record.
  transferToken?: string;
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
  createTransferToken?: () => string,
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
        transferToken:
          existing.status === "ready"
            ? existing.transferToken
            : requeue || !existing.transferToken
              ? createTransferToken?.() ?? existing.transferToken
              : existing.transferToken,
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
      transferToken: createTransferToken?.(),
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

export function planUnpinScopeFromSongs(
  currentRecords: Readonly<Record<string, OfflineDownloadRecord>>,
  songIds: readonly string[],
  scope: DownloadScope,
  accountScope: string,
  now: () => number = Date.now,
): {
  records: Record<string, OfflineDownloadRecord>;
  removedRecords: OfflineDownloadRecord[];
  updatedRecords: OfflineDownloadRecord[];
} {
  const records = { ...currentRecords };
  const removedRecords: OfflineDownloadRecord[] = [];
  const updatedRecords: OfflineDownloadRecord[] = [];

  for (const songId of new Set(songIds)) {
    const key = offlineDownloadKey(accountScope, songId);
    const existing = records[key];
    if (!existing?.scopes.includes(scope)) continue;
    const scopes = existing.scopes.filter((candidate) => candidate !== scope);
    if (scopes.length === 0) {
      delete records[key];
      removedRecords.push(existing);
      continue;
    }
    const updated = {
      ...existing,
      scopes,
      updatedAt: now(),
    };
    records[key] = updated;
    updatedRecords.push(updated);
  }

  return {
    records:
      removedRecords.length > 0 || updatedRecords.length > 0
        ? records
        : (currentRecords as Record<string, OfflineDownloadRecord>),
    removedRecords,
    updatedRecords,
  };
}
