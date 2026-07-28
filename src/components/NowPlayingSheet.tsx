"use client";

import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { parseCredits, useLyrics } from "@/lib/credits";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Heart,
  ListMusic,
  MicVocal,
  Moon,
  Pause,
  Play,
  Podcast,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useNavigate } from "react-router";
import { formatPlaybackRate, nextPlaybackRate, sleepTimerRemainingMinutes, usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn, formatTime } from "@/lib/utils";
import { CoverImage } from "@/components/CoverImage";
import { LyricsPanel } from "@/components/LyricsPanel";
import { MarqueeText } from "@/components/MarqueeText";
import { useModalDialogFocus } from "@/lib/use-modal-dialog";

const SLEEP_TIMER_MINUTE_OPTIONS = [5, 15, 30, 45, 60];
// Horizontal artwork-swipe distance (px) that commits to a track change.
const COVER_SWIPE_COMMIT_PX = 64;

type NowPlayingSheetProps = {
  open: boolean;
  // Suspends the Escape-to-close handler while a sheet stacked on top (the
  // queue sheet) is open, so one press closes only the topmost sheet.
  escapeDisabled?: boolean;
  onClose: () => void;
  onOpenQueue: () => void;
  song: PlayerSong;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onSeek: (value: number) => void;
};

export default function NowPlayingSheet({
  open,
  escapeDisabled = false,
  onClose,
  onOpenQueue,
  song,
  isPlaying,
  currentTime,
  duration,
  onSeek,
}: NowPlayingSheetProps) {
  const navigate = useNavigate();
  const play = usePlayerStore((s) => s.play);
  const pause = usePlayerStore((s) => s.pause);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtEndOfTrack = usePlayerStore((s) => s.sleepAtEndOfTrack);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const startSleepTimer = usePlayerStore((s) => s.startSleepTimer);
  const setSleepAtEndOfTrack = usePlayerStore((s) => s.setSleepAtEndOfTrack);
  const cancelSleepTimer = usePlayerStore((s) => s.cancelSleepTimer);

  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const likesHydrated = useLikesStore((state) => state.hydrated);

  const liveStream = isRadioSong(song);
  const podcastEpisode = isPodcastSong(song);
  const showLibraryActions = !liveStream && !podcastEpisode;
  const songIsLiked = !!likedLookup[song.id];
  const likePending = !!pendingLookup[song.id];
  const podcastDescription = song.description?.trim() ?? "";

  const [showLyrics, setShowLyrics] = useState(false);
  const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
  // UI nicety only (refreshes the remaining-minutes label); expiry enforcement
  // lives in PlayerBar's timeupdate handler and 8s sync interval.
  const [, setSleepTimerTick] = useState(0);
  const sleepTimerActive = sleepTimerEndsAt != null || sleepAtEndOfTrack;
  const sleepTimerRemaining = sleepTimerEndsAt != null ? sleepTimerRemainingMinutes(sleepTimerEndsAt) : null;
  const sleepTimerTitle =
    sleepTimerRemaining != null
      ? `Sleep timer: ${sleepTimerRemaining} min left`
      : sleepAtEndOfTrack
        ? "Sleep timer: end of track"
        : "Sleep timer";
  const touchStartYRef = useRef<number | null>(null);
  const swipeDismissAllowedRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // Trap focus inside the sheet while it's the topmost surface; defer to the
  // queue sheet (escapeDisabled) when it's stacked on top.
  useModalDialogFocus(open, panelRef, { enabled: !escapeDisabled });
  // Horizontal swipe on the artwork to skip tracks (mobile). The axis is locked
  // on the first move so it never fights the vertical swipe-to-dismiss or scroll.
  const coverSwipeRef = useRef<{ startX: number; startY: number; axis: "x" | "y" | null; dx: number } | null>(null);
  const [coverDragX, setCoverDragX] = useState(0);
  const [coverSwiping, setCoverSwiping] = useState(false);

  const lyricsSong = song;

  const credits = useMemo(() => parseCredits(song.artist), [song.artist]);
  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  // Prefetch whenever the sheet is open so toggling the lyrics view is
  // instant; the files are tiny and HTTP/offline-cached.
  const lyricsAvailable = !!lyricsSong.lyricsUrl;
  const lyricsState = useLyrics(lyricsSong.id, lyricsSong.lyricsUrl, open && lyricsAvailable);
  const lyricsViewOpen = showLyrics && lyricsAvailable;

  useEffect(() => {
    if (!open || escapeDisabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (sleepMenuOpen) {
          setSleepMenuOpen(false);
          return;
        }
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [escapeDisabled, onClose, open, sleepMenuOpen]);

  useEffect(() => {
    if (!open || sleepTimerEndsAt == null) return;
    const intervalId = window.setInterval(() => setSleepTimerTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(intervalId);
  }, [open, sleepTimerEndsAt]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("wf-now-playing-open");
    return () => {
      // The queue sheet may still be open on top; keep the body scroll lock
      // until every sheet has closed.
      if (document.querySelector('.wf-now-playing-panel[data-open="true"]')) return;
      document.body.classList.remove("wf-now-playing-open");
    };
  }, [open]);

  async function handleToggleLike() {
    if (!showLibraryActions || !likesHydrated || likePending) return;
    const result = await toggleLike(song.id, !songIsLiked, song);
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }

  function handleTogglePlayback() {
    if (isPlaying) {
      pause();
      return;
    }
    requestImmediatePlayback(song);
    play();
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
    // Only allow swipe-to-dismiss when the scroll container is already at the
    // top (so a downward drag isn't actually scrolling content) and the touch
    // didn't start on the seek/range input (so dragging the scrubber down can't
    // close the sheet).
    const target = event.target;
    const startedOnRange =
      target instanceof HTMLInputElement && target.type.toLowerCase() === "range";
    const atTop = (scrollContainerRef.current?.scrollTop ?? 0) <= 0;
    swipeDismissAllowedRef.current = atTop && !startedOnRange;
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    const startY = touchStartYRef.current;
    const endY = event.changedTouches[0]?.clientY;
    const dismissAllowed = swipeDismissAllowedRef.current;
    touchStartYRef.current = null;
    swipeDismissAllowedRef.current = false;
    if (!dismissAllowed || startY == null || endY == null) return;
    if (endY - startY > 80) {
      onClose();
    }
  }

  function handleCoverTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0];
    if (!touch) return;
    coverSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, axis: null, dx: 0 };
    setCoverSwiping(true);
  }

  function handleCoverTouchMove(event: TouchEvent<HTMLDivElement>) {
    const swipe = coverSwipeRef.current;
    const touch = event.touches[0];
    if (!swipe || !touch) return;
    const dx = touch.clientX - swipe.startX;
    const dy = touch.clientY - swipe.startY;
    if (swipe.axis === null) {
      // Wait until there's enough movement to tell intent apart, then lock.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (swipe.axis !== "x") return;
    // Horizontal: take over. Cancel the sheet's vertical swipe-to-dismiss and
    // follow the finger so the artwork tracks the gesture.
    swipeDismissAllowedRef.current = false;
    swipe.dx = dx;
    setCoverDragX(dx);
  }

  function handleCoverTouchEnd() {
    const swipe = coverSwipeRef.current;
    coverSwipeRef.current = null;
    setCoverSwiping(false);
    setCoverDragX(0);
    if (!swipe || swipe.axis !== "x") return;
    if (swipe.dx <= -COVER_SWIPE_COMMIT_PX) {
      next();
    } else if (swipe.dx >= COVER_SWIPE_COMMIT_PX) {
      previous();
    }
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 transition",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        className={cn(
          "wf-sheet-backdrop absolute inset-0 bg-black/60 transition-opacity lg:block",
          open ? "opacity-100" : "opacity-0",
          "hidden lg:block",
        )}
        onClick={onClose}
        aria-label="Close now playing view"
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Now playing: ${song.title}`}
        tabIndex={-1}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={cn(
          "wf-now-playing-panel absolute overflow-hidden bg-background",
          "inset-0 lg:inset-auto lg:left-0 lg:right-0 lg:top-14 lg:bottom-[84px] lg:mx-auto lg:max-w-3xl lg:border lg:border-black/10 lg:dark:border-white/10 lg:bg-background/95 lg:backdrop-blur-lg lg:rounded-t-2xl",
          open
            ? "translate-y-0 opacity-100"
            : "translate-y-full opacity-0 lg:translate-y-8 lg:opacity-0",
        )}
        data-open={open ? "true" : "false"}
      >
        <div
          ref={scrollContainerRef}
          className="h-full overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:pt-0 lg:pb-0"
        >
          <div className="p-4 sm:p-6 min-h-full flex flex-col">
            <div className="flex items-center justify-between mb-4 lg:mb-4">
              <button
                type="button"
                onClick={onClose}
                className="wf-control-button h-11 w-11 -ml-1 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation"
                aria-label="Collapse now playing"
              >
                <ChevronDown size={24} />
              </button>
              <div className="-mr-1 flex items-center gap-1">
                {showLibraryActions ? (
                  <>
                    <button
                      type="button"
                      aria-label={songIsLiked ? "In liked songs" : "Save to liked songs"}
                      onClick={handleToggleLike}
                      disabled={!likesHydrated || likePending}
                      className={cn(
                        "h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                        "wf-control-button",
                        likePending ? "opacity-60" : "active:bg-black/10 dark:active:bg-white/10",
                        songIsLiked ? "text-emerald-500" : "text-foreground/70",
                      )}
                    >
                      <Heart size={22} className={cn(songIsLiked && "fill-emerald-500 text-emerald-500")} />
                    </button>
                  </>
                ) : null}
                {lyricsAvailable ? (
                  <button
                    type="button"
                    aria-label={lyricsViewOpen ? "Hide lyrics" : "Show lyrics"}
                    title={lyricsViewOpen ? "Hide lyrics" : "Show lyrics"}
                    aria-pressed={lyricsViewOpen}
                    onClick={() => setShowLyrics((value) => !value)}
                    className={cn(
                      "wf-control-button h-11 w-11 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation",
                      lyricsViewOpen ? "text-emerald-500" : "text-foreground/70",
                    )}
                  >
                    <MicVocal size={22} />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={sleepTimerTitle}
                  aria-expanded={sleepMenuOpen}
                  title={sleepTimerTitle}
                  onClick={() => setSleepMenuOpen((value) => !value)}
                  className={cn(
                    "wf-control-button relative h-11 w-11 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation",
                    sleepTimerActive ? "text-[#1ed760]" : "text-foreground/70",
                  )}
                >
                  <Moon size={20} />
                  <span
                    className={cn(
                      "absolute bottom-1.5 h-1 w-1 rounded-full bg-[#1ed760] transition-opacity",
                      sleepTimerActive ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
                <button
                  type="button"
                  aria-label="Open queue"
                  title="Open queue"
                  onClick={onOpenQueue}
                  className="wf-control-button h-11 w-11 rounded-full grid place-items-center text-foreground/70 active:bg-black/10 dark:active:bg-white/10 touch-manipulation"
                >
                  <ListMusic size={22} />
                </button>
              </div>
            </div>

            <div className="flex-1 flex flex-col justify-center gap-6 lg:gap-5 max-w-md mx-auto w-full">
              <div className="-mb-2 text-center text-xs uppercase tracking-wide opacity-70">Now Playing</div>
              {lyricsViewOpen ? (
                // Same square footprint as the art so toggling never reflows
                // the title/progress/controls below.
                <LyricsPanel
                  lyricsState={lyricsState}
                  currentTime={currentTime}
                  onSeek={liveStream ? undefined : onSeek}
                  className="mx-auto aspect-square w-full shadow-2xl shadow-black/30"
                />
              ) : (
                <div
                  className="mx-auto w-full"
                  onTouchStart={handleCoverTouchStart}
                  onTouchMove={handleCoverTouchMove}
                  onTouchEnd={handleCoverTouchEnd}
                  onTouchCancel={handleCoverTouchEnd}
                  style={{
                    transform: coverDragX ? `translateX(${coverDragX}px)` : undefined,
                    transition: coverSwiping ? "none" : "transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)",
                    touchAction: "pan-y",
                  }}
                >
                  <div className="wf-now-playing-art w-full shadow-2xl shadow-black/30 rounded-2xl overflow-hidden">
                    <CoverImage
                      src={song.imageUrl || "/apple-icon.png"}
                      networkSrc={song.networkImageUrl}
                      alt={song.title}
                      width={1200}
                      height={1200}
                      loading="eager"
                      className="w-full aspect-square object-cover"
                      sizes="(max-width: 768px) 100vw, 448px"
                    />
                  </div>
                </div>
              )}

              <div className="text-center lg:text-left">
                <MarqueeText text={song.title} className="text-2xl sm:text-3xl font-bold leading-tight" />
                <MarqueeText text={song.artist} className="text-lg opacity-80 mt-1" />
              </div>

              {liveStream ? (
                <div className="space-y-2">
                  <div className="h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div className={cn("h-full w-full bg-emerald-500", isPlaying && "animate-pulse")} />
                  </div>
                  <div className="flex justify-between text-xs font-semibold text-emerald-400">
                    <span>LIVE</span>
                    <span>Radio</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, duration)}
                    step={0.1}
                    value={currentTime}
                    aria-label="Playback position"
                    onChange={(event) => onSeek(Number(event.target.value))}
                    className="w-full h-1 appearance-none rounded-full bg-black/10 dark:bg-white/10 accent-emerald-500 touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    style={{
                      background: `linear-gradient(to right, rgb(16 185 129) 0%, rgb(16 185 129) ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)`,
                    }}
                  />
                  <div className="flex justify-between text-xs tabular-nums opacity-70">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between px-2">
                <button
                  type="button"
                  aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
                  title={shuffle ? "Disable shuffle" : "Enable shuffle"}
                  onClick={toggleShuffle}
                  className={cn(
                    "wf-control-button relative h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                    shuffle ? "text-emerald-500" : "text-foreground/70",
                  )}
                >
                  <Shuffle size={20} />
                  <span
                    className={cn(
                      "absolute bottom-1.5 h-1 w-1 rounded-full bg-emerald-500 transition-opacity",
                      shuffle ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
                {/* prev / play / next grouped with a real gap so a Next tap that
                    drifts left can't land on the big play/pause button. */}
                <div className="flex items-center gap-7">
                  <button
                    type="button"
                    aria-label="Previous"
                    onClick={previous}
                    className="wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation"
                  >
                    <SkipBack size={24} />
                  </button>
                  <button
                    type="button"
                    aria-label={isPlaying ? "Pause" : "Play"}
                    onClick={handleTogglePlayback}
                    className="wf-control-button h-14 w-14 rounded-full grid place-items-center bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 touch-manipulation"
                  >
                    {isPlaying ? <Pause size={26} /> : <Play size={26} className="translate-x-[2px]" />}
                  </button>
                  <button
                    type="button"
                    aria-label="Next"
                    onClick={next}
                    className="wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation"
                  >
                    <SkipForward size={24} />
                  </button>
                </div>
                <button
                  type="button"
                  aria-label="Repeat"
                  onClick={cycleRepeatMode}
                  className={cn(
                    "wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                    repeatMode !== "off" ? "text-emerald-500" : "text-foreground/70",
                  )}
                >
                  <Repeat size={20} />
                </button>
              </div>

            </div>

            {showLibraryActions ? (
              // Credits card is desktop-only; hide the wrapper on mobile so
              // its margin doesn't add dead space under the controls.
              <div className="hidden lg:block lg:mt-5 space-y-4">
                <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 hidden lg:block">
                  <div className="font-medium mb-3">Credits</div>
                  <div className="space-y-3">
                    {credits.map((credit) => (
                      <div key={`${credit.name}-${credit.role}`} className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{credit.name}</div>
                          <div className="text-sm opacity-70">{credit.role}</div>
                        </div>
                        <CheckCircle2 size={16} className="opacity-50 mt-1" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : podcastEpisode ? (
              <div className="mt-6 rounded-xl border border-black/10 p-4 dark:border-white/10 lg:mt-5">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fuchsia-500/15 text-fuchsia-200">
                    <Podcast size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">Podcast Episode</div>
                    <div className="text-sm opacity-70">{song.artist}</div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Playback speed: ${formatPlaybackRate(playbackRate)}`}
                    title="Playback speed"
                    onClick={() => setPlaybackRate(nextPlaybackRate(playbackRate))}
                    className="wf-control-button h-9 shrink-0 rounded-full border border-black/15 px-3 text-sm font-semibold tabular-nums active:bg-black/5 dark:border-white/20 dark:active:bg-white/5 touch-manipulation"
                  >
                    {formatPlaybackRate(playbackRate)}
                  </button>
                </div>
                {podcastDescription ? (
                  <p className="mt-3 line-clamp-4 text-sm leading-6 opacity-75">{podcastDescription}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Sleep timer bottom sheet (stacks inside this section; the section
            is the containing block, so it hugs the sheet's bottom edge). */}
        <button
          type="button"
          aria-label="Close sleep timer menu"
          onClick={() => setSleepMenuOpen(false)}
          className={cn(
            "absolute inset-0 z-30 cursor-default bg-black/60 transition-opacity",
            sleepMenuOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          tabIndex={sleepMenuOpen ? 0 : -1}
        />
        <div
          role="dialog"
          aria-label="Sleep timer"
          aria-hidden={!sleepMenuOpen}
          className={cn(
            "absolute inset-x-0 bottom-0 z-40 rounded-t-2xl border-t border-black/10 bg-background pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-2xl transition-transform duration-300 dark:border-white/10",
            sleepMenuOpen ? "translate-y-0" : "pointer-events-none translate-y-full",
          )}
        >
          <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-black/20 dark:bg-white/20" />
          <div className="px-6 pb-1 pt-3 text-center">
            <div className="text-sm font-semibold">Sleep timer</div>
            <div className={cn("mt-0.5 text-xs", sleepTimerActive ? "text-[#1ed760]" : "opacity-60")}>
              {sleepTimerRemaining != null
                ? `Music stops in ${sleepTimerRemaining} min`
                : sleepAtEndOfTrack
                  ? "Music stops at the end of this track"
                  : "Stop the music after a while"}
            </div>
          </div>
          <div className="px-3 pt-1">
            {SLEEP_TIMER_MINUTE_OPTIONS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => {
                  startSleepTimer(minutes);
                  setSleepMenuOpen(false);
                }}
                tabIndex={sleepMenuOpen ? 0 : -1}
                className="wf-control-button flex h-12 w-full items-center rounded-lg px-3 text-[15px] active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
              >
                {minutes} minutes
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setSleepAtEndOfTrack();
                setSleepMenuOpen(false);
              }}
              tabIndex={sleepMenuOpen ? 0 : -1}
              className={cn(
                "wf-control-button flex h-12 w-full items-center justify-between rounded-lg px-3 text-[15px] active:bg-black/5 dark:active:bg-white/5 touch-manipulation",
                sleepAtEndOfTrack && "text-[#1ed760]",
              )}
            >
              End of track
              {sleepAtEndOfTrack ? <Check size={18} /> : null}
            </button>
          </div>
          {sleepTimerActive ? (
            <div className="mt-1 border-t border-black/10 px-3 pt-1 dark:border-white/10">
              <button
                type="button"
                onClick={() => {
                  cancelSleepTimer();
                  setSleepMenuOpen(false);
                }}
                tabIndex={sleepMenuOpen ? 0 : -1}
                className="wf-control-button flex h-12 w-full items-center justify-center rounded-lg px-3 text-[15px] font-semibold text-[#1ed760] active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
              >
                Turn off timer
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
