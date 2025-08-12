"use client";

import { PlayerSong, usePlayerStore } from "@/store/player";
import { SongCard } from "@/components/SongCard";

export function SongGrid({ songs }: { songs: PlayerSong[] }) {
  const setQueue = usePlayerStore((s) => s.setQueue);

  function onPlayAt(index: number) {
    setQueue(songs, index);
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {songs.map((song, i) => (
        <SongCard key={song.id} song={song} onPlay={() => onPlayAt(i)} />
      ))}
    </div>
  );
}


