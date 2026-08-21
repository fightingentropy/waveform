import * as FileSystem from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";

// expo-sqlite store for offline download records. Mirrors the web app's
// IndexedDB `downloads_v2` store: composite key [accountScope, songId] (here a
// single TEXT primary key), with status/updatedAt available for queries.
export type DownloadRow = {
  key: string; // `${accountScope}:${songId}`
  accountScope: string;
  songId: string;
  scopes: string; // JSON string[]
  status: string;
  song: string; // JSON PlayerSong
  audioPath: string | null;
  coverPath: string | null;
  lyricsPath: string | null;
  transferToken: string | null;
  updatedAt: number;
};

// Downloaded assets are addressed RELATIVE to the app's document directory
// (e.g. "offline-media/<safeName(songId)>/audio.flac"). iOS can hand the app a
// DIFFERENT container path after a reinstall, so any absolute path persisted by a
// previous install goes stale and strands the file on disk. Never trust a stored
// absolute path: resolve it against the CURRENT documentDirectory at the point of
// use. resolveMediaPath also repairs a legacy absolute value by re-rooting it.
const MEDIA_MARKER = "offline-media/";
export function toMediaRelativePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const i = path.indexOf(MEDIA_MARKER);
  return i >= 0 ? path.slice(i) : path;
}
export function resolveMediaPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const i = path.indexOf(MEDIA_MARKER);
  if (i < 0) return path;
  return `${FileSystem.documentDirectory ?? ""}${path.slice(i)}`;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let dbWriteTail: Promise<void> = Promise.resolve();

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("spotify-offline.db");
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS downloads (
          key TEXT PRIMARY KEY NOT NULL,
          accountScope TEXT NOT NULL,
          songId TEXT NOT NULL,
          scopes TEXT NOT NULL,
          status TEXT NOT NULL,
          song TEXT NOT NULL,
          audioPath TEXT,
          coverPath TEXT,
          lyricsPath TEXT,
          transferToken TEXT,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_downloads_account ON downloads (accountScope);
        CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads (status);
      `);
      const columns = await db.getAllAsync<{ name: string }>(
        "PRAGMA table_info(downloads)",
      );
      if (!columns.some((column) => column.name === "transferToken")) {
        await db.execAsync(
          "ALTER TABLE downloads ADD COLUMN transferToken TEXT",
        );
      }
      return db;
    })();
  }
  return dbPromise;
}

function enqueueDbWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = dbWriteTail.then(write);
  // A rejected row must not poison every later write. Keep the caller-visible
  // rejection while advancing the shared tail as a fulfilled promise.
  dbWriteTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function dbAllRows(): Promise<DownloadRow[]> {
  await dbWriteTail;
  const db = await getDb();
  return db.getAllAsync<DownloadRow>("SELECT * FROM downloads ORDER BY updatedAt DESC");
}

async function runUpsertRows(rows: readonly DownloadRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  const placeholders = rows
    .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .join(", ");
  const values: Array<string | number | null> = [];
  for (const row of rows) {
    values.push(
      row.key,
      row.accountScope,
      row.songId,
      row.scopes,
      row.status,
      row.song,
      row.audioPath,
      row.coverPath,
      row.lyricsPath,
      row.transferToken,
      row.updatedAt,
    );
  }
  await db.runAsync(
    `INSERT OR REPLACE INTO downloads
      (key, accountScope, songId, scopes, status, song, audioPath, coverPath, lyricsPath, transferToken, updatedAt)
     VALUES ${placeholders}`,
    values,
  );
}

export function dbUpsertRow(row: DownloadRow): Promise<void> {
  return enqueueDbWrite(() => runUpsertRows([row]));
}

// One native SQLite statement per bounded caller chunk. The shared write tail
// preserves enqueue order against status transitions and cancellation deletes.
export function dbUpsertRows(rows: readonly DownloadRow[]): Promise<void> {
  if (rows.length === 0) return Promise.resolve();
  return enqueueDbWrite(() => runUpsertRows(rows));
}

export async function dbDeleteRow(key: string): Promise<void> {
  return enqueueDbWrite(async () => {
    const db = await getDb();
    await db.runAsync("DELETE FROM downloads WHERE key = ?", [key]);
  });
}

export function dbDeleteRows(keys: readonly string[]): Promise<void> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return Promise.resolve();
  return enqueueDbWrite(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      // Stay comfortably below SQLite's bound-parameter limit while keeping a
      // large "Cancel Download All" atomic and bounded.
      for (let offset = 0; offset < uniqueKeys.length; offset += 250) {
        const chunk = uniqueKeys.slice(offset, offset + 250);
        await db.runAsync(
          `DELETE FROM downloads WHERE key IN (${chunk.map(() => "?").join(", ")})`,
          chunk,
        );
      }
    });
  });
}

// All rows whose status is "ready" for an account scope. Used by the verify pass
// and the storage total — mirrors the web app's readDownloadedRecordsPage, which
// reads only the "downloaded" status. SQLite has no in-memory cap, so this is the
// authoritative set (the store's in-memory `records` map is the same set today,
// but this keeps the verify/total logic correct if that ever changes).
export async function readAllDownloadedRecords(accountScope: string): Promise<DownloadRow[]> {
  await dbWriteTail;
  const db = await getDb();
  return db.getAllAsync<DownloadRow>(
    "SELECT * FROM downloads WHERE accountScope = ? AND status = 'ready' ORDER BY updatedAt DESC",
    [accountScope],
  );
}

async function isNonEmptyFile(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists && !info.isDirectory && info.size > 0;
  } catch {
    return false;
  }
}

export type DownloadVerificationResult = {
  ok: boolean;
  audioValid: boolean;
  coverValid: boolean;
  lyricsValid: boolean;
};

// A ready download is complete only when its audio and every catalog-advertised
// sidecar exist as non-empty files. Missing artwork/lyrics is repaired in place:
// valid audio and other valid assets remain attached while native transport
// fetches only the missing destinations under a fresh transfer generation.
export async function verifyOrRepairRecord(
  row: DownloadRow,
): Promise<DownloadVerificationResult> {
  let song: { imageUrl?: string; lyricsUrl?: string } = {};
  try {
    song = JSON.parse(row.song) as typeof song;
  } catch {}

  const [audioValid, coverValid, lyricsValid] = await Promise.all([
    isNonEmptyFile(resolveMediaPath(row.audioPath)),
    isNonEmptyFile(resolveMediaPath(row.coverPath)),
    isNonEmptyFile(resolveMediaPath(row.lyricsPath)),
  ]);
  const coverRequired = Boolean(song.imageUrl?.trim());
  const lyricsRequired = Boolean(song.lyricsUrl?.trim());
  const ok =
    audioValid &&
    (!coverRequired || coverValid) &&
    (!lyricsRequired || lyricsValid);
  if (ok) return { ok, audioValid, coverValid, lyricsValid };

  await dbUpsertRow({
    ...row,
    status: "queued",
    audioPath: audioValid ? row.audioPath : null,
    coverPath: coverValid ? row.coverPath : null,
    lyricsPath: lyricsValid ? row.lyricsPath : null,
    updatedAt: Date.now(),
  });
  return { ok, audioValid, coverValid, lyricsValid };
}
