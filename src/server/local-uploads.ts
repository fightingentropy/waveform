import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parseFile } from "music-metadata";
import { RemoteUrlError, fetchPublicHttpUrl } from "../lib/safe-fetch";
import { sniffUploadFile } from "../lib/upload-media-sniff";
import {
  LOCAL_AUDIO_EXTENSIONS as AUDIO_EXTENSIONS,
  LOCAL_IMAGE_EXTENSIONS as IMAGE_EXTENSIONS,
  LOCAL_LYRICS_EXTENSIONS as LYRICS_EXTENSIONS,
} from "../lib/local-media-path";
import type { PlayerSong } from "../types/player";
import { json, readJsonBody } from "./local-http";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_LYRICS_BYTES,
  PayloadTooLargeError,
  audioExtensionFromContentType,
  byteLength,
  extensionFromRemoteUrl,
  parseHttpUrl,
  sanitizeFileName,
  saveFile,
  saveRemoteImage,
  saveResponseBody,
  trackKey,
  uniquePath,
  validateUploadFile,
} from "./local-files";
import {
  type LibrarySource,
  type LocalSidecar,
  type LocalSongEntry,
  getLibrary,
  readSidecar,
  writeSidecar,
} from "./local-library-scan";
import { youtubePreviewConfig } from "./local-discover";
import { downloadYouTubePreviewAudioResilient, resolveYouTubePreviewMatch } from "./youtube-preview";

export type SongEntryBackup = {
  directory: string;
  files: Array<{ original: string; backup: string }>;
};

export type UploadDeps = {
  forbiddenLibraryResponse: () => Response;
  notFound: (message?: string) => Response;
  songForRequest: (song: PlayerSong, request: Request) => PlayerSong;
  markSongLikedForSource: (source: LibrarySource, songs: PlayerSong[], songId: string) => Promise<void>;
  backupSongEntryFiles: (source: LibrarySource, entry: LocalSongEntry) => Promise<SongEntryBackup>;
  restoreSongEntryBackup: (
    source: LibrarySource,
    entry: LocalSongEntry,
    replacementPath: string,
    backup: SongEntryBackup,
  ) => Promise<void>;
  discardSongEntryBackup: (backup: SongEntryBackup) => Promise<void>;
  outputFormatFromPayload: (value: unknown) => string;
  serverImportOutputFormat: string;
};

let forbiddenLibraryResponse: UploadDeps["forbiddenLibraryResponse"];
let notFound: UploadDeps["notFound"];
let songForRequest: UploadDeps["songForRequest"];
let markSongLikedForSource: UploadDeps["markSongLikedForSource"];
let backupSongEntryFiles: UploadDeps["backupSongEntryFiles"];
let restoreSongEntryBackup: UploadDeps["restoreSongEntryBackup"];
let discardSongEntryBackup: UploadDeps["discardSongEntryBackup"];
let outputFormatFromPayload: UploadDeps["outputFormatFromPayload"];
let SERVER_IMPORT_OUTPUT_FORMAT: string;

export function configureUploads(deps: UploadDeps): void {
  forbiddenLibraryResponse = deps.forbiddenLibraryResponse;
  notFound = deps.notFound;
  songForRequest = deps.songForRequest;
  markSongLikedForSource = deps.markSongLikedForSource;
  backupSongEntryFiles = deps.backupSongEntryFiles;
  restoreSongEntryBackup = deps.restoreSongEntryBackup;
  discardSongEntryBackup = deps.discardSongEntryBackup;
  outputFormatFromPayload = deps.outputFormatFromPayload;
  SERVER_IMPORT_OUTPUT_FORMAT = deps.serverImportOutputFormat;
}

export async function handleRemoteSongUpload(payload: {
  source: LibrarySource;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  audioUrl?: unknown;
  imageUrl?: unknown;
  lyricsText?: unknown;
  replaceExisting?: unknown;
  outputFormat?: unknown;
}): Promise<Response> {
  const { source } = payload;
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const artist = typeof payload.artist === "string" ? payload.artist.trim() : "";
  const album = typeof payload.album === "string" ? payload.album.trim() : "";
  const audioUrl = typeof payload.audioUrl === "string" ? payload.audioUrl.trim() : "";
  const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl.trim() : "";
  const lyricsText = typeof payload.lyricsText === "string" ? payload.lyricsText.trim() : "";
  const replaceExisting =
    payload.replaceExisting === true ||
    (typeof payload.replaceExisting === "string" && payload.replaceExisting.toLowerCase() === "true");
  const outputFormat = outputFormatFromPayload(payload.outputFormat);

  if (!title || !artist || !audioUrl) {
    return json({ error: "Title, artist, and audio URL are required" }, { status: 400 });
  }
  if (outputFormat !== SERVER_IMPORT_OUTPUT_FORMAT) {
    return json(
      {
        error: `${outputFormat.toUpperCase()} output is only available for browser/local saves. Server imports currently support FLAC/original audio.`,
      },
      { status: 400 },
    );
  }
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }

  const parsedAudioUrl = parseHttpUrl(audioUrl);
  if (!parsedAudioUrl) return json({ error: "Only valid http(s) audio URLs are supported" }, { status: 400 });
  let response: Response;
  try {
    response = await fetchPublicHttpUrl(parsedAudioUrl, { headers: { accept: "audio/*,*/*" } }, 120_000);
  } catch (error) {
    if (error instanceof RemoteUrlError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const snapshot = await getLibrary(source);
  const existingEntry = snapshot.songs
    .map((song) => snapshot.entriesById.get(song.id))
    .find((entry): entry is LocalSongEntry =>
      Boolean(entry && trackKey(entry.song.title, entry.song.artist) === trackKey(title, artist)),
    );

  if (existingEntry && !replaceExisting) {
    // Drain the upstream body we opened before the duplicate check, or the
    // socket stays alive (on Bun) until GC.
    await response.body?.cancel().catch(() => undefined);
    return json(
      {
        error: "Song already exists in your library",
        code: "DUPLICATE_SONG",
        existingSong: {
          id: existingEntry.song.id,
          title: existingEntry.song.title,
          artist: existingEntry.song.artist,
        },
      },
      { status: 409 },
    );
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return json({ error: `Audio server returned ${response.status}` }, { status: 502 });
  }

  const contentType = response.headers.get("content-type") || "";
  const normalizedContentType = contentType.split(";")[0]?.trim().toLowerCase() || "";
  if (
    normalizedContentType &&
    !normalizedContentType.startsWith("audio/") &&
    normalizedContentType !== "application/octet-stream"
  ) {
    return json({ error: "Remote audio URL did not return an audio file" }, { status: 415 });
  }
  const audioExt = extensionFromRemoteUrl(
    audioUrl,
    AUDIO_EXTENSIONS,
    audioExtensionFromContentType(contentType),
  );
  const stem = sanitizeFileName(`${artist} - ${title}`);
  const preferredAudioPath = existingEntry && replaceExisting
    ? resolve(dirname(existingEntry.absolutePath), `${stem}${audioExt}`)
    : resolve(source.root, `${stem}${audioExt}`);
  const audioPath =
    existingEntry &&
    replaceExisting &&
    (!existsSync(preferredAudioPath) || preferredAudioPath === existingEntry.absolutePath)
      ? preferredAudioPath
      : await uniquePath(preferredAudioPath);
  const tempAudioPath = existingEntry && replaceExisting
    ? await uniquePath(resolve(
        dirname(audioPath),
        `.${basename(audioPath, extname(audioPath))}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${audioExt}`,
      ))
    : audioPath;

  try {
    await saveResponseBody(response, tempAudioPath, MAX_AUDIO_BYTES, "Audio file");
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return json({ error: error.message }, { status: 413 });
    }
    if (error instanceof RemoteUrlError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  const replacementBackup = existingEntry && replaceExisting
    ? await backupSongEntryFiles(source, existingEntry)
    : null;
  try {
    if (replacementBackup) {
      await mkdir(dirname(audioPath), { recursive: true });
      await rename(tempAudioPath, audioPath);
    }

    const sidecar: LocalSidecar = {
      version: 1,
      title,
      artist,
      album: album || undefined,
      updatedAt: new Date().toISOString(),
    };

    if (imageUrl) {
      sidecar.coverFile = await saveRemoteImage(imageUrl, basename(audioPath, extname(audioPath)), audioPath).catch(
        () => undefined,
      );
    }

    if (lyricsText) {
      const lyricsName = `${basename(audioPath, extname(audioPath))}.lrc`;
      await writeFile(resolve(dirname(audioPath), lyricsName), `${lyricsText}\n`, "utf8");
      sidecar.lyricsFile = lyricsName;
    }

    await writeSidecar(audioPath, sidecar);
    const nextSnapshot = await getLibrary(source, true);
    const relativePath = relative(source.root, audioPath).split(sep).join("/");
    const entry = nextSnapshot.entriesByPath.get(relativePath);
    if (!entry) throw new Error("Uploaded song could not be scanned");
    if (replacementBackup) await discardSongEntryBackup(replacementBackup);
    if (!existingEntry) await markSongLikedForSource(source, nextSnapshot.songs, entry.song.id);
    return json(entry.song, { status: existingEntry && replaceExisting ? 200 : 201 });
  } catch (error) {
    await rm(tempAudioPath, { force: true }).catch(() => undefined);
    if (replacementBackup && existingEntry) {
      await restoreSongEntryBackup(source, existingEntry, audioPath, replacementBackup);
    }
    throw error;
  }
}

// Refetch the CORRECT (studio) version of a library song from YouTube and replace
// its audio file in place. The wrong-version file is backed up to a scan-ignored
// ".wrong-version" folder (reversible). The new file keeps the song's ORIGINAL id
// via a pinned sidecar, so the owner's like + any playlist rows stay valid and the
// song is served live as the new copy. Owner/shared library only.
export async function handleRefetchYouTube(source: LibrarySource, id: string, request: Request): Promise<Response> {
  if (!source.shared) return forbiddenLibraryResponse();
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");

  const body = await readJsonBody<{ title?: unknown; artist?: unknown }>(request);
  const title = (typeof body?.title === "string" && body.title.trim()) || entry.song.title;
  const artist = (typeof body?.artist === "string" && body.artist.trim()) || entry.song.artist;
  if (!title || !artist) return json({ error: "title and artist are required" }, { status: 400 });

  // Deliberately NO duration: the current file is the WRONG version, so its length
  // would bias the match toward another wrong cut. The matcher's studio/Topic
  // preference + artist gate pick the canonical version.
  const config = youtubePreviewConfig();
  const match = await resolveYouTubePreviewMatch({ title, artist }, config).catch(() => null);
  if (!match) {
    return json(
      { error: "no_youtube_match", message: "Couldn't find a confident YouTube match for this track." },
      { status: 404 },
    );
  }

  let audio: { bytes: Buffer; ext: string } | null;
  try {
    audio = await downloadYouTubePreviewAudioResilient(match.videoId, config);
  } catch {
    audio = null;
  }
  if (!audio || !audio.bytes.byteLength || audio.bytes.byteLength > MAX_AUDIO_BYTES) {
    return json({ error: "download_failed", message: "Couldn't download audio from YouTube." }, { status: 502 });
  }

  try {
    await replaceLibraryAudioInPlace(source, entry, id, audio, { title, artist });
  } catch (err) {
    console.error("[refetch-youtube] replace failed", err);
    return json(
      { error: "refetch_replace_failed", message: err instanceof Error ? err.message : "Couldn't replace the file." },
      { status: 500 },
    );
  }

  const next = await getLibrary(source, true);
  const updated = next.entriesById.get(id);
  if (!updated) {
    return json({ error: "refetch_rescan_failed", message: "Replaced the file but couldn't rescan it." }, { status: 500 });
  }
  return json(songForRequest(updated.song, request));
}

// Best-effort: if the old file has embedded artwork but no cover sibling, extract
// it to "<stem>.cover.<ext>" so the new (art-less) .opus keeps the album art.
// Returns the cover filename it wrote (for the sidecar), or undefined.
async function preserveEmbeddedCover(oldAbs: string, dir: string, stem: string): Promise<string | undefined> {
  const lowerStem = stem.toLowerCase();
  const names = await readdir(dir).catch(() => [] as string[]);
  const hasCover = names.some(
    (name) =>
      name.toLowerCase().startsWith(`${lowerStem}.cover.`) ||
      (IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) && name.replace(/\.[^.]+$/, "").toLowerCase() === lowerStem),
  );
  if (hasCover) return undefined;
  const parsed = await parseFile(oldAbs, { duration: false, skipCovers: false }).catch(() => null);
  const pic = parsed?.common.picture?.[0];
  if (!pic?.data?.length) return undefined;
  const ext = (pic.format || "").includes("png") ? ".png" : ".jpg";
  const coverName = `${stem}.cover${ext}`;
  await writeFile(resolve(dir, coverName), Buffer.from(pic.data));
  return coverName;
}

async function replaceLibraryAudioInPlace(
  source: LibrarySource,
  entry: LocalSongEntry,
  pinnedId: string,
  audio: { bytes: Buffer; ext: string },
  meta: { title: string; artist: string },
): Promise<void> {
  const oldAbs = entry.absolutePath;
  const dir = dirname(oldAbs);
  const stem = basename(oldAbs, extname(oldAbs));
  const lowerExt = audio.ext.toLowerCase();
  // Only write a container the scanner actually indexes — never write bytes under a
  // mismatched/unknown extension (e.g. raw .webm), which would make the song vanish
  // from the library. The Opus formats yt-dlp -x produces (.opus/.m4a/.ogg) qualify.
  if (!AUDIO_EXTENSIONS.has(lowerExt)) {
    throw new Error(`refetch produced an unsupported audio format: ${lowerExt || "unknown"}`);
  }
  const newAbs = resolve(dir, `${stem}${lowerExt}`);

  // 1) Preserve album art before touching the old file — but only when there is no
  // usable cover already (a valid sidecar ref or a same-stem sibling), to avoid
  // writing an orphaned extract.
  const sidecar = await readSidecar(oldAbs);
  const sidecarCoverValid = !!sidecar.coverFile && existsSync(resolve(dir, sidecar.coverFile));
  const coverName = sidecarCoverValid ? undefined : await preserveEmbeddedCover(oldAbs, dir, stem).catch(() => undefined);

  // 2) Write the new audio to a temp file FIRST and validate it parses. A failed or
  // corrupt download must never destroy the existing file — at this point the old
  // file is still fully intact, so any throw here leaves the library unchanged.
  const tempPath = `${newAbs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, audio.bytes);
  try {
    const probe = await parseFile(tempPath, { duration: true, skipCovers: true });
    if (!probe.format.duration || probe.format.duration <= 1) {
      throw new Error("downloaded audio is too short or unreadable");
    }
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err instanceof Error ? err : new Error("downloaded audio failed validation");
  }

  // 3) Back up the wrong-version audio to a scan-ignored ".wrong-version" dir
  // (reversible; a dot-dir is skipped by the scanner — Trash auto-empties here).
  const backupDir = resolve(dir, ".wrong-version");
  await mkdir(backupDir, { recursive: true });
  const backupPath = await uniquePath(resolve(backupDir, basename(oldAbs)));
  await rename(oldAbs, backupPath);

  // 4) Pin the id in the (stem-shared) sidecar BEFORE swapping the audio in, so a
  // crash can never leave the new audio present with an un-pinned sidecar — which
  // would mint a fresh path-hash id and orphan the like / playlist rows.
  sidecar.version = sidecar.version ?? 1;
  sidecar.songId = pinnedId;
  sidecar.title = meta.title;
  sidecar.artist = meta.artist;
  if (coverName && !sidecar.coverFile) sidecar.coverFile = coverName;
  sidecar.updatedAt = new Date().toISOString();
  await writeSidecar(newAbs, sidecar);

  // 5) Atomically move the validated audio into place (same dir → atomic rename).
  // If this last step fails, restore the original so the song is never left missing.
  try {
    await rename(tempPath, newAbs);
  } catch (err) {
    await rename(backupPath, oldAbs).catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function handleSongUpload(source: LibrarySource, request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("application/json")) {
    const payload = await readJsonBody<{
      title?: unknown;
      artist?: unknown;
      album?: unknown;
      audioUrl?: unknown;
      imageUrl?: unknown;
      lyricsText?: unknown;
      replaceExisting?: unknown;
      outputFormat?: unknown;
    }>(request);
    if (!payload) return json({ error: "Invalid JSON body" }, { status: 400 });
    return handleRemoteSongUpload({ ...payload, source });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid form body" }, { status: 400 });
  const title = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
  const artist = typeof form.get("artist") === "string" ? String(form.get("artist")).trim() : "";
  const album = typeof form.get("album") === "string" ? String(form.get("album")).trim() : "";
  const imageUrl = typeof form.get("imageUrl") === "string" ? String(form.get("imageUrl")).trim() : "";
  const image = form.get("image");
  const audio = form.get("audio");
  if (!title || !artist || !(audio instanceof File)) {
    return json({ error: "Title, artist, and audio are required" }, { status: 400 });
  }
  const invalidAudio = validateUploadFile(audio, "Audio file", MAX_AUDIO_BYTES, AUDIO_EXTENSIONS, "audio/");
  if (invalidAudio) return invalidAudio;
  const sniffedAudio = await sniffUploadFile(audio, "audio");
  if (!sniffedAudio) return json({ error: "Audio file content is not supported" }, { status: 415 });
  const sniffedImage = image instanceof File && image.size > 0
    ? await sniffUploadFile(image, "image")
    : null;
  if (image instanceof File && image.size > 0) {
    const invalidImage = validateUploadFile(image, "Image file", MAX_IMAGE_BYTES, IMAGE_EXTENSIONS, "image/");
    if (invalidImage) return invalidImage;
    if (!sniffedImage) return json({ error: "Image file content is not supported" }, { status: 415 });
  }
  const lyricsText = typeof form.get("lyricsText") === "string" ? String(form.get("lyricsText")).trim() : "";
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }
  const replaceExisting =
    form.get("replaceExisting") === "true" ||
    form.get("replaceExisting") === "1" ||
    form.get("replaceExisting") === "yes";

  const currentSnapshot = await getLibrary(source);
  const existingEntry = currentSnapshot.songs
    .map((song) => currentSnapshot.entriesById.get(song.id))
    .find((entry): entry is LocalSongEntry =>
      Boolean(entry && trackKey(entry.song.title, entry.song.artist) === trackKey(title, artist)),
    );

  if (existingEntry && !replaceExisting) {
    return json(
      {
        error: "Song already exists in your library",
        code: "DUPLICATE_SONG",
        existingSong: {
          id: existingEntry.song.id,
          title: existingEntry.song.title,
          artist: existingEntry.song.artist,
        },
      },
      { status: 409 },
    );
  }

  const audioExt = sniffedAudio.extension;
  const stem = sanitizeFileName(`${artist} - ${title}`);
  const preferredAudioPath = existingEntry && replaceExisting
    ? resolve(dirname(existingEntry.absolutePath), `${stem}${audioExt}`)
    : resolve(source.root, `${stem}${audioExt}`);
  const audioPath =
    existingEntry &&
    replaceExisting &&
    (!existsSync(preferredAudioPath) || preferredAudioPath === existingEntry.absolutePath)
      ? preferredAudioPath
      : await uniquePath(preferredAudioPath);
  const tempAudioPath = existingEntry && replaceExisting
    ? await uniquePath(resolve(
        dirname(audioPath),
        `.${basename(audioPath, extname(audioPath))}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${audioExt}`,
      ))
    : audioPath;
  await saveFile(audio, tempAudioPath);
  const replacementBackup = existingEntry && replaceExisting
    ? await backupSongEntryFiles(source, existingEntry)
    : null;
  try {
    if (replacementBackup) {
      await mkdir(dirname(audioPath), { recursive: true });
      await rename(tempAudioPath, audioPath);
    }

    const sidecar: LocalSidecar = {
      version: 1,
      title,
      artist,
      album: album || undefined,
      updatedAt: new Date().toISOString(),
    };

    if (image instanceof File && image.size > 0) {
      const imageExt = sniffedImage?.extension || ".jpg";
      const coverName = `${basename(audioPath, extname(audioPath))}.cover${imageExt}`;
      await saveFile(image, resolve(dirname(audioPath), coverName));
      sidecar.coverFile = coverName;
    } else if (imageUrl) {
      sidecar.coverFile = await saveRemoteImage(imageUrl, basename(audioPath, extname(audioPath)), audioPath).catch(
        () => undefined,
      );
    }

    if (lyricsText) {
      const lyricsName = `${basename(audioPath, extname(audioPath))}.lrc`;
      await writeFile(resolve(dirname(audioPath), lyricsName), `${lyricsText}\n`, "utf8");
      sidecar.lyricsFile = lyricsName;
    }

    await writeSidecar(audioPath, sidecar);
    const snapshot = await getLibrary(source, true);
    const relativePath = relative(source.root, audioPath).split(sep).join("/");
    const entry = snapshot.entriesByPath.get(relativePath);
    if (!entry) throw new Error("Uploaded song could not be scanned");
    if (replacementBackup) await discardSongEntryBackup(replacementBackup);
    if (!existingEntry) await markSongLikedForSource(source, snapshot.songs, entry.song.id);
    return json(entry.song, { status: existingEntry && replaceExisting ? 200 : 201 });
  } catch (error) {
    await rm(tempAudioPath, { force: true }).catch(() => undefined);
    if (replacementBackup && existingEntry) {
      await restoreSongEntryBackup(source, existingEntry, audioPath, replacementBackup);
    }
    throw error;
  }
}

export async function handlePatchSong(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const payload = await readJsonBody<{ title?: unknown; artist?: unknown }>(request);
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  const artist = typeof payload?.artist === "string" ? payload.artist.trim() : "";
  if (!title || !artist) return json({ error: "Title and artist are required" }, { status: 400 });

  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");
  const currentSidecar = await readSidecar(entry.absolutePath);
  await writeSidecar(entry.absolutePath, {
    ...currentSidecar,
    version: 1,
    title,
    artist,
    updatedAt: new Date().toISOString(),
  });
  const nextSnapshot = await getLibrary(source, true);
  const updated = nextSnapshot.entriesById.get(id);
  return updated ? json(updated.song) : notFound("Song not found");
}

// --- Lyrics auto-fetch (LRCLIB) ------------------------------------------
// LRCLIB (https://lrclib.net) is a free, crowd-sourced synced-lyrics API.
// We pull the timed .lrc (or plain text) for a track and write it as a sidecar
// next to the audio file so the normal library scan exposes `lyricsUrl`. Lyric
// text only ever flows provider -> sidecar file; it is never logged.
const LRCLIB_API = "https://lrclib.net/api";
const LRCLIB_USER_AGENT = "spotify-streamarena/1.0 (+https://music.streamarena.xyz)";

type ResolvedLyrics = { synced: string | null; plain: string | null };

function pickLyrics(synced: unknown, plain: unknown): ResolvedLyrics | null {
  const s = typeof synced === "string" && synced.trim() ? synced : null;
  const p = typeof plain === "string" && plain.trim() ? plain : null;
  return s || p ? { synced: s, plain: p } : null;
}

async function lrclibFetchJson(path: string, params: URLSearchParams): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${LRCLIB_API}${path}?${params.toString()}`, {
      headers: { "User-Agent": LRCLIB_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLyricsFromProvider(opts: {
  artist: string;
  title: string;
  album?: string | null;
  durationSec?: number | null;
}): Promise<ResolvedLyrics | null> {
  const artist = opts.artist?.trim();
  const title = opts.title?.trim();
  if (!artist || !title) return null;
  const duration = opts.durationSec && opts.durationSec > 0 ? Math.round(opts.durationSec) : null;

  // 1) Exact match — most reliable when the duration is known.
  {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (opts.album?.trim()) params.set("album_name", opts.album.trim());
    if (duration) params.set("duration", String(duration));
    const data = (await lrclibFetchJson("/get", params)) as Record<string, unknown> | null;
    if (data && typeof data === "object" && data.instrumental !== true) {
      const got = pickLyrics(data.syncedLyrics, data.plainLyrics);
      if (got) return got;
    }
  }

  // 2) Search fallback — prefer synced, then the closest duration.
  {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    const list = await lrclibFetchJson("/search", params);
    if (Array.isArray(list) && list.length > 0) {
      const best = list
        .filter(
          (r) =>
            r && typeof r === "object" && r.instrumental !== true && (r.syncedLyrics || r.plainLyrics),
        )
        .map((r) => ({
          r,
          hasSynced: Boolean(r.syncedLyrics),
          delta:
            duration && typeof r.duration === "number"
              ? Math.abs(r.duration - duration)
              : Number.MAX_SAFE_INTEGER,
        }))
        .sort((a, b) => (a.hasSynced === b.hasSynced ? a.delta - b.delta : a.hasSynced ? -1 : 1))[0];
      if (best) return pickLyrics(best.r.syncedLyrics, best.r.plainLyrics);
    }
  }

  return null;
}

// POST /api/songs/:id/lyrics — fetch lyrics from the provider and save the
// sidecar. `?force=1` re-fetches even if the song already has lyrics.
export async function handleFetchLyrics(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");

  const force = new URL(request.url).searchParams.get("force") === "1";
  if (entry.song.lyricsUrl && !force) {
    return json(songForRequest(entry.song, request));
  }

  const resolved = await fetchLyricsFromProvider({
    artist: entry.song.artist,
    title: entry.song.title,
    album: entry.song.album ?? null,
    durationSec: entry.song.duration ?? null,
  });
  const body = resolved?.synced || resolved?.plain || "";
  if (!body.trim()) {
    return json({ error: "No lyrics found for this track", code: "LYRICS_NOT_FOUND" }, { status: 404 });
  }
  if (byteLength(body) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics are too large" }, { status: 413 });
  }

  const stem = basename(entry.absolutePath, extname(entry.absolutePath));
  const lyricsName = `${stem}.lrc`;
  await writeFile(resolve(dirname(entry.absolutePath), lyricsName), `${body}\n`, "utf8");
  const sidecar = await readSidecar(entry.absolutePath);
  await writeSidecar(entry.absolutePath, {
    ...sidecar,
    version: 1,
    lyricsFile: lyricsName,
    updatedAt: new Date().toISOString(),
  });

  const next = await getLibrary(source, true);
  const updated = next.entriesById.get(id);
  if (!updated) return json({ error: "Song could not be rescanned" }, { status: 500 });
  return json(songForRequest(updated.song, request));
}

export async function handleSongAssets(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");

  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid form body" }, { status: 400 });
  const sidecar = await readSidecar(entry.absolutePath);
  const stem = basename(entry.absolutePath, extname(entry.absolutePath));
  const image = form.get("image");
  const lyricsFile = form.get("lyricsFile");
  const lyricsText = typeof form.get("lyricsText") === "string" ? String(form.get("lyricsText")).trim() : "";
  const sniffedImage = image instanceof File && image.size > 0
    ? await sniffUploadFile(image, "image")
    : null;
  if (image instanceof File && image.size > 0) {
    const invalidImage = validateUploadFile(image, "Image file", MAX_IMAGE_BYTES, IMAGE_EXTENSIONS, "image/");
    if (invalidImage) return invalidImage;
    if (!sniffedImage) return json({ error: "Image file content is not supported" }, { status: 415 });
  }
  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    const invalidLyrics = validateUploadFile(lyricsFile, "Lyrics file", MAX_LYRICS_BYTES, LYRICS_EXTENSIONS, "text/");
    if (invalidLyrics) return invalidLyrics;
  }
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }

  if (image instanceof File && image.size > 0) {
    const imageExt = sniffedImage?.extension || ".jpg";
    const coverName = `${stem}.cover${imageExt}`;
    await saveFile(image, resolve(dirname(entry.absolutePath), coverName));
    sidecar.coverFile = coverName;
  }

  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    const lyricsExt = LYRICS_EXTENSIONS.has(extname(lyricsFile.name).toLowerCase())
      ? extname(lyricsFile.name).toLowerCase()
      : ".lrc";
    const lyricsName = `${stem}${lyricsExt}`;
    await saveFile(lyricsFile, resolve(dirname(entry.absolutePath), lyricsName));
    sidecar.lyricsFile = lyricsName;
  } else if (lyricsText) {
    const lyricsName = `${stem}.lrc`;
    await writeFile(resolve(dirname(entry.absolutePath), lyricsName), `${lyricsText}\n`, "utf8");
    sidecar.lyricsFile = lyricsName;
  }

  sidecar.updatedAt = new Date().toISOString();
  await writeSidecar(entry.absolutePath, sidecar);
  const nextSnapshot = await getLibrary(source, true);
  const updated = nextSnapshot.entriesById.get(id);
  return updated ? json(updated.song) : notFound("Song not found");
}
