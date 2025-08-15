"use client";

import { usePlayerStore, type PlayerSong } from "@/store/player";
import { cn } from "@/lib/utils";
import { Pause, Play } from "lucide-react";

export function SongCard({ song, onPlay }: { song: PlayerSong; onPlay?: () => void }) {
  const { setSong, play, pause, currentSong, isPlaying } = usePlayerStore();

  const isActive = currentSong?.id === song.id;

  function onPress() {
    if (isActive) {
      if (isPlaying) pause();
      else play();
      return;
    }
    if (onPlay) {
      onPlay();
    } else {
      setSong(song);
      play();
    }
  }

  return (
    <button
      onClick={onPress}
      aria-pressed={isActive && isPlaying}
      className={cn(
        "group relative rounded-lg overflow-hidden bg-black/5 dark:bg-white/5 focus:outline-none",
        isActive && "ring-2 ring-emerald-500"
      )}
    >
      {song.imageUrl && <img src={song.imageUrl} alt={song.title} className="aspect-square w-full object-cover" />}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between">
        <div className="text-left">
          <div className="text-white font-medium drop-shadow truncate">{song.title}</div>
          <div className="text-white/80 text-xs drop-shadow truncate">{song.artist}</div>
        </div>
        <div
          className={cn(
            "transition-opacity",
            isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
        >
          <div className="h-10 w-10 rounded-full bg-emerald-500 text-white grid place-items-center">
            {isActive && isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </div>
        </div>
      </div>
    </button>
  );
}


