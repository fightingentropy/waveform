import AudioEngine, {
  type CrossfadeCompleteEvent,
  type DeckId,
  type EndedEvent,
  type ErrorEvent,
  type PlayingEvent,
  type RemoteEvent,
  type SeekedEvent,
  type TimeEvent,
  type WaitingEvent,
} from "../../modules/audio-engine";
import { toAbsoluteApiUrl } from "@/lib/config";
import { getIsOnline, markOffline, subscribeOnline } from "@/lib/connectivity";
import { isUnstagedDiscoverSong } from "@/lib/discover-queue";
import { isLikelyNetworkPlaybackError } from "@/lib/playback-continuity";
import { shouldPublishQueueMutation } from "@/lib/queue-publish-policy";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { createPlayListen, flushPlayListen, type PlayListenEntry } from "@/lib/play-events";
import {
  isEpisodeFinished,
  markEpisodeFinished,
  PODCAST_PROGRESS_WRITE_INTERVAL_MS,
  PODCAST_RESUME_MIN_SECONDS,
  readEpisodeProgress,
  writeEpisodeProgressGuarded,
} from "@/lib/podcast-progress";
import { resolveOfflinePlaybackSong, useOfflineStore } from "@/store/offline";
import { getUpcomingPlaybackIndices, usePlayerStore } from "@/store/player";
import { lockScreenArtwork } from "@/audio/track";
import { isOwnHandledSong, MAX_CONSECUTIVE_AUDIO_ERRORS, refreshCurrentSong } from "@/audio/refresh";
import { enforceSleepTimer } from "@/audio/sleep";
import { publishPlaybackState, setLastPosition, takePendingResumeSeek } from "@/audio/playback-sync";
import { resetAudioProgress, setAudioProgress, useAudioProgressStore } from "@/audio/progress";
import type { PlayerSong } from "@/types/player";

// iOS dual-deck native audio engine. The native AudioEngine module (two AVPlayer
// decks A/B, an equal-power crossfade ramp on a background-safe 33ms timer, and
// the lock-screen Now Playing center) owns audio OUTPUT; this file owns all
// ORCHESTRATION — which song goes on which deck, when to prefetch the next track,
// when to fade, and committing the queue advance. Mirrors the original web
// PlayerBar crossfade state machine. Android uses engine-rntp.ts instead.

const PREFETCH_LEAD_S = 25; // warm well before the fade, while reception is still usable
const NOW_PLAYING_THROTTLE_MS = 1000; // lock-screen scrubber refresh cadence
// A streamed track that can't buffer leaves AVPlayer in .waitingToPlayAtSpecifiedRate
// indefinitely WITHOUT ever firing an error — so the onError circuit-breaker never
// trips and playback wedges on "loading". If the active deck sits buffering this
// long without once reaching "playing", treat it as un-streamable and fall back to
// the downloaded subset (the exact "connected but slow" gap between online + offline).
const STALL_TIMEOUT_MS = 12000;

type StoreState = ReturnType<typeof usePlayerStore.getState>;
type NextTrack = { index: number; song: PlayerSong; fromFuture: boolean };

let started = false;
let initPromise: Promise<void> | null = null;
let activeDeck: DeckId = "A";
const deckSong: Record<DeckId, PlayerSong | null> = { A: null, B: null };
const deckKey: Record<DeckId, string | null> = { A: null, B: null };
let loadSeq = 0;
let currentListen: PlayListenEntry | null = null;

// crossfade scheduling state
let crossfading = false;
let prefetchDeck: DeckId | null = null;
let prefetchIndex: number | null = null;
let prefetchFromFuture = false;

// error circuit-breaker
let consecutiveErrors = 0;
let erroredKeyRetry: string | null = null;
let localSwitchInFlight = false;
// Set once repeated load failures reveal we're effectively offline for streaming.
// While set, auto-advance stays on the downloaded subset so playback doesn't flash
// through un-streamable tracks. Cleared when a streamed (non-downloaded) track
// actually plays, or when the user starts a brand-new queue.
let offlinePlayback = false;

// Jump to the next downloaded song in the queue (skipping un-streamable ones).
// Returns false when nothing in the queue is downloaded.
function skipToDownloaded(): boolean {
  const isDownloaded = useOfflineStore.getState().isDownloaded;
  return usePlayerStore.getState().skipToPlayable((song) => isDownloaded(song.id));
}

// --- stall watchdog ---------------------------------------------------------
// AVPlayer buffers a slow stream silently (no error), so a "connected but slow"
// network leaves us stuck on "loading" forever — unlike fully-offline, where the
// queue is pre-filtered to downloads, or fully-online, where the stream resolves.
// We arm a timer when the active deck reports it's waiting-to-play and disarm it
// the instant it actually plays; if it never plays, we treat the track as
// un-streamable and skip to a downloaded one (which plays from the phone).
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let stallSongId: string | null = null;

function clearStallWatchdog(): void {
  if (stallTimer != null) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
  stallSongId = null;
}

function armStallWatchdog(song: PlayerSong): void {
  if (stallTimer != null && stallSongId === song.id) return; // already watching this track
  clearStallWatchdog();
  stallSongId = song.id;
  stallTimer = setTimeout(onStallTimeout, STALL_TIMEOUT_MS);
}

function onStallTimeout(): void {
  const watchedId = stallSongId;
  stallTimer = null;
  stallSongId = null;
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  // The world may have moved on while we waited: paused, or a different track is
  // current now. onPlaying disarms the moment audio flows, so reaching here means
  // this exact track never started.
  if (!song || !s.isPlaying || song.id !== watchedId) return;
  if (isOwnHandledSong(song) || isPodcastSong(song)) return; // local/radio/podcast own their buffering

  // A 12s silent buffer is effectively "can't stream this." Mirror onError's
  // offline-fallback: prefer the downloaded subset so auto-advance lands on a
  // track that plays from the phone instead of hanging again. The shared
  // consecutive-error budget backstops a queue with nothing downloaded.
  consecutiveErrors += 1;
  if (consecutiveErrors >= MAX_CONSECUTIVE_AUDIO_ERRORS) {
    consecutiveErrors = 0;
    s.pause(); // stop — don't churn a fully un-streamable queue forever
    return;
  }
  offlinePlayback = true;
  markOffline();
  if (startPreferredLocalSwitch()) return;
  if (skipToDownloaded()) return;
  s.next(); // nothing downloaded — try the next track (may stream, or trips the breaker)
}

function onWaiting(e: WaitingEvent): void {
  if (e.deck !== activeDeck) return; // only the deck driving playback matters
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song || deckSong[e.deck]?.id !== song.id || !s.isPlaying) return;
  if (isOwnHandledSong(song) || isPodcastSong(song)) return;
  armStallWatchdog(song);
}

// throttles
let lastPodcastWriteMs = 0;
let lastNowPlayingMs = 0;

function other(deck: DeckId): DeckId {
  return deck === "A" ? "B" : "A";
}

function trackKey(song: PlayerSong): string {
  return `${song.id}|${toAbsoluteApiUrl(song.audioUrl)}`;
}

// A current stream may gain a ready local copy after it was loaded. Resolve the
// preferred source against live download state and report only a real remote→file
// transition; callers preserve the current position while swapping.
function currentPreferredLocalSong(): PlayerSong | null {
  const song = usePlayerStore.getState().currentSong;
  if (!song) return null;
  const resolved = resolveOfflinePlaybackSong(song);
  return resolved.source === "offline" && trackKey(resolved) !== deckKey[activeDeck] ? song : null;
}

function startPreferredLocalSwitch(): boolean {
  const song = currentPreferredLocalSong();
  if (!song) return false;
  if (localSwitchInFlight) return true;
  localSwitchInFlight = true;
  void hardLoad(song, usePlayerStore.getState().isPlaying)
    .catch(() => {
      usePlayerStore.getState().pause();
    })
    .finally(() => {
      localSwitchInFlight = false;
    });
  return true;
}

function currentVolume(): number {
  const { volume, isMuted } = usePlayerStore.getState();
  return isMuted ? 0 : volume;
}

function currentRate(song: PlayerSong | null): number {
  return song && isPodcastSong(song) ? usePlayerStore.getState().playbackRate : 1;
}

// Crossfade only applies to music — never bleed a podcast or radio station.
function crossfadeEligible(song: PlayerSong | null | undefined): boolean {
  return !!song && !isPodcastSong(song) && !isRadioSong(song);
}

function computeStartAt(song: PlayerSong): number {
  const pending = takePendingResumeSeek(song.id);
  if (pending != null) return pending;
  if (isPodcastSong(song)) {
    const progress = readEpisodeProgress(song.id);
    if (progress && progress.time >= PODCAST_RESUME_MIN_SECONDS && !isEpisodeFinished(progress)) {
      return progress.time;
    }
  }
  return 0;
}

function setNowPlayingFor(song: PlayerSong): void {
  void AudioEngine.setNowPlaying({
    title: song.title,
    artist: song.artist,
    album: song.album ?? "",
    duration: song.duration ?? 0,
    artworkUrl: lockScreenArtwork(song),
  }).catch(() => {});
}

function clearPrefetch(): void {
  prefetchDeck = null;
  prefetchIndex = null;
  prefetchFromFuture = false;
}

// The next track in *playback* order (mirrors next() under shuffle/repeat).
function computeNext(s: StoreState): NextTrack | null {
  const indices = getUpcomingPlaybackIndices(s.queue.length, s.currentIndex, 1, {
    shuffle: s.shuffle,
    repeatMode: s.repeatMode,
    playFuture: s.playFuture,
    shuffleRemaining: s.shuffleRemaining,
  });
  const index = indices[0];
  if (index === undefined) return null;
  const song = s.queue[index];
  if (!song) return null;
  const fromFuture = s.shuffle && s.playFuture.length > 0 && s.playFuture[s.playFuture.length - 1] === index;
  return { index, song, fromFuture };
}

// --- track loading (hard cut: user skip / select / initial) -----------------
async function hardLoad(song: PlayerSong | null, isPlaying: boolean): Promise<void> {
  clearStallWatchdog(); // new track boundary — drop any watchdog from the prior one
  // Unstaged Discover placeholder (empty audioUrl): there's nothing to load yet.
  // Stop the previous track, surface this one's metadata on the lock screen, and
  // idle until the stager swaps in the real source — which re-enters hardLoad with
  // a playable URL. Loading toAbsoluteApiUrl("") would point a deck at the API
  // origin and error.
  if (song && isUnstagedDiscoverSong(song)) {
    await abortCrossfade();
    flushPlayListen(currentListen);
    currentListen = null;
    loadSeq += 1; // supersede any in-flight prepare/prefetch from the prior track
    await AudioEngine.releaseDeck("A");
    await AudioEngine.releaseDeck("B");
    deckSong.A = deckSong.B = null;
    deckKey.A = deckKey.B = null;
    setLastPosition(0, song.id);
    resetAudioProgress(song.duration ?? 0);
    setNowPlayingFor(song);
    // Explicitly mark the lock screen as paused/at-zero — setNowPlaying alone
    // leaves the system playbackState stale (it would keep showing the prior
    // track as "playing" with a frozen 0:00 while we idle waiting for the stager).
    void AudioEngine.updateNowPlaying({ position: 0, rate: 0, playing: false }).catch(() => {});
    return;
  }

  const resolved = song ? resolveOfflinePlaybackSong(song) : null;
  const key = resolved ? trackKey(resolved) : null;

  // Already the active deck's track (crossfade just committed, or a no-op store
  // change) — just reconcile play/pause; never reload.
  if (key && key === deckKey[activeDeck]) {
    await syncPlayState(isPlaying);
    return;
  }

  // Switching tracks by hand cancels any in-flight / prepared crossfade.
  await abortCrossfade();

  const sameLogicalSong = !!song && deckSong[activeDeck]?.id === song.id;
  if (!sameLogicalSong) {
    flushPlayListen(currentListen);
    currentListen = song ? createPlayListen(song) : null;
  }

  const seq = ++loadSeq;
  if (!song || !resolved) {
    await AudioEngine.releaseDeck("A");
    await AudioEngine.releaseDeck("B");
    deckSong.A = deckSong.B = null;
    deckKey.A = deckKey.B = null;
    setLastPosition(0, null);
    resetAudioProgress(0);
    return;
  }

  // Free the idle deck and (re)load onto the active deck.
  const target = activeDeck;
  const idle = other(target);
  await AudioEngine.releaseDeck(idle);
  deckSong[idle] = null;
  deckKey[idle] = null;

  await AudioEngine.setActiveDeck(target);
  // A refreshed signed URL or newly-downloaded file is a source swap for the
  // same logical song. Keep its audible position and listen accounting.
  const startAt = sameLogicalSong ? useAudioProgressStore.getState().position : computeStartAt(song);
  setLastPosition(startAt, song.id);
  if (sameLogicalSong) setAudioProgress(startAt, song.duration ?? useAudioProgressStore.getState().duration);
  else resetAudioProgress(song.duration ?? 0);
  await AudioEngine.prepare({ deck: target, url: toAbsoluteApiUrl(resolved.audioUrl), id: song.id, startAt });
  if (seq !== loadSeq) return;
  deckSong[target] = song;
  deckKey[target] = key;
  await AudioEngine.setVolume(target, currentVolume());
  await AudioEngine.setRate(target, currentRate(song));
  setNowPlayingFor(song);
  // Read isPlaying LIVE (not the captured param). This load is a long async chain,
  // and a pause that lands mid-load must win — otherwise the deck plays while the
  // store shows paused. Cross-device restore hits this: setQueue (→playing) is
  // immediately followed by pause(), and that pause has to stick.
  if (usePlayerStore.getState().isPlaying) await AudioEngine.play(target);
  else await AudioEngine.pause(target);

  void refreshCurrentSong(song);
  void publishPlaybackState(true);
}

async function syncPlayState(isPlaying: boolean): Promise<void> {
  if (isPlaying) {
    await AudioEngine.play(activeDeck);
  } else {
    if (crossfading) await abortCrossfade();
    await AudioEngine.pause(activeDeck);
  }
}

// Cancel an in-flight or prepared crossfade and restore the active deck to full
// volume. The native setVolume cancels the ramp.
async function abortCrossfade(): Promise<void> {
  if (!crossfading && prefetchDeck == null) return;
  const idle = prefetchDeck ?? other(activeDeck);
  if (crossfading) {
    await AudioEngine.setVolume(activeDeck, currentVolume());
  }
  await AudioEngine.releaseDeck(idle);
  deckSong[idle] = null;
  deckKey[idle] = null;
  crossfading = false;
  clearPrefetch();
}

async function applyVolume(): Promise<void> {
  if (crossfading) return; // don't cancel an in-flight ramp
  await AudioEngine.setVolume(activeDeck, currentVolume());
}

async function applyRate(song: PlayerSong | null): Promise<void> {
  await AudioEngine.setRate(activeDeck, currentRate(song));
}

// --- native event handlers --------------------------------------------------
function onTime(e: TimeEvent): void {
  if (e.deck !== activeDeck) return; // only the active deck drives the clock
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  // Store selection changes synchronously, while releasing/preparing the native
  // deck is async. Ignore a tail event from the outgoing deck during that gap so
  // its position/listen/end state cannot be attributed to the newly-selected song.
  if (!song || deckSong[e.deck]?.id !== song.id) return;
  setLastPosition(e.currentTime, song.id);
  setAudioProgress(e.currentTime, e.duration);

  // play-listen tracking → fire play-event at 30s OR ≥50%.
  if (currentListen) {
    if (e.currentTime > currentListen.maxPositionSeconds) currentListen.maxPositionSeconds = e.currentTime;
    if (Number.isFinite(e.duration) && e.duration > 0) currentListen.durationSeconds = e.duration;
    flushPlayListen(currentListen);
  }

  // podcast progress write (~5s).
  if (isPodcastSong(song)) {
    const now = Date.now();
    if (now - lastPodcastWriteMs >= PODCAST_PROGRESS_WRITE_INTERVAL_MS) {
      lastPodcastWriteMs = now;
      writeEpisodeProgressGuarded(song.id, e.currentTime, e.duration);
    }
  }

  enforceSleepTimer();

  // lock-screen scrubber (throttled; iOS extrapolates between updates via rate).
  const now = Date.now();
  if (now - lastNowPlayingMs >= NOW_PLAYING_THROTTLE_MS) {
    lastNowPlayingMs = now;
    void AudioEngine.updateNowPlaying({
      position: e.currentTime,
      rate: currentRate(song),
      playing: s.isPlaying,
    }).catch(() => {});
  }

  // cross-device resume publish (self-throttled to ~8s).
  if (s.isPlaying) void publishPlaybackState(false);

  maybeCrossfade(e, s, song);
}

function maybeCrossfade(e: TimeEvent, s: StoreState, song: PlayerSong): void {
  if (crossfading) return;
  if (!s.crossfadeEnabled || s.crossfadeSeconds <= 0) return;
  if (s.repeatMode === "one") return; // replay handled on `ended`
  if (s.sleepAtEndOfTrack) return; // stop at end, don't bleed into the next track
  if (!crossfadeEligible(song)) return;
  if (!Number.isFinite(e.duration) || e.duration <= 0) return;

  const remaining = e.duration - e.currentTime;
  if (remaining <= 0) return;
  const fade = Math.min(s.crossfadeSeconds, Math.max(0.1, e.duration - 0.1));

  const next = computeNext(s);
  // next is podcast/radio/none, or an unstaged Discover placeholder → hard-cut on
  // ended (the stager replaces a placeholder with a real source before then for a
  // linear prefetch; a still-unstaged one just falls back to the ended path).
  if (!next || !crossfadeEligible(next.song) || isUnstagedDiscoverSong(next.song)) return;

  // 1) Prefetch the upcoming track onto the idle deck ~8s before the fade window.
  if (prefetchIndex !== next.index && remaining <= fade + PREFETCH_LEAD_S) {
    void prefetchNext(next);
    return;
  }
  // 2) Arm the crossfade once the fade window opens.
  if (prefetchDeck != null && prefetchIndex === next.index && remaining <= fade + 0.05) {
    void startCrossfade(fade);
  }
}

async function prefetchNext(next: NextTrack): Promise<void> {
  const idle = other(activeDeck);
  const seq = loadSeq;
  const resolved = resolveOfflinePlaybackSong(next.song);
  if (!getIsOnline() && resolved.source !== "offline") return;
  prefetchDeck = idle;
  prefetchIndex = next.index;
  prefetchFromFuture = next.fromFuture;
  try {
    await AudioEngine.prepare({
      deck: idle,
      url: toAbsoluteApiUrl(resolved.audioUrl),
      id: next.song.id,
      startAt: 0,
    });
  } catch {
    if (seq === loadSeq && prefetchDeck === idle && prefetchIndex === next.index) {
      deckSong[idle] = null;
      deckKey[idle] = null;
      clearPrefetch();
    }
    return;
  }
  if (seq !== loadSeq) return; // a hard load superseded the prefetch
  deckSong[idle] = next.song;
  deckKey[idle] = trackKey(resolved);
  await AudioEngine.setVolume(idle, 0); // silent until the ramp lifts it
}

async function startCrossfade(fade: number): Promise<void> {
  if (crossfading || prefetchDeck == null) return;
  if (deckSong[prefetchDeck] == null) return; // prefetch not ready yet
  const from = activeDeck;
  const to = prefetchDeck;
  crossfading = true;
  try {
    await AudioEngine.crossfade(from, to, Math.max(1, Math.round(fade * 1000)), currentVolume());
  } catch {
    // A rejected native ramp must not strand the state machine in "crossfading".
    crossfading = false;
    await abortCrossfade().catch(() => {});
  }
}

function onCrossfadeComplete(e: CrossfadeCompleteEvent): void {
  const from = e.from;
  const to = e.to;
  // Native already swapped its activeDeck to `to` and zeroed/paused `from`.
  activeDeck = to;
  flushPlayListen(currentListen);
  const newSong = deckSong[to];
  currentListen = newSong ? createPlayListen(newSong) : null;

  // Commit the queue advance to the EXACT track we faded into — without a reload
  // (it's already playing on the now-active deck). advanceToIndex mirrors next()'s
  // shuffle bookkeeping; preservePlayState avoids forcing play on a paused fade.
  if (prefetchIndex != null) {
    usePlayerStore.getState().advanceToIndex(prefetchIndex, {
      fromFuture: prefetchFromFuture,
      preservePlayState: true,
    });
  }

  if (newSong) {
    setNowPlayingFor(newSong);
    setLastPosition(0, newSong.id);
    resetAudioProgress(newSong.duration ?? 0);
  }

  // Recycle the outgoing deck for the next prefetch.
  void AudioEngine.releaseDeck(from).catch(() => {});
  deckSong[from] = null;
  deckKey[from] = null;

  crossfading = false;
  clearPrefetch();
  lastNowPlayingMs = 0; // force an immediate lock-screen refresh for the new track

  if (newSong) {
    void publishPlaybackState(true);
    void refreshCurrentSong(newSong);
  }
}

async function onEnded(e: EndedEvent): Promise<void> {
  if (e.deck !== activeDeck) return; // outgoing deck after a fade — ignore
  if (crossfading) return; // crossfadeComplete drives this transition
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song || deckSong[e.deck]?.id !== song.id) return;
  if (song && isPodcastSong(song)) markEpisodeFinished(song.id);

  // "Sleep at end of track" is an explicit stop request and must win over repeat
  // one/all. Checking repeat first made this timer silently ineffective.
  if (s.sleepAtEndOfTrack) {
    s.pause();
    s.cancelSleepTimer();
    return;
  }
  if (s.repeatMode === "one" || (s.repeatMode === "all" && s.queue.length === 1)) {
    // With a one-item queue, store.next() cannot create a current-song change for
    // the subscription to observe. Replay directly so repeat-all does not stop on
    // (or remain parked at the end of) its only track.
    flushPlayListen(currentListen);
    currentListen = song ? createPlayListen(song) : null;
    await AudioEngine.seek(activeDeck, 0);
    await AudioEngine.play(activeDeck);
    return;
  }
  flushPlayListen(currentListen);
  // Once offline playback is detected, keep auto-advance on the downloaded subset
  // so transitions don't flash through tracks we can't stream. If the downloads
  // are exhausted, stop cleanly rather than churning.
  if (offlinePlayback) {
    if (skipToDownloaded()) return;
    // Repeat-all over an effectively one-item offline subset should replay that
    // local item even when the canonical queue still contains remote-only rows.
    if (s.repeatMode === "all" && song && resolveOfflinePlaybackSong(song).source === "offline") {
      currentListen = createPlayListen(song);
      setLastPosition(0, song.id);
      await AudioEngine.seek(activeDeck, 0);
      await AudioEngine.play(activeDeck);
    } else {
      s.pause();
    }
    return;
  }
  s.next(); // store advances → subscription hard-loads the next track
}

async function onError(e: ErrorEvent): Promise<void> {
  // Prefetched (idle) deck failed: abandon the prefetch; the transition will
  // hard-cut on `ended` and retry/skip through the active-deck path.
  if (e.deck !== activeDeck) {
    if (prefetchDeck === e.deck) {
      await AudioEngine.releaseDeck(e.deck);
      deckSong[e.deck] = null;
      deckKey[e.deck] = null;
      clearPrefetch();
    }
    return;
  }

  clearStallWatchdog(); // a hard error supersedes the stall watchdog's own recovery
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song || deckSong[e.deck]?.id !== song.id) return;
  if (isOwnHandledSong(song)) return; // radio/offline/local manage their own URLs

  const baseUrl = toAbsoluteApiUrl(song.audioUrl);
  const isHls = /\.m3u8(\?|$)/i.test(baseUrl);

  // A transport error is not a bad media URL. Retrying the same remote source
  // first adds a long silent pause in a tunnel; move straight to the queue cache.
  if (!getIsOnline() || isLikelyNetworkPlaybackError(e.message)) {
    offlinePlayback = true;
    markOffline();
    if (startPreferredLocalSwitch()) return;
    if (!skipToDownloaded()) s.pause();
    return;
  }

  // Retry the same track ONCE with a cache-busted URL.
  if (!isHls && erroredKeyRetry !== baseUrl) {
    erroredKeyRetry = baseUrl;
    const busted = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}__retry=${Date.now()}`;
    const seq = ++loadSeq;
    // Retry in place. Resetting to 0 sounds like a phantom skip even though the
    // store never advanced.
    const retryAt = useAudioProgressStore.getState().position;
    await AudioEngine.prepare({ deck: activeDeck, url: busted, id: song.id, startAt: retryAt });
    if (seq !== loadSeq) return;
    deckSong[activeDeck] = song;
    deckKey[activeDeck] = `${song.id}|${busted}`;
    if (s.isPlaying) await AudioEngine.play(activeDeck);
    return;
  }

  consecutiveErrors += 1;
  if (consecutiveErrors >= MAX_CONSECUTIVE_AUDIO_ERRORS) {
    consecutiveErrors = 0;
    erroredKeyRetry = null;
    s.pause(); // stop — don't loop a dead queue forever
    return;
  }
  erroredKeyRetry = null;
  // A single failure is usually one bad/transient track — just try the next one.
  // Two+ in a row means we're effectively offline: stop churning through random
  // (under shuffle) un-streamable tracks and jump straight to a downloaded song.
  // If nothing is downloaded, fall through to a normal skip (the circuit-breaker
  // above then ends it at a clean pause instead of looping).
  if (consecutiveErrors >= 2) {
    offlinePlayback = true;
    markOffline();
    if (skipToDownloaded()) return;
  }
  s.next(); // skip
}

function onPlaying(e: PlayingEvent): void {
  if (e.deck === activeDeck) {
    const song = usePlayerStore.getState().currentSong;
    if (!song || deckSong[e.deck]?.id !== song.id) return;
    clearStallWatchdog(); // audio is flowing — this deck isn't stalled
    consecutiveErrors = 0;
    erroredKeyRetry = null;
    // A non-downloaded track actually playing means streaming works again →
    // resume normal full-queue auto-advance.
    if (song && getIsOnline() && !useOfflineStore.getState().isDownloaded(song.id)) offlinePlayback = false;
  }
}

function onSeeked(e: SeekedEvent): void {
  if (e.deck === activeDeck) {
    const song = usePlayerStore.getState().currentSong;
    if (!song || deckSong[e.deck]?.id !== song.id) return;
    setLastPosition(e.currentTime, song.id);
    setAudioProgress(e.currentTime, useAudioProgressStore.getState().duration);
  }
}

function onRemote(e: RemoteEvent): void {
  const s = usePlayerStore.getState();
  switch (e.action) {
    case "play":
      s.play();
      break;
    case "pause":
      s.pause();
      break;
    case "toggle":
      s.toggle();
      break;
    case "next":
      s.next();
      break;
    case "prev":
      s.previous();
      break;
    case "seek":
      if (typeof e.value === "number") void seekNative(e.value);
      break;
  }
}

// --- store subscription -----------------------------------------------------
function subscribeToStore(): void {
  let prev = usePlayerStore.getState();
  usePlayerStore.subscribe((state) => {
    const songChanged =
      state.currentSong?.id !== prev.currentSong?.id ||
      state.currentSong?.audioUrl !== prev.currentSong?.audioUrl;
    if (songChanged) {
      void hardLoad(state.currentSong, state.isPlaying).catch(() => {});
    } else if (state.isPlaying !== prev.isPlaying) {
      if (!state.isPlaying) clearStallWatchdog(); // user paused → a buffer isn't a stall
      if (state.isPlaying && state.currentSong) {
        // Re-resolve on resume: the download may have completed while paused.
        // hardLoad degenerates to a cheap play() when the source key is unchanged.
        void hardLoad(state.currentSong, true).catch(() => {});
      } else {
        void syncPlayState(false).catch(() => {});
      }
      void publishPlaybackState(true);
    }
    if (state.volume !== prev.volume || state.isMuted !== prev.isMuted) void applyVolume().catch(() => {});
    if (state.playbackRate !== prev.playbackRate) void applyRate(state.currentSong).catch(() => {});
    // A brand-new queue (user started a different list) re-evaluates offline
    // inference from scratch, and is persisted IMMEDIATELY rather than only at the
    // end of the async track load (hardLoad) — otherwise starting a queue from a
    // collection's Play button and quitting right away loses it. Ordinary user
    // edits are also persisted immediately. Background catalog hydration is the
    // exception: appendToQueue marks those mutations with queueAppendToken and the
    // playlist loader publishes one trailing snapshot after the page loop. Without
    // that distinction a 10k-track playlist serialized and uploaded its entire
    // growing queue after every page (quadratic work and visible jank).
    if (state.queue !== prev.queue) {
      const startedNewQueue = state.queueToken !== prev.queueToken;
      if (startedNewQueue) {
        clearStallWatchdog();
        offlinePlayback = !getIsOnline();
      }
      if (shouldPublishQueueMutation(prev, state)) {
        void publishPlaybackState(true);
      }
    }
    prev = state;
  });
}

// UI seek (Scrubber) — routes to the active deck.
export async function seekNative(seconds: number): Promise<void> {
  const position = Math.max(0, seconds);
  setLastPosition(position, usePlayerStore.getState().currentSong?.id ?? null);
  setAudioProgress(position, useAudioProgressStore.getState().duration);
  await AudioEngine.seek(activeDeck, position);
}

export async function initNativeAudio(): Promise<void> {
  if (started) return;
  if (!initPromise) {
    initPromise = (async () => {
      // Do not flip `started` until failure-prone setup is complete. A transient
      // native configure rejection must be retryable, and concurrent callers
      // share this promise so listeners can never be registered twice.
      await AudioEngine.configure(); // idempotent (OnCreate also runs it)
      await applyVolume();

      AudioEngine.addListener("time", onTime);
      AudioEngine.addListener("ended", (e) => void onEnded(e).catch(() => {}));
      AudioEngine.addListener("error", (e) => void onError(e).catch(() => {}));
      AudioEngine.addListener("playing", onPlaying);
      AudioEngine.addListener("waiting", onWaiting);
      AudioEngine.addListener("seeked", onSeeked);
      AudioEngine.addListener("crossfadeComplete", onCrossfadeComplete);
      AudioEngine.addListener("remote", onRemote);

      subscribeOnline((online) => {
        offlinePlayback = !online;
        if (!online) {
          // A local source swap cancels any prepared fade inside hardLoad. If the
          // current song has no local copy, keep its buffered active deck and drop
          // only the remote idle transition.
          if (!startPreferredLocalSwitch()) void abortCrossfade().catch(() => {});
        }
      });

      subscribeToStore();
      started = true;

      // If a song was already current (e.g. restored before init), load it. The
      // native error event owns media failure recovery after listeners are live.
      const { currentSong, isPlaying } = usePlayerStore.getState();
      if (currentSong) await hardLoad(currentSong, isPlaying).catch(() => {});
    })();
  }
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}
