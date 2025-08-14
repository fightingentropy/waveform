"use client";

import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/store/player";
import { cn, formatTime } from "@/lib/utils";
import { Pause, Play, SkipBack, SkipForward, Shuffle, Repeat, Volume2, VolumeX } from "lucide-react";

function PlayerBar(): React.ReactElement | null {
  const {
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
  } = usePlayerStore();

  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onLoaded = () => setDuration(audio.duration || 0);
    const onTime = () => setCurrentTime(audio.currentTime || 0);
    const onEnded = () => {
      if (repeatMode === "one") {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      next();
    };
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
    };
  }, [next, repeatMode]);

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
    if (isPlaying) audio.play().catch(() => {});
    else audio.pause();
  }, [src, isPlaying]);

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
      <audio ref={audioRef} hidden playsInline />
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


