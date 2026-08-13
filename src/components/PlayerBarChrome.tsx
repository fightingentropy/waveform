"use client";

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  formatPlaybackRate,
  nextPlaybackRate,
  SLEEP_TIMER_MINUTE_OPTIONS,
  sleepTimerRemainingMinutes,
  usePlayerStore,
} from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { cn, formatTime } from "@/lib/utils";
import { ChevronDown, ChevronUp, Heart, ListMusic, Moon, Pause, Play, SkipBack, SkipForward, Shuffle, Repeat, Volume2, VolumeX } from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import { MarqueeText } from "@/components/MarqueeText";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { subscribePlaybackPosition } from "@/lib/playback-position";

const NowPlayingSheet = lazy(() => import("@/components/NowPlayingSheet"));
const QueueSheet = lazy(() => import("@/components/QueueSheet"));

export type PlayerBarChromeProps = {
  song: PlayerSong;
  duration: number;
  currentTime: number;
  onSeek: (value: number) => void;
  onTogglePlayback: () => void;
  nowPlayingOpen: boolean;
  nowPlayingMounted: boolean;
  onCloseNowPlaying: () => void;
  onOpenNowPlaying: () => void;
  onToggleNowPlaying: () => void;
  onOpenQueue: () => void;
  queueSheetOpen: boolean;
  queueSheetMounted: boolean;
  onCloseQueue: () => void;
  onToggleQueue: () => void;
};

export function PlayerBarChrome({
  song,
  duration,
  currentTime,
  onSeek,
  onTogglePlayback,
  nowPlayingOpen,
  nowPlayingMounted,
  onCloseNowPlaying,
  onOpenNowPlaying,
  onToggleNowPlaying,
  onOpenQueue,
  queueSheetOpen,
  queueSheetMounted,
  onCloseQueue,
  onToggleQueue,
}: PlayerBarChromeProps): React.ReactElement {
  const navigate = useNavigate();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtEndOfTrack = usePlayerStore((s) => s.sleepAtEndOfTrack);
  const startSleepTimer = usePlayerStore((s) => s.startSleepTimer);
  const setSleepAtEndOfTrack = usePlayerStore((s) => s.setSleepAtEndOfTrack);
  const cancelSleepTimer = usePlayerStore((s) => s.cancelSleepTimer);

  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const likesHydrated = useLikesStore((state) => state.hydrated);

  const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
  const [, setSleepTimerTick] = useState(0);

  useEffect(() => {
    if (sleepTimerEndsAt == null) return;
    const intervalId = window.setInterval(() => setSleepTimerTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(intervalId);
  }, [sleepTimerEndsAt]);

  const songId = song.id;
  const songIsRadio = isRadioSong(song);
  const songIsPodcast = isPodcastSong(song);
  const songIsLiked = !!likedLookup[songId];
  const likePending = !!pendingLookup[songId];
  const hasSeekableDuration = duration > 0 && Number.isFinite(duration) && !songIsRadio;
  const safeCurrentTime = hasSeekableDuration ? Math.min(currentTime, duration) : 0;
  const VolumeIcon = isMuted || volume === 0 ? VolumeX : Volume2;
  const sleepTimerActive = sleepTimerEndsAt != null || sleepAtEndOfTrack;
  const sleepTimerRemaining = sleepTimerEndsAt != null ? sleepTimerRemainingMinutes(sleepTimerEndsAt) : null;
  const sleepTimerTitle =
    sleepTimerRemaining != null
      ? `Sleep timer: ${sleepTimerRemaining} min left`
      : sleepAtEndOfTrack
        ? "Sleep timer: end of track"
        : "Sleep timer";

  const handleToggleLike = useCallback(async () => {
    if (!likesHydrated || likePending || songIsRadio || songIsPodcast) return;
    const result = await toggleLike(songId, !songIsLiked, song);
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }, [likePending, likesHydrated, navigate, song, songId, songIsLiked, songIsPodcast, songIsRadio, toggleLike]);

  return (
    <>
      {nowPlayingMounted ? (
        <Suspense fallback={null}>
          <NowPlayingSheet
            open={nowPlayingOpen}
            escapeDisabled={queueSheetOpen}
            onClose={onCloseNowPlaying}
            onOpenQueue={onOpenQueue}
            song={song}
            isPlaying={isPlaying}
            currentTime={safeCurrentTime}
            duration={hasSeekableDuration ? duration : 0}
            onSeek={onSeek}
          />
        </Suspense>
      ) : null}
      {queueSheetMounted ? (
        <Suspense fallback={null}>
          <QueueSheet open={queueSheetOpen} onClose={onCloseQueue} />
        </Suspense>
      ) : null}
      <div className="fixed inset-x-0 z-40 bottom-[calc(var(--wf-mobile-nav-bottom-offset)+var(--wf-floating-gap))] text-white lg:bottom-0 lg:border-t lg:border-white/[0.08] lg:bg-black">
      {/* Mobile mini player */}
      <div className="relative mx-[var(--wf-floating-inset)] overflow-hidden rounded-[18px] border border-white/[0.13] bg-[rgba(10,12,16,0.84)] shadow-[0_8px_24px_rgba(0,0,0,0.34)] backdrop-blur-2xl lg:hidden">
        <div
          className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-white/[0.12]"
          aria-hidden
        >
          <PlaybackProgressFill
            duration={duration}
            isRadio={songIsRadio}
            className="h-full bg-white/[0.82] transition-[width] duration-150"
          />
        </div>
        <div className="flex h-[var(--wf-mobile-player-height)] items-center gap-3 px-2.5">
          <button
            type="button"
            onClick={onOpenNowPlaying}
            className="wf-pressable flex items-center gap-3 min-w-0 flex-1 text-left touch-manipulation"
            aria-label="Open now playing"
          >
            <CoverImage
              src={song.imageUrl || "/apple-icon.png"}
              networkSrc={song.networkImageUrl}
              alt=""
              width={50}
              height={50}
              loading="eager"
              className="wf-song-cover h-[50px] w-[50px] shrink-0 rounded-[9px] object-cover"
              sizes="50px"
            />
            <div className="min-w-0">
              <MarqueeText text={song.title} className="text-[15px] font-medium leading-5 text-white" />
              <div className="text-[13px] leading-5 text-white/[0.62] truncate">{song.artist}</div>
            </div>
          </button>
          {!songIsRadio && !songIsPodcast ? (
            <button
              type="button"
              aria-label={songIsLiked ? "In liked songs" : "Save to liked songs"}
              onClick={handleToggleLike}
              disabled={!likesHydrated || likePending}
              className={cn(
                "wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation shrink-0",
                likePending ? "opacity-60" : "",
                songIsLiked ? "text-white" : "text-white/[0.68]",
              )}
            >
              <Heart size={22} className={cn(songIsLiked && "fill-white text-white")} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={onTogglePlayback}
            className="wf-control-button grid h-11 w-11 shrink-0 place-items-center rounded-full text-white touch-manipulation"
          >
            {isPlaying ? (
              <Pause size={26} fill="currentColor" />
            ) : (
              <Play size={26} fill="currentColor" className="translate-x-[1px]" />
            )}
          </button>
        </div>
      </div>

      {/* Desktop player */}
      <div className="hidden h-[84px] grid-cols-[minmax(15rem,1fr)_minmax(27rem,44rem)_minmax(15rem,1fr)] items-center gap-4 px-4 py-3 sm:px-6 lg:grid">
        <div className="flex min-w-0 items-center justify-start gap-3 sm:gap-4">
          <CoverImage
            src={song.imageUrl || "/apple-icon.png"}
            networkSrc={song.networkImageUrl}
            alt=""
            width={48}
            height={48}
            loading="eager"
            className="wf-song-cover h-12 w-12 shrink-0 rounded-[5px] object-cover"
            sizes="48px"
          />
          <div className="min-w-0 max-w-[20rem]">
            <div className="truncate text-[15px] font-medium leading-5 text-white">{song.title}</div>
            <div className="truncate text-[13px] leading-5 text-white/[0.62]">{song.artist}</div>
          </div>
          {!songIsRadio && !songIsPodcast ? (
            <button
              type="button"
              aria-label={songIsLiked ? "In liked songs" : "Save to liked songs"}
              title={songIsLiked ? "In liked songs" : "Save to liked songs"}
              onClick={handleToggleLike}
              disabled={!likesHydrated || likePending}
              className={cn(
                "wf-control-button flex-shrink-0 h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                likePending ? "cursor-wait opacity-60" : "hover:bg-white/[0.09] hover:text-white",
                songIsLiked ? "text-white" : "text-white/[0.68]",
              )}
            >
              <Heart size={18} className={cn(songIsLiked && "fill-white text-white")} />
            </button>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col items-center gap-2">
          <div className="flex items-center justify-center gap-4">
            <button
              aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
              title={shuffle ? "Disable shuffle" : "Enable shuffle"}
              onClick={toggleShuffle}
              className={cn(
                "wf-control-button relative p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white",
                shuffle && "text-white",
              )}
            >
              <Shuffle size={18} />
              <span
                className={cn(
                  "absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white transition-opacity",
                  shuffle ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
            <button aria-label="Previous" onClick={previous} className="wf-control-button p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white">
              <SkipBack size={18} />
            </button>
            <button aria-label={isPlaying ? "Pause" : "Play"} onClick={onTogglePlayback} className="wf-control-button h-9 w-9 rounded-full grid place-items-center bg-white text-black transition">
              {isPlaying ? <Pause size={18} /> : <Play size={18} className="translate-x-[1px]" />}
            </button>
            <button aria-label="Next" onClick={next} className="wf-control-button p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white">
              <SkipForward size={18} />
            </button>
            <button aria-label="Repeat" onClick={cycleRepeatMode} className={cn("wf-control-button p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white", repeatMode !== "off" && "text-white")}>
              <Repeat size={18} />
            </button>
          </div>

          {songIsRadio ? (
            <div className="flex w-full items-center gap-3">
              <span className="w-10 text-right text-[12px] font-semibold text-white/[0.82]">LIVE</span>
              <div className="h-1.5 w-full overflow-hidden rounded bg-white/[0.12]">
                <div className={cn("h-full w-full bg-white/75", isPlaying && "animate-pulse")} />
              </div>
              <span className="w-10 text-[12px] text-white/[0.62]">Radio</span>
            </div>
          ) : (
            <PlaybackScrubber duration={duration} onSeek={onSeek} />
          )}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2">
          {songIsPodcast ? (
            <button
              type="button"
              aria-label={`Playback speed: ${formatPlaybackRate(playbackRate)}`}
              title="Playback speed"
              onClick={() => setPlaybackRate(nextPlaybackRate(playbackRate))}
              className="wf-control-button h-9 flex-shrink-0 rounded-full px-2.5 grid place-items-center text-[12px] font-semibold tabular-nums text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              {formatPlaybackRate(playbackRate)}
            </button>
          ) : null}
          <div className="relative flex-shrink-0">
            <button
              type="button"
              aria-label={sleepTimerTitle}
              aria-expanded={sleepMenuOpen}
              title={sleepTimerTitle}
              onClick={() => setSleepMenuOpen((open) => !open)}
              className={cn(
                "wf-control-button h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                sleepMenuOpen && "bg-white/[0.08]",
                sleepTimerActive ? "text-white" : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
              )}
            >
              <Moon size={18} />
            </button>
            {sleepMenuOpen ? (
              <>
                <button
                  type="button"
                  aria-label="Close sleep timer options"
                  className="fixed inset-0 z-40 cursor-default"
                  onClick={() => setSleepMenuOpen(false)}
                />
                <div className="absolute bottom-11 right-0 z-50 w-48 rounded-xl border border-white/15 bg-zinc-950/95 p-1 shadow-2xl">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-white/[0.62]">Sleep timer</span>
                    {sleepTimerRemaining != null ? (
                      <span className="text-[11px] font-semibold tabular-nums text-white">{sleepTimerRemaining} min left</span>
                    ) : null}
                  </div>
                  {SLEEP_TIMER_MINUTE_OPTIONS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => {
                        startSleepTimer(minutes);
                        setSleepMenuOpen(false);
                      }}
                      className="wf-control-button block w-full rounded-lg px-3 py-2 text-left text-[13px] text-white/[0.85] transition hover:bg-white/[0.09] hover:text-white"
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
                    className={cn(
                      "wf-control-button block w-full rounded-lg px-3 py-2 text-left text-[13px] transition hover:bg-white/[0.09]",
                      sleepAtEndOfTrack ? "text-white" : "text-white/[0.85] hover:text-white",
                    )}
                  >
                    End of track
                  </button>
                  {sleepTimerActive ? (
                    <>
                      <div className="mx-3 my-1 border-t border-white/[0.12]" />
                      <button
                        type="button"
                        onClick={() => {
                          cancelSleepTimer();
                          setSleepMenuOpen(false);
                        }}
                        className="wf-control-button block w-full rounded-lg px-3 py-2 text-left text-[13px] text-white/[0.85] transition hover:bg-white/[0.09] hover:text-white"
                      >
                        Turn off
                      </button>
                    </>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={queueSheetOpen ? "Close queue" : "Open queue"}
            title={queueSheetOpen ? "Close queue" : "Open queue"}
            onClick={onToggleQueue}
            className={cn(
              "wf-control-button flex-shrink-0 h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              queueSheetOpen
                ? "bg-white/[0.08] text-white"
                : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
            )}
          >
            <ListMusic size={18} />
          </button>
          <button
            type="button"
            aria-label={nowPlayingOpen ? "Collapse now playing" : "Open now playing"}
            title={nowPlayingOpen ? "Collapse now playing" : "Open now playing"}
            onClick={onToggleNowPlaying}
            className={cn(
              "wf-control-button flex-shrink-0 h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              nowPlayingOpen
                ? "bg-white/[0.08] text-white"
                : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
            )}
          >
            {nowPlayingOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </button>
          <div className="hidden items-center gap-2 xl:flex">
            <button aria-label={isMuted ? "Unmute" : "Mute"} onClick={toggleMute} className="wf-control-button rounded-full p-2 text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white">
              <VolumeIcon size={18} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => setVolume(Number(e.target.value))}
              className="h-1.5 w-28 appearance-none rounded bg-white/[0.12] accent-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            />
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

// Leaf components that subscribe to the 4Hz playback-position event bridge so the
// progress UIs stay smooth without re-rendering the whole player chrome on every
// tick. They retain their last value when playback pauses (no events fire) and
// are re-seeded by PlayerBar's discrete position publishes (song change, resume,
// seek).
function PlaybackScrubber({ duration, onSeek }: { duration: number; onSeek: (value: number) => void }) {
  const [time, setTime] = useState(0);
  useEffect(() => subscribePlaybackPosition(({ currentTime }) => setTime(currentTime)), []);
  const seekable = duration > 0 && Number.isFinite(duration);
  const safe = seekable ? Math.min(time, duration) : 0;
  const progress = seekable ? Math.min(100, Math.max(0, (safe / duration) * 100)) : 0;
  return (
    <div className="flex w-full items-center gap-3">
      <span className="w-10 text-right text-[12px] tabular-nums text-white/[0.62]">{formatTime(safe)}</span>
      <input
        type="range"
        min={0}
        max={Math.max(0, duration)}
        step={0.1}
        value={safe}
        aria-label="Playback position"
        onChange={(e) => {
          const value = Number(e.target.value);
          setTime(value);
          onSeek(value);
        }}
        className="h-1.5 w-full appearance-none rounded bg-white/[0.12] accent-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        style={{
          background: `linear-gradient(to right, rgba(242,242,242,0.94) 0%, rgba(242,242,242,0.94) ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)`,
        }}
      />
      <span className="w-10 text-[12px] tabular-nums text-white/[0.62]">{formatTime(duration)}</span>
    </div>
  );
}

function PlaybackProgressFill({
  duration,
  isRadio,
  className,
}: {
  duration: number;
  isRadio: boolean;
  className?: string;
}) {
  const [time, setTime] = useState(0);
  useEffect(() => subscribePlaybackPosition(({ currentTime }) => setTime(currentTime)), []);
  const seekable = duration > 0 && Number.isFinite(duration);
  const pct = isRadio ? 100 : seekable ? Math.min(100, Math.max(0, (Math.min(time, duration) / duration) * 100)) : 0;
  return <div className={className} style={{ width: `${pct}%` }} />;
}
