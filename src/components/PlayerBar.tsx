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
    crossfadeEnabled,
    crossfadeSeconds,
    setCrossfadeEnabled,
    setCrossfadeSeconds,
  } = usePlayerStore();

  // Dual audio elements for real crossfade
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  const [activeIdx, setActiveIdx] = useState<0 | 1>(0);
  const getActiveAudio = () => (activeIdx === 0 ? audioARef.current : audioBRef.current);
  const getInactiveAudio = () => (activeIdx === 0 ? audioBRef.current : audioARef.current);

  const crossfadingRef = useRef<boolean>(false);
  const suppressAutoLoadRef = useRef<boolean>(false);
  const volumeRef = useRef<number>(volume);
  const mutedRef = useRef<boolean>(isMuted);

  const savedSeekRef = useRef<number | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);

  const src = currentSong?.audioUrl ?? null;

  // Client hydration of crossfade settings to ensure feature works without visiting /settings
  useEffect(() => {
    try {
      const enabled = localStorage.getItem("wf_crossfade_enabled") === "1";
      const secs = Math.max(0, Math.min(12, Number(localStorage.getItem("wf_crossfade_seconds") ?? 0)));
      if (enabled !== crossfadeEnabled) setCrossfadeEnabled(enabled);
      if (secs !== crossfadeSeconds) setCrossfadeSeconds(secs);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep mute state in sync on both elements
  useEffect(() => {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (a) a.muted = isMuted;
    if (b) b.muted = isMuted;
  }, [isMuted]);

  // Track latest volume/mute for fades without re-running effects
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { mutedRef.current = isMuted; }, [isMuted]);

  // Keep volume on the active element (crossfade code manages both during fades)
  useEffect(() => {
    if (crossfadingRef.current) return;
    const audio = getActiveAudio();
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted, activeIdx]);

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
      if (isPlaying) active?.play().catch(() => {});
      else try { active?.pause(); } catch {}
      // Keep inactive paused when not crossfading
      if (inactive && inactive !== active) {
        try { inactive.pause(); } catch {}
        inactive.currentTime = inactive.currentTime; // noop to avoid iOS suspending issues
      }
    }
  }, [isPlaying, activeIdx]);

  // Restore last played queue/song and time on client mount to avoid SSR mismatches
  useEffect(() => {
    try {
      const raw = localStorage.getItem("wf_player_state");
      if (!raw) return;
      const data = JSON.parse(raw) as
        | {
            queue?: import("@/store/player").PlayerSong[];
            currentIndex?: number;
            song?: import("@/store/player").PlayerSong;
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

  // Load current song into the ACTIVE element when not crossfading
  useEffect(() => {
    if (suppressAutoLoadRef.current) return;
    const audio = getActiveAudio();
    const other = getInactiveAudio();
    if (!audio) return;
    if (!src) {
      audio.pause();
      if (other) other.pause();
      setCurrentTime(0);
      setDuration(0);
      return;
    }
    const absolute = location.origin + src;
    if (audio.src !== absolute) audio.src = absolute;
    if (other && other !== audio) {
      // Ensure the inactive element is quiet and not playing
      try { other.pause(); } catch {}
      other.volume = 0;
    }
    if (isPlaying) audio.play().catch(() => { pause(); });
    else audio.pause();
  }, [src, isPlaying, pause, activeIdx]);

  // Crossfade: if enabled, monitor active element time and overlap next track
  useEffect(() => {
    if (!crossfadeEnabled) return;
    const audio = getActiveAudio();
    if (!audio) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const fadeWindow = Math.min(crossfadeSeconds, Math.max(0, duration / 2));
    if (fadeWindow <= 0) return;

    let raf: number | null = null;
    let started = false;

    function step() {
      const current = getActiveAudio();
      if (!current) return;
      const remaining = (duration || 0) - (current.currentTime || 0);
      if (!started && remaining <= fadeWindow + 0.05 && isPlaying && repeatMode !== "one") {
        started = true;
        crossfadingRef.current = true;

        const fromAudio = current;
        const toAudio = getInactiveAudio();
        if (!toAudio) {
          crossfadingRef.current = false;
          return;
        }
        const incoming = toAudio as HTMLAudioElement;
        
        // Compute upcoming track based on current queue snapshot
        let nextIdx = currentIndex;
        let nextSong = undefined as undefined | import("@/store/player").PlayerSong;
        if (Array.isArray(queue) && queue.length > 0) {
          if (shuffle) {
            if (queue.length === 1) {
              crossfadingRef.current = false;
              return;
            }
            let idx = currentIndex;
            while (idx === currentIndex) {
              idx = Math.floor(Math.random() * queue.length);
            }
            nextIdx = idx;
          } else {
            const atEnd = currentIndex >= queue.length - 1;
            if (atEnd) {
              if (repeatMode === "all") nextIdx = 0;
              else {
                crossfadingRef.current = false;
                return;
              }
            } else {
              nextIdx = currentIndex + 1;
            }
          }
          nextSong = queue[nextIdx];
        } else {
          crossfadingRef.current = false;
          return;
        }
        if (!nextSong) { crossfadingRef.current = false; return; }

        // Prepare incoming track
        suppressAutoLoadRef.current = true;
        const absoluteNext = location.origin + nextSong.audioUrl;
        if (incoming.src !== absoluteNext) incoming.src = absoluteNext;
        incoming.currentTime = 0;
        incoming.volume = 0;

        // Do not switch UI yet; we will switch after fade completes to keep time/progress stable

        const fadeMs = fadeWindow * 1000;
        const startTs = performance.now();
        const targetVol = mutedRef.current ? 0 : volumeRef.current;
        const fromStartTime = fromAudio.currentTime || 0;
        // Lock the total duration snapshot used for remaining calculations during fade
        const totalDurationSnapshot = Number.isFinite(fromAudio.duration) ? fromAudio.duration : duration;

        // Start incoming playback, ensure it's running while we fade
        incoming.play().catch(() => {});

        function fade() {
          const now = performance.now();
          const elapsed = Math.min(fadeMs, now - startTs);
          const t = elapsed / fadeMs;
          // Ease linear
          const fromVol = Math.max(0, (mutedRef.current ? 0 : volumeRef.current) * (1 - t));
          const toVol = Math.max(0, targetVol * t);
          // Apply volumes only if still the same segment (avoid jumps after seeks)
          if ((fromAudio.currentTime || 0) >= fromStartTime) {
            fromAudio.volume = fromVol;
          }
          incoming.volume = toVol;

          if (elapsed < fadeMs && isPlaying) {
            raf = requestAnimationFrame(fade);
          } else {
            // Finish: pause outgoing, keep incoming playing, then switch UI to the new track
            try { fromAudio.pause(); } catch {}
            if (!isPlaying) { try { incoming.pause(); } catch {} }
            // Keep previous track silent to avoid bleed-through
            fromAudio.volume = 0;
            // Switch UI/active element now that audio is already running
            setQueue(queue, nextIdx);
            setActiveIdx(activeIdx === 0 ? 1 : 0);
            // Update duration from incoming element if known
            if (Number.isFinite(incoming.duration)) {
              setDuration(incoming.duration || 0);
            }
            suppressAutoLoadRef.current = false;
            crossfadingRef.current = false;
          }
        }
        raf = requestAnimationFrame(fade);
      }
      if (!started) raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);
    // Ensure we don't pause or change volume elsewhere during fade
    return () => { if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossfadeEnabled, crossfadeSeconds, duration, isPlaying, repeatMode]);

  // Save queue/song and playback position right before page unload
  useEffect(() => {
    function saveState() {
      try {
        if (!currentSong) {
          localStorage.removeItem("wf_player_state");
          return;
        }
        const audio = getActiveAudio();
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
      const audio = getActiveAudio();
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
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as AddEventListenerOptions);
  }, [next, previous, duration, toggle]);

  if (!currentSong) return null;
  // const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  function onSeek(value: number) {
    const active = getActiveAudio();
    const inactive = getInactiveAudio();
    if (!active || !duration) return;
    const nextTime = Math.max(0, Math.min(duration, value));
    active.currentTime = nextTime;
    // Keep inactive in sync during crossfade seek to avoid jump when roles swap
    if (crossfadingRef.current && inactive) {
      try { inactive.currentTime = Math.max(0, Math.min(inactive.duration || nextTime, nextTime)); } catch {}
    }
    setCurrentTime(nextTime);
  }

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : Volume2;

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 border-t border-black/10 dark:border-white/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <audio
        ref={audioARef}
        hidden
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const audio = e.currentTarget;
          if (audio !== getActiveAudio()) return;
          setDuration(audio.duration || 0);
          const pending = savedSeekRef.current;
          if (typeof pending === "number") {
            const clamped = Math.max(0, Math.min(audio.duration || 0, pending));
            audio.currentTime = clamped;
            setCurrentTime(clamped);
            savedSeekRef.current = null;
          }
          audio.volume = isMuted ? 0 : volume;
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget === getActiveAudio()) setCurrentTime(e.currentTarget.currentTime || 0);
        }}
        onEnded={(e) => {
          if (e.currentTarget !== getActiveAudio()) return;
          if (crossfadingRef.current) return;
          const audio = e.currentTarget;
          if (repeatMode === "one") {
            audio.currentTime = 0;
            audio.play().catch(() => {});
            return;
          }
          next();
        }}
      />
      <audio
        ref={audioBRef}
        hidden
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const audio = e.currentTarget;
          if (audio !== getActiveAudio()) return;
          setDuration(audio.duration || 0);
          const pending = savedSeekRef.current;
          if (typeof pending === "number") {
            const clamped = Math.max(0, Math.min(audio.duration || 0, pending));
            audio.currentTime = clamped;
            setCurrentTime(clamped);
            savedSeekRef.current = null;
          }
          audio.volume = isMuted ? 0 : volume;
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget === getActiveAudio()) setCurrentTime(e.currentTarget.currentTime || 0);
        }}
        onEnded={(e) => {
          if (e.currentTarget !== getActiveAudio()) return;
          if (crossfadingRef.current) return;
          const audio = e.currentTarget;
          if (repeatMode === "one") {
            audio.currentTime = 0;
            audio.play().catch(() => {});
            return;
          }
          next();
        }}
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


