import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import {
  LOCAL_AUDIO_EXTENSIONS as AUDIO_EXTENSIONS,
  LOCAL_IMAGE_EXTENSIONS as IMAGE_EXTENSIONS,
  LOCAL_LYRICS_EXTENSIONS as LYRICS_EXTENSIONS,
} from "../lib/local-media-path";
import type { PlayerSong } from "../types/player";
import { isPathInside, resolveInside } from "./local-media-serve";

export type LocalSongEntry = {
  song: PlayerSong;
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  // Inode identity. Two entries with the same (dev, ino) are hard links to ONE
  // physical file — the guaranteed-safe signal that they are the same song
  // (different rips never share an inode). Drives canonical-id assignment.
  ino: number;
  dev: number;
};

export type LibrarySnapshot = {
  songs: PlayerSong[];
  entriesById: Map<string, LocalSongEntry>;
  entriesByPath: Map<string, LocalSongEntry>;
  scannedAt: number;
};

export type LibrarySource = {
  key: string;
  root: string;
  cachePath: string;
  artworkDir: string;
  shared: boolean;
};

type PersistentSongCache = {
  version: number;
  root: string;
  entries: Record<
    string,
    {
      size: number;
      mtimeMs: number;
      sidecarMtimeMs?: number;
      // Persisted so the cached-snapshot path can regroup by inode without a
      // re-stat. Optional for forward-compat; the v4 bump guarantees presence.
      ino?: number;
      dev?: number;
      song: PlayerSong;
    }
  >;
};
export type LocalSidecar = {
  version?: number;
  title?: string;
  artist?: string;
  album?: string;
  coverFile?: string;
  lyricsFile?: string;
  updatedAt?: string;
  // Pins the song's id independent of its file path. Written by the YouTube
  // refetch flow so replacing a wrong-version .flac with the correct .opus keeps
  // the same id — the owner's like (mini-side) and any playlist rows reference
  // the id, so a path-derived id change would orphan them. See songFromFile.
  songId?: string;
};

// v3: forces a one-time full rescan so cover/lyrics sidecars created by the
// backfill scripts get discovered (cached entries only re-check the audio
// file and its .spotify.json mtimes, not newly-appearing sidecar files).
// v4: persists (ino, dev) per entry so content-canonical ids can be assigned
// from the cached-snapshot path without re-statting every file.
const SCAN_CACHE_VERSION = 4;

let scanTtlMs = 30_000;
let librarySnapshot: LibrarySnapshot | null = null;
let scanPromise: Promise<LibrarySnapshot> | null = null;
const userLibrarySnapshots = new Map<string, LibrarySnapshot>();
const userScanPromises = new Map<string, Promise<LibrarySnapshot>>();

export function configureLibraryScan(options: { scanTtlMs: number }): void {
  scanTtlMs = options.scanTtlMs;
}

export function hydrateSharedLibrarySnapshot(snapshot: LibrarySnapshot): void {
  librarySnapshot = snapshot;
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(", ")
      .trim();
  }
  return "";
}

export function encodeRelativePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function stableSongId(relativePath: string): string {
  const digest = createHash("sha1").update(relativePath).digest("hex").slice(0, 24);
  return `local-server:${digest}`;
}

export function titleFromFileName(fileName: string): { title: string; artist: string } {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  const separator = stem.lastIndexOf(" - ");
  if (separator > 0) {
    return {
      title: stem.slice(0, separator).trim() || stem,
      artist: stem.slice(separator + 3).trim() || "Unknown Artist",
    };
  }
  return { title: stem || "Untitled", artist: "Unknown Artist" };
}

export function sidecarPathForAudio(audioPath: string): string {
  return audioPath.replace(/\.[^.]+$/, ".spotify.json");
}

export async function readSidecar(audioPath: string): Promise<LocalSidecar> {
  try {
    const raw = await readFile(sidecarPathForAudio(audioPath), "utf8");
    const parsed = JSON.parse(raw) as LocalSidecar;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeSidecar(audioPath: string, sidecar: LocalSidecar): Promise<void> {
  const target = sidecarPathForAudio(audioPath);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  await rename(tempPath, target);
}

async function directoryNames(path: string, cache: Map<string, Promise<string[]>>): Promise<string[]> {
  const dir = dirname(path);
  let promise = cache.get(dir);
  if (!promise) {
    promise = readdir(dir).catch(() => []);
    cache.set(dir, promise);
  }
  return promise;
}

async function findSidecarByExtensions(
  source: LibrarySource,
  audioPath: string,
  extensions: Set<string>,
  candidates: string[],
  cache: Map<string, Promise<string[]>>,
): Promise<string> {
  const names = await directoryNames(audioPath, cache);
  const wanted = new Set(candidates.map((item) => item.toLowerCase()));
  const exact = names.find((name) => wanted.has(name.toLowerCase()) && extensions.has(extname(name).toLowerCase()));
  if (!exact) return "";
  const rel = relative(source.root, resolve(dirname(audioPath), exact)).split(sep).join("/");
  return rel && !rel.startsWith("..") ? rel : "";
}

async function findCoverPath(source: LibrarySource, audioPath: string, stem: string, sidecar: LocalSidecar, cache: Map<string, Promise<string[]>>): Promise<string> {
  if (sidecar.coverFile) {
    const candidate = resolve(dirname(audioPath), sidecar.coverFile);
    if (isPathInside(source.root, candidate) && existsSync(candidate)) {
      return relative(source.root, candidate).split(sep).join("/");
    }
  }

  return findSidecarByExtensions(
    source,
    audioPath,
    IMAGE_EXTENSIONS,
    [
      `${stem}.cover.jpg`,
      `${stem}.cover.jpeg`,
      `${stem}.cover.png`,
      `${stem}.cover.webp`,
      `${stem}.jpg`,
      `${stem}.jpeg`,
      `${stem}.png`,
      `${stem}.webp`,
      "cover.jpg",
      "cover.jpeg",
      "cover.png",
      "cover.webp",
      "folder.jpg",
      "folder.jpeg",
      "folder.png",
      "folder.webp",
      "front.jpg",
      "front.jpeg",
      "front.png",
      "front.webp",
    ],
    cache,
  );
}

async function findLyricsPath(source: LibrarySource, audioPath: string, stem: string, sidecar: LocalSidecar, cache: Map<string, Promise<string[]>>): Promise<string> {
  if (sidecar.lyricsFile) {
    const candidate = resolve(dirname(audioPath), sidecar.lyricsFile);
    if (isPathInside(source.root, candidate) && existsSync(candidate)) {
      return relative(source.root, candidate).split(sep).join("/");
    }
  }

  return findSidecarByExtensions(
    source,
    audioPath,
    LYRICS_EXTENSIONS,
    [`${stem}.lrc`, `${stem}.lyrics.lrc`, `${stem}.txt`, `${stem}.lyrics.txt`],
    cache,
  );
}

async function songFromFile(
  source: LibrarySource,
  relativePath: string,
  absolutePath: string,
  fileStat: Stats,
  directoryCache: Map<string, Promise<string[]>>,
): Promise<PlayerSong> {
  const fileName = basename(absolutePath);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const fallback = titleFromFileName(fileName);
  const sidecar = await readSidecar(absolutePath);
  // A pinned songId keeps a song's identity stable across a FILE change (the
  // YouTube-refetch flow rewrites a wrong-version .flac as the correct .opus);
  // otherwise the path-derived hash changes and orphans the like / playlist rows.
  const id =
    sidecar.songId?.trim() || stableSongId(source.shared ? relativePath : `${source.key}/${relativePath}`);
  let metadata: IAudioMetadata | null;

  try {
    metadata = await parseFile(absolutePath, { duration: true, skipCovers: true });
  } catch {
    metadata = null;
  }

  const common = metadata?.common;
  const format = metadata?.format;
  const artist =
    firstString(sidecar.artist) ||
    firstString(common?.artist) ||
    firstString(common?.artists) ||
    fallback.artist;
  const title = firstString(sidecar.title) || firstString(common?.title) || fallback.title;
  const album = firstString(sidecar.album) || firstString(common?.album);
  const coverPath = await findCoverPath(source, absolutePath, stem, sidecar, directoryCache);
  const lyricsPath = await findLyricsPath(source, absolutePath, stem, sidecar, directoryCache);

  return {
    id,
    title,
    artist,
    album: album || undefined,
    imageUrl: coverPath
      ? `/api/files/local/${encodeRelativePath(coverPath)}`
      : `/api/artwork/local/${encodeURIComponent(id)}`,
    audioUrl: `/api/files/local/${encodeRelativePath(relativePath)}`,
    lyricsUrl: lyricsPath ? `/api/files/local/${encodeRelativePath(lyricsPath)}` : undefined,
    createdAt: new Date(Number(fileStat.birthtimeMs || fileStat.mtimeMs)).toISOString(),
    duration:
      typeof format?.duration === "number" && Number.isFinite(format.duration)
        ? Math.round(format.duration)
        : undefined,
    audioBitDepth:
      typeof format?.bitsPerSample === "number" && Number.isFinite(format.bitsPerSample)
        ? format.bitsPerSample
        : undefined,
    audioSampleRate:
      typeof format?.sampleRate === "number" && Number.isFinite(format.sampleRate)
        ? format.sampleRate
        : undefined,
    source: "server",
    localPath: relativePath,
  };
}

async function collectAudioFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const output: Array<{ absolutePath: string; relativePath: string }> = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = resolve(dir, entry.name);
      if (!isPathInside(root, absolutePath)) continue;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      output.push({
        absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/"),
      });
    }
  }

  await walk(root);
  return output;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function readPersistentCache(source: LibrarySource): Promise<PersistentSongCache> {
  try {
    const raw = await readFile(source.cachePath, "utf8");
    const parsed = JSON.parse(raw) as PersistentSongCache;
    if (parsed?.version === SCAN_CACHE_VERSION && parsed.root === source.root) return parsed;
  } catch {}
  return { version: SCAN_CACHE_VERSION, root: source.root, entries: {} };
}

async function writePersistentCache(source: LibrarySource, cache: PersistentSongCache): Promise<void> {
  await mkdir(dirname(source.cachePath), { recursive: true });
  const tempPath = `${source.cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(tempPath, source.cachePath);
}

// Assigns every entry a content-canonical id derived from its inode group's
// anchor. Files that are hard links of one song share an inode, so they collapse
// onto a single canonical id WITHOUT changing each file's own `song.id`. The
// anchor (root-preferred path, else lexicographically-smallest) computes its
// canonical id with the SAME formula + per-user-source prefixing as
// songFromFile(), so the anchor's own id already equals the canonical id and
// existing id lookups keep resolving — only collapsed duplicate copies pick up a
// canonicalId that differs from their id. Different rips never share an inode, so
// this never merges distinct songs.
function assignCanonicalIds(source: LibrarySource, entries: LocalSongEntry[]): void {
  const groups = new Map<string, LocalSongEntry[]>();
  for (const entry of entries) {
    // ino is always > 0 for a real file; a missing/zero ino (malformed cache)
    // gets a per-path key so unrelated entries never group together.
    const key = entry.ino > 0 ? `${entry.dev}:${entry.ino}` : `solo:${entry.relativePath}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  for (const group of groups.values()) {
    let anchor = group[0];
    for (const entry of group) {
      const entryAtRoot = !entry.relativePath.includes("/");
      const anchorAtRoot = !anchor.relativePath.includes("/");
      if (entryAtRoot !== anchorAtRoot) {
        if (entryAtRoot) anchor = entry; // prefer a root-level copy as the anchor
      } else if (entry.relativePath.localeCompare(anchor.relativePath) < 0) {
        anchor = entry; // tie-break: lexicographically-smallest path
      }
    }
    const canonicalId = stableSongId(
      source.shared ? anchor.relativePath : `${source.key}/${anchor.relativePath}`,
    );
    for (const entry of group) entry.song.canonicalId = canonicalId;
  }
}

function buildLibrarySnapshot(
  source: LibrarySource,
  entries: LocalSongEntry[],
  scannedAt = Date.now(),
): LibrarySnapshot {
  assignCanonicalIds(source, entries);
  const songs = entries
    .map((entry) => entry.song)
    .sort((left, right) => {
      const leftKey = `${left.artist} ${left.title}`.toLowerCase();
      const rightKey = `${right.artist} ${right.title}`.toLowerCase();
      return leftKey.localeCompare(rightKey);
    });
  const entriesById = new Map(entries.map((entry) => [entry.song.id, entry] as const));
  const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry] as const));

  return {
    songs,
    entriesById,
    entriesByPath,
    scannedAt,
  };
}

export async function readCachedLibrarySnapshot(source: LibrarySource): Promise<LibrarySnapshot | null> {
  const cache = await readPersistentCache(source);
  const entries: LocalSongEntry[] = [];

  for (const [relativePath, cached] of Object.entries(cache.entries)) {
    if (!cached?.song || typeof cached.size !== "number" || typeof cached.mtimeMs !== "number") continue;
    const absolutePath = resolveInside(source.root, relativePath);
    if (!absolutePath) continue;
    entries.push({
      song: cached.song,
      absolutePath,
      relativePath,
      size: cached.size,
      mtimeMs: cached.mtimeMs,
      ino: typeof cached.ino === "number" ? cached.ino : 0,
      dev: typeof cached.dev === "number" ? cached.dev : 0,
    });
  }

  return entries.length ? buildLibrarySnapshot(source, entries) : null;
}

function cachedStatMatches(
  cached: PersistentSongCache["entries"][string] | undefined,
  fileStat: Stats,
  sidecarMtimeMs: number | undefined,
): cached is PersistentSongCache["entries"][string] {
  if (!cached || cached.size !== fileStat.size) return false;
  return (
    Math.trunc(cached.mtimeMs) === Math.trunc(fileStat.mtimeMs) &&
    Math.trunc(cached.sidecarMtimeMs ?? 0) === Math.trunc(sidecarMtimeMs ?? 0)
  );
}

async function scanLibrary(source: LibrarySource, usePersistentCache = true): Promise<LibrarySnapshot> {
  await mkdir(source.root, { recursive: true });
  await mkdir(dirname(source.cachePath), { recursive: true });

  const previous: PersistentSongCache = usePersistentCache
    ? await readPersistentCache(source)
    : { version: SCAN_CACHE_VERSION, root: source.root, entries: {} };
  const files = await collectAudioFiles(source.root);
  const directoryCache = new Map<string, Promise<string[]>>();
  const nextCache: PersistentSongCache = {
    version: SCAN_CACHE_VERSION,
    root: source.root,
    entries: {},
  };

  const entries = await mapWithConcurrency(files, 8, async (file): Promise<LocalSongEntry | null> => {
    try {
      const fileStat = await stat(file.absolutePath);
      const sidecarMtimeMs = await stat(sidecarPathForAudio(file.absolutePath))
        .then((sidecarStat) => sidecarStat.mtimeMs)
        .catch(() => undefined);
      const cached = previous.entries[file.relativePath];
      const song =
        cachedStatMatches(cached, fileStat, sidecarMtimeMs)
          ? cached.song
          : await songFromFile(source, file.relativePath, file.absolutePath, fileStat, directoryCache);

      nextCache.entries[file.relativePath] = {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        sidecarMtimeMs,
        ino: fileStat.ino,
        dev: fileStat.dev,
        song,
      };

      return {
        song,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ino: fileStat.ino,
        dev: fileStat.dev,
      };
    } catch (error) {
      // A file can vanish between the directory walk and this stat (e.g. an
      // in-flight download that swaps .m4a for .flac) or be unreadable. Skip it
      // so one bad file never aborts the whole library refresh. ENOENT is the
      // expected transient case and stays quiet; anything else is logged.
      if ((error as { code?: string } | null)?.code !== "ENOENT") {
        console.error(
          `Skipping ${file.relativePath} during library scan: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  });

  const presentEntries = entries.filter((entry): entry is LocalSongEntry => entry !== null);

  await writePersistentCache(source, nextCache).catch(() => {});

  return buildLibrarySnapshot(source, presentEntries);
}

export function refreshLibrary(source: LibrarySource, usePersistentCache = true): Promise<LibrarySnapshot> {
  if (!source.shared) {
    const existing = userScanPromises.get(source.key);
    if (existing) return existing;
    const promise = scanLibrary(source, usePersistentCache)
      .then((snapshot) => {
        userLibrarySnapshots.set(source.key, snapshot);
        return snapshot;
      })
      .finally(() => {
        userScanPromises.delete(source.key);
      });
    userScanPromises.set(source.key, promise);
    return promise;
  }

  scanPromise ??= scanLibrary(source, usePersistentCache)
    .then((snapshot) => {
      librarySnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}

export async function getLibrary(source: LibrarySource, force = false): Promise<LibrarySnapshot> {
  const now = Date.now();
  const snapshot = source.shared ? librarySnapshot : userLibrarySnapshots.get(source.key) ?? null;
  const activePromise = source.shared ? scanPromise : userScanPromises.get(source.key) ?? null;
  if (!force && snapshot) {
    if (now - snapshot.scannedAt >= scanTtlMs && !activePromise) {
      void refreshLibrary(source, true).catch((error) => {
        console.error(`Spotify local music library refresh failed for ${source.key}: ${error}`);
      });
    }
    return snapshot;
  }
  // `force` only means "scan now instead of serving a (possibly stale) snapshot".
  // The on-disk stat cache must still be honored so unchanged files reuse their
  // parsed metadata; only new/changed/removed files (a stat mismatch) are
  // re-parsed. Passing usePersistentCache=false here would seed an empty cache
  // and re-run music-metadata on the entire library for every mutation.
  return refreshLibrary(source, true);
}
