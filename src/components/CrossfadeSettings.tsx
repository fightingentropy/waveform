"use client";

import { useEffect, useState } from "react";
import { usePlayerStore } from "@/store/player";

export default function CrossfadeSettings() {
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

  const [seconds, setSeconds] = useState<number>(crossfadeSeconds);
  const [mounted, setMounted] = useState(false);

  // Hydrate settings from localStorage on client to avoid SSR mismatch
  useEffect(() => {
    try {
      const enabled = localStorage.getItem("wf_crossfade_enabled") === "1";
      const secs = Math.max(0, Math.min(12, Number(localStorage.getItem("wf_crossfade_seconds") ?? 0)));
      setCrossfadeEnabled(enabled);
      setCrossfadeSeconds(secs);
      setSeconds(secs);
      setMounted(true);
    } catch {}
  }, [setCrossfadeEnabled, setCrossfadeSeconds]);

  useEffect(() => setSeconds(crossfadeSeconds), [crossfadeSeconds]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium mb-2">Playback</h2>
        <div className="rounded border border-black/10 dark:border-white/10 p-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={crossfadeEnabled}
              onChange={(e) => setCrossfadeEnabled(e.target.checked)}
            />
            <span>Enable crossfade between songs</span>
          </label>
          <div className="mt-4 opacity-80">
            <label className="block text-sm mb-2">Crossfade duration: <span suppressHydrationWarning>{mounted ? seconds : crossfadeSeconds}</span>s</label>
            {mounted ? (
              <input
                key="slider-controlled"
                type="range"
                min={0}
                max={12}
                step={1}
                value={seconds}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSeconds(v);
                  setCrossfadeSeconds(v);
                }}
                onBlur={() => setCrossfadeSeconds(seconds)}
                onKeyUp={(e) => { if (e.key === "Enter") setCrossfadeSeconds(seconds); }}
                className="w-full h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500"
                disabled={!crossfadeEnabled}
              />
            ) : (
              <input
                key="slider-uncontrolled"
                type="range"
                min={0}
                max={12}
                step={1}
                defaultValue={crossfadeSeconds}
                className="w-full h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500"
                disabled
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


