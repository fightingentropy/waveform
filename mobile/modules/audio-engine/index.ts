import { requireNativeModule, EventEmitter, type EventSubscription } from "expo-modules-core";

// JS bridge for the native AudioEngine Expo module. Mirrors the 14 native
// AsyncFunctions and the 9 native events 1:1. The JS player (PlayerBar) owns all
// orchestration (queue, scrobble, crossfade timing); this module owns audio
// output so playback survives a locked screen. See docs/native-audio-engine.md
// and docs/port-notes/native-swift-engine.md.

// ---------------------------------------------------------------------------
// Native module handle
// ---------------------------------------------------------------------------

// Lazy native handle: resolving the native module is deferred until first use so
// that *importing* this file is side-effect-free. That lets the audio dispatcher
// statically import the iOS engine on any platform without `requireNativeModule`
// throwing where the module isn't present (e.g. Android) — it only fires when a
// method is actually called, which only happens on iOS.
let _module: any = null;
function nativeModule(): any {
  if (!_module) _module = requireNativeModule("AudioEngine");
  return _module;
}

let _emitter: any = null;
function emitter(): any {
  // Typed `any` for SDK-version tolerance — the typed addListener wrapper below is
  // the real type surface.
  if (!_emitter) _emitter = new EventEmitter(nativeModule() as any);
  return _emitter;
}

// ---------------------------------------------------------------------------
// Deck / method arg types
// ---------------------------------------------------------------------------

/** Deck identifier — only "A" and "B" exist (dual-deck crossfade). */
export type DeckId = "A" | "B";

/** Remote-command / interruption actions forwarded from the OS to JS. */
export type RemoteAction = "play" | "pause" | "toggle" | "next" | "prev" | "seek";

/** Args for `prepare` (≈ JS `load`): loads a URL onto a deck. */
export interface PrepareArgs {
  /** Required. "A" or "B". */
  deck: DeckId;
  /**
   * Required. http(s) URL, a bare absolute path ("/var/.../x.mp3" → local file),
   * or a "file://" URI for offline-cached local files.
   */
  url: string;
  /** Optional app-level track id (stored as `deck.songId`). */
  id?: string;
  /** Optional seconds to seek to once ready (podcast resume). Default 0. */
  startAt?: number;
}

/** Args for `setNowPlaying`: builds the full lock-screen Now Playing dict. */
export interface NowPlayingArgs {
  /** Default "". */
  title?: string;
  /** Default "". */
  artist?: string;
  /** Default "". */
  album?: string;
  /** Default 0. Only set on the dict when > 0. */
  duration?: number;
  /** Optional https artwork URL (downloaded async via URLSession). */
  artworkUrl?: string;
}

/** Args for `updateNowPlaying`: merges scrubber position/rate + playback state. */
export interface UpdateNowPlayingArgs {
  /** Default 0. */
  position?: number;
  /** Default 1. */
  rate?: number;
  /** Default false. */
  playing?: boolean;
}

// ---------------------------------------------------------------------------
// Event payload types (exact keys must match the native sendEvent payloads)
// ---------------------------------------------------------------------------

/** `time` — periodic clock for the active (or actively-playing) deck, every 0.25s. */
export interface TimeEvent {
  deck: DeckId;
  songId: string;
  currentTime: number;
  duration: number;
}

/** `loaded` — item status reached .readyToPlay. */
export interface LoadedEvent {
  deck: DeckId;
  songId: string;
  duration: number;
}

/** `ended` — AVPlayerItemDidPlayToEndTime (natural end of track). */
export interface EndedEvent {
  deck: DeckId;
  songId: string;
}

/** `seeked` — completion of a JS-requested seek; currentTime is the requested position. */
export interface SeekedEvent {
  deck: DeckId;
  songId: string;
  currentTime: number;
}

/** `error` — item status reached .failed; message is verbose (domain/code/underlying). */
export interface ErrorEvent {
  deck: DeckId;
  songId: string;
  message: string;
}

/** `crossfadeComplete` — ramp reached progress >= 1; activeDeck already swapped to `to`. */
export interface CrossfadeCompleteEvent {
  from: DeckId;
  to: DeckId;
  fromSongId: string;
  toSongId: string;
}

/** `playing` — timeControlStatus became .playing (audio actually flowing). */
export interface PlayingEvent {
  deck: DeckId;
  songId: string;
}

/** `waiting` — timeControlStatus became .waitingToPlayAtSpecifiedRate (buffering/stall). */
export interface WaitingEvent {
  deck: DeckId;
  songId: string;
}

/**
 * `remote` — lock-screen / Control-Center / headphone commands + audio-session
 * interruptions. `value` (seconds) is only present when `action === "seek"`.
 */
export interface RemoteEvent {
  action: RemoteAction;
  value?: number;
}

/** Map of event name → payload type, for typed `addListener`. */
export interface AudioEngineEventMap {
  time: TimeEvent;
  loaded: LoadedEvent;
  ended: EndedEvent;
  seeked: SeekedEvent;
  error: ErrorEvent;
  crossfadeComplete: CrossfadeCompleteEvent;
  playing: PlayingEvent;
  waiting: WaitingEvent;
  remote: RemoteEvent;
}

export type AudioEngineEventName = keyof AudioEngineEventMap;

// ---------------------------------------------------------------------------
// Method wrappers (14) — one per native AsyncFunction
// ---------------------------------------------------------------------------

/**
 * Idempotent one-time setup: builds decks A & B, per-deck observers,
 * AVAudioSession (.playback/.default), remote commands, interruption observer.
 * Also runs automatically in the module's OnCreate, before the first prepare.
 */
export function configure(): Promise<void> {
  return nativeModule().configure();
}

/** Legacy M1a path: just put the shared AVAudioSession into .playback + active. */
export function activateSession(): Promise<void> {
  return nativeModule().activateSession();
}

/** Load a track onto a deck (the prefetch primitive). Does not auto-start unless already wantsPlaying. */
export function prepare(args: PrepareArgs): Promise<void> {
  return nativeModule().prepare(args.deck, args.url, args.id ?? null, args.startAt ?? 0);
}

/** Set wantsPlaying = true and start playback (rate-aware). */
export function play(deck: DeckId): Promise<void> {
  return nativeModule().play(deck);
}

/** Set wantsPlaying = false, cancel any ramp, pause the player. */
export function pause(deck: DeckId): Promise<void> {
  return nativeModule().pause(deck);
}

/** Full teardown of a deck (pause, clear item + observers). */
export function stop(deck: DeckId): Promise<void> {
  return nativeModule().stop(deck);
}

/** Exact seek (position clamped >= 0); emits `seeked` on completion. */
export function seek(deck: DeckId, position: number = 0): Promise<void> {
  return nativeModule().seek(deck, position);
}

/** Set deck + player volume (clamped 0…1). Cancels any in-flight crossfade. */
export function setVolume(deck: DeckId, volume: number = 1.0): Promise<void> {
  return nativeModule().setVolume(deck, volume);
}

/** Set desired playback rate; applies live if not paused. Default 1.0. */
export function setRate(deck: DeckId, rate: number = 1.0): Promise<void> {
  return nativeModule().setRate(deck, rate);
}

/**
 * Equal-power native ramp from one deck to another on a background-safe timer.
 * durationMs clamped >= 1 (default 4000); peak clamped >= 0 (default 1.0).
 * Swaps activeDeck and emits `crossfadeComplete` on completion.
 */
export function crossfade(
  from: DeckId,
  to: DeckId,
  durationMs: number = 4000,
  peak: number = 1.0,
): Promise<void> {
  return nativeModule().crossfade(from, to, durationMs, peak);
}

/** Force the active deck (non-crossfade hard cuts) so the UI clock follows it. */
export function setActiveDeck(deck: DeckId): Promise<void> {
  return nativeModule().setActiveDeck(deck);
}

/** Set the full lock-screen Now Playing dict + kick off async artwork download. */
export function setNowPlaying(args: NowPlayingArgs): Promise<void> {
  return nativeModule().setNowPlaying(
    args.title ?? "",
    args.artist ?? "",
    args.album ?? "",
    args.duration ?? 0,
    args.artworkUrl ?? null,
  );
}

/** Merge scrubber position/rate into the Now Playing dict + set playbackState. */
export function updateNowPlaying(args: UpdateNowPlayingArgs): Promise<void> {
  return nativeModule().updateNowPlaying(
    args.position ?? 0,
    args.rate ?? 1,
    args.playing ?? false,
  );
}

/** Same teardown as `stop` but never rejects — safe cleanup of a deck. */
export function releaseDeck(deck: DeckId): Promise<void> {
  return nativeModule().releaseDeck(deck);
}

// ---------------------------------------------------------------------------
// Event subscription (9 events) — typed addListener
// ---------------------------------------------------------------------------

/**
 * Subscribe to a native AudioEngine event. Returns an EventSubscription;
 * call `.remove()` to unsubscribe.
 */
export function addListener<E extends AudioEngineEventName>(
  event: E,
  listener: (payload: AudioEngineEventMap[E]) => void,
): EventSubscription {
  return emitter().addListener(event as any, listener as any);
}

/** Remove all listeners for a given event name. */
export function removeAllListeners(event: AudioEngineEventName): void {
  emitter().removeAllListeners(event as any);
}

// ---------------------------------------------------------------------------
// Default export — the full typed API surface
// ---------------------------------------------------------------------------

export default {
  configure,
  activateSession,
  prepare,
  play,
  pause,
  stop,
  seek,
  setVolume,
  setRate,
  crossfade,
  setActiveDeck,
  setNowPlaying,
  updateNowPlaying,
  releaseDeck,
  addListener,
  removeAllListeners,
};
