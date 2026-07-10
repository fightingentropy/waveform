"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useAuth } from "@/client/auth";
import { type SearchCatalogPayload, useApiData, withAccountScope } from "@/client/api";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { CoverImage } from "@/components/CoverImage";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { dedupeSongsByTitleArtist } from "@/lib/song-dedupe";

type MobileSearchProps = {
  songs: PlayerSong[];
};

export default function MobileSearch({ songs }: MobileSearchProps) {
  const [query, setQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const { user, status } = useAuth();
  const setQueue = usePlayerStore((state) => state.setQueue);

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => setCatalogQuery(trimmed.length >= 2 ? trimmed : ""), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const catalogState = useApiData<SearchCatalogPayload>(
    withAccountScope(`/api/search/catalog?q=${encodeURIComponent(catalogQuery)}`, user?.id ?? status),
    { results: [] },
    { enabled: status === "authenticated" && catalogQuery.length >= 2, keepPreviousData: false },
  );

  const dedupedSongs = useMemo(() => dedupeSongsByTitleArtist(songs), [songs]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return dedupedSongs
      .filter((song) => {
        const title = song.title.toLowerCase();
        const artist = song.artist.toLowerCase();
        return title.includes(q) || artist.includes(q);
      })
      .slice(0, 50);
  }, [dedupedSongs, query]);

  const libraryKeys = useMemo(
    () => new Set(dedupedSongs.map((song) => `${song.title.trim().toLowerCase()}\u0000${song.artist.trim().toLowerCase()}`)),
    [dedupedSongs],
  );
  const catalogResults = useMemo(
    () => catalogState.data.results.filter(
      (song) => !libraryKeys.has(`${song.title.trim().toLowerCase()}\u0000${song.artist.trim().toLowerCase()}`),
    ),
    [catalogState.data.results, libraryKeys],
  );

  const playQueueSong = (queue: PlayerSong[], index: number) => {
    const song = setQueue(queue, index);
    if (song?.audioUrl) requestImmediatePlayback(song);
  };

  const renderSong = (song: PlayerSong, queue: PlayerSong[], index: number) => (
    <button
      key={song.id}
      type="button"
      onClick={() => playQueueSong(queue, index)}
      className="wf-list-row wf-pressable w-full min-h-[56px] px-2 rounded-xl flex items-center gap-3 text-left active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
    >
      <div className="relative h-12 w-12 rounded-md overflow-hidden shrink-0">
        <CoverImage src={song.imageUrl} alt={song.title} className="wf-song-cover h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{song.title}</div>
        <div className="text-xs opacity-70 truncate">{song.artist}</div>
      </div>
    </button>
  );

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-5">Search</h1>

      <div className="relative mb-6">
        <Search
          size={18}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-foreground/50 pointer-events-none"
        />
        <input
          type="search"
          aria-label="Search songs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What do you want to play?"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full h-12 pl-11 pr-4 rounded-full border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-base outline-none transition focus:ring-2 focus:ring-emerald-500/40"
        />
      </div>

      <div className="space-y-1">
        {query.trim().length === 0 ? (
          <div className="py-12 text-center text-sm opacity-70">Start typing to search songs</div>
        ) : (
          <>
            {results.length > 0 ? (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/[0.55]">In your library</h2>
                {results.map((song) => renderSong(song, results, results.indexOf(song)))}
              </section>
            ) : null}

            {catalogQuery.length >= 2 ? (
              <section className={results.length > 0 ? "mt-7" : ""}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/[0.55]">More on Spotify</h2>
                {catalogState.loading ? <div className="py-5 text-sm opacity-70">Searching the catalog...</div> : null}
                {catalogState.error ? (
                  <div className="py-5 text-sm text-red-300">
                    <p>{catalogState.error}</p>
                    <button type="button" onClick={catalogState.retry} className="mt-3 rounded-full border border-white/[0.2] px-3 py-1.5 text-white">Try again</button>
                  </div>
                ) : null}
                {!catalogState.loading && !catalogState.error
                  ? catalogResults.map((song, index) => renderSong(song, catalogResults, index))
                  : null}
              </section>
            ) : null}

            {results.length === 0 && catalogQuery.length >= 2 && !catalogState.loading && !catalogState.error && catalogResults.length === 0 ? (
              <div className="py-12 text-center text-sm opacity-70">No songs found</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
