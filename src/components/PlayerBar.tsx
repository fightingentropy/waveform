"use client";

import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/store/player";
import { cn, formatTime } from "@/lib/utils";
import { Pause, Play, SkipBack, SkipForward, Shuffle, Repeat, Volume2, VolumeX } from "lucide-react";

function PlayerBar(): React.ReactElement | null {
  const {
    queue,
    currentIndex,
    currentSong,
    isPlaying,
    toggle,
    next,
    previous,
    volume,
    setVolume,
    isMuted,
    toggleMute,
    shuffle,
    toggleShuffle,
    repeatMode,
    cycleRepeatMode,
    setSong,
    setQueue,
    pause,
  } = usePlayerStore();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const savedSeekRef = useRef<number | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);

  const src = currentSong?.audioUrl ?? null;

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  // Restore last played queue/song and time on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("wf_player_state");
      if (!raw) return;
      const data = JSON.parse(raw) as
        | {
            queue?: any[];
            currentIndex?: number;
            song?: any;
            currentTime?: number;
            isPlaying?: boolean;
          }
        | null;
      if (data?.queue && Array.isArray(data.queue) && typeof data.currentIndex === "number") {
        const idx = Math.max(0, Math.min(data.queue.length - 1, data.currentIndex));
        setQueue(data.queue, idx);
        // Always start paused on fresh load to avoid autoplay restrictions
        pause();
        if (typeof data.currentTime === "number") {
          savedSeekRef.current = data.currentTime;
          setCurrentTime(data.currentTime);
        }
      } else if (data?.song) {
        setSong(data.song);
        pause();
        if (typeof data.currentTime === "number") {
          savedSeekRef.current = data.currentTime;
          setCurrentTime(data.currentTime);
        }
      }
    } catch {}
  }, [setSong, setQueue, pause]);

  function handleEnded() {
    const audio = audioRef.current;
    if (!audio) return;
    if (repeatMode === "one") {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    next();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!src) {
      audio.pause();
      setCurrentTime(0);
      setDuration(0);
      return;
    }
    const absolute = location.origin + src;
    if (audio.src !== absolute) {
      audio.src = absolute;
    }
    if (isPlaying) audio.play().catch(() => { pause(); });
    else audio.pause();
  }, [src, isPlaying, pause]);

  // Save queue/song and playback position right before page unload
  useEffect(() => {
    function saveState() {
      try {
        if (!currentSong) {
          localStorage.removeItem("wf_player_state");
          return;
        }
        const audio = audioRef.current;
        const time = audio?.currentTime ?? currentTime;
        const payload = {
          queue,
          currentIndex,
          song: currentSong,
          currentTime: time,
          isPlaying,
        };
        localStorage.setItem("wf_player_state", JSON.stringify(payload));
      } catch {}
    }

    window.addEventListener("beforeunload", saveState);
    window.addEventListener("pagehide", saveState);
    return () => {
      window.removeEventListener("beforeunload", saveState);
      window.removeEventListener("pagehide", saveState);
    };
  }, [queue, currentIndex, currentSong, currentTime, isPlaying]);

  // Global keyboard shortcuts (always register to keep hook order stable)
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || target.isContentEditable;
    }

    function seekBy(seconds: number) {
      const audio = audioRef.current;
      if (!audio) return;
      const total = Number.isFinite(audio.duration) ? audio.duration : duration;
      if (!total || Number.isNaN(total)) return;
      const nextTime = Math.max(0, Math.min(total, (audio.currentTime || 0) + seconds));
      audio.currentTime = nextTime;
      setCurrentTime(nextTime);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      // Spacebar toggles play/pause
      if ((e.code === "Space" || e.key === " " || e.key === "Spacebar") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
        return;
      }
      // Meta + Arrow for previous/next track
      if (e.metaKey && e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        next();
        return;
      }
      if (e.metaKey && e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        previous();
        return;
      }
      // Arrow keys for seeking +/- 5 seconds
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        seekBy(5);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        seekBy(-5);
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [next, previous, duration, toggle]);

  if (!currentSong) return null;
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  function onSeek(value: number) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const nextTime = Math.max(0, Math.min(duration, value));
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : Volume2;

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 border-t border-black/10 dark:border-white/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <audio
        ref={audioRef}
        hidden
        playsInline
        preload="metadata"
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          if (!audio) return;
          setDuration(audio.duration || 0);
          const pending = savedSeekRef.current;
          if (typeof pending === "number") {
            const clamped = Math.max(0, Math.min(audio.duration || 0, pending));
            audio.currentTime = clamped;
            setCurrentTime(clamped);
            savedSeekRef.current = null;
          }
        }}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onEnded={handleEnded}
      />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
        <div className="flex items-center gap-3 sm:gap-4">
          <img src={currentSong.imageUrl} alt="cover" className="hidden sm:block w-12 h-12 rounded object-cover" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{currentSong.title}</div>
            <div className="text-xs opacity-70 truncate">{currentSong.artist}</div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <span className="text-xs tabular-nums opacity-70 w-10 text-right">{formatTime(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, duration)}
                step={0.1}
                value={currentTime}
                onChange={(e) => onSeek(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500"
              />
              <span className="text-xs tabular-nums opacity-70 w-10">{formatTime(duration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <button aria-label="Shuffle" onClick={toggleShuffle} className={cn("p-2 rounded-full", shuffle && "text-emerald-500")}>
              <Shuffle size={18} />
            </button>
            <button aria-label="Previous" onClick={previous} className="p-2 rounded-full">
              <SkipBack size={18} />
            </button>
            <button aria-label={isPlaying ? "Pause" : "Play"} onClick={toggle} className="h-9 w-9 rounded-full grid place-items-center bg-foreground text-background">
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button aria-label="Next" onClick={next} className="p-2 rounded-full">
              <SkipForward size={18} />
            </button>
            <button aria-label="Repeat" onClick={cycleRepeatMode} className={cn("p-2 rounded-full", repeatMode !== "off" && "text-emerald-500")}>
              <Repeat size={18} />
            </button>

            <div className="hidden sm:flex items-center gap-2 ml-2">
              <button aria-label={isMuted ? "Unmute" : "Mute"} onClick={toggleMute} className="p-2 rounded-full">
                <VolumeIcon size={18} />
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={isMuted ? 0 : volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="w-28 h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { PlayerBar };
export default PlayerBar;


