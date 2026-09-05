"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chooseNextShuffleIndex, usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import type { PlayerBarChromeProps } from "@/components/PlayerBarChrome";
import { isBrowserLocalSong } from "@/lib/browser-local-song";
import {
  isSpaceKey,
  playbackKeyTargetInfo,
  shouldPreserveEditableShortcutTarget,
  shouldPreservePlaybackShortcutTarget,
} from "@/lib/player-keyboard";
import { equalPowerGain, scheduleEqualPowerRamp } from "@/lib/crossfade-curve";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { isPersistablePlayerSong } from "@/lib/player-persistence";
import type { PlaybackStateSnapshot } from "@/lib/playback-state";
import { PLAYBACK_GESTURE_EVENT, requestImmediatePlayback, type PlaybackGestureDetail } from "@/lib/playback-gesture";
import { PLAYBACK_SEEK_REQUEST_EVENT, publishPlaybackPosition } from "@/lib/playback-position";
import { useMediaSession } from "@/lib/use-media-session";
import {
  fetchServerPlaybackState,
  getPlaybackDeviceId,
  clearPlaybackStatePendingSync,
  markPlaybackStatePendingSync,
  readLocalPlaybackState,
  readPlaybackStatePendingSyncUpdatedAt,
  removeLocalPlaybackState,
  writeLocalPlaybackState,
  writeServerPlaybackState,
} from "@/client/playback-state";
import {
  notePlaybackNetworkFailure,
  notePlaybackNetworkSuccess,
  prefetchUpcomingPlayback,
} from "@/client/playback-warm";
import { normalizeAccountScope } from "@/client/api";
import { prepareHistorySongForPlayback } from "@/client/discover-queue";
import {
  isEpisodeFinished,
  markEpisodeFinished,
  readEpisodeProgress,
  writeEpisodeProgress,
} from "@/client/podcast-progress";
import { useAuth } from "@/client/auth";
import { recordPlayEvent, shouldRecordPlay } from "@/client/play-events";
import {
  audioVolumeIsWritable,
  canPlayHlsNatively,
  crossOriginForAudioSrc,
  errorName,
  finiteMediaDuration,
  isHlsPlaylistSrc,
  isIosLikePlatform,
  loadHlsConstructor,
  resolvePlayableSrc,
  seekIsCloseEnough,
  type HlsInstance,
} from "@/lib/playback-audio";

function playbackStateSyncSignature(state: PlaybackStateSnapshot): string {
  return [
    state.queue.map((song) => song.id).join(","),
    state.accountScope,
    state.currentIndex,
    Math.floor(state.currentTime),
    state.isPlaying ? "1" : "0",
    state.song.audioUrl,
  ].join("|");
}

type AudioSourceState = {
  src: string;
  hls: HlsInstance | null;
};

type StickySeekRequest = {
  audio: HTMLAudioElement;
  time: number;
  duration: number;
  resumePlayback: boolean;
  attempts: number;
};

type PlayListenEntry = {
  song: PlayerSong;
  startedAtMs: number;
  maxPositionSeconds: number;
  durationSeconds: number | null;
  recorded: boolean;
};

const STICKY_SEEK_RETRY_MS = 180;
const MAX_STICKY_SEEK_ATTEMPTS = 30;
const PODCAST_PROGRESS_WRITE_INTERVAL_MS = 5_000;
const PODCAST_RESUME_MIN_SECONDS = 10;

export function usePlaybackEngine(): {
  audioElements: React.ReactNode;
  playbackSong: PlayerSong | null | undefined;
  chrome: PlayerBarChromeProps | null;
} {
  // Individual selectors so we only re-render when each specific value changes
  // (instead of on every store mutation, as a full destructure would cause).
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentSong = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const shuffleRemaining = usePlayerStore((s) => s.shuffleRemaining);
  const playFuture = usePlayerStore((s) => s.playFuture);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const play = usePlayerStore((s) => s.play);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const setSong = usePlayerStore((s) => s.setSong);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const advanceToIndex = usePlayerStore((s) => s.advanceToIndex);
  const replaceSong = usePlayerStore((s) => s.replaceSong);
  const pause = usePlayerStore((s) => s.pause);
  const playbackError = usePlayerStore((s) => s.playbackError);
  const failPlayback = usePlayerStore((s) => s.failPlayback);
  const clearPlaybackError = usePlayerStore((s) => s.clearPlaybackError);
  const cancelSleepTimer = usePlayerStore((s) => s.cancelSleepTimer);

  const { user, status: authStatus } = useAuth();

  // Offline playback resolution is gone (downloads were removed), so the song we
  // play is exactly the current store song. Kept as an identity helper because a
  // few call sites still pass the "playback" song around.
  const resolvePlaybackSong = useCallback((song: PlayerSong) => song, []);
  const playbackSong = currentSong;

  const currentSongId = playbackSong?.id ?? null;
  const currentSongIsBrowserLocal = isBrowserLocalSong(playbackSong);
  const currentSongIsRadio = isRadioSong(playbackSong);
  const currentSongIsPodcast = isPodcastSong(playbackSong);
  const playbackDuration = finiteMediaDuration(playbackSong?.duration ?? 0);
  const effectivePlaybackRate = currentSongIsPodcast ? playbackRate : 1;

  // Global transport shortcut: ⌘/Ctrl + → skips to the next track, ⌘/Ctrl + ←
  // to the previous one (mirrors the prev/next buttons below). We ignore the
  // combo while a text field is focused — so ⌘← / ⌘→ still moves the caret in
  // the search box — and only swallow it when a song is loaded, otherwise the
  // browser's back/forward history navigation is left intact. Reads the current
  // song from the store at fire time to avoid re-binding the listener per track.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      if (shouldPreserveEditableShortcutTarget(playbackKeyTargetInfo(event.target))) return;
      if (!usePlayerStore.getState().currentSong) return;
      event.preventDefault();
      if (event.key === "ArrowRight") next();
      else previous();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [next, previous]);

  // Dual audio elements for real crossfade
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  const audioSourceStateRef = useRef<WeakMap<HTMLAudioElement, AudioSourceState>>(new WeakMap());
  const [activeIdx, setActiveIdx] = useState<0 | 1>(0);
  const getActiveAudio = useCallback(
    () => (activeIdx === 0 ? audioARef.current : audioBRef.current),
    [activeIdx]
  );
  const getInactiveAudio = useCallback(
    () => (activeIdx === 0 ? audioBRef.current : audioARef.current),
    [activeIdx]
  );
  const mediaSessionAudioRefs = useMemo(() => [audioARef, audioBRef], []);

  const crossfadingRef = useRef<boolean>(false);
  const crossfadeCancelRef = useRef<(() => void) | null>(null);
  const crossfadeCommitSongIdRef = useRef<string | null>(null);
  const crossfadeStartedRef = useRef<boolean>(false);
  // The next-track target chosen when the fade armed. forceCommit (the
  // ended-before-the-ramp-finished path, common on backgrounded mobile) must
  // reuse THIS exact target, not recompute it: in shuffle mode computeNextTarget()
  // draws a fresh random index, so recomputing would commit a different song than
  // the one already loaded and audibly fading into the incoming element.
  const crossfadeTargetRef = useRef<{ playbackSong: PlayerSong; index: number; fromFuture: boolean } | null>(null);
  // Web Audio crossfade (iOS only): HTMLMediaElement.volume is read-only on iOS,
  // so both elements are routed through GainNodes to fade. The graph is built
  // lazily on the first play gesture (an AudioContext must be started inside a
  // user gesture). webAudioModeRef: null = undecided, true = use gain nodes
  // (iOS), false = use audio.volume directly (desktop/Android — unchanged path).
  const audioContextRef = useRef<AudioContext | null>(null);
  const webAudioNodesRef = useRef<WeakMap<HTMLAudioElement, { source: MediaElementAudioSourceNode; gain: GainNode }>>(new WeakMap());
  const webAudioModeRef = useRef<boolean | null>(null);
  const webAudioFailedRef = useRef<boolean>(false);
  // Latest crossfade trigger / force-commit, called from the active element's
  // timeupdate/ended handlers (which fire even when the tab is backgrounded).
  const maybeStartCrossfadeRef = useRef<() => void>(() => {});
  const forceCommitCrossfadeRef = useRef<() => void>(() => {});
  const suppressAutoLoadRef = useRef<boolean>(false);
  const resumeAfterSeekRef = useRef<boolean>(false);
  const pendingSeekTimeoutRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<{ audio: HTMLAudioElement; time: number; duration: number } | null>(null);
  const stickySeekRef = useRef<StickySeekRequest | null>(null);
  const stickySeekTimeoutRef = useRef<number | null>(null);
  const retryStickySeekRef = useRef<() => void>(() => {});
  const lastSeekTargetRef = useRef<number | null>(null);
  const isPlayingRef = useRef<boolean>(isPlaying);
  const playRequestIdRef = useRef<number>(0);
  const volumeRef = useRef<number>(volume);
  const mutedRef = useRef<boolean>(isMuted);
  const restoredPlayerStateRef = useRef(false);
  const playbackSyncReadyRef = useRef(false);
  const applyingSyncedPlaybackStateRef = useRef(false);
  const playbackStateUpdatedAtRef = useRef(0);
  const pendingPlaybackSyncTimeoutRef = useRef<number | null>(null);
  const lastSyncedPlaybackStateSignatureRef = useRef("");
  const playbackDeviceIdRef = useRef("");
  const accountScopeRef = useRef<string | null>(null);

  const savedSeekRef = useRef<{ songId: string; time: number } | null>(null);
  const lockedPlaybackSourceRef = useRef<{ songId: string; src: string } | null>(null);
  const nowPlayingOpenFrameRef = useRef<number | null>(null);
  const nowPlayingCloseTimeoutRef = useRef<number | null>(null);
  const queueSheetOpenFrameRef = useRef<number | null>(null);
  const queueSheetCloseTimeoutRef = useRef<number | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  // Mirrors currentTime without forcing the snapshot/sync callbacks to rebuild on
  // every 4Hz timeupdate; read by buildPlaybackStateSnapshot for a stable identity.
  const currentTimeRef = useRef<number>(0);
  // Wall-clock of the last currentTime *state* write from the timeupdate tick. The
  // smooth 4Hz position goes to the scrubber leaf via publishPlaybackPosition; the
  // React state (which re-renders this whole tree and feeds MediaSession) is only
  // updated ~1Hz while the full sheet is closed, matching MediaSession's own 1Hz
  // publish — so steady-state playback no longer re-renders PlayerBar at 4Hz.
  const lastTimeStateWriteRef = useRef<number>(0);
  const erroredSrcRetryRef = useRef<string | null>(null);
  const refreshNotFoundCountRef = useRef<{ id: string | null; count: number }>({ id: null, count: 0 });
  const sleepTimerPrevSongIdRef = useRef<string | null>(null);
  const lastResumeAtRef = useRef<number>(0);
  const lastResumeSeededSongIdRef = useRef<string | null>(null);
  const lastPodcastProgressWriteRef = useRef<number>(0);
  const playListenRef = useRef<PlayListenEntry | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingMounted, setNowPlayingMounted] = useState(false);
  const [queueSheetOpen, setQueueSheetOpen] = useState(false);
  const [queueSheetMounted, setQueueSheetMounted] = useState(false);

  const desiredSrc = playbackSong?.audioUrl || null;
  const authSettled = authStatus !== "loading";
  const accountScope = normalizeAccountScope(user?.id ?? authStatus);

  useEffect(() => {
    if (!authSettled) return;
    if (accountScopeRef.current === null) {
      accountScopeRef.current = accountScope;
      return;
    }
    if (accountScopeRef.current === accountScope) return;
    accountScopeRef.current = accountScope;
    setQueue([], 0);
    pause();
  }, [accountScope, authSettled, pause, setQueue]);

  const getPlaybackStateDeviceId = useCallback(() => {
    if (!playbackDeviceIdRef.current) playbackDeviceIdRef.current = getPlaybackDeviceId();
    return playbackDeviceIdRef.current;
  }, []);

  const buildPlaybackStateSnapshot = useCallback((updatedAt: number): PlaybackStateSnapshot | null => {
    if (!isPersistablePlayerSong(currentSong)) return null;
    const persistableQueue = queue.filter(isPersistablePlayerSong);
    const persistableIndex = persistableQueue.findIndex((song) => song.id === currentSong.id);
    if (persistableIndex < 0) return null;
    const active = activeIdx === 0 ? audioARef.current : audioBRef.current;
    // A resume target that hasn't landed yet (metadata not loaded) is the
    // truthful position — the element still sits at the wrong spot and must not
    // overwrite the saved resume point. And a metadata-less element has been
    // reset by teardown or a source swap; its 0 is meaningless, so fall back to
    // the last timeupdate position.
    const pendingResume = savedSeekRef.current;
    const elementTime =
      active && active.readyState >= HTMLMediaElement.HAVE_METADATA ? active.currentTime : null;
    const time =
      pendingResume?.songId === currentSong.id
        ? Math.max(0, pendingResume.time)
        : Math.max(0, elementTime ?? currentTimeRef.current);
    return {
      version: 1,
      accountScope,
      queue: persistableQueue,
      currentIndex: persistableIndex,
      song: currentSong,
      currentTime: time,
      isPlaying,
      updatedAt,
      deviceId: getPlaybackStateDeviceId(),
    };
  }, [accountScope, activeIdx, currentSong, getPlaybackStateDeviceId, isPlaying, queue]);

  const saveCurrentPlaybackStateToLocal = useCallback((): PlaybackStateSnapshot | null => {
    // Stamp fresh: this is the device's live position at teardown, the newest
    // state that exists. Reusing the last-applied timestamp made the restore
    // tie-break (server >= local) resurrect an old server snapshot over it.
    const updatedAt = Math.max(Date.now(), playbackStateUpdatedAtRef.current + 1);
    const state = buildPlaybackStateSnapshot(updatedAt);
    if (!state) {
      // Only delete the persisted resume state once restore has finished AND the
      // queue is genuinely empty. Otherwise (e.g. backgrounding before the
      // restore effect runs) leave the saved state untouched so we don't wipe a
      // resume point we haven't loaded yet.
      if (playbackSyncReadyRef.current && queue.length === 0) {
        removeLocalPlaybackState();
      }
      return null;
    }
    writeLocalPlaybackState(state);
    return state;
  }, [buildPlaybackStateSnapshot, queue]);

  const applyPlaybackStateSnapshot = useCallback((state: PlaybackStateSnapshot) => {
    const restoredQueue = state.queue.filter(isPersistablePlayerSong);
    const restoredSongId = state.queue[state.currentIndex]?.id ?? state.song.id;
    const idxFromSong = restoredQueue.findIndex((song) => song.id === restoredSongId);
    const idxFromStateSong = restoredQueue.findIndex((song) => song.id === state.song.id);
    const idx =
      idxFromSong >= 0
        ? idxFromSong
        : idxFromStateSong >= 0
          ? idxFromStateSong
          : Math.max(0, Math.min(restoredQueue.length - 1, state.currentIndex));

    applyingSyncedPlaybackStateRef.current = true;
    playbackStateUpdatedAtRef.current = state.updatedAt;
    writeLocalPlaybackState(state);
    if (restoredQueue.length > 0) {
      setQueue(restoredQueue, idx);
    } else {
      setSong(state.song);
    }
    pause();
    savedSeekRef.current = { songId: restoredSongId, time: state.currentTime };
    currentTimeRef.current = state.currentTime;
    setCurrentTime(state.currentTime);
    window.setTimeout(() => {
      applyingSyncedPlaybackStateRef.current = false;
    }, 500);
  }, [pause, setQueue, setSong]);

  const touchPlaybackStateTimestamp = useCallback((state: PlaybackStateSnapshot): PlaybackStateSnapshot => {
    const updatedAt = Math.max(Date.now(), playbackStateUpdatedAtRef.current + 1, state.updatedAt + 1);
    playbackStateUpdatedAtRef.current = updatedAt;
    return {
      ...state,
      updatedAt,
      deviceId: getPlaybackStateDeviceId(),
    };
  }, [getPlaybackStateDeviceId]);

  const closeNowPlaying = useCallback(() => {
    if (nowPlayingOpenFrameRef.current != null) {
      window.cancelAnimationFrame(nowPlayingOpenFrameRef.current);
      nowPlayingOpenFrameRef.current = null;
    }
    setNowPlayingOpen(false);
    if (nowPlayingCloseTimeoutRef.current != null) {
      window.clearTimeout(nowPlayingCloseTimeoutRef.current);
    }
    nowPlayingCloseTimeoutRef.current = window.setTimeout(() => {
      nowPlayingCloseTimeoutRef.current = null;
      setNowPlayingMounted(false);
    }, 380);
  }, []);

  const openNowPlaying = useCallback(() => {
    if (nowPlayingCloseTimeoutRef.current != null) {
      window.clearTimeout(nowPlayingCloseTimeoutRef.current);
      nowPlayingCloseTimeoutRef.current = null;
    }
    setNowPlayingMounted(true);
    if (nowPlayingOpenFrameRef.current != null) {
      window.cancelAnimationFrame(nowPlayingOpenFrameRef.current);
    }
    nowPlayingOpenFrameRef.current = window.requestAnimationFrame(() => {
      nowPlayingOpenFrameRef.current = null;
      setNowPlayingOpen(true);
    });
  }, []);

  const toggleNowPlaying = useCallback(() => {
    if (nowPlayingOpen) closeNowPlaying();
    else openNowPlaying();
  }, [closeNowPlaying, nowPlayingOpen, openNowPlaying]);

  const closeQueueSheet = useCallback(() => {
    if (queueSheetOpenFrameRef.current != null) {
      window.cancelAnimationFrame(queueSheetOpenFrameRef.current);
      queueSheetOpenFrameRef.current = null;
    }
    setQueueSheetOpen(false);
    if (queueSheetCloseTimeoutRef.current != null) {
      window.clearTimeout(queueSheetCloseTimeoutRef.current);
    }
    queueSheetCloseTimeoutRef.current = window.setTimeout(() => {
      queueSheetCloseTimeoutRef.current = null;
      setQueueSheetMounted(false);
    }, 380);
  }, []);

  const openQueueSheet = useCallback(() => {
    if (queueSheetCloseTimeoutRef.current != null) {
      window.clearTimeout(queueSheetCloseTimeoutRef.current);
      queueSheetCloseTimeoutRef.current = null;
    }
    setQueueSheetMounted(true);
    if (queueSheetOpenFrameRef.current != null) {
      window.cancelAnimationFrame(queueSheetOpenFrameRef.current);
    }
    queueSheetOpenFrameRef.current = window.requestAnimationFrame(() => {
      queueSheetOpenFrameRef.current = null;
      setQueueSheetOpen(true);
    });
  }, []);

  const toggleQueueSheet = useCallback(() => {
    if (queueSheetOpen) closeQueueSheet();
    else openQueueSheet();
  }, [closeQueueSheet, openQueueSheet, queueSheetOpen]);

  // --- Web Audio crossfade plumbing (iOS) -----------------------------------
  // Decide once whether to use the Web Audio gain path (iOS, where audio.volume
  // is read-only) or leave audio.volume alone (desktop/Android). Cheap + cached
  // and needs no user gesture, so the right crossOrigin can be set from the very
  // first load (before the gesture that builds the graph).
  const decideWebAudioMode = useCallback((): boolean => {
    if (webAudioModeRef.current === null) {
      if (isIosLikePlatform()) {
        // iOS Safari/PWA: audio.volume can't change output there, and the probe
        // false-positives on iOS 26 (see isIosLikePlatform), so force the
        // gain-node path.
        webAudioModeRef.current = true;
      } else {
        const probe = audioARef.current ?? audioBRef.current;
        if (probe) webAudioModeRef.current = !audioVolumeIsWritable(probe);
      }
    }
    return webAudioModeRef.current === true;
  }, []);

  // Match the element's crossOrigin to what its src needs to be Web-Audio-readable
  // (credentialed for our authed API, anonymous for third-party radio, none for
  // same-origin/blob). MUST run before the src is assigned — crossOrigin only
  // takes effect on the next load. No-op on desktop, preserving today's loads.
  const applyAudioCrossOrigin = useCallback((audio: HTMLAudioElement, absoluteSrc: string) => {
    if (!decideWebAudioMode()) {
      if (audio.crossOrigin !== null) audio.crossOrigin = null;
      return;
    }
    const next = crossOriginForAudioSrc(absoluteSrc);
    if (audio.crossOrigin !== next) audio.crossOrigin = next;
  }, [decideWebAudioMode]);

  // Build the AudioContext + per-element source→gain→destination graph lazily.
  // Returns true when the gain path is active. Call from a user gesture so the
  // context can start; createMediaElementSource is permanent + once-per-element,
  // so it's guarded and cached.
  const ensureWebAudioGraph = useCallback((): boolean => {
    if (!decideWebAudioMode() || webAudioFailedRef.current) return false;
    const a = audioARef.current;
    const b = audioBRef.current;
    if (!a || !b) return false;
    try {
      let ctx = audioContextRef.current;
      if (!ctx) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          webAudioFailedRef.current = true;
          webAudioModeRef.current = false;
          return false;
        }
        ctx = new Ctor();
        audioContextRef.current = ctx;
      }
      for (const el of [a, b]) {
        if (!webAudioNodesRef.current.has(el)) {
          const source = ctx.createMediaElementSource(el);
          const gain = ctx.createGain();
          gain.gain.value = mutedRef.current ? 0 : volumeRef.current;
          source.connect(gain);
          gain.connect(ctx.destination);
          webAudioNodesRef.current.set(el, { source, gain });
        }
      }
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      return true;
    } catch {
      // Fall back to the audio.volume path (clean cut on iOS) if the graph can't
      // be built — never leave the player silent.
      webAudioFailedRef.current = true;
      webAudioModeRef.current = false;
      return false;
    }
  }, [decideWebAudioMode]);

  // Set an element's effective output level via its GainNode when routed through
  // Web Audio (cancelling any in-flight ramp), else via audio.volume. One call
  // site for both the crossfade ramp and ordinary volume control.
  const setOutputLevel = useCallback((audio: HTMLAudioElement, level: number) => {
    const clamped = Math.max(0, level);
    const node = webAudioNodesRef.current.get(audio);
    const ctx = audioContextRef.current;
    if (node && ctx) {
      try {
        node.gain.gain.cancelScheduledValues(ctx.currentTime);
        node.gain.gain.setValueAtTime(clamped, ctx.currentTime);
        return;
      } catch {}
    }
    try { audio.volume = clamped; } catch {}
  }, []);

  // Build the Web Audio graph at mount on iOS, BEFORE either <audio> element ever
  // plays. iOS leaves an element that is already "live" when createMediaElementSource
  // runs outputting straight to the speakers (bypassing its GainNode) — which made
  // the first-played (outgoing) side of the crossfade un-fadeable while the second
  // (incoming) side faded correctly. Wiring both elements up front while idle avoids
  // that; the context stays suspended until a play gesture resumes it.
  useEffect(() => {
    if (decideWebAudioMode()) ensureWebAudioGraph();
  }, [decideWebAudioMode, ensureWebAudioGraph]);

  const unloadAudioSource = useCallback((audio: HTMLAudioElement) => {
    const current = audioSourceStateRef.current.get(audio);
    current?.hls?.destroy();
    audioSourceStateRef.current.delete(audio);
    try { audio.pause(); } catch {}
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const loadAudioSource = useCallback((audio: HTMLAudioElement, nextSrc: string) => {
    const absolute = resolvePlayableSrc(nextSrc);
    const current = audioSourceStateRef.current.get(audio);
    if (current?.src === absolute) return;

    current?.hls?.destroy();
    audioSourceStateRef.current.delete(audio);

    if (isHlsPlaylistSrc(absolute) && !canPlayHlsNatively(audio)) {
      audio.removeAttribute("src");
      audio.load();
      audioSourceStateRef.current.set(audio, { src: absolute, hls: null });
      void (async () => {
        const HlsConstructor = await loadHlsConstructor();
        const latest = audioSourceStateRef.current.get(audio);
        if (latest?.src !== absolute || latest.hls) return;

        if (!HlsConstructor?.isSupported()) {
          applyAudioCrossOrigin(audio, absolute);
          if (audio.src !== absolute) audio.src = absolute;
          if (isPlayingRef.current) void audio.play().catch(() => {});
          return;
        }

        const hls = new HlsConstructor({
          enableWorker: true,
          lowLatencyMode: true,
        });
        hls.loadSource(absolute);
        hls.attachMedia(audio);

        const currentAfterAttach = audioSourceStateRef.current.get(audio);
        if (currentAfterAttach?.src === absolute) {
          audioSourceStateRef.current.set(audio, { src: absolute, hls });
          if (isPlayingRef.current) void audio.play().catch(() => {});
        } else {
          hls.destroy();
        }
      })();
      return;
    }

    // Only audio ever flows through loadAudioSource, so the path marker alone
    // is a safe detector (cover art / lyrics never reach here).
    applyAudioCrossOrigin(audio, absolute);
    if (audio.src !== absolute) audio.src = absolute;
    audioSourceStateRef.current.set(audio, { src: absolute, hls: null });
  }, [applyAudioCrossOrigin]);

  const cancelActiveCrossfade = useCallback(() => {
    const cancel = crossfadeCancelRef.current;
    crossfadeCancelRef.current = null;
    suppressAutoLoadRef.current = false;
    crossfadingRef.current = false;
    crossfadeStartedRef.current = false;
    crossfadeTargetRef.current = null;
    cancel?.();
  }, []);

  // Shared so timeupdate / the 8s sync interval enforce expiry identically; the
  // canonical pause is the store's pause() (never the audio elements directly).
  const enforceSleepTimerExpiry = useCallback(() => {
    const { sleepTimerEndsAt: endsAt, pause: pausePlayback, cancelSleepTimer: cancelTimer } = usePlayerStore.getState();
    if (endsAt == null || Date.now() < endsAt) return;
    // Deadline passed while paused, before this resume: enforcing now would
    // instantly pause the manual resume, so just clear the consumed timer.
    if (endsAt <= lastResumeAtRef.current) {
      cancelTimer();
      return;
    }
    // An in-flight crossfade ramp ignores pause() and its commit
    // unconditionally resumes playback, so kill the fade first.
    cancelActiveCrossfade();
    pausePlayback();
    cancelTimer();
  }, [cancelActiveCrossfade]);

  const clearStickySeek = useCallback(() => {
    if (stickySeekTimeoutRef.current != null) {
      window.clearTimeout(stickySeekTimeoutRef.current);
      stickySeekTimeoutRef.current = null;
    }
    stickySeekRef.current = null;
  }, []);

  const resetPendingSeek = useCallback(() => {
    if (pendingSeekTimeoutRef.current != null) {
      window.clearTimeout(pendingSeekTimeoutRef.current);
      pendingSeekTimeoutRef.current = null;
    }
    pendingSeekRef.current = null;
    clearStickySeek();
    lastSeekTargetRef.current = null;
    resumeAfterSeekRef.current = false;
  }, [clearStickySeek]);

  const resetPlaybackClock = useCallback((nextDuration = 0) => {
    resetPendingSeek();
    currentTimeRef.current = 0;
    setCurrentTime(0);
    setDuration(finiteMediaDuration(nextDuration) ?? 0);
  }, [resetPendingSeek]);

  const playAudio = useCallback((audio: HTMLAudioElement): Promise<boolean> => {
    const requestId = ++playRequestIdRef.current;
    // Ensure the Web Audio context is RUNNING before the element starts: on iOS an
    // element that begins playing while the context is still suspended outputs
    // straight to the speakers, bypassing its GainNode — which left the first
    // (outgoing) crossfade track un-fadeable while the later (incoming) one, played
    // into an already-running context, faded fine. Awaiting resume first makes the
    // element route through its gain node so both sides of the fade work.
    const ctx = audioContextRef.current;
    const ready = ctx && ctx.state === "suspended" ? ctx.resume().catch(() => {}) : Promise.resolve();
    return ready
      .then(() => audio.play())
      .then(() => requestId === playRequestIdRef.current)
      .catch((error: unknown) => {
        if (errorName(error) === "AbortError") return false;
        if (requestId !== playRequestIdRef.current) return false;
        if (audio !== getActiveAudio() || !isPlayingRef.current) return false;
        pause();
        return false;
      });
  }, [getActiveAudio, pause]);

  useEffect(() => {
    function onPlaybackGesture(event: Event) {
      const detail = (event as CustomEvent<PlaybackGestureDetail>).detail;
      if (!detail?.audioUrl) return;
      const audio = getActiveAudio();
      if (!audio) return;

      // This runs inside a user gesture — the only time an AudioContext may be
      // started on iOS. Build/resume the Web Audio graph here so the gain-node
      // crossfade is ready for the rest of the session.
      ensureWebAudioGraph();
      cancelActiveCrossfade();
      clearPlaybackError();
      erroredSrcRetryRef.current = null;
      // A failed element keeps its error when the source URL is unchanged.
      // Explicit play must reload it so a restored file can be retried.
      if (audio.error) unloadAudioSource(audio);
      if (audioSourceStateRef.current.get(audio)?.src !== resolvePlayableSrc(detail.audioUrl)) {
        resetPlaybackClock();
      }
      loadAudioSource(audio, detail.audioUrl);
      isPlayingRef.current = true;
      void playAudio(audio);
    }

    window.addEventListener(PLAYBACK_GESTURE_EVENT, onPlaybackGesture);
    return () => window.removeEventListener(PLAYBACK_GESTURE_EVENT, onPlaybackGesture);
  }, [cancelActiveCrossfade, clearPlaybackError, ensureWebAudioGraph, getActiveAudio, loadAudioSource, unloadAudioSource, playAudio, resetPlaybackClock]);

  const resumeActivePlayback = useCallback((audio: HTMLAudioElement) => {
    if (!isPlayingRef.current || audio !== getActiveAudio()) return;
    playAudio(audio).then((started) => {
      if (started && audio === getActiveAudio()) resumeAfterSeekRef.current = false;
    });
  }, [getActiveAudio, playAudio]);

  const scheduleStickySeekRetry = useCallback((delay = STICKY_SEEK_RETRY_MS) => {
    if (stickySeekTimeoutRef.current != null) {
      window.clearTimeout(stickySeekTimeoutRef.current);
    }
    stickySeekTimeoutRef.current = window.setTimeout(() => {
      stickySeekTimeoutRef.current = null;
      retryStickySeekRef.current();
    }, delay);
  }, []);

  const queueStickySeek = useCallback((request: StickySeekRequest, delay = STICKY_SEEK_RETRY_MS) => {
    stickySeekRef.current = request;
    currentTimeRef.current = request.time;
    setCurrentTime(request.time);
    scheduleStickySeekRetry(delay);
  }, [scheduleStickySeekRetry]);

  const retryStickySeek = useCallback(() => {
    const request = stickySeekRef.current;
    if (!request) return;
    if (request.audio !== getActiveAudio()) {
      if (lastSeekTargetRef.current === request.time) lastSeekTargetRef.current = null;
      resumeAfterSeekRef.current = false;
      clearStickySeek();
      return;
    }
    if (request.attempts >= MAX_STICKY_SEEK_ATTEMPTS) {
      if (lastSeekTargetRef.current === request.time) lastSeekTargetRef.current = null;
      resumeAfterSeekRef.current = false;
      clearStickySeek();
      return;
    }

    const seekDuration =
      finiteMediaDuration(duration) ??
      finiteMediaDuration(request.audio.duration) ??
      playbackDuration ??
      request.duration;
    const nextTime = Math.max(0, Math.min(seekDuration, request.time));
    const nextRequest = {
      ...request,
      time: nextTime,
      duration: seekDuration,
      attempts: request.attempts + 1,
    };

    try {
      request.audio.currentTime = nextTime;
    } catch {
      queueStickySeek(nextRequest);
      return;
    }

    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);
    if (seekIsCloseEnough(request.audio.currentTime, nextTime)) {
      clearStickySeek();
      if (lastSeekTargetRef.current === nextTime) lastSeekTargetRef.current = null;
      if (request.resumePlayback && isPlayingRef.current) resumeActivePlayback(request.audio);
      return;
    }

    queueStickySeek(nextRequest);
  }, [clearStickySeek, duration, getActiveAudio, playbackDuration, queueStickySeek, resumeActivePlayback]);

  useEffect(() => {
    retryStickySeekRef.current = retryStickySeek;
  }, [retryStickySeek]);

  const performSeek = useCallback((active: HTMLAudioElement, nextTime: number, seekDuration: number) => {
    if (active !== getActiveAudio()) return;
    // Cancelling the crossfade clears crossfadingRef, so there's no in-flight
    // inactive element to keep in sync afterwards.
    if (crossfadingRef.current) cancelActiveCrossfade();
    const resumePlayback = isPlayingRef.current;
    resumeAfterSeekRef.current = resumePlayback;
    clearStickySeek();
    try {
      active.currentTime = nextTime;
    } catch {
      queueStickySeek({ audio: active, time: nextTime, duration: seekDuration, resumePlayback, attempts: 0 });
      return;
    }
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);
    if (!seekIsCloseEnough(active.currentTime, nextTime)) {
      queueStickySeek({ audio: active, time: nextTime, duration: seekDuration, resumePlayback, attempts: 0 });
      return;
    }
    if (resumeAfterSeekRef.current) resumeActivePlayback(active);
  }, [cancelActiveCrossfade, clearStickySeek, getActiveAudio, queueStickySeek, resumeActivePlayback]);

  // Shared clamp+seek for a pending resume target. Used by onLoadedMetadata and
  // by the load effect when a gesture-preloaded element already has metadata
  // (loadedmetadata won't fire again, so the seek must be applied directly).
  const applyPendingResumeSeek = useCallback((audio: HTMLAudioElement) => {
    const pending = savedSeekRef.current;
    if (!pending) return;
    if (pending.songId !== playbackSong?.id) {
      // Stale resume target for a different track; drop it so it can't be
      // applied to the wrong song.
      savedSeekRef.current = null;
      return;
    }
    const seekDuration =
      finiteMediaDuration(audio.duration) ?? playbackDuration ?? finiteMediaDuration(duration);
    if (seekDuration == null) return;
    const clamped = Math.max(0, Math.min(seekDuration, pending.time));
    performSeek(audio, clamped, seekDuration);
    // Only consume the target once the element actually moved. A non-seekable
    // source (the native scheme-handler fallback) silently drops the write; a
    // kept target re-applies on the next source load (e.g. the blob upgrade)
    // and meanwhile blocks progress writes from clobbering the resume point.
    // Radio is live — its position is meaningless, never hold a target for it.
    if (currentSongIsRadio || seekIsCloseEnough(audio.currentTime, clamped)) {
      savedSeekRef.current = null;
    }
  }, [currentSongIsRadio, duration, performSeek, playbackDuration, playbackSong?.id]);

  // Podcast resume of last resort, run on every metadata load: if no snapshot
  // seek is pending and the element sits at the start while localStorage says
  // mid-episode, seek to the stored position. This is what restores the resume
  // point after a source reload that lost it — most importantly the native
  // fallback→blob upgrade, where the original resume seek was dropped by the
  // non-seekable source.
  const applyStoredPodcastResume = useCallback((audio: HTMLAudioElement) => {
    if (!currentSongIsPodcast || !currentSongId) return;
    if (savedSeekRef.current) return;
    if (stickySeekRef.current?.audio === audio) return;
    if ((audio.currentTime || 0) >= 1) return;
    const stored = readEpisodeProgress(currentSongId);
    if (!stored || stored.time < PODCAST_RESUME_MIN_SECONDS || isEpisodeFinished(stored)) return;
    const seekDuration =
      finiteMediaDuration(audio.duration) ?? playbackDuration ?? finiteMediaDuration(duration);
    if (seekDuration == null) return;
    performSeek(audio, Math.max(0, Math.min(seekDuration, stored.time)), seekDuration);
  }, [currentSongId, currentSongIsPodcast, duration, performSeek, playbackDuration]);

  const onSeek = useCallback((value: number) => {
    const active = getActiveAudio();
    if (!active || !Number.isFinite(value)) return;
    // An explicit user seek wins over any pending resume target; without this
    // a restore seek that hasn't applied yet would later yank playback away
    // from where the user just scrubbed to.
    savedSeekRef.current = null;
    const seekDuration = finiteMediaDuration(duration) ?? finiteMediaDuration(active.duration) ?? playbackDuration;
    if (seekDuration == null) return;
    const nextTime = Math.max(0, Math.min(seekDuration, value));
    lastSeekTargetRef.current = nextTime;
    pendingSeekRef.current = { audio: active, time: nextTime, duration: seekDuration };
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);

    if (pendingSeekTimeoutRef.current != null) {
      window.clearTimeout(pendingSeekTimeoutRef.current);
    }
    pendingSeekTimeoutRef.current = window.setTimeout(() => {
      pendingSeekTimeoutRef.current = null;
      const pending = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (!pending) return;
      performSeek(pending.audio, pending.time, pending.duration);
      const sticky = stickySeekRef.current;
      if (lastSeekTargetRef.current === pending.time && !(sticky?.audio === pending.audio && sticky.time === pending.time)) {
        lastSeekTargetRef.current = null;
      }
    }, 90);
  }, [duration, getActiveAudio, performSeek, playbackDuration]);

  // Mirror playback position to satellite UIs (desktop sidebar lyrics) and
  // accept their seek requests. currentTime state already updates from every
  // path (timeupdate, seeks, resume points), so an effect catches them all.
  useEffect(() => {
    publishPlaybackPosition({ currentTime, duration });
  }, [currentTime, duration]);

  useEffect(() => {
    const onSeekRequest = (event: Event) => {
      const value = (event as CustomEvent<number>).detail;
      if (typeof value === "number") onSeek(value);
    };
    window.addEventListener(PLAYBACK_SEEK_REQUEST_EVENT, onSeekRequest);
    return () => window.removeEventListener(PLAYBACK_SEEK_REQUEST_EVENT, onSeekRequest);
  }, [onSeek]);

  useMediaSession({
    song: playbackSong,
    isPlaying,
    currentTime,
    duration,
    playbackRate: effectivePlaybackRate,
    onPlay: play,
    onPause: pause,
    onPrevious: previous,
    onNext: next,
    onSeek,
    getActiveAudio,
    audioRefs: mediaSessionAudioRefs,
  });

  useEffect(() => {
    return () => {
      const a = audioARef.current;
      const b = audioBRef.current;
      if (a) unloadAudioSource(a);
      if (b) unloadAudioSource(b);
    };
  }, [unloadAudioSource]);

  useEffect(() => {
    if (!currentSong) return;
    void prefetchUpcomingPlayback(queue, currentIndex, { shuffle, repeatMode, playFuture, shuffleRemaining });
  }, [currentIndex, currentSong?.id, queue, shuffle, repeatMode, playFuture, shuffleRemaining]);

  useEffect(() => {
    return () => {
      if (pendingSeekTimeoutRef.current != null) {
        window.clearTimeout(pendingSeekTimeoutRef.current);
      }
      if (stickySeekTimeoutRef.current != null) {
        window.clearTimeout(stickySeekTimeoutRef.current);
      }
      if (pendingPlaybackSyncTimeoutRef.current != null) {
        window.clearTimeout(pendingPlaybackSyncTimeoutRef.current);
      }
      if (nowPlayingOpenFrameRef.current != null) {
        window.cancelAnimationFrame(nowPlayingOpenFrameRef.current);
      }
      if (nowPlayingCloseTimeoutRef.current != null) {
        window.clearTimeout(nowPlayingCloseTimeoutRef.current);
      }
      if (queueSheetOpenFrameRef.current != null) {
        window.cancelAnimationFrame(queueSheetOpenFrameRef.current);
      }
      if (queueSheetCloseTimeoutRef.current != null) {
        window.clearTimeout(queueSheetCloseTimeoutRef.current);
      }
    };
  }, []);

  // Crossfade settings are hydrated by the player store's lazy initializer
  // (single source of truth), so no separate client hydration effect is needed.

  // Keep mute state in sync on both elements
  useEffect(() => {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (a) a.muted = isMuted;
    if (b) b.muted = isMuted;
  }, [isMuted]);

  // Apply the playback rate to BOTH elements. Setting defaultPlaybackRate too is
  // load-bearing: a new src load resets playbackRate to defaultPlaybackRate, and
  // crossfade swaps the active element every track.
  useEffect(() => {
    const r = currentSongIsPodcast ? playbackRate : 1;
    for (const el of [audioARef.current, audioBRef.current]) {
      if (!el) continue;
      el.defaultPlaybackRate = r;
      el.playbackRate = r;
    }
  }, [playbackRate, currentSongIsPodcast, activeIdx, currentSongId]);

  // Track latest volume/mute for fades without re-running effects
  useEffect(() => {
    // The effect only re-runs when isPlaying changes, so true here marks a
    // false->true resume transition (read by the sleep-timer expiry path).
    if (isPlaying) lastResumeAtRef.current = Date.now();
    isPlayingRef.current = isPlaying;
    if (!isPlaying) resumeAfterSeekRef.current = false;
  }, [isPlaying]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { mutedRef.current = isMuted; }, [isMuted]);

  // Keep volume on the active element (crossfade code manages both during fades).
  // setOutputLevel routes through the GainNode on iOS so the slider works there
  // too (audio.volume is a no-op on iOS), and falls back to audio.volume elsewhere.
  useEffect(() => {
    if (crossfadingRef.current) return;
    const audio = getActiveAudio();
    if (!audio) return;
    setOutputLevel(audio, isMuted ? 0 : volume);
  }, [volume, isMuted, getActiveAudio, setOutputLevel]);

  // Ensure play/pause controls affect both elements during an active crossfade
  useEffect(() => {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (crossfadingRef.current) {
      if (isPlaying) {
        a?.play().catch(() => {});
        b?.play().catch(() => {});
      } else {
        try { a?.pause(); } catch {}
        try { b?.pause(); } catch {}
      }
    } else {
      const active = getActiveAudio();
      const inactive = getInactiveAudio();
      if (isPlaying) {
        if (active) void playAudio(active);
      } else {
        playRequestIdRef.current += 1;
        try { active?.pause(); } catch {}
      }
      // Keep inactive paused when not crossfading
      if (inactive && inactive !== active) {
        try { inactive.pause(); } catch {}
      }
    }
  }, [isPlaying, activeIdx, getActiveAudio, getInactiveAudio, playAudio]);

  // Restore last played queue/song and time on client mount to avoid SSR mismatches
  useEffect(() => {
    if (!authSettled || restoredPlayerStateRef.current) return;
    restoredPlayerStateRef.current = true;
    let cancelled = false;
	    const localState = readLocalPlaybackState();
    const scopedLocalState =
      localState && normalizeAccountScope(localState.accountScope) === accountScope
        ? localState
        : null;
    if (scopedLocalState) applyPlaybackStateSnapshot(scopedLocalState);

    async function restoreSyncedPlaybackState() {
      let serverState: PlaybackStateSnapshot | null = null;
      try {
        const fetched = await fetchServerPlaybackState();
        if (fetched && normalizeAccountScope(fetched.accountScope) === accountScope) {
          serverState = fetched;
        }
      } catch {}
      if (cancelled) {
        // The restore latch (restoredPlayerStateRef) means nobody will run
        // this again — leaving sync not-ready would silently block every
        // publish for the rest of the session (guaranteed under StrictMode's
        // dev double-mount), so the stale server state never gets overwritten.
        playbackSyncReadyRef.current = true;
        return;
      }

      const localUpdatedAt = scopedLocalState?.updatedAt ?? 0;
      if (serverState && serverState.updatedAt >= localUpdatedAt) {
        applyPlaybackStateSnapshot(serverState);
        lastSyncedPlaybackStateSignatureRef.current = playbackStateSyncSignature(serverState);
        clearPlaybackStatePendingSync();
        playbackSyncReadyRef.current = true;
        return;
      }

      if (scopedLocalState) {
        const localStateToPublish = touchPlaybackStateTimestamp({
          ...scopedLocalState,
          isPlaying: false,
        });
        writeLocalPlaybackState(localStateToPublish);
        try {
          const acceptedState = await writeServerPlaybackState(localStateToPublish);
          if (acceptedState && acceptedState.updatedAt > localStateToPublish.updatedAt) {
            applyPlaybackStateSnapshot(acceptedState);
            lastSyncedPlaybackStateSignatureRef.current = playbackStateSyncSignature(acceptedState);
            clearPlaybackStatePendingSync();
          } else if (acceptedState) {
            lastSyncedPlaybackStateSignatureRef.current = playbackStateSyncSignature(localStateToPublish);
            clearPlaybackStatePendingSync();
          } else {
            markPlaybackStatePendingSync(localStateToPublish.updatedAt);
          }
        } catch {
          markPlaybackStatePendingSync(localStateToPublish.updatedAt);
          lastSyncedPlaybackStateSignatureRef.current = "";
        }
      }

      playbackSyncReadyRef.current = true;
    }

    void restoreSyncedPlaybackState();
    return () => {
      cancelled = true;
    };
  }, [accountScope, applyPlaybackStateSnapshot, authSettled, touchPlaybackStateTimestamp]);

  useEffect(() => {
    if (!currentSongId || currentSongIsBrowserLocal || currentSongIsRadio || currentSongIsPodcast) return;

    let cancelled = false;
    const songId = currentSongId;

    function clearStaleCurrentSong() {
      removeLocalPlaybackState();
      setQueue([], 0);
      pause();
    }

    async function refreshCurrentSong() {
      try {
        const response = await fetch(`/api/songs/${encodeURIComponent(songId)}`, {
          cache: "no-store",
        });
        if (response.status === 401 || response.status === 403) {
          // Auth genuinely lost — clear the queue and persisted resume state.
          if (cancelled) return;
          clearStaleCurrentSong();
          return;
        }
        if (response.status === 404) {
          // A single 404 can be transient (e.g. mid-deploy / proxy hiccup); only
          // wipe the queue after two consecutive 404s for the same song.
          if (cancelled) return;
          const count = refreshNotFoundCountRef.current.id === songId
            ? refreshNotFoundCountRef.current.count + 1
            : 1;
          refreshNotFoundCountRef.current = { id: songId, count };
          if (count >= 2) {
            refreshNotFoundCountRef.current = { id: null, count: 0 };
            clearStaleCurrentSong();
          }
          return;
        }
        if (!response.ok) return;
        const song = (await response.json()) as PlayerSong;
        if (cancelled || !song?.id || song.id !== songId) return;
        refreshNotFoundCountRef.current = { id: null, count: 0 };
        replaceSong(song);
      } catch {}
    }

    refreshCurrentSong();

    return () => {
      cancelled = true;
    };
  }, [currentSongId, currentSongIsBrowserLocal, currentSongIsPodcast, currentSongIsRadio, pause, replaceSong, setQueue]);

  useEffect(() => {
    if (!currentSongId) {
      cancelActiveCrossfade();
      return;
    }
    if (crossfadeCommitSongIdRef.current === currentSongId) {
      crossfadeCommitSongIdRef.current = null;
      return;
    }
    cancelActiveCrossfade();
  }, [cancelActiveCrossfade, currentSongId]);

  // Queue mutations during an armed/in-flight crossfade would commit a stale
  // captured index; cancel and let timeupdate re-arm with a fresh target.
  // (advanceToIndex preserves queue identity, so commits don't land here; the
  // setQueue gesture path already cancels — a harmless double-cancel.)
  useEffect(() => {
    if (crossfadingRef.current || crossfadeStartedRef.current) cancelActiveCrossfade();
  }, [cancelActiveCrossfade, queue]);

  // "End of track" sleep mode: any song-id change (natural ended, crossfade
  // commit, manual next) means the armed track finished, so stop there. Initial
  // mount (prev null) is playback starting, not a track ending.
  useEffect(() => {
    const previousSongId = sleepTimerPrevSongIdRef.current;
    sleepTimerPrevSongIdRef.current = currentSongId;
    if (previousSongId == null || currentSongId === previousSongId) return;
    const { sleepAtEndOfTrack: armed, pause: pausePlayback, cancelSleepTimer: cancelTimer } = usePlayerStore.getState();
    if (!armed) return;
    pausePlayback();
    cancelTimer();
  }, [currentSongId]);

  // Load current song into the ACTIVE element when not crossfading
  useEffect(() => {
    if (suppressAutoLoadRef.current) {
      cancelActiveCrossfade();
    }
    const audio = getActiveAudio();
    const other = getInactiveAudio();
    if (!audio) return;
    if (!playbackSong?.id || !desiredSrc) {
      lockedPlaybackSourceRef.current = null;
      unloadAudioSource(audio);
      if (other) unloadAudioSource(other);
      resetPlaybackClock();
      return;
    }
    const lockedSource = lockedPlaybackSourceRef.current;
    const activeSourceIsSettled = audio.currentTime > 0 || audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    const canKeepLockedSource =
      lockedSource?.songId === playbackSong.id &&
      lockedSource.src !== desiredSrc &&
      activeSourceIsSettled;
    const src =
      canKeepLockedSource
        ? lockedSource.src
        : desiredSrc;
    const sourceChanged = audioSourceStateRef.current.get(audio)?.src !== resolvePlayableSrc(src);
    if (sourceChanged) {
      resetPlaybackClock(playbackSong?.duration ?? 0);
    }
    // Drop any pending resume seek that targets a different song so it can't be
    // applied to this track. A seek saved for the current song (the resume
    // case) is preserved and applied in onLoadedMetadata.
    if (savedSeekRef.current && savedSeekRef.current.songId !== playbackSong.id) {
      savedSeekRef.current = null;
    }
    // Per-episode podcast resume: only when no seek is already pending, so a
    // cross-device snapshot restore wins and we never double-seek. Seeded once
    // per song id rather than on sourceChanged: a tap pre-loads the source via
    // the playback-gesture handler, so by the time this effect runs the source
    // is usually already loaded — and may even have metadata, in which case
    // loadedmetadata won't fire again and the seek must be applied right here.
    if (lastResumeSeededSongIdRef.current !== playbackSong.id) {
      lastResumeSeededSongIdRef.current = playbackSong.id;
      if (!savedSeekRef.current && isPodcastSong(playbackSong)) {
        const stored = readEpisodeProgress(playbackSong.id);
        if (stored && stored.time >= PODCAST_RESUME_MIN_SECONDS && !isEpisodeFinished(stored)) {
          savedSeekRef.current = { songId: playbackSong.id, time: stored.time };
          if (
            audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
            audioSourceStateRef.current.get(audio)?.src === resolvePlayableSrc(src)
          ) {
            applyPendingResumeSeek(audio);
          }
        }
      }
    }
    if (sourceChanged || lockedSource?.songId !== playbackSong.id) {
      lockedPlaybackSourceRef.current = { songId: playbackSong.id, src };
    }
    loadAudioSource(audio, src);
    // Restore the active element to full level: a prior cancelled/committed fade
    // may have left its GainNode (or volume) at 0. Use refs so volume/mute changes
    // don't re-trigger this load effect (which would reload the source).
    setOutputLevel(audio, mutedRef.current ? 0 : volumeRef.current);
    if (other && other !== audio) {
      // Ensure the inactive element is quiet and not playing
      try { other.pause(); } catch {}
      setOutputLevel(other, 0);
      unloadAudioSource(other);
    }
    if (isPlaying) {
      void playAudio(audio);
    } else {
      playRequestIdRef.current += 1;
      audio.pause();
    }
  }, [applyPendingResumeSeek, desiredSrc, isPlaying, playbackSong?.duration, playbackSong?.id, getActiveAudio, getInactiveAudio, loadAudioSource, unloadAudioSource, cancelActiveCrossfade, playAudio, resetPlaybackClock, setOutputLevel]);

  // Crossfade: triggered from the active element's `timeupdate` event (which keeps
  // firing while the tab/app is backgrounded, unlike requestAnimationFrame).
  // Two ramp implementations share the same target/commit logic:
  //  - iOS (audio.volume read-only): route both elements through GainNodes and
  //    ramp on the Web Audio thread (linearRampToValueAtTime), which keeps running
  //    smoothly even when the app is backgrounded.
  //  - Desktop/Android: ramp audio.volume on a ~60ms setInterval.
  // If the Web Audio graph can't be built on iOS, it falls back to a clean cut so
  // two tracks never play at full volume at once.
  useEffect(() => {
    // Reset the per-effect "started" latch whenever the inputs change (e.g. a new
    // song loaded, settings changed) so a fresh fade can arm. Don't disturb an
    // in-flight fade.
    if (!crossfadingRef.current) crossfadeStartedRef.current = false;

    const computeNextTarget = ():
      | { song: PlayerSong; playbackSong: PlayerSong; index: number; fromFuture: boolean }
      | null => {
      if (!Array.isArray(queue) || queue.length === 0) return null;
      let nextIdx: number;
      let nextFromFuture = false;
      if (shuffle) {
        if (queue.length === 1) return null;
        // Mirror next(): consume the redo stack (playFuture) before drawing a
        // fresh index from the shuffle pool, so the crossfade target matches
        // what next() would have chosen.
        const peekedFuture = playFuture[playFuture.length - 1];
        const fromFuture =
          peekedFuture !== undefined &&
          peekedFuture >= 0 &&
          peekedFuture < queue.length &&
          peekedFuture !== currentIndex;
        const idx = fromFuture
          ? peekedFuture
          : chooseNextShuffleIndex(queue.length, currentIndex, shuffleRemaining);
        if (idx === currentIndex || idx < 0 || idx >= queue.length) return null;
        // Mirror next()'s shuffle-with-repeat-off stop behavior: if the pool is
        // exhausted and we're not repeating, don't crossfade into a refilled pool.
        if (!fromFuture && repeatMode !== "all") {
          const remaining = queue
            .map((_, index) => index)
            .filter((index) => index !== currentIndex && shuffleRemaining.includes(index));
          if (remaining.length === 0) return null;
        }
        nextIdx = idx;
        nextFromFuture = fromFuture;
      } else {
        const atEnd = currentIndex >= queue.length - 1;
        if (atEnd) {
          if (repeatMode === "all") nextIdx = 0;
          else return null;
        } else {
          nextIdx = currentIndex + 1;
        }
      }
      const nextSong = queue[nextIdx];
      if (!nextSong) return null;
      return {
        song: nextSong,
        playbackSong: resolvePlaybackSong(nextSong),
        index: nextIdx,
        fromFuture: nextFromFuture,
      };
    };

    // Shared commit: advance the store index and swap the active element so the UI
    // tracks the now-playing (incoming) element. Used by both the timer-driven
    // finish and the force-commit-on-ended path.
    const commit = (
      incoming: HTMLAudioElement,
      target: { playbackSong: PlayerSong; index: number; fromFuture: boolean },
    ) => {
      crossfadeCancelRef.current = null;
      crossfadeCommitSongIdRef.current = target.playbackSong.id;
      // preservePlayState: a pause that lands mid-fade (lock screen / MediaSession)
      // must survive the queue advance — don't let advanceToIndex force playback on.
      advanceToIndex(target.index, { fromFuture: target.fromFuture, preservePlayState: true });
      const nextActiveIdx = activeIdx === 0 ? 1 : 0;
      setActiveIdx(nextActiveIdx);
      setDuration(
        finiteMediaDuration(incoming.duration) ??
          finiteMediaDuration(target.playbackSong.duration ?? 0) ??
          0,
      );
      suppressAutoLoadRef.current = false;
      crossfadingRef.current = false;
      crossfadeStartedRef.current = false;
      crossfadeTargetRef.current = null;
    };

    const startCrossfade = () => {
      if (!crossfadeEnabled) return;
      if (crossfadeStartedRef.current || crossfadingRef.current) return;
      if (!isPlaying || repeatMode === "one") return;
      // Podcasts: the fade-window math assumes media-time == wall-time (wrong at
      // rate != 1), and crossfading speech is undesirable anyway.
      if (currentSongIsPodcast) return;
      const fromAudio = getActiveAudio();
      const incoming = getInactiveAudio();
      if (!fromAudio || !incoming) return;
      const total = finiteMediaDuration(fromAudio.duration) ?? finiteMediaDuration(duration);
      if (total == null) return;
      const fadeWindow = Math.min(crossfadeSeconds, Math.max(0, total / 2));
      if (fadeWindow <= 0) return;
      const remaining = total - (fromAudio.currentTime || 0);
      if (remaining > fadeWindow + 0.05) return;

      const target = computeNextTarget();
      if (!target) return;

      crossfadeStartedRef.current = true;
      crossfadingRef.current = true;
      suppressAutoLoadRef.current = true;
      crossfadeTargetRef.current = target;

      if (target.playbackSong.audioUrl) loadAudioSource(incoming, target.playbackSong.audioUrl);
      try { incoming.currentTime = 0; } catch {}

      const fadeMs = fadeWindow * 1000;
      const targetVol = mutedRef.current ? 0 : volumeRef.current;

      const webAudio = ensureWebAudioGraph();

      // Last-resort fallback: if we can neither ramp the GainNode (Web Audio) nor
      // audio.volume (iOS without a graph), clean-cut so two tracks never blast at
      // full volume at once.
      if (!webAudio && !audioVolumeIsWritable(fromAudio)) {
        try { fromAudio.pause(); } catch {}
        commit(incoming, target);
        return;
      }

      setOutputLevel(incoming, 0);
      incoming.play().catch(() => {});

      let intervalId: number | null = null;
      let timeoutId: number | null = null;
      const clearTimer = () => {
        if (intervalId != null) { window.clearInterval(intervalId); intervalId = null; }
        if (timeoutId != null) { window.clearTimeout(timeoutId); timeoutId = null; }
      };

      const finish = () => {
        clearTimer();
        if (crossfadeCancelRef.current !== cancelFade) return;
        try { fromAudio.pause(); } catch {}
        if (!isPlayingRef.current) { try { incoming.pause(); } catch {} }
        setOutputLevel(fromAudio, 0);
        setOutputLevel(incoming, targetVol);
        commit(incoming, target);
      };

      const cancelFade = () => {
        clearTimer();
        try { incoming.pause(); } catch {}
        setOutputLevel(incoming, 0);
        setOutputLevel(fromAudio, mutedRef.current ? 0 : volumeRef.current);
        suppressAutoLoadRef.current = false;
        crossfadingRef.current = false;
        crossfadeStartedRef.current = false;
        crossfadeTargetRef.current = null;
      };
      crossfadeCancelRef.current = cancelFade;

      if (webAudio) {
        // Ramp the GainNodes on the audio thread (linearRampToValueAtTime) so the
        // fade stays smooth even when the app is backgrounded — timers throttle,
        // the audio thread does not.
        const ctx = audioContextRef.current;
        const fromNode = webAudioNodesRef.current.get(fromAudio);
        const toNode = webAudioNodesRef.current.get(incoming);
        if (ctx && fromNode && toNode) {
          const t0 = ctx.currentTime;
          // Equal-power curves (cos out / sin in) instead of straight linear ramps,
          // so the overlap doesn't dip ~3 dB through the middle of the fade.
          scheduleEqualPowerRamp(fromNode.gain.gain, t0, fadeWindow, targetVol, "out");
          scheduleEqualPowerRamp(toNode.gain.gain, t0, fadeWindow, targetVol, "in");
        }
        // Commit when the fade window elapses. If the app is backgrounded the
        // timeout may be throttled — the outgoing track's `ended` event then
        // drives forceCommit instead (the audio-thread ramp already completed).
        timeoutId = window.setTimeout(finish, fadeMs);
      } else {
        const startTs = performance.now();
        const fromStartTime = fromAudio.currentTime || 0;
        const tick = () => {
          if (crossfadeCancelRef.current !== cancelFade) {
            clearTimer();
            return;
          }
          const elapsed = Math.min(fadeMs, performance.now() - startTs);
          const t = fadeMs > 0 ? elapsed / fadeMs : 1;
          // Equal-power curve (cos out / sin in) — the same shape the iOS gain-node
          // path uses — so neither path dips in loudness mid-crossfade.
          const fromVol = Math.max(0, (mutedRef.current ? 0 : volumeRef.current) * equalPowerGain(t, "out"));
          const toVol = Math.max(0, targetVol * equalPowerGain(t, "in"));
          if ((fromAudio.currentTime || 0) >= fromStartTime) setOutputLevel(fromAudio, fromVol);
          setOutputLevel(incoming, toVol);
          if (elapsed >= fadeMs) finish();
        };
        // ~60ms ticks keep the ramp smooth while still firing when backgrounded.
        intervalId = window.setInterval(tick, 60);
        tick();
      }
    };

    // Force-commit immediately when the outgoing track ends mid-fade (e.g. a
    // backgrounded/locked fade where the ramp timer was throttled): snap volumes
    // to final, pause the outgoing element, and commit so the queue can't wedge.
    const forceCommit = () => {
      if (!crossfadingRef.current) return;
      // Detach the running ramp timer: it self-clears once crossfadeCancelRef no
      // longer points at its cancelFade closure.
      crossfadeCancelRef.current = null;
      const fromAudio = getActiveAudio();
      const incoming = getInactiveAudio();
      // Reuse the target captured when the fade armed — the incoming element
      // already has THIS song loaded and partially faded in. Recomputing would,
      // in shuffle mode, draw a different random index and play one song while the
      // queue advances to another. Fall back to a fresh pick only if (defensively)
      // no target was captured, which keeps the queue from wedging.
      const target = crossfadeTargetRef.current ?? computeNextTarget();
      if (!incoming || !target) {
        // Nothing to commit into; clear the fade so the onEnded fallback can run.
        suppressAutoLoadRef.current = false;
        crossfadingRef.current = false;
        crossfadeStartedRef.current = false;
        return;
      }
      try { fromAudio?.pause(); } catch {}
      if (fromAudio) setOutputLevel(fromAudio, 0);
      setOutputLevel(incoming, mutedRef.current ? 0 : volumeRef.current);
      if (isPlayingRef.current) incoming.play().catch(() => {});
      commit(incoming, target);
    };

    maybeStartCrossfadeRef.current = startCrossfade;
    forceCommitCrossfadeRef.current = forceCommit;
  }, [activeIdx, advanceToIndex, crossfadeEnabled, crossfadeSeconds, currentIndex, currentSongIsPodcast, duration, ensureWebAudioGraph, getActiveAudio, getInactiveAudio, isPlaying, loadAudioSource, playFuture, queue, repeatMode, resolvePlaybackSong, setOutputLevel, shuffle, shuffleRemaining]);

  // Cancel any in-flight crossfade ramp (and its timer) when the bar unmounts.
  useEffect(() => {
    return () => {
      crossfadeCancelRef.current?.();
      crossfadeCancelRef.current = null;
    };
  }, []);

  // iOS may suspend the AudioContext when backgrounded; resume it when the app
  // returns to the foreground so a routed element doesn't stay silent. (While
  // backgrounded, the audio session keeps it alive during active playback.)
  useEffect(() => {
    const resume = () => {
      const ctx = audioContextRef.current;
      if (ctx && ctx.state === "suspended" && document.visibilityState === "visible") {
        void ctx.resume().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);

  const publishPlaybackState = useCallback(async (options?: { keepalive?: boolean }) => {
    if (!playbackSyncReadyRef.current || applyingSyncedPlaybackStateRef.current) return;
    const updatedAt = Math.max(Date.now(), playbackStateUpdatedAtRef.current + 1);
    const state = buildPlaybackStateSnapshot(updatedAt);
    if (!state) {
      // Mirror saveCurrentPlaybackStateToLocal: only remove when the queue is
      // genuinely empty (sync is already known ready here).
      if (queue.length === 0) removeLocalPlaybackState();
      return;
    }
    const stateSignature = playbackStateSyncSignature(state);
    if (stateSignature === lastSyncedPlaybackStateSignatureRef.current) return;
    playbackStateUpdatedAtRef.current = state.updatedAt;
    writeLocalPlaybackState(state);
    try {
      const acceptedState = await writeServerPlaybackState(state, options);
      if (acceptedState && acceptedState.updatedAt > state.updatedAt) {
        applyPlaybackStateSnapshot(acceptedState);
        lastSyncedPlaybackStateSignatureRef.current = playbackStateSyncSignature(acceptedState);
        clearPlaybackStatePendingSync();
        return;
      }
      if (acceptedState) {
        lastSyncedPlaybackStateSignatureRef.current = stateSignature;
        clearPlaybackStatePendingSync();
      } else {
        markPlaybackStatePendingSync(state.updatedAt);
      }
    } catch {
      markPlaybackStatePendingSync(state.updatedAt);
    }
  }, [applyPlaybackStateSnapshot, buildPlaybackStateSnapshot, queue]);

  const schedulePlaybackStateSync = useCallback((delayMs = 1_000) => {
    if (!playbackSyncReadyRef.current || applyingSyncedPlaybackStateRef.current) return;
    if (pendingPlaybackSyncTimeoutRef.current != null) {
      window.clearTimeout(pendingPlaybackSyncTimeoutRef.current);
    }
    pendingPlaybackSyncTimeoutRef.current = window.setTimeout(() => {
      pendingPlaybackSyncTimeoutRef.current = null;
      void publishPlaybackState();
    }, delayMs);
  }, [publishPlaybackState]);

  const flushPendingPlaybackState = useCallback(async () => {
    if (!authSettled || !playbackSyncReadyRef.current) return;
    const pendingUpdatedAt = readPlaybackStatePendingSyncUpdatedAt();
    if (!pendingUpdatedAt) return;
    const localState = readLocalPlaybackState();
    if (!localState || normalizeAccountScope(localState.accountScope) !== accountScope) {
      clearPlaybackStatePendingSync();
      return;
    }
    try {
      const acceptedState = await writeServerPlaybackState(localState);
      if (!acceptedState) {
        markPlaybackStatePendingSync(localState.updatedAt);
        return;
      }
      clearPlaybackStatePendingSync();
      const localSignature = playbackStateSyncSignature(localState);
      lastSyncedPlaybackStateSignatureRef.current =
        acceptedState.updatedAt > localState.updatedAt
          ? playbackStateSyncSignature(acceptedState)
          : localSignature;
      if (acceptedState.updatedAt > localState.updatedAt) {
        applyPlaybackStateSnapshot(acceptedState);
      }
    } catch {
      markPlaybackStatePendingSync(localState.updatedAt);
    }
  }, [accountScope, applyPlaybackStateSnapshot, authSettled]);

  useEffect(() => {
    if (!authSettled) return;
    const handleOnline = () => {
      void flushPendingPlaybackState();
    };
    window.addEventListener("online", handleOnline);
    void flushPendingPlaybackState();
    return () => window.removeEventListener("online", handleOnline);
  }, [authSettled, flushPendingPlaybackState]);

  useEffect(() => {
    if (!currentSong) return;
    schedulePlaybackStateSync(isPlaying ? 1_000 : 700);
  }, [currentIndex, currentSong?.id, isPlaying, queue, schedulePlaybackStateSync]);

  useEffect(() => {
    if (!currentSong || isPlaying) return;
    schedulePlaybackStateSync(900);
  }, [currentSong?.id, currentTime, isPlaying, schedulePlaybackStateSync]);

  useEffect(() => {
    if (!currentSong || !isPlaying) return;
    const intervalId = window.setInterval(() => {
      // Backstop for sleep expiry when timeupdate isn't firing (stalled audio,
      // backgrounded tab); setInterval keeps ticking where rAF/setTimeout don't.
      enforceSleepTimerExpiry();
      schedulePlaybackStateSync(0);
    }, 8_000);
    return () => window.clearInterval(intervalId);
  }, [currentSong?.id, enforceSleepTimerExpiry, isPlaying, schedulePlaybackStateSync]);

  // Near-zero positions over substantial saved progress are almost always a
  // torn-down or freshly-reset element (navigation/app teardown, native source
  // swap), not a real listen position — keep the resume point instead.
  const writeEpisodeProgressGuarded = useCallback((id: string, time: number, total: number) => {
    if (time < PODCAST_RESUME_MIN_SECONDS) {
      const existing = readEpisodeProgress(id);
      if (existing && existing.time >= PODCAST_RESUME_MIN_SECONDS && !isEpisodeFinished(existing)) return;
    }
    writeEpisodeProgress(id, time, total);
  }, []);

  const flushPodcastProgress = useCallback(() => {
    if (!currentSongIsPodcast || !currentSongId) return;
    // A resume target that never landed means the element's position is wrong;
    // flushing it would clobber the real resume point — keep the stored one.
    if (savedSeekRef.current?.songId === currentSongId) return;
    const active = getActiveAudio();
    // Teardown resets media elements before pagehide fires, so the element
    // reads 0 here; currentTimeRef still holds the last timeupdate position.
    const elementTime =
      active && active.readyState >= HTMLMediaElement.HAVE_METADATA ? active.currentTime : null;
    const time = elementTime ?? currentTimeRef.current;
    const total =
      finiteMediaDuration(active?.duration ?? 0) ?? playbackDuration ?? 0;
    lastPodcastProgressWriteRef.current = Date.now();
    writeEpisodeProgressGuarded(currentSongId, time, total);
  }, [currentSongId, currentSongIsPodcast, getActiveAudio, playbackDuration, writeEpisodeProgressGuarded]);

  // Recording must never affect playback: fire-and-forget, all errors swallowed.
  // `keepEntry` keeps tracking the same listen after a flush (pagehide/hidden may
  // not be a real exit); the `recorded` latch prevents double counting.
  const flushPlayListen = useCallback((keepEntry = false) => {
    const listen = playListenRef.current;
    if (!keepEntry) playListenRef.current = null;
    if (!listen || listen.recorded) return;
    try {
      const durationSeconds = finiteMediaDuration(listen.song.duration ?? 0) ?? listen.durationSeconds;
      if (!shouldRecordPlay(listen.maxPositionSeconds, durationSeconds)) return;
      listen.recorded = true;
      recordPlayEvent(listen.song, Math.round(listen.maxPositionSeconds * 1000));
    } catch {}
  }, []);

  const beginPlayListen = useCallback((song: PlayerSong | null) => {
    playListenRef.current = song
      ? { song, startedAtMs: Date.now(), maxPositionSeconds: 0, durationSeconds: null, recorded: false }
      : null;
  }, []);

  // Record the previous listen at the song-change boundary, where every advance
  // path converges (next/previous/advanceToIndex/crossfade-commit/error-skip,
  // queue emptied). The audio 'ended' event is NOT a reliable hook: under
  // crossfade the outgoing element is paused/unloaded at commit, so 'ended'
  // never fires. The threshold filters error-skipped tracks (no position).
  useEffect(() => {
    if (playListenRef.current?.song.id === currentSongId) return;
    flushPlayListen();
    beginPlayListen(currentSongId ? currentSong : null);
  }, [beginPlayListen, currentSong, currentSongId, flushPlayListen]);

  // Save queue/song and playback position right before page unload
  useEffect(() => {
    function saveState() {
      flushPodcastProgress();
      flushPlayListen(true);
      if (pendingPlaybackSyncTimeoutRef.current != null) {
        window.clearTimeout(pendingPlaybackSyncTimeoutRef.current);
        pendingPlaybackSyncTimeoutRef.current = null;
        void publishPlaybackState({ keepalive: true });
        return;
      }
      saveCurrentPlaybackStateToLocal();
    }

    function saveStateWhenHidden() {
      // iOS never fires pagehide/beforeunload when a backgrounded PWA is
      // killed from the app switcher, so persist on backgrounding too.
      if (document.visibilityState === "hidden") saveState();
    }

    window.addEventListener("beforeunload", saveState);
    window.addEventListener("pagehide", saveState);
    document.addEventListener("visibilitychange", saveStateWhenHidden);
    return () => {
      window.removeEventListener("beforeunload", saveState);
      window.removeEventListener("pagehide", saveState);
      document.removeEventListener("visibilitychange", saveStateWhenHidden);
    };
  }, [flushPlayListen, flushPodcastProgress, publishPlaybackState, saveCurrentPlaybackStateToLocal]);

  const handleActiveAudioResumePoint = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    const audio = event.currentTarget;
    if (audio !== getActiveAudio()) return;
    retryStickySeekRef.current();
    const sticky = stickySeekRef.current;
    if (sticky?.audio === audio && !seekIsCloseEnough(audio.currentTime, sticky.time)) {
      currentTimeRef.current = sticky.time;
      setCurrentTime(sticky.time);
      return;
    }
    currentTimeRef.current = audio.currentTime || 0;
    setCurrentTime(audio.currentTime || 0);
    if (resumeAfterSeekRef.current) resumeActivePlayback(audio);
  }, [getActiveAudio, resumeActivePlayback]);

  const handleActiveAudioPlaying = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    if (event.currentTarget === getActiveAudio()) {
      resumeAfterSeekRef.current = false;
      clearPlaybackError();
      // Successful playback gives a future failure a fresh retry budget.
      erroredSrcRetryRef.current = null;
      notePlaybackNetworkSuccess();
    }
  }, [clearPlaybackError, getActiveAudio]);

  const handleActiveAudioError = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    const audio = event.currentTarget;
    if (audio !== getActiveAudio() || !audio.error) return;
    // Radio / browser-local sources have their own handling. Streaming podcasts
    // (plain HTTP through the media proxy) deliberately fall through to the same
    // retry path as music.
    if (currentSongIsBrowserLocal || currentSongIsRadio) return;
    notePlaybackNetworkFailure();

    const state = audioSourceStateRef.current.get(audio);
    const baseSrc = state?.src ?? audio.currentSrc ?? audio.src;
    if (!baseSrc) return;

    // Retry the same track once with a cache-busted URL. Don't
    // touch HLS sources (managed by hls.js) — only retry plain element srcs.
    if (!state?.hls && erroredSrcRetryRef.current !== baseSrc) {
      erroredSrcRetryRef.current = baseSrc;
      const sep = baseSrc.includes("?") ? "&" : "?";
      const bustedSrc = `${baseSrc}${sep}__retry=${Date.now()}`;
      try {
        // Ignore the rejected play promise from the source we're replacing.
        playRequestIdRef.current += 1;
        audio.src = bustedSrc;
        audioSourceStateRef.current.set(audio, { src: baseSrc, hls: null });
        audio.load();
        if (isPlayingRef.current) void playAudio(audio);
        return;
      } catch {}
    }

    // A missing file is not a request to change songs. Keep the selected song
    // and queue intact, including when a paused/restored source fails to load.
    cancelActiveCrossfade();
    resetPendingSeek();
    isPlayingRef.current = false;
    playRequestIdRef.current += 1;
    audio.pause();
    const failedSong = usePlayerStore.getState().currentSong;
    if (failedSong?.id === currentSongId) {
      const retrySong = prepareHistorySongForPlayback(failedSong);
      if (retrySong !== failedSong) replaceSong(retrySong);
    }
    if (currentSongId) failPlayback(currentSongId, "This song couldn’t load. Press play to retry.");
  }, [currentSongId, currentSongIsBrowserLocal, currentSongIsRadio, getActiveAudio, cancelActiveCrossfade, resetPendingSeek, playAudio, failPlayback, replaceSong]);

  const handleTogglePlayback = useCallback(() => {
    if (isPlaying) {
      pause();
      return;
    }
    // Build/resume the Web Audio graph inside this user gesture (iOS requirement).
    ensureWebAudioGraph();
    requestImmediatePlayback(playbackSong);
    play();
  }, [playbackSong, isPlaying, pause, play, ensureWebAudioGraph]);

  // Global keyboard shortcuts (always register to keep hook order stable)
  useEffect(() => {
    function seekBy(seconds: number) {
      const audio = getActiveAudio();
      if (!audio) return;
      const total = finiteMediaDuration(audio.duration) ?? finiteMediaDuration(duration) ?? playbackDuration;
      if (total == null) return;
      const baseTime = lastSeekTargetRef.current ?? audio.currentTime ?? 0;
      const nextTime = Math.max(0, Math.min(total, baseTime + seconds));
      onSeek(nextTime);
    }

    function clearShortcutFocus(target: EventTarget | null) {
      // Pressing a key flips the browser into keyboard-focus mode, which draws
      // a focus ring around whatever element was last clicked. These are global
      // playback shortcuts, not interactions with the focused element, so drop
      // focus to keep the ring from appearing.
      const focused =
        target instanceof HTMLElement
          ? target
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      if (focused && focused !== document.body) focused.blur();
    }

    function onKeyDown(e: KeyboardEvent) {
      // No song loaded: don't hijack any keys app-wide (let the browser handle
      // space/arrows normally).
      if (!currentSongId) return;
      // Spacebar toggles play/pause
      if (isSpaceKey(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (shouldPreservePlaybackShortcutTarget(playbackKeyTargetInfo(e.target))) return;
        e.preventDefault();
        e.stopPropagation();
        clearShortcutFocus(e.target);
        if (!e.repeat) handleTogglePlayback();
        return;
      }
      if (shouldPreservePlaybackShortcutTarget(playbackKeyTargetInfo(e.target))) return;
      // Plain arrow keys seek +/- 5 seconds. Modifier+arrow is left untouched so
      // it doesn't shadow browser navigation (e.g. Cmd+Left/Right Back/Forward).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        clearShortcutFocus(e.target);
        seekBy(5);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        clearShortcutFocus(e.target);
        seekBy(-5);
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (!currentSongId) return;
      if (isSpaceKey(e) && !e.metaKey && !e.ctrlKey && !e.altKey && !shouldPreservePlaybackShortcutTarget(playbackKeyTargetInfo(e.target))) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    const options = { capture: true };
    window.addEventListener("keydown", onKeyDown, options);
    window.addEventListener("keyup", onKeyUp, options);
    return () => {
      window.removeEventListener("keydown", onKeyDown, options);
      window.removeEventListener("keyup", onKeyUp, options);
    };
  }, [currentSongId, duration, handleTogglePlayback, getActiveAudio, onSeek, playbackDuration]);

  // Extracted from the <audio> JSX so they can be registered on the native deck
  // adapters too (which have no JSX props). On native iOS these run off the
  // AVPlayer engine's events; on web they're the element's event handlers.
  const handleLoadedMetadata = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    const audio = event.currentTarget;
    if (audio !== getActiveAudio()) return;
    const mediaDuration = finiteMediaDuration(audio.duration) ?? playbackDuration;
    setDuration(mediaDuration ?? 0);
    applyPendingResumeSeek(audio);
    applyStoredPodcastResume(audio);
    retryStickySeekRef.current();
    setOutputLevel(audio, isMuted ? 0 : volume);
    // Belt-and-braces: a fresh load resets playbackRate to defaultPlaybackRate.
    audio.defaultPlaybackRate = effectivePlaybackRate;
    audio.playbackRate = effectivePlaybackRate;
  }, [getActiveAudio, playbackDuration, applyPendingResumeSeek, applyStoredPodcastResume, setOutputLevel, isMuted, volume, effectivePlaybackRate]);

  const handleTimeUpdate = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    if (event.currentTarget !== getActiveAudio()) return;
    // timeupdate keeps firing while iOS backgrounds throttle timers, so enforce
    // sleep-timer expiry here.
    enforceSleepTimerExpiry();
    // A user seek is queued (onSeek debounces ~90ms before issuing it): the
    // optimistic target is already on the scrubber, so ignore pre-seek time ticks.
    // The native deck reports the OLD position until the seek is actually issued,
    // which would otherwise flash the scrubber back before it jumps to the target.
    if (pendingSeekRef.current) return;
    const sticky = stickySeekRef.current;
    if (sticky?.audio === event.currentTarget && !seekIsCloseEnough(event.currentTarget.currentTime, sticky.time)) {
      currentTimeRef.current = sticky.time;
      publishPlaybackPosition({ currentTime: sticky.time, duration });
      lastTimeStateWriteRef.current = Date.now();
      setCurrentTime(sticky.time);
      return;
    }
    const nextTime = currentSongIsRadio ? 0 : event.currentTarget.currentTime || 0;
    currentTimeRef.current = nextTime;
    // A pending resume target is consumed once playback reaches it; until then it
    // blocks progress/snapshot writes so a dropped seek can't overwrite the saved
    // position with the wrong one.
    const pendingResume = savedSeekRef.current;
    if (
      pendingResume?.songId === currentSongId &&
      (seekIsCloseEnough(nextTime, pendingResume.time) || nextTime > pendingResume.time)
    ) {
      savedSeekRef.current = null;
    }
    const listen = playListenRef.current;
    if (listen && listen.song.id === currentSongId) {
      if (nextTime > listen.maxPositionSeconds) listen.maxPositionSeconds = nextTime;
      if (listen.durationSeconds == null) {
        listen.durationSeconds = finiteMediaDuration(event.currentTarget.duration);
      }
    }
    // Smooth 4Hz position to the scrubber leaf (and sidebar lyrics). The React
    // state write — which re-renders this whole tree — is throttled to ~1Hz unless
    // the full-screen sheet is open (it needs the smooth value too).
    publishPlaybackPosition({ currentTime: nextTime, duration });
    const nowMs = Date.now();
    if (nowPlayingOpen || nowMs - lastTimeStateWriteRef.current >= 900) {
      lastTimeStateWriteRef.current = nowMs;
      setCurrentTime(nextTime);
    }
    if (
      currentSongIsPodcast &&
      currentSongId &&
      !savedSeekRef.current
    ) {
      const now = Date.now();
      if (now - lastPodcastProgressWriteRef.current >= PODCAST_PROGRESS_WRITE_INTERVAL_MS) {
        lastPodcastProgressWriteRef.current = now;
        writeEpisodeProgressGuarded(
          currentSongId,
          nextTime,
          finiteMediaDuration(event.currentTarget.duration) ?? playbackDuration ?? 0,
        );
      }
    }
    // Drive the crossfade trigger from timeupdate (fires while backgrounded too).
    if (!currentSongIsRadio) {
      maybeStartCrossfadeRef.current();
    }
  }, [getActiveAudio, enforceSleepTimerExpiry, duration, currentSongIsRadio, currentSongId, currentSongIsPodcast, nowPlayingOpen, playbackDuration]);

  const handleEnded = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    if (event.currentTarget !== getActiveAudio()) return;
    if (crossfadingRef.current) {
      // A backgrounded/locked fade may not have finished on the timer before the
      // outgoing track ended. Force-commit now so the queue can't wedge.
      forceCommitCrossfadeRef.current();
      return;
    }
    if (currentSongIsPodcast && currentSongId) markEpisodeFinished(currentSongId);
    const audio = event.currentTarget;
    if (repeatMode === "one" || (repeatMode === "all" && queue.length <= 1)) {
      // Same song id replays, so the song-change boundary never fires; flush +
      // re-arm here so each full repeat counts as a play.
      flushPlayListen();
      // "End of track" sleep: an in-place replay never changes currentSongId, so
      // the song-id-change effect can't see it. Stop here instead of replaying.
      if (usePlayerStore.getState().sleepAtEndOfTrack) {
        pause();
        cancelSleepTimer();
        return;
      }
      beginPlayListen(currentSongId ? currentSong : null);
      audio.currentTime = 0;
      void playAudio(audio);
      return;
    }
    next();
  }, [getActiveAudio, currentSongIsPodcast, currentSongId, repeatMode, queue.length, flushPlayListen, pause, cancelSleepTimer, beginPlayListen, currentSong, playAudio, next]);

  const renderAudio = (ref: React.RefObject<HTMLAudioElement | null>) => (
    <audio
      ref={ref}
      hidden
      playsInline
      preload="auto"
      onLoadedMetadata={handleLoadedMetadata}
      onTimeUpdate={handleTimeUpdate}
      onLoadedData={handleActiveAudioResumePoint}
      onDurationChange={handleActiveAudioResumePoint}
      onSeeked={handleActiveAudioResumePoint}
      onCanPlay={handleActiveAudioResumePoint}
      onCanPlayThrough={handleActiveAudioResumePoint}
      onPlaying={handleActiveAudioPlaying}
      onError={handleActiveAudioError}
      onEnded={handleEnded}
    />
  );

  const audioElements = (
    <>
      {renderAudio(audioARef)}
      {renderAudio(audioBRef)}
    </>
  );


  return {
    audioElements,
    playbackSong,
    chrome: playbackSong
      ? {
          song: playbackSong,
          playbackError: playbackError?.songId === playbackSong.id
            ? playbackError.message
            : null,
          duration,
          currentTime,
          onSeek,
          onTogglePlayback: handleTogglePlayback,
          nowPlayingOpen,
          nowPlayingMounted,
          onCloseNowPlaying: closeNowPlaying,
          onOpenNowPlaying: openNowPlaying,
          onToggleNowPlaying: toggleNowPlaying,
          onOpenQueue: openQueueSheet,
          queueSheetOpen,
          queueSheetMounted,
          onCloseQueue: closeQueueSheet,
          onToggleQueue: toggleQueueSheet,
        }
      : null,
  };
}
