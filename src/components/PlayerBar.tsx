"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerStore, type PlayerSong } from "@/store/player";
import { Pause, Play, Volume2, VolumeX, Shuffle, SkipBack, SkipForward, Repeat } from "lucide-react";
import { cn, formatTime } from "@/lib/utils";

export function PlayerBar() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const restoredOnceRef = useRef<boolean>(false);
  const STORAGE_KEY = "waveform-player";
  const {
    currentSong,
    isPlaying,
    toggle,
    play,
    pause,
    setSong,
    volume,
    setVolume,
    isMuted,
    toggleMute,
    shuffle,
    repeatMode,
    previous,
    next,
    toggleShuffle,
    cycleRepeatMode,
    currentIndex,
    queue,
  } =
    usePlayerStore();
  const [progressPct, setProgressPct] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);

  // Restore last session on first mount
  useEffect(() => {
    if (restoredOnceRef.current) return;
    restoredOnceRef.current = true;
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (!raw) return;
      const parsed = JSON.parse(raw) as { song?: PlayerSong | null; time?: number } | null;
      if (parsed?.song) {
        // Hydrate the last played song but do not auto-play to avoid autoplay restrictions
        setSong(parsed.song);
        pause();
        if (typeof parsed.time === "number" && parsed.time > 0) {
          pendingSeekRef.current = parsed.time;
        }
      }
    } catch {
      // ignore malformed storage
    }
  }, [pause, setSong]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = isMuted;
  }, [isMuted]);

  // Save on visibility/unload and when audio pauses
  useEffect(() => {
    function save() {
      const audio = audioRef.current;
      if (!currentSong || !audio) return;
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ song: currentSong, time: audio.currentTime })
        );
      } catch {}
    }
    const onVisibility = () => {
      if (document.hidden) save();
    };

    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    document.addEventListener("visibilitychange", onVisibility);

    const audio = audioRef.current;
    if (audio) audio.addEventListener("pause", save);

    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
      document.removeEventListener("visibilitychange", onVisibility);
      if (audio) audio.removeEventListener("pause", save);
    };
  }, [currentSong]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.play().catch(() => {/* ignore */});
    } else {
      audio.pause();
    }
  }, [isPlaying, currentSong]);

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    setDuration(audio.duration || 0);
    // Seek to previously saved position after metadata is available
    if (pendingSeekRef.current && audio.duration) {
      const clamped = Math.max(0, Math.min(audio.duration - 0.01, pendingSeekRef.current));
      audio.currentTime = clamped;
      setCurrentTime(clamped);
      setProgressPct((clamped / audio.duration) * 100);
      pendingSeekRef.current = null;
    }
  }

  function onProgress() {
    const audio = audioRef.current;
    if (!audio || !audio.buffered?.length) return;
    try {
      const end = audio.buffered.end(audio.buffered.length - 1);
      const pct = audio.duration ? (end / audio.duration) * 100 : 0;
      setBufferedPct(Math.max(0, Math.min(100, pct)));
    } catch {}
  }

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    setCurrentTime(audio.currentTime);
    setProgressPct((audio.currentTime / audio.duration) * 100);
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const pct = Number(e.target.value);
    audio.currentTime = (pct / 100) * audio.duration;
    setProgressPct(pct);
    // Immediately persist the new seek position
    if (currentSong) {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ song: currentSong, time: audio.currentTime })
        );
      } catch {}
    }
  }

  // Space to toggle
  useEffect(() => {
    function onKeydown(ev: KeyboardEvent) {
      if (ev.code === "Space") {
        ev.preventDefault();
        toggle();
      } else if (ev.code === "ArrowRight") {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.min((audio.duration || 0) - 0.01, audio.currentTime + 5);
      } else if (ev.code === "ArrowLeft") {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [toggle]);

  if (!currentSong) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 border-t border-black/10 dark:border-white/10 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto max-w-7xl px-4 py-2 grid grid-cols-[auto_1fr_auto] items-center gap-4">
        <img
          src={currentSong.imageUrl}
          alt={currentSong.title}
          className="h-12 w-12 rounded object-cover"
        />
        <div className="min-w-0">
          <div className="font-medium truncate">{currentSong.title}</div>
          <div className="text-sm opacity-70 truncate">{currentSong.artist}</div>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-3">
            <button
              aria-label="Shuffle"
              onClick={toggleShuffle}
              className={cn("p-2 rounded hover:bg-black/10 dark:hover:bg-white/10", shuffle && "text-emerald-500")}
              title="Shuffle"
            >
              <Shuffle size={18} />
            </button>
            <button
              aria-label="Previous"
              onClick={() => {
                const audio = audioRef.current;
                if (audio && audio.currentTime > 3) {
                  audio.currentTime = 0;
                } else {
                  previous();
                }
              }}
              className="p-2 rounded hover:bg-black/10 dark:hover:bg-white/10"
              title="Previous"
            >
              <SkipBack size={18} />
            </button>
            <button
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={toggle}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <button
              aria-label="Next"
              onClick={() => next()}
              className="p-2 rounded hover:bg-black/10 dark:hover:bg-white/10"
              title="Next"
            >
              <SkipForward size={18} />
            </button>
            <button
              aria-label="Repeat"
              onClick={cycleRepeatMode}
              className={cn(
                "relative p-2 rounded hover:bg-black/10 dark:hover:bg-white/10",
                repeatMode !== "off" && "text-emerald-500"
              )}
              title={repeatMode === "off" ? "Repeat: off" : repeatMode === "all" ? "Repeat: all" : "Repeat: one"}
            >
              <Repeat size={18} />
              {repeatMode === "one" && (
                <span className="absolute right-1 bottom-1 text-[10px] leading-none">1</span>
              )}
            </button>
          </div>
          <div className="flex items-center gap-3 min-w-0 w-[min(720px,70vw)]">
          <span className="w-12 text-xs tabular-nums text-right opacity-70">
            {formatTime(currentTime)}
          </span>
          <div className="relative w-full h-2 rounded bg-black/10 dark:bg-white/10 overflow-hidden">
            <div
              className="absolute left-0 top-0 bottom-0 bg-black/20 dark:bg-white/20"
              style={{ width: `${bufferedPct}%` }}
            />
            <input
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={progressPct}
              onChange={onSeek}
              aria-label="Seek"
              className={cn(
                "absolute inset-0 w-full appearance-none bg-transparent cursor-pointer",
                "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground",
                "[&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-foreground"
              )}
            />
            <div
              className="absolute left-0 top-0 bottom-0 bg-foreground/70 pointer-events-none"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="w-12 text-xs tabular-nums opacity-70">{formatTime(duration)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 justify-self-end">
          <button aria-label={isMuted ? "Unmute" : "Mute"} onClick={toggleMute} className="p-1">
            {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={isMuted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </div>
        <audio
          ref={audioRef}
          src={currentSong.audioUrl}
          onLoadedMetadata={onLoadedMetadata}
          onProgress={onProgress}
          onTimeUpdate={onTimeUpdate}
          onEnded={() => {
            const audio = audioRef.current;
            if (!audio) return;
            if (repeatMode === "one") {
              audio.currentTime = 0;
              audio.play().catch(() => {/* ignore */});
              return;
            }
            const atEnd = currentIndex >= queue.length - 1;
            if (!atEnd || shuffle || repeatMode === "all") {
              next();
            } else {
              pause();
            }
          }}
        />
      </div>
    </div>
  );
}


