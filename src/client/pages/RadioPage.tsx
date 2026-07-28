"use client";

import { Radio, RadioTower } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { CoverImage } from "@/components/CoverImage";
import { RADIO_STATIONS } from "@/lib/radio-stations";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";

export default function RadioPage() {
  const setQueue = usePlayerStore((state) => state.setQueue);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const toggle = usePlayerStore((state) => state.toggle);
  const currentStationId = currentSong?.source === "radio" ? currentSong.id : null;

  function playStation(index: number) {
    const station = RADIO_STATIONS[index];
    if (!station) return;

    if (currentStationId === station.id) {
      if (!isPlaying) requestImmediatePlayback(station);
      toggle();
      return;
    }

    requestImmediatePlayback(station);
    setQueue(RADIO_STATIONS, index);
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/[0.075] text-white/60">
              <RadioTower size={23} />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">Radio Stations</h1>
              <div className="mt-1 text-sm text-white/[0.62]">
                {RADIO_STATIONS.length} live stations
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {RADIO_STATIONS.map((station, index) => {
            const active = currentStationId === station.id;
            const playing = active && isPlaying;
            return (
              <button
                key={station.id}
                type="button"
                onClick={() => playStation(index)}
                aria-label={`${playing ? "Pause" : "Play"} ${station.title}`}
                aria-pressed={playing}
                className={cn(
                  "group relative aspect-square overflow-hidden rounded-[10px] bg-white/[0.045] text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                  active && "ring-1 ring-white/30",
                )}
              >
                <CoverImage
                  src={station.imageUrl}
                  alt={station.title}
                  fill
                  className="object-cover"
                  loading={index === 0 ? "eager" : "lazy"}
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 200px"
                />
                <div className="absolute inset-x-0 bottom-0 h-24 bg-black/[0.76]" />
                <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/80 backdrop-blur">
                  <Radio size={11} />
                  Live
                </div>
                <div className="absolute inset-x-2 bottom-2">
                  <h2 className="truncate text-[15px] font-semibold leading-5 text-white drop-shadow sm:text-base">
                    {station.title}
                  </h2>
                  <div className="mt-0.5 truncate text-xs leading-4 text-white/80 drop-shadow">
                    {station.location}
                  </div>
                  <div className="mt-1 truncate text-[11px] leading-4 text-white/65 drop-shadow">
                    {station.streamLabel}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

      </div>
    </div>
  );
}
