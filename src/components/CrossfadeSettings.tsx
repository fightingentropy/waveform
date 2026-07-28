"use client";

import { usePlayerStore } from "@/store/player";

export default function CrossfadeSettings() {
  // Crossfade settings are hydrated once by the player store's lazy initializer
  // (the single source of truth reading the stored crossfade keys), so this
  // component just reads from / writes to the store.
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium mb-2">Playback</h2>
        <div className="rounded border border-black/10 dark:border-white/10 p-4">
          <label htmlFor="crossfade-enabled" className="flex items-center gap-2">
            <input
              id="crossfade-enabled"
              type="checkbox"
              checked={crossfadeEnabled}
              onChange={(e) => setCrossfadeEnabled(e.target.checked)}
            />
            <span>Enable crossfade between songs</span>
          </label>
          <div className="mt-4 opacity-80">
            <label htmlFor="crossfade-seconds" className="block text-sm mb-2">
              Crossfade duration: <span suppressHydrationWarning>{crossfadeSeconds}</span>s
            </label>
            <input
              id="crossfade-seconds"
              type="range"
              min={0}
              max={12}
              step={1}
              value={crossfadeSeconds}
              aria-label="Crossfade duration"
              onChange={(e) => setCrossfadeSeconds(Number(e.target.value))}
              className="h-1.5 w-full appearance-none rounded bg-white/[0.12] accent-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              disabled={!crossfadeEnabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
