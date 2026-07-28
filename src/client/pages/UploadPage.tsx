"use client";

import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router";
import { CheckCircle2, Download, Loader2, Pause, Play, XCircle } from "lucide-react";
import { invalidateLibraryApiCache } from "@/client/api";
import { useAuth } from "@/client/auth";
import { readSpotifyCookie, writeSpotifyCookie } from "@/lib/spotify-cookie";
import { formatTime } from "@/lib/utils";
import { resolveSpotifyBatchOnClient } from "@/lib/spotify-batch-client";

type SpotifyTrack = {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  releaseDate: string;
  totalPlays: number;
  durationMs: number;
  imageUrl: string;
  previewUrl: string;
};

type ActionStatus = "idle" | "loading" | "success" | "error";
type ImportProgress = { stage: "resolving" | "downloading" | "saving"; received: number; total: number };
type ImportStreamOutcome =
  | { kind: "done" }
  | { kind: "duplicate"; existingSong: { title?: string; artist?: string } | null }
  | { kind: "error"; error: string };
// Server imports only accept FLAC/original audio (see assertServerImportOutputFormat in the Worker).
type OutputFormat = "flac";
type BatchType = "track" | "album" | "playlist";
type PendingImportPayload = { lyricsToInclude: string };
type BatchInfo = {
  type: BatchType;
  title: string;
  artist: string;
  trackCount: number;
  // Display-only; the batch resolver may report other formats but server imports stay FLAC.
  format: "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";
  trackIds: string[];
  tracks?: SpotifyTrack[];
};
type BatchProgress = {
  current: number;
  total: number;
  currentTrack: string;
  succeeded: number;
  skipped: number;
  failed: number;
};

type PersistentBatchState = {
  batchInfo: BatchInfo;
  status: ActionStatus;
  progress: BatchProgress | null;
  failures: string[];
  notice: string | null;
  error: string | null;
};

const BATCH_STATE_KEY = "spotify_active_batch_import";
let persistentBatchController: AbortController | null = null;
let persistentBatchState: PersistentBatchState | null = null;
const persistentBatchListeners = new Set<(state: PersistentBatchState) => void>();

function publishBatchState(patch: Partial<PersistentBatchState>): void {
  if (!persistentBatchState && !patch.batchInfo) return;
  persistentBatchState = {
    batchInfo: patch.batchInfo ?? persistentBatchState!.batchInfo,
    status: patch.status ?? persistentBatchState?.status ?? "idle",
    progress: patch.progress !== undefined ? patch.progress : persistentBatchState?.progress ?? null,
    failures: patch.failures ?? persistentBatchState?.failures ?? [],
    notice: patch.notice !== undefined ? patch.notice : persistentBatchState?.notice ?? null,
    error: patch.error !== undefined ? patch.error : persistentBatchState?.error ?? null,
  };
  try {
    sessionStorage.setItem(BATCH_STATE_KEY, JSON.stringify(persistentBatchState));
  } catch {}
  for (const listener of persistentBatchListeners) listener(persistentBatchState);
}

function readPersistedBatchState(): PersistentBatchState | null {
  try {
    const raw = sessionStorage.getItem(BATCH_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistentBatchState;
    if (!parsed?.batchInfo || !Array.isArray(parsed.batchInfo.trackIds)) return null;
    if (parsed.status === "loading") {
      parsed.status = "idle";
      parsed.notice = "The browser reloaded during this import. Choose Resume batch to continue; completed tracks will be skipped.";
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearPersistedBatchState(): void {
  persistentBatchState = null;
  try {
    sessionStorage.removeItem(BATCH_STATE_KEY);
  } catch {}
}

function formatDuration(durationMs: number): string {
  if (!durationMs || !Number.isFinite(durationMs)) return "0:00";
  return formatTime(durationMs / 1000);
}

function formatPlays(totalPlays: number): string {
  if (!totalPlays || !Number.isFinite(totalPlays)) return "N/A";
  return totalPlays.toLocaleString();
}

function ActionIcon({ status }: { status: ActionStatus }) {
  if (status === "success") return <CheckCircle2 size={16} className="text-green-500" />;
  if (status === "error") return <XCircle size={16} className="text-red-500" />;
  return null;
}

function normalizeTrackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function spotifyTrackIdFromUrl(url: string): string {
  const match = url.match(/\/track\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? "";
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function importStageLabel(progress: ImportProgress): string {
  if (progress.stage === "resolving") return "Resolving lossless source…";
  if (progress.stage === "saving") return "Saving to your library…";
  return "Downloading lossless audio…";
}

// Bar width: real % while downloading with a known size; otherwise a sensible
// indeterminate position per stage (rendered with a pulse by the caller).
function importBarPercent(progress: ImportProgress): number {
  if (progress.stage === "resolving") return 8;
  // Saving sits above the downloading cap so the bar only ever moves forward.
  if (progress.stage === "saving") return 98;
  if (progress.total > 0) return Math.min(96, Math.max(2, Math.round((progress.received / progress.total) * 100)));
  return progress.received > 0 ? 55 : 12;
}

function importIsDeterminate(progress: ImportProgress): boolean {
  return progress.stage === "downloading" && progress.total > 0;
}

// True download percentage for the label (0–100), independent of the bar's
// capped width.
function importDownloadPercent(progress: ImportProgress): number {
  if (progress.total <= 0) return 0;
  return Math.min(100, Math.round((progress.received / progress.total) * 100));
}

// Read the worker's NDJSON import stream, driving `onProgress` and returning the
// terminal outcome (done / duplicate / error).
async function consumeImportProgressStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: ImportProgress) => void,
): Promise<ImportStreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // If the stream closes with no terminal event, the import may actually have
  // saved server-side — don't claim a hard failure.
  let outcome: ImportStreamOutcome = {
    kind: "error",
    error: "Connection interrupted before the import finished — check your library before retrying.",
  };
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const stage = typeof event.stage === "string" ? event.stage : "";
    if (stage === "resolving") onProgress({ stage: "resolving", received: 0, total: 0 });
    else if (stage === "downloading")
      onProgress({ stage: "downloading", received: Number(event.received) || 0, total: Number(event.total) || 0 });
    else if (stage === "saving") onProgress({ stage: "saving", received: 0, total: 0 });
    else if (stage === "done") outcome = { kind: "done" };
    else if (stage === "duplicate")
      outcome = {
        kind: "duplicate",
        existingSong: (event.existingSong as { title?: string; artist?: string } | null) ?? null,
      };
    else if (stage === "error")
      outcome = { kind: "error", error: typeof event.error === "string" ? event.error : "Import failed" };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer) handleLine(buffer);
  } finally {
    reader.releaseLock?.();
  }
  return outcome;
}

export default function UploadPage() {
  const { user, status } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"upload" | "spotify">("spotify");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [spotifyUrl, setSpotifyUrl] = useState("");
  const [spotifyTrack, setSpotifyTrack] = useState<SpotifyTrack | null>(null);
  const [lyricsText, setLyricsText] = useState("");
  const [fetchStatus, setFetchStatus] = useState<ActionStatus>("idle");
  const [downloadStatus, setDownloadStatus] = useState<ActionStatus>("idle");
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [replaceModalMessage, setReplaceModalMessage] = useState("");
  const [pendingImportPayload, setPendingImportPayload] = useState<PendingImportPayload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [batchInfo, setBatchInfo] = useState<BatchInfo | null>(null);
  const [batchStatus, setBatchStatus] = useState<ActionStatus>("idle");
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchFailures, setBatchFailures] = useState<string[]>([]);
  const autoStartRef = useRef<"fetch" | "download" | null>(null);
  const [autoDownloadPending, setAutoDownloadPending] = useState(false);
  const autoDownloadStartedRef = useRef(false);
  const batchDownloadRunnerRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const replaceModalRef = useRef<HTMLDivElement | null>(null);
  const replaceTriggerRef = useRef<HTMLElement | null>(null);
  const requestedOutputFormat: OutputFormat = "flac";

  useEffect(() => {
    const restore = (state: PersistentBatchState) => {
      setBatchInfo(state.batchInfo);
      setBatchStatus(state.status);
      setBatchProgress(state.progress);
      setBatchFailures(state.failures);
      setNotice(state.notice);
      setError(state.error);
    };
    if (!persistentBatchState) persistentBatchState = readPersistedBatchState();
    if (persistentBatchState) restore(persistentBatchState);
    persistentBatchListeners.add(restore);
    return () => {
      previewAudioRef.current?.pause();
      if (previewAudioRef.current) previewAudioRef.current.currentTime = 0;
      persistentBatchListeners.delete(restore);
    };
  }, []);

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const params = new URLSearchParams(window.location.search);
    // sp_dc is an account credential. Accept it only from the URL fragment,
    // which is never transmitted in HTTP requests or written to Caddy logs.
    const cookieParam = hashParams.get("spotifyCookie");
    const urlParam = params.get("url");
    const autostart = params.get("autostart") === "1";
    if (cookieParam) writeSpotifyCookie(cookieParam);
    if (urlParam) {
      clearPersistedBatchState();
      setSpotifyUrl(urlParam);
    }
    if (autostart && urlParam) {
      autoStartRef.current = "download";
    } else if (urlParam) {
      autoStartRef.current = "fetch";
    }
    if (cookieParam || urlParam || window.location.hash) {
      window.history.replaceState({}, "", "/upload");
    }
  }, []);

  useEffect(() => {
    if (status === "loading" || !user) return;
    const pending = autoStartRef.current;
    if (!pending || !spotifyUrl.trim()) return;
    autoStartRef.current = null;
    if (pending === "download") setAutoDownloadPending(true);

    void (async () => {
      setError(null);
      setNotice(null);
      setFetchStatus("loading");
      setBatchStatus("idle");
      setBatchProgress(null);
      setBatchFailures([]);
      setBatchInfo(null);
      setSpotifyTrack(null);

      const url = spotifyUrl.trim();
      const isBatch =
        url.includes("/album/") || url.includes("/playlist/") || url.includes("/collection/");
      try {
        if (isBatch) {
          const cookie = readSpotifyCookie();
          const clientBatch = await resolveSpotifyBatchOnClient(url, cookie, requestedOutputFormat);
          setBatchInfo(clientBatch);
          setFetchStatus("success");
          setNotice(`Found ${clientBatch.trackCount} tracks from Spotify.`);
        } else {
          // /track/ URLs cannot be resolved as a batch on the client; use the single-track path.
          // There is no single-track auto-download trigger, so clear any pending flag.
          setAutoDownloadPending(false);
          const track = await fetchSpotifyTrackById(spotifyTrackIdFromUrl(url));
          setSpotifyTrack(track);
          setFetchStatus("success");
        }
      } catch (err) {
        setAutoDownloadPending(false);
        setFetchStatus("error");
        setError(err instanceof Error ? err.message : "Failed to fetch batch info");
      }
    })();
  }, [user, status, spotifyUrl, requestedOutputFormat]);

  useEffect(() => {
    if (!batchInfo || !autoDownloadPending || autoDownloadStartedRef.current) return;
    autoDownloadStartedRef.current = true;
    setAutoDownloadPending(false);
    window.dispatchEvent(new CustomEvent("spotify-start-batch-download"));
  }, [batchInfo, autoDownloadPending]);

  useEffect(() => {
    const handler = () => {
      void batchDownloadRunnerRef.current();
    };
    window.addEventListener("spotify-start-batch-download", handler);
    return () => window.removeEventListener("spotify-start-batch-download", handler);
  }, []);

  // Replace-song modal: Escape to close, focus trap, and restore focus to the trigger.
  useEffect(() => {
    if (!showReplaceModal) return;
    const previouslyFocused = (replaceTriggerRef.current ?? document.activeElement) as
      | HTMLElement
      | null;
    const raf = requestAnimationFrame(() => {
      const dialog = replaceModalRef.current;
      const focusable = dialog?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeReplaceModal();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = replaceModalRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [showReplaceModal]);

  if (status === "loading") return <div className="max-w-md mx-auto py-16 px-4">Loading...</div>;
  if (!user) {
    return (
      <div className="max-w-md mx-auto py-16 px-4">
        <p className="mb-4">You must be signed in to upload songs.</p>
        <Link className="underline" to="/signin">Sign in</Link>
      </div>
    );
  }

  async function onUploadSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedTitle = title.trim();
    const trimmedArtist = artist.trim();
    if (!trimmedTitle || !trimmedArtist || !image || !audio) {
      setError("All upload fields are required");
      return;
    }
    setLoading(true);
    try {
      const form = new FormData();
      form.append("title", trimmedTitle);
      form.append("artist", trimmedArtist);
      form.append("image", image);
      form.append("audio", audio);
      const res = await fetch("/api/songs", { method: "POST", body: form, credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? "Upload failed");
      }
      invalidateLibraryApiCache();
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleFetchSpotify() {
    if (persistentBatchController && !persistentBatchController.signal.aborted) return;
    clearPersistedBatchState();
    // Stop any preview audio that was playing for a previously fetched track.
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
    }
    setIsPreviewPlaying(false);
    setError(null);
    setNotice(null);
    setFetchStatus("loading");
    setDownloadStatus("idle");
    setImportProgress(null);
    setBatchStatus("idle");
    setBatchProgress(null);
    setBatchFailures([]);
    setSpotifyTrack(null);
    setBatchInfo(null);
    setLyricsText("");
    setShowReplaceModal(false);
    setReplaceModalMessage("");
    setPendingImportPayload(null);

    // Detect if this is a batch URL (album/playlist)
    const url = spotifyUrl.trim();
    const isBatch = url.includes("/album/") || url.includes("/playlist/") || url.includes("/collection/");

    if (isBatch) {
      try {
        const cookie = readSpotifyCookie();
        try {
          const clientBatch = await resolveSpotifyBatchOnClient(url, cookie, requestedOutputFormat);
          setBatchInfo(clientBatch);
          setFetchStatus("success");
          setNotice(`Found ${clientBatch.trackCount} tracks from Spotify.`);
          return;
        } catch (clientError) {
          const res = await fetch("/api/songs/spotify/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              spotifyUrl: url,
              region: "US",
              outputFormat: requestedOutputFormat,
              qualityProfile: "max",
              spotifyCookie: cookie,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw clientError instanceof Error
              ? clientError
              : new Error(data?.error ?? "Failed to fetch batch info");
          }
          setBatchInfo(data.batchInfo);
          setFetchStatus("success");
        }
      } catch (err) {
        setFetchStatus("error");
        setError(err instanceof Error ? err.message : "Failed to fetch batch info");
      }
    } else {
      // Handle single track
      try {
        const res = await fetch("/api/songs/spotify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "fetch", spotifyUrl: url, region: "US" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "Failed to fetch Spotify track");
        setSpotifyTrack(data.track ?? null);
        setFetchStatus("success");
      } catch (err) {
        setFetchStatus("error");
        setError(err instanceof Error ? err.message : "Failed to fetch Spotify track");
      }
    }
  }

  async function fetchSpotifyTrackById(trackId: string): Promise<SpotifyTrack> {
    const res = await fetch("/api/songs/spotify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        action: "fetch",
        spotifyUrl: `https://open.spotify.com/track/${trackId}`,
        region: "US",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "Failed to fetch Spotify track");
    if (!data.track) throw new Error("Spotify track metadata missing");
    return data.track as SpotifyTrack;
  }

  async function fetchLyricsForTrack(track: SpotifyTrack, trackUrl: string): Promise<string> {
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "lyrics",
          spotifyUrl: trackUrl,
          title: track.title,
          artist: track.artist,
          region: "US",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return "";
      return typeof data.lyrics === "string" ? data.lyrics.trim() : "";
    } catch {
      return "";
    }
  }

  async function submitTrackImport(
    track: SpotifyTrack,
    trackUrl: string,
    lyricsToInclude: string,
    replaceExisting = false,
  ) {
    const payload: Record<string, string> = {
      mode: "spotify",
      spotifyUrl: trackUrl,
      region: "US",
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: String(track.durationMs || ""),
      imageUrl: track.imageUrl,
      qualityProfile: "max",
      outputFormat: "flac",
    };
    if (lyricsToInclude) payload.lyricsText = lyricsToInclude;
    if (replaceExisting) payload.replaceExisting = "true";
    const res = await fetch("/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.code === "DUPLICATE_SONG") {
      return "skipped" as const;
    }
    if (!res.ok) throw new Error(data?.error ?? "Failed to add song from Spotify");
    invalidateLibraryApiCache();
    return "imported" as const;
  }

  function trackFromBatchId(spotifyId: string): SpotifyTrack {
    return {
      spotifyId,
      title: "Unknown Track",
      artist: "Unknown Artist",
      album: "",
      releaseDate: "",
      totalPlays: 0,
      durationMs: 0,
      imageUrl: "",
      previewUrl: "",
    };
  }

  function needsTrackMetadataRefresh(track: SpotifyTrack) {
    return (
      !track.title ||
      !track.artist ||
      track.title === "Unknown Track" ||
      track.artist === "Unknown Artist"
    );
  }

  function cancelBatchDownload() {
    persistentBatchController?.abort();
  }

  async function handleBatchDownload() {
    if (!batchInfo) return;
    // Guard against a double-trigger (e.g. button click + autostart event).
    if (persistentBatchController && !persistentBatchController.signal.aborted) return;
    const controller = new AbortController();
    persistentBatchController = controller;
    const { signal } = controller;
    setError(null);
    setNotice(null);
    publishBatchState({ batchInfo, failures: [], status: "loading", notice: null, error: null });

    const batchTracks =
      batchInfo.tracks && batchInfo.tracks.length > 0
        ? batchInfo.tracks
        : batchInfo.trackIds.map(trackFromBatchId);
    const total = batchTracks.length;
    const knownKeys = new Set<string>();
    const failures: string[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let cancelled = false;

    publishBatchState({ progress: {
      current: 0,
      total,
      currentTrack: "",
      succeeded: 0,
      skipped: 0,
      failed: 0,
    } });

    try {
      for (let index = 0; index < batchTracks.length; index += 1) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        const batchTrack = batchTracks[index];
        const trackId = batchTrack.spotifyId || batchInfo.trackIds[index];
        const trackUrl = `https://open.spotify.com/track/${trackId}`;
        let track = batchTrack;

        try {
          if (!trackId) throw new Error("Spotify track ID missing");
          if (needsTrackMetadataRefresh(track)) {
            track = await fetchSpotifyTrackById(trackId);
          }
        } catch (err) {
          failed += 1;
          failures.push(
            `${trackId}: ${err instanceof Error ? err.message : "Failed to fetch track metadata"}`,
          );
          publishBatchState({ progress: {
            current: index + 1,
            total,
            currentTrack: trackId,
            succeeded,
            skipped,
            failed,
          } });
          await delay(400);
          continue;
        }

        if (signal.aborted) {
          cancelled = true;
          break;
        }

        publishBatchState({ progress: {
          current: index + 1,
          total,
          currentTrack: `${track.artist} - ${track.title}`,
          succeeded,
          skipped,
          failed,
        } });

        if (knownKeys.has(normalizeTrackKey(track.title, track.artist))) {
          skipped += 1;
          publishBatchState({ progress: {
            current: index + 1,
            total,
            currentTrack: `${track.artist} - ${track.title}`,
            succeeded,
            skipped,
            failed,
          } });
          await delay(200);
          continue;
        }

        try {
          const lyrics = await fetchLyricsForTrack(track, trackUrl);
          const result = await submitTrackImport(track, trackUrl, lyrics);
          if (result === "skipped") {
            skipped += 1;
            knownKeys.add(normalizeTrackKey(track.title, track.artist));
            publishBatchState({ progress: {
              current: index + 1,
              total,
              currentTrack: `${track.artist} - ${track.title}`,
              succeeded,
              skipped,
              failed,
            } });
            await delay(400);
            continue;
          }
          knownKeys.add(normalizeTrackKey(track.title, track.artist));
          succeeded += 1;
        } catch (err) {
          failed += 1;
          failures.push(
            `${track.artist} - ${track.title}: ${err instanceof Error ? err.message : "Download failed"}`,
          );
        }

        publishBatchState({ progress: {
          current: index + 1,
          total,
          currentTrack: `${track.artist} - ${track.title}`,
          succeeded,
          skipped,
          failed,
        } });
        await delay(500);
      }

      const finalNotice = cancelled
          ? `Batch cancelled: ${succeeded} downloaded, ${skipped} skipped, ${failed} failed.`
          : `Batch complete: ${succeeded} downloaded, ${skipped} skipped, ${failed} failed out of ${total} tracks.`;
      publishBatchState({
        failures,
        status: cancelled ? "idle" : failed > 0 && succeeded === 0 ? "error" : "success",
        notice: finalNotice,
        error: failures.length > 0 ? failures.slice(0, 3).join(" · ") : null,
      });
      if (succeeded > 0) invalidateLibraryApiCache();
    } catch (err) {
      publishBatchState({
        status: "error",
        error: err instanceof Error ? err.message : "Batch download failed",
      });
    } finally {
      if (persistentBatchController === controller) persistentBatchController = null;
    }
  }
  batchDownloadRunnerRef.current = handleBatchDownload;

  async function handlePreviewToggle() {
    if (!spotifyTrack) return;
    setError(null);
    if (isPreviewPlaying && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
      setIsPreviewPlaying(false);
      return;
    }
    if (!spotifyTrack.previewUrl) {
      setError("Preview not available for this track");
      return;
    }
    try {
      const audioEl = new Audio(spotifyTrack.previewUrl);
      previewAudioRef.current = audioEl;
      audioEl.addEventListener("ended", () => {
        setIsPreviewPlaying(false);
        previewAudioRef.current = null;
      });
      audioEl.addEventListener("error", () => {
        setIsPreviewPlaying(false);
        previewAudioRef.current = null;
      });
      await audioEl.play();
      setIsPreviewPlaying(true);
    } catch {
      setError("Failed to play preview");
    }
  }

  async function fetchLyricsForImport(): Promise<string> {
    if (!spotifyTrack) return "";
    if (lyricsText.trim()) return lyricsText.trim();
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "lyrics",
          spotifyUrl: spotifyUrl.trim(),
          title: spotifyTrack.title,
          artist: spotifyTrack.artist,
          region: "US",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return "";
      const text = typeof data.lyrics === "string" ? data.lyrics.trim() : "";
      if (text) setLyricsText(text);
      return text;
    } catch {
      return "";
    }
  }

  function duplicateSongError(existingSong: { title?: string; artist?: string } | null): Error & { code: string } {
    const message =
      typeof existingSong?.title === "string" && typeof existingSong?.artist === "string"
        ? `You already have "${existingSong.title}" by ${existingSong.artist}. Replace it?`
        : "You already have this song in your library. Replace it?";
    const error = new Error(message) as Error & { code: string };
    error.code = "DUPLICATE_SONG";
    return error;
  }

  async function submitSpotifyImport(lyricsToInclude: string, replaceExisting = false) {
    if (!spotifyTrack) return;
    const payload: Record<string, string> = {
      mode: "spotify",
      spotifyUrl: spotifyUrl.trim(),
      region: "US",
      title: spotifyTrack.title,
      artist: spotifyTrack.artist,
      album: spotifyTrack.album,
      durationMs: String(spotifyTrack.durationMs || ""),
      imageUrl: spotifyTrack.imageUrl,
      qualityProfile: "max",
      outputFormat: "flac",
    };
    if (lyricsToInclude) payload.lyricsText = lyricsToInclude;
    if (replaceExisting) payload.replaceExisting = "true";
    setImportProgress({ stage: "resolving", received: 0, total: 0 });
    const res = await fetch("/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-progress-stream": "1" },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    // Progress stream: read NDJSON events; the outcome is the terminal event.
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/x-ndjson") && res.body) {
      const outcome = await consumeImportProgressStream(res.body, setImportProgress);
      if (outcome.kind === "duplicate") throw duplicateSongError(outcome.existingSong);
      if (outcome.kind === "error") throw new Error(outcome.error);
      invalidateLibraryApiCache();
      return;
    }

    // Fallback: a server that didn't stream (e.g. non-mini path) returns plain JSON.
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.code === "DUPLICATE_SONG") {
      throw duplicateSongError(data?.existingSong ?? null);
    }
    if (!res.ok) throw new Error(data?.error ?? "Failed to add song from Spotify");
    invalidateLibraryApiCache();
  }

  function isDuplicateSongError(errorValue: unknown): errorValue is Error & { code: string } {
    return errorValue instanceof Error && (errorValue as Error & { code?: string }).code === "DUPLICATE_SONG";
  }

  function closeReplaceModal() {
    setShowReplaceModal(false);
    setPendingImportPayload(null);
    setDownloadStatus("idle");
    setImportProgress(null);
  }

  async function handleConfirmReplaceSong() {
    if (!pendingImportPayload) return;
    setShowReplaceModal(false);
    setDownloadStatus("loading");
    setImportProgress({ stage: "resolving", received: 0, total: 0 });
    setError(null);
    setNotice(null);
    try {
      await submitSpotifyImport(pendingImportPayload.lyricsToInclude, true);
      setPendingImportPayload(null);
      setDownloadStatus("success");
      navigate("/");
    } catch (err) {
      setImportProgress(null);
      setDownloadStatus("error");
      setError(err instanceof Error ? err.message : "Failed to replace existing song");
    }
  }

  async function handleAddFromSpotify(event?: React.MouseEvent<HTMLButtonElement>) {
    if (!spotifyTrack) {
      setError("Fetch a Spotify track first");
      return;
    }
    if (event) replaceTriggerRef.current = event.currentTarget;
    setError(null);
    setNotice(null);
    setDownloadStatus("loading");
    setImportProgress({ stage: "resolving", received: 0, total: 0 });
    let resolvedLyrics = "";
    try {
      resolvedLyrics = await fetchLyricsForImport();
      await submitSpotifyImport(resolvedLyrics);
      setDownloadStatus("success");
      navigate("/");
    } catch (err) {
      setImportProgress(null);
      if (isDuplicateSongError(err)) {
        setPendingImportPayload({ lyricsToInclude: resolvedLyrics || lyricsText.trim() });
        setReplaceModalMessage(err.message);
        setShowReplaceModal(true);
        setDownloadStatus("idle");
        return;
      }
      setDownloadStatus("error");
      setError(err instanceof Error ? err.message : "Failed to add song from Spotify");
    }
  }

  return (
    <div className="max-w-5xl mx-auto py-12 px-4">
      <h1 className="text-2xl font-semibold mb-6">Add a song</h1>
      <div className="mb-8 inline-flex rounded-2xl border border-white/25 bg-white/[0.02] p-1.5">
        <button type="button" aria-pressed={mode === "spotify"} onClick={() => { setError(null); setMode("spotify"); }} className={`h-10 px-5 rounded-xl text-sm font-medium transition-colors ${mode === "spotify" ? "bg-foreground text-background" : "text-foreground/80 hover:text-foreground"}`}>
          Spotify link
        </button>
        <button type="button" aria-pressed={mode === "upload"} onClick={() => { setError(null); setMode("upload"); }} className={`h-10 px-5 rounded-xl text-sm font-medium transition-colors ${mode === "upload" ? "bg-foreground text-background" : "text-foreground/80 hover:text-foreground"}`}>
          Upload files
        </button>
      </div>

      {mode === "upload" ? (
        <form onSubmit={onUploadSubmit} className="max-w-2xl rounded-3xl border border-white/20 bg-white/[0.02] p-6 md:p-7 space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label htmlFor="upload-title" className="block text-sm mb-2 text-foreground/80">Title</label>
              <input id="upload-title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50" required />
            </div>
            <div>
              <label htmlFor="upload-artist" className="block text-sm mb-2 text-foreground/80">Artist</label>
              <input id="upload-artist" value={artist} onChange={(e) => setArtist(e.target.value)} className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50" required />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="rounded-2xl border border-dashed border-white/30 bg-black/20 p-4 cursor-pointer transition-colors hover:border-yellow-500/60 focus-within:border-yellow-500/60 focus-within:ring-2 focus-within:ring-yellow-500/50">
              <span className="block text-sm font-medium">Cover image</span>
              <span className="block text-xs text-foreground/60 mt-1">JPG, PNG, WEBP</span>
              <span className="mt-3 inline-block text-xs px-2.5 py-1 rounded-lg bg-white/10">{image ? image.name : "Choose image file"}</span>
              <input type="file" accept="image/*" aria-label="Cover image file" onChange={(e) => setImage(e.target.files?.[0] ?? null)} className="sr-only" />
            </label>
            <label className="rounded-2xl border border-dashed border-white/30 bg-black/20 p-4 cursor-pointer transition-colors hover:border-yellow-500/60 focus-within:border-yellow-500/60 focus-within:ring-2 focus-within:ring-yellow-500/50">
              <span className="block text-sm font-medium">Audio file</span>
              <span className="block text-xs text-foreground/60 mt-1">FLAC, MP3, WAV</span>
              <span className="mt-3 inline-block text-xs px-2.5 py-1 rounded-lg bg-white/10">{audio ? audio.name : "Choose audio file"}</span>
              <input type="file" accept="audio/*" aria-label="Audio file" onChange={(e) => setAudio(e.target.files?.[0] ?? null)} className="sr-only" />
            </label>
          </div>
          {error && <div className="text-sm text-red-500">{error}</div>}
          <button type="submit" disabled={loading} className="h-11 px-5 rounded-2xl bg-yellow-500 text-black font-semibold disabled:opacity-50 inline-flex items-center gap-2">
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? "Uploading..." : "Upload Song"}
          </button>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row gap-3">
            <input aria-label="Spotify URL" value={spotifyUrl} onChange={(e) => setSpotifyUrl(e.target.value)} className="flex-1 border border-white/25 rounded-2xl px-4 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50" placeholder="Spotify playlist, album, or Liked Songs URL" />
            <button type="button" onClick={handleFetchSpotify} disabled={fetchStatus === "loading" || batchStatus === "loading" || !spotifyUrl.trim()} className="h-11 px-5 rounded-2xl bg-yellow-500 text-black font-medium disabled:opacity-50 inline-flex items-center gap-2">
              {fetchStatus === "loading" ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              Fetch
            </button>
          </div>

          {/* Format and Quality Settings */}
          {(spotifyTrack || batchInfo) && (
            <div className="rounded-3xl border border-white/20 bg-white/[0.02] p-6 space-y-4">
              <h3 className="text-lg font-semibold">Download Settings</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="upload-output-format" className="block text-sm mb-2 text-foreground/80">Output Format</label>
                  <select
                    id="upload-output-format"
                    value={requestedOutputFormat}
                    disabled
                    className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50 disabled:opacity-70"
                  >
                    <option value="flac">FLAC (Lossless)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Batch Info Display */}
          {batchInfo && (
            <div className="rounded-3xl border border-white/20 bg-white/[0.02] p-6">
              <h3 className="text-xl font-semibold mb-4">Batch Download</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Type:</span>
                  <span className="font-medium capitalize">{batchInfo.type}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Title:</span>
                  <span className="font-medium">{batchInfo.title}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Artist:</span>
                  <span className="font-medium">{batchInfo.artist}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Tracks:</span>
                  <span className="font-medium">{batchInfo.trackCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Format:</span>
                  <span className="font-medium uppercase">{batchInfo.format}</span>
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  type="button"
                  onClick={handleBatchDownload}
                  disabled={batchStatus === "loading"}
                  className="flex-1 h-11 rounded-2xl bg-yellow-500 text-black font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
                >
                  {batchStatus === "loading" ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {batchStatus === "idle" && batchProgress && batchProgress.current > 0
                    ? `Resume batch (${batchInfo.trackCount} tracks)`
                    : `Download All (${batchInfo.trackCount} tracks)`}
                  <ActionIcon status={batchStatus} />
                </button>
                {batchStatus === "loading" && (
                  <button
                    type="button"
                    onClick={cancelBatchDownload}
                    className="h-11 px-5 rounded-2xl border border-white/30 font-semibold inline-flex items-center justify-center"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {batchProgress && (
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-foreground/70 truncate pr-3">
                      {batchProgress.currentTrack || "Starting..."}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {batchProgress.current}/{batchProgress.total}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-yellow-500 transition-all duration-300"
                      style={{
                        width: `${batchProgress.total > 0 ? (batchProgress.current / batchProgress.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="text-xs text-foreground/60">
                    {batchProgress.succeeded} downloaded · {batchProgress.skipped} skipped · {batchProgress.failed} failed
                  </div>
                </div>
              )}
              {batchFailures.length > 0 && (
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-red-400">
                    {batchFailures.length} track{batchFailures.length === 1 ? "" : "s"} failed
                  </summary>
                  <ul className="mt-2 space-y-1 text-foreground/70 max-h-40 overflow-y-auto">
                    {batchFailures.map((failure) => (
                      <li key={failure}>{failure}</li>
                    ))}
                  </ul>
                </details>
              )}
              {notice && <div className="text-sm text-green-500 mt-4">{notice}</div>}
            </div>
          )}

          {/* Single Track Display */}
          {spotifyTrack && !batchInfo && (
            <div className="rounded-3xl border p-5 bg-black/[0.03] dark:bg-white/[0.03]">
              <div className="flex flex-col lg:flex-row gap-6">
                <div className="shrink-0">
                  {spotifyTrack.imageUrl ? (
                    <div className="relative w-56 h-56 rounded-2xl overflow-hidden bg-black/10">
                      <img src={spotifyTrack.imageUrl} alt={spotifyTrack.title} className="w-full h-full object-cover" />
                      <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-0.5 rounded-lg">{formatDuration(spotifyTrack.durationMs)}</div>
                    </div>
                  ) : (
                    <div className="w-56 h-56 rounded-2xl bg-black/10 grid place-items-center text-sm opacity-70">No Cover</div>
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-4">
                  <div>
                    <h2 className="text-4xl font-bold leading-tight break-words">{spotifyTrack.title}</h2>
                    <p className="text-2xl text-foreground/70 mt-1">{spotifyTrack.artist}</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div><div className="text-foreground/60">Album</div><div className="font-medium">{spotifyTrack.album || "N/A"}</div></div>
                    <div><div className="text-foreground/60">Release Date</div><div className="font-medium">{spotifyTrack.releaseDate || "N/A"}</div></div>
                    <div><div className="text-foreground/60">Total Plays</div><div className="font-medium">{formatPlays(spotifyTrack.totalPlays)}</div></div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button type="button" onClick={handleAddFromSpotify} disabled={downloadStatus === "loading"} className="h-11 flex-1 justify-center rounded-2xl bg-yellow-500 px-5 text-black font-semibold inline-flex items-center gap-2 disabled:opacity-50 sm:flex-none">
                      {downloadStatus === "loading" ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                      Download
                      <ActionIcon status={downloadStatus} />
                    </button>
                    {spotifyTrack.previewUrl && (
                      <button type="button" onClick={handlePreviewToggle} className="h-11 w-11 rounded-2xl border inline-flex items-center justify-center" aria-label={isPreviewPlaying ? "Stop preview" : "Play preview"}>
                        {isPreviewPlaying ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                    )}
                  </div>
                  {downloadStatus === "loading" && importProgress && (
                    <div className="space-y-2" aria-live="polite">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-foreground/70">{importStageLabel(importProgress)}</span>
                        <span className="shrink-0 tabular-nums text-foreground/70">
                          {importIsDeterminate(importProgress)
                            ? `${importDownloadPercent(importProgress)}% · ${formatMb(importProgress.received)} / ${formatMb(importProgress.total)} MB`
                            : importProgress.stage === "downloading" && importProgress.received > 0
                              ? `${formatMb(importProgress.received)} MB`
                              : ""}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full bg-yellow-500 transition-all duration-300 ${importIsDeterminate(importProgress) ? "" : "animate-pulse"}`}
                          style={{ width: `${importBarPercent(importProgress)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {notice && <div className="text-sm text-green-500">{notice}</div>}
                </div>
              </div>
            </div>
          )}

          {showReplaceModal && (
            <div
              className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4"
              onClick={closeReplaceModal}
            >
              <div
                ref={replaceModalRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="replace-song-title"
                className="w-full max-w-md rounded-2xl border border-white/20 bg-zinc-950 p-5 space-y-4"
                onClick={(event) => event.stopPropagation()}
              >
                <div>
                  <h3 id="replace-song-title" className="text-lg font-semibold">Song already exists</h3>
                  <p className="text-sm text-zinc-300 mt-1">{replaceModalMessage || "This song is already in your library."}</p>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={closeReplaceModal} className="h-10 px-4 rounded border border-white/30">Keep Existing</button>
                  <button type="button" onClick={handleConfirmReplaceSong} className="h-10 px-4 rounded bg-yellow-500 text-black font-medium inline-flex items-center gap-2">Replace Song</button>
                </div>
              </div>
            </div>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
      )}
    </div>
  );
}
