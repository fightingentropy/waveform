import * as FileSystem from "expo-file-system/legacy";
import {
  downloadExtension,
  safeDownloadName,
} from "@/lib/background-download-policy";
import { toAbsoluteApiUrl } from "@/lib/config";
import { getIsOnline, markOffline } from "@/lib/connectivity";
import { apiFetch } from "@/lib/http";
import { toMediaRelativePath } from "@/lib/offline-db";
import {
  nextQueuedDownload,
  type OfflineDownloadRecord,
} from "@/lib/offline-download-queue";
import type { PlayerSong } from "@/types/player";

export type JsOfflineDownloadPumpDeps = {
  getAccountScope: () => string;
  nativeBackgroundDownloads: boolean;
  offlineDir: string;
  getRecords: () => Record<string, OfflineDownloadRecord>;
  persist: (record: OfflineDownloadRecord) => void;
  setProgress: (key: string, frac: number) => void;
  clearProgress: (key: string) => void;
  keyFor: (scope: string, songId: string) => string;
};

export function createJsOfflineDownloadPump(deps: JsOfflineDownloadPumpDeps): {
  runPump: () => Promise<void>;
  pauseActiveDownload: () => Promise<void>;
  isActiveDownloadKey: (key: string) => boolean;
} {
  let pumping = false;
  // The download in flight right now, exposed so a connectivity drop or an
  // app-background can pauseAsync() it (banking an NSURLSession resume blob)
  // before the socket dies — otherwise the partial is orphaned and we restart
  // from zero. Null whenever nothing is downloading.
  let activeDownload: { resumable: FileSystem.DownloadResumable; key: string } | null = null;
  // Key that pauseActiveDownload just paused, so the pump can tell a deliberate
  // pause (re-queue + keep the resume blob) from a genuine failure (mark error).
  let pausedKey: string | null = null;

  const runPump = async () => {
    // iOS hands the entire durable batch to BackgroundDownloadCoordinator.
    // Running this JS pump as well would create duplicate writers for each file.
    if (deps.nativeBackgroundDownloads) return;
    if (pumping) return;
    pumping = true;
    try {
      try {
        await FileSystem.makeDirectoryAsync(deps.offlineDir, { intermediates: true });
      } catch {}
      while (true) {
        // Run while online (foreground or background). Offline: stop so we don't
        // flip every row to "error"; connectivity handler re-kicks the pump.
        if (!getIsOnline()) break;
        const accountScope = deps.getAccountScope();
        const queued = nextQueuedDownload(Object.values(deps.getRecords()), accountScope);
        if (!queued) break;
        const key = deps.keyFor(accountScope, queued.songId);
        const resumeData = queued.resumeData;
        deps.persist({ ...queued, status: "downloading", updatedAt: Date.now() });
        deps.setProgress(key, 0);
        try {
          const dir = `${deps.offlineDir}${safeDownloadName(queued.songId)}/`;
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          const audioExt = downloadExtension(queued.song.audioUrl, ".audio");
          const audioPath = `${dir}audio${audioExt}`;
          // Audio is ~all the bytes (cover/lyrics are tiny), so its byte stream
          // drives the fill ring. createDownloadResumable gives us the progress
          // callback that downloadAsync lacks — and, seeded with a resume blob,
          // the ability to continue a partial instead of starting over.
          const resumable = FileSystem.createDownloadResumable(
            toAbsoluteApiUrl(queued.song.audioUrl),
            audioPath,
            {},
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
              if (totalBytesExpectedToWrite > 0) {
                deps.setProgress(key, totalBytesWritten / totalBytesExpectedToWrite);
              }
            },
            resumeData,
          );
          activeDownload = { resumable, key };
          // resumeAsync() continues from the saved partial (server replies 206);
          // downloadAsync() starts fresh. Either resolves to undefined when a
          // pauseAsync() cancels it — that's our deliberate-pause signal below.
          let result: FileSystem.FileSystemDownloadResult | undefined;
          try {
            result = resumeData ? await resumable.resumeAsync() : await resumable.downloadAsync();
          } catch (error) {
            // A queue-ahead download is also our end-to-end reachability probe.
            // When it cannot reach the media URL, prefer cached/downloaded tracks
            // immediately instead of trusting iOS's still-present cellular route.
            if (pausedKey !== key) markOffline();
            throw error;
          }
          activeDownload = null;
          if (!result) {
            // Cancelled by pauseActiveDownload (offline/background). It has already
            // re-queued the row with its resume blob — leave that record intact.
            pausedKey = null;
            deps.clearProgress(key);
            continue;
          }
          if (result.status >= 400) {
            // expo resolves (doesn't throw) on a bad HTTP status and writes the
            // response body to the file — e.g. an expired signed URL returning
            // HTML. Signed media URLs can expire while a large playlist waits in
            // this serial queue, so refresh the song once at the authoritative
            // endpoint and retry with the new URL instead of leaving a permanently
            // poisoned "Retry" row that keeps using the same stale signature.
            if (result.status === 401 || result.status === 403 || result.status === 404) {
              try {
                const response = await apiFetch(`/api/songs/${encodeURIComponent(queued.songId)}`, {
                  cache: "no-store",
                });
                if (response.ok) {
                  const fresh = (await response.json()) as PlayerSong;
                  const latest = deps.getRecords()[key];
                  if (
                    latest &&
                    fresh?.id === queued.songId &&
                    fresh.audioUrl &&
                    fresh.audioUrl !== queued.song.audioUrl
                  ) {
                    await FileSystem.deleteAsync(audioPath, { idempotent: true }).catch(() => {});
                    deps.clearProgress(key);
                    deps.persist({
                      ...latest,
                      song: fresh,
                      status: "queued",
                      resumeData: undefined,
                      error: undefined,
                      updatedAt: Date.now(),
                    });
                    continue;
                  }
                }
              } catch {
                // Fall through to the normal error/offline classification below.
              }
            }
            // Guard every other error response so garbage is never marked ready.
            throw new Error(`Download failed with HTTP ${result.status}`);
          }
          // Write-time integrity check — confirm the bytes actually landed before
          // we trust this as a download. expo resolves on any *completed* HTTP
          // response, so without this a 0-byte or truncated file could be marked
          // "ready". Require a non-empty file; for a full (non-resumed, 200)
          // response that advertised a Content-Length, also require the on-disk
          // size to reach it, catching a short/truncated transfer. Resumed 206s
          // report only the remaining length, so the length match is skipped there
          // (the size>0 floor still applies). A failure throws into the catch below
          // → re-queued while offline, "error" while online — never a bad "ready".
          const info = await FileSystem.getInfoAsync(audioPath);
          if (!info.exists || info.isDirectory || info.size <= 0) {
            throw new Error("Downloaded audio file is missing or empty");
          }
          const expectedBytes = Number(
            result.headers?.["Content-Length"] ?? result.headers?.["content-length"],
          );
          if (
            !resumeData &&
            result.status === 200 &&
            Number.isFinite(expectedBytes) &&
            expectedBytes > 0 &&
            info.size < expectedBytes
          ) {
            throw new Error(`Downloaded audio is truncated (${info.size}/${expectedBytes} bytes)`);
          }
          deps.setProgress(key, 1);

          let coverPath: string | undefined;
          if (queued.song.imageUrl) {
            try {
              const coverExt = downloadExtension(queued.song.imageUrl, ".jpg");
              const p = `${dir}cover${coverExt}`;
              await FileSystem.downloadAsync(toAbsoluteApiUrl(queued.song.imageUrl), p);
              coverPath = p;
            } catch {}
          }
          let lyricsPath: string | undefined;
          if (queued.song.lyricsUrl) {
            try {
              const p = `${dir}lyrics.lrc`;
              await FileSystem.downloadAsync(toAbsoluteApiUrl(queued.song.lyricsUrl), p);
              lyricsPath = p;
            } catch {}
          }

          // The record may have gained/lost scopes while downloading; re-read.
          const latest = deps.getRecords()[key];
          deps.clearProgress(key);
          if (!latest) continue; // unpinned mid-download
          // Persist paths RELATIVE to documentDirectory — never the absolute
          // container path, which iOS can change across a reinstall and strand.
          deps.persist({
            ...latest,
            status: "ready",
            audioPath: toMediaRelativePath(audioPath) ?? audioPath,
            coverPath: toMediaRelativePath(coverPath) ?? undefined,
            lyricsPath: toMediaRelativePath(lyricsPath) ?? undefined,
            resumeData: undefined,
            updatedAt: Date.now(),
            error: undefined,
          });
        } catch (e) {
          activeDownload = null;
          deps.clearProgress(key);
          if (pausedKey === key) {
            // A deliberate pause surfaced as a rejection rather than an undefined
            // result — pauseActiveDownload already re-queued it with a resume blob.
            pausedKey = null;
            continue;
          }
          const latest = deps.getRecords()[key];
          if (!latest) continue;
          if (!getIsOnline()) {
            // Connectivity dropped mid-download and the socket error raced ahead of
            // our pause (no resume blob captured). Keep it queued so it retries from
            // scratch on reconnect, instead of stranding it as a manual-retry error.
            deps.persist({ ...latest, status: "queued", resumeData: undefined, updatedAt: Date.now() });
          } else {
            deps.persist({
              ...latest,
              status: "error",
              resumeData: undefined,
              updatedAt: Date.now(),
              error: e instanceof Error ? e.message : "Download failed",
            });
          }
        }
      }
    } finally {
      pumping = false;
    }
  };

  // Pause whatever is downloading right now and bank its NSURLSession resume blob
  // on the record, so a later resumeAsync() continues from the partial. Invoked on
  // the two interruptions we can see coming — connectivity loss and app-background.
  // Best-effort: if pauseAsync can't produce a blob, the row just restarts fresh.
  const pauseActiveDownload = async () => {
    if (deps.nativeBackgroundDownloads) {
      // The native URLSession waits for connectivity and owns suspension/relaunch.
      // Pausing it from JS would defeat the background queue.
      return;
    }
    const active = activeDownload;
    if (!active) return;
    activeDownload = null;
    pausedKey = active.key;
    let resumeData: string | undefined;
    try {
      const state = await active.resumable.pauseAsync();
      resumeData = state.resumeData;
    } catch {}
    deps.clearProgress(active.key);
    const latest = deps.getRecords()[active.key];
    if (latest) deps.persist({ ...latest, status: "queued", resumeData, updatedAt: Date.now() });
  };

  return {
    runPump,
    pauseActiveDownload,
    isActiveDownloadKey: (key) => activeDownload?.key === key,
  };
}
