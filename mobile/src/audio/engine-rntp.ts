import TrackPlayer, { Event, State, type PlaybackErrorEvent } from "react-native-track-player";
import { toAbsoluteApiUrl } from "@/lib/config";
import { getIsOnline, markOffline, subscribeOnline } from "@/lib/connectivity";
import { isUnstagedDiscoverSong } from "@/lib/discover-queue";
import { isLikelyNetworkPlaybackError } from "@/lib/playback-continuity";
import { shouldPublishQueueMutation } from "@/lib/queue-publish-policy";
import { isPodcastSong } from "@/lib/player-song";
import {
  createPlayListen,
  flushPlayListen,
  type PlayListenEntry,
} from "@/lib/play-events";
import {
  isEpisodeFinished,
  markEpisodeFinished,
  PODCAST_PROGRESS_WRITE_INTERVAL_MS,
  PODCAST_RESUME_MIN_SECONDS,
  readEpisodeProgress,
  writeEpisodeProgressGuarded,
} from "@/lib/podcast-progress";
import { resolveOfflinePlaybackSong, useOfflineStore } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import { buildTrack } from "@/audio/track";
import { setupTrackPlayer } from "@/audio/setup";
import {
  isOwnHandledSong,
  MAX_CONSECUTIVE_AUDIO_ERRORS,
  refreshCurrentSong,
} from "@/audio/refresh";
import { enforceSleepTimer } from "@/audio/sleep";
import {
  PLAYBACK_STATE_PUBLISH_INTERVAL_MS,
  publishPlaybackState,
  getLastPosition,
  setLastPosition,
  takePendingResumeSeek,
} from "@/audio/playback-sync";
import { resetAudioProgress, setAudioProgress } from "@/audio/progress";
import type { PlayerSong } from "@/types/player";

// The RNTP single-player audio backend (Android + non-iOS fallback). On iOS the
// app uses engine-native.ts (dual-deck native crossfade) instead. Ported verbatim
// from the original engine.ts; cross-device resume, signed-URL refresh, sleep
// timer, and play-event tracking now live in shared modules.

let started = false;
let initPromise: Promise<void> | null = null;
let loadSeq = 0;
let lastLoadedKey: string | null = null;
// Set only after the currently-selected track has actually been added. Clearing
// it synchronously at a selection boundary lets us reject late progress/end/error
// events emitted by the outgoing RNTP item during reset().
let loadedSongId: string | null = null;
let currentListen: PlayListenEntry | null = null;

// error circuit-breaker
let consecutiveErrors = 0;
let erroredSrcRetry: string | null = null;
let localSwitchInFlight = false;
let offlinePlayback = false;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
const STALL_TIMEOUT_MS = 12_000;
// throttles
let lastPodcastWriteMs = 0;
let lastStatePublishMs = 0;

function trackKey(song: PlayerSong): string {
  return `${song.id}|${toAbsoluteApiUrl(song.audioUrl)}`;
}

function currentPreferredLocalSong(): PlayerSong | null {
  const song = usePlayerStore.getState().currentSong;
  if (!song) return null;
  const resolved = resolveOfflinePlaybackSong(song);
  return resolved.source === "offline" &&
    (trackKey(resolved) !== lastLoadedKey || loadedSongId !== song.id)
    ? song
    : null;
}

function startPreferredLocalSwitch(): boolean {
  const song = currentPreferredLocalSong();
  if (!song) return false;
  if (localSwitchInFlight) return true;
  localSwitchInFlight = true;
  void loadCurrentSong(song, usePlayerStore.getState().isPlaying)
    .catch(() => {
      usePlayerStore.getState().pause();
    })
    .finally(() => {
      localSwitchInFlight = false;
    });
  return true;
}

function skipToDownloaded(): boolean {
  const isDownloaded = useOfflineStore.getState().isDownloaded;
  return usePlayerStore.getState().skipToPlayable((song) => isDownloaded(song.id));
}

function clearStallWatchdog(): void {
  if (stallTimer != null) clearTimeout(stallTimer);
  stallTimer = null;
}

function armStallWatchdog(): void {
  if (stallTimer != null) return;
  stallTimer = setTimeout(() => {
    stallTimer = null;
    const state = usePlayerStore.getState();
    const song = state.currentSong;
    if (!song || !state.isPlaying || isOwnHandledSong(song) || isPodcastSong(song)) return;
    offlinePlayback = true;
    markOffline();
    if (startPreferredLocalSwitch()) return;
    if (!skipToDownloaded()) state.pause();
  }, STALL_TIMEOUT_MS);
}

// --- track loading ----------------------------------------------------------
async function loadCurrentSong(song: PlayerSong | null, isPlaying: boolean): Promise<void> {
  // Unstaged Discover placeholder (empty audioUrl): nothing to load yet — stop
  // playback and idle until the stager swaps in the real source, which re-enters
  // this with a playable URL. Adding a track with an empty url would error.
  if (song && isUnstagedDiscoverSong(song)) {
    flushPlayListen(currentListen);
    currentListen = null;
    lastLoadedKey = null;
    loadedSongId = null;
    loadSeq += 1; // supersede any in-flight load from the prior track
    await TrackPlayer.reset();
    setLastPosition(0, song.id);
    resetAudioProgress(song.duration ?? 0);
    return;
  }

  // Swap in the downloaded file:// copy if this song is available offline.
  const resolved = song ? resolveOfflinePlaybackSong(song) : null;
  const key = resolved ? trackKey(resolved) : null;
  if (key === lastLoadedKey) {
    await syncPlayState(isPlaying);
    return;
  }

  const sameLogicalSong = !!song && loadedSongId === song.id;
  if (!sameLogicalSong) {
    flushPlayListen(currentListen);
    currentListen = song ? createPlayListen(song) : null;
  }
  lastLoadedKey = key;
  loadedSongId = null;
  erroredSrcRetry = null;

  const seq = ++loadSeq;
  if (!song || !resolved) {
    await TrackPlayer.reset();
    setLastPosition(0, null);
    resetAudioProgress(0);
    return;
  }

  if (!sameLogicalSong) resetAudioProgress(song.duration ?? 0);
  await TrackPlayer.reset();
  if (seq !== loadSeq) return;
  await TrackPlayer.add(buildTrack(resolved));
  if (seq !== loadSeq) return;
  loadedSongId = song.id;

  // Resume-seek injection (cross-device resume or podcast resume ≥10s).
  const sourceSwapPosition = sameLogicalSong ? getLastPosition(song.id) : null;
  const pendingSeek = sameLogicalSong ? null : takePendingResumeSeek(song.id);
  if (sourceSwapPosition != null) {
    setLastPosition(sourceSwapPosition, song.id);
    setAudioProgress(sourceSwapPosition, song.duration ?? 0);
    if (sourceSwapPosition > 0) await TrackPlayer.seekTo(sourceSwapPosition);
  } else if (pendingSeek != null) {
    setLastPosition(pendingSeek, song.id);
    setAudioProgress(pendingSeek, song.duration ?? 0);
    if (pendingSeek > 0) await TrackPlayer.seekTo(pendingSeek);
  } else if (isPodcastSong(song)) {
    const progress = readEpisodeProgress(song.id);
    if (progress && progress.time >= PODCAST_RESUME_MIN_SECONDS && !isEpisodeFinished(progress)) {
      setLastPosition(progress.time, song.id);
      await TrackPlayer.seekTo(progress.time);
    } else {
      setLastPosition(0, song.id);
    }
  } else {
    setLastPosition(0, song.id);
  }
  if (seq !== loadSeq) return;

  await applyRate(song);
  if (isPlaying) await TrackPlayer.play();

  // double-404 / metadata refresh (fire-and-forget) — guards expired signed URLs.
  void refreshCurrentSong(song);
  void publishPlaybackState(true);
}

async function syncPlayState(isPlaying: boolean): Promise<void> {
  if (isPlaying) await TrackPlayer.play();
  else await TrackPlayer.pause();
}

async function applyVolume(): Promise<void> {
  const { volume, isMuted } = usePlayerStore.getState();
  await TrackPlayer.setVolume(isMuted ? 0 : volume);
}

async function applyRate(song: PlayerSong | null): Promise<void> {
  const rate = song && isPodcastSong(song) ? usePlayerStore.getState().playbackRate : 1;
  await TrackPlayer.setRate(rate);
}

// --- RNTP event handlers ----------------------------------------------------
async function onEnded(): Promise<void> {
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song || loadedSongId !== song.id) return;
  if (isPodcastSong(song)) markEpisodeFinished(song.id);

  // The explicit sleep request wins over repeat. Otherwise repeat-one would
  // restart first and "sleep at end of track" could never fire.
  if (s.sleepAtEndOfTrack) {
    s.pause();
    s.cancelSleepTimer();
    return;
  }
  if (s.repeatMode === "one" || (s.repeatMode === "all" && s.queue.length === 1)) {
    // Replay in place; flush + rearm the play-listen.
    // Repeat-all needs the same direct replay for a one-item queue because
    // store.next() leaves the current id unchanged and therefore cannot trigger
    // the engine's load subscription.
    flushPlayListen(currentListen);
    currentListen = song ? createPlayListen(song) : null;
    await TrackPlayer.seekTo(0);
    await TrackPlayer.play();
    return;
  }
  flushPlayListen(currentListen);
  if (offlinePlayback || !getIsOnline()) {
    if (skipToDownloaded()) return;
    if (s.repeatMode === "all" && resolveOfflinePlaybackSong(song).source === "offline") {
      currentListen = createPlayListen(song);
      setLastPosition(0, song.id);
      await TrackPlayer.seekTo(0);
      await TrackPlayer.play();
    } else {
      s.pause();
    }
    return;
  }
  s.next(); // store advances → subscription loads the next track
}

async function onError(error?: PlaybackErrorEvent): Promise<void> {
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song || loadedSongId !== song.id) return;
  // radio / offline / local handle their own failures; don't wedge on one of them.
  if (isOwnHandledSong(song)) return;

  const baseUrl = toAbsoluteApiUrl(song.audioUrl);
  const isHls = /\.m3u8(\?|$)/i.test(baseUrl);

  // Do not spend a retry cycle on a source we already know is unreachable.
  // Falling through to a cached queue item immediately avoids a long silent gap.
  if (!getIsOnline() || isLikelyNetworkPlaybackError(`${error?.code ?? ""} ${error?.message ?? ""}`)) {
    offlinePlayback = true;
    markOffline();
    if (startPreferredLocalSwitch()) return;
    if (!skipToDownloaded()) s.pause();
    return;
  }

  // Retry the same track ONCE with a cache-busted URL.
  if (!isHls && erroredSrcRetry !== baseUrl) {
    erroredSrcRetry = baseUrl;
    const busted = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}__retry=${Date.now()}`;
    const seq = ++loadSeq;
    await TrackPlayer.reset();
    if (seq !== loadSeq) return;
    await TrackPlayer.add({ ...buildTrack(song), url: busted });
    const retryAt = getLastPosition(song.id);
    if (retryAt > 0.5) await TrackPlayer.seekTo(retryAt);
    if (s.isPlaying) await TrackPlayer.play();
    return;
  }

  consecutiveErrors += 1;
  if (consecutiveErrors >= MAX_CONSECUTIVE_AUDIO_ERRORS) {
    consecutiveErrors = 0;
    erroredSrcRetry = null;
    s.pause(); // stop — don't loop a dead queue forever
    return;
  }
  erroredSrcRetry = null;
  s.next();
}

function onProgress(position: number, duration: number): void {
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song || loadedSongId !== song.id) return;
  setLastPosition(position, song.id);
  setAudioProgress(position, duration);

  // play-listen tracking → fire play-event at 30s OR ≥50%.
  if (currentListen) {
    if (position > currentListen.maxPositionSeconds) currentListen.maxPositionSeconds = position;
    if (Number.isFinite(duration) && duration > 0) currentListen.durationSeconds = duration;
    flushPlayListen(currentListen); // no-op until the threshold is crossed
  }

  // podcast progress write (~5s).
  if (isPodcastSong(song)) {
    const now = Date.now();
    if (now - lastPodcastWriteMs >= PODCAST_PROGRESS_WRITE_INTERVAL_MS) {
      lastPodcastWriteMs = now;
      writeEpisodeProgressGuarded(song.id, position, duration);
    }
  }

  enforceSleepTimer();

  // cross-device resume publish (~8s while playing).
  if (s.isPlaying && Date.now() - lastStatePublishMs >= PLAYBACK_STATE_PUBLISH_INTERVAL_MS) {
    lastStatePublishMs = Date.now();
    void publishPlaybackState(false);
  }
}

// --- store subscription -----------------------------------------------------
function subscribeToStore(): void {
  let prev = usePlayerStore.getState();
  usePlayerStore.subscribe((state) => {
    const songChanged = state.currentSong?.id !== prev.currentSong?.id ||
      state.currentSong?.audioUrl !== prev.currentSong?.audioUrl;
    if (songChanged) {
      void loadCurrentSong(state.currentSong, state.isPlaying).catch(() => {});
    } else if (state.isPlaying !== prev.isPlaying) {
      if (state.isPlaying && state.currentSong) {
        void loadCurrentSong(state.currentSong, true).catch(() => {});
      } else {
        void syncPlayState(false).catch(() => {});
      }
      void publishPlaybackState(true);
    }
    if (state.volume !== prev.volume || state.isMuted !== prev.isMuted) void applyVolume().catch(() => {});
    if (state.playbackRate !== prev.playbackRate) void applyRate(state.currentSong).catch(() => {});
    // Persist newly-started/user-edited queues immediately. Catalog hydration
    // appends are marked separately and receive one trailing publish from the
    // playlist loader, avoiding a full growing-queue snapshot on every page.
    if (state.queue !== prev.queue) {
      const startedNewQueue = state.queueToken !== prev.queueToken;
      if (startedNewQueue) offlinePlayback = !getIsOnline();
      if (shouldPublishQueueMutation(prev, state)) {
        void publishPlaybackState(true);
      }
    }
    prev = state;
  });
}

// UI seek (Scrubber / remote) on the RNTP backend.
export async function seekRntp(seconds: number): Promise<void> {
  const position = Math.max(0, seconds);
  setLastPosition(position, usePlayerStore.getState().currentSong?.id ?? null);
  await TrackPlayer.seekTo(position);
}

export async function initRntpAudio(): Promise<void> {
  if (started) return;
  if (!initPromise) {
    initPromise = (async () => {
      // Setup can fail transiently while the native service/session comes up.
      // Keep it retryable and coalesce concurrent bootstrap calls.
      await setupTrackPlayer();
      await applyVolume();

      TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
        void onEnded().catch(() => {});
      });
      TrackPlayer.addEventListener(Event.PlaybackError, (error) => {
        void onError(error).catch(() => {});
      });
      TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, ({ position, duration }) => {
        onProgress(position, duration);
      });
      TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
        if (state === State.Playing) {
          clearStallWatchdog();
          consecutiveErrors = 0;
          erroredSrcRetry = null;
          if (getIsOnline()) offlinePlayback = false;
        } else if (state === State.Buffering && usePlayerStore.getState().isPlaying) {
          armStallWatchdog();
        }
      });

      subscribeOnline((online) => {
        offlinePlayback = !online;
        if (!online) {
          startPreferredLocalSwitch();
        }
      });

      subscribeToStore();
      started = true;

      const { currentSong, isPlaying } = usePlayerStore.getState();
      if (currentSong) await loadCurrentSong(currentSong, isPlaying).catch(() => {});
    })();
  }
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}
