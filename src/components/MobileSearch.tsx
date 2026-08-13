"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { AuthButtons } from "@/components/AuthButtons";
import { useAuth } from "@/client/auth";
import { useApiData, withAccountScope, type SearchCatalogPayload, type SearchIndexPayload } from "@/client/api";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { CoverImage } from "@/components/CoverImage";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { dedupeSongsByTitleArtist } from "@/lib/song-dedupe";

export default function MobileSearch() {
  const [query, setQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const { user, status } = useAuth();
  const setQueue = usePlayerStore((state) => state.setQueue);

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      setLibraryQuery(trimmed);
      setCatalogQuery(trimmed.length >= 2 ? trimmed : "");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const libraryState = useApiData<SearchIndexPayload>(
    withAccountScope(
      `/api/search-index?q=${encodeURIComponent(libraryQuery)}&limit=50`,
      user?.id ?? status,
    ),
    { songs: [] },
    { enabled: status !== "loading" && libraryQuery.length > 0, keepPreviousData: true },
  );

  const catalogState = useApiData<SearchCatalogPayload>(
    withAccountScope(`/api/search/catalog?q=${encodeURIComponent(catalogQuery)}`, user?.id ?? status),
    { results: [] },
    { enabled: status === "authenticated" && catalogQuery.length >= 2, keepPreviousData: false },
  );

  const dedupedSongs = useMemo(
    () => dedupeSongsByTitleArtist(libraryState.data.songs),
    [libraryState.data.songs],
  );

  const results = useMemo(() => dedupedSongs.slice(0, 50), [dedupedSongs]);

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
      className="wf-list-row wf-pressable flex min-h-[64px] w-full items-center gap-3 px-0 text-left touch-manipulation hover:bg-white/[0.045] active:bg-white/[0.06]"
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
        <CoverImage src={song.imageUrl} alt={song.title} className="wf-song-cover h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium text-[#f2f2f2]">{song.title}</div>
        <div className="truncate text-xs text-white/60">{song.artist}</div>
      </div>
    </button>
  );

  return (
    <div className="mx-auto max-w-7xl px-5 pb-8 pt-[18px] sm:px-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="lg:hidden">
          <AuthButtons compact />
        </div>
        <h1 className="text-[34px] font-bold leading-10 tracking-[-0.9px] text-[#f2f2f2]">
          Search
        </h1>
      </div>

      <div className="relative mb-6">
        <Search
          size={21}
          strokeWidth={2.2}
          className="pointer-events-none absolute left-[17px] top-1/2 -translate-y-1/2 text-white/50"
        />
        <input
          type="search"
          aria-label="Search songs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Songs, artists and playlists"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-[50px] w-full rounded-xl border border-white/[0.08] bg-[#0c0c0d] pl-12 pr-4 text-base font-medium text-[#f2f2f2] outline-none transition placeholder:text-white/60 focus:border-white/20 focus:ring-2 focus:ring-white/10"
        />
      </div>

      <div className="space-y-1">
        {query.trim().length === 0 ? (
          <div className="py-12 text-center text-sm text-white/60">Start typing to search music</div>
        ) : (
          <>
            {libraryState.loading && results.length === 0 ? (
              <div className="py-5 text-sm opacity-70">Searching your library...</div>
            ) : null}
            {libraryState.error ? (
              <div className="py-5 text-sm text-red-300">
                <p>{libraryState.error}</p>
                <button type="button" onClick={libraryState.retry} className="mt-3 rounded-lg border border-white/[0.16] px-3 py-1.5 text-white">Try again</button>
              </div>
            ) : null}
            {results.length > 0 ? (
              <section>
                <h2 className="mb-1 pt-2 text-lg font-bold tracking-[-0.3px] text-[#f2f2f2]">
                  In your library
                </h2>
                {results.map((song) => renderSong(song, results, results.indexOf(song)))}
              </section>
            ) : null}

            {catalogQuery.length >= 2 ? (
              <section className={results.length > 0 ? "mt-7" : ""}>
                <h2 className="mb-1 text-lg font-bold tracking-[-0.3px] text-[#f2f2f2]">
                  More on Spotify
                </h2>
                {catalogState.loading ? <div className="py-5 text-sm opacity-70">Searching the catalog...</div> : null}
                {catalogState.error ? (
                  <div className="py-5 text-sm text-red-300">
                    <p>{catalogState.error}</p>
                    <button type="button" onClick={catalogState.retry} className="mt-3 rounded-lg border border-white/[0.16] px-3 py-1.5 text-white">Try again</button>
                  </div>
                ) : null}
                {!catalogState.loading && !catalogState.error
                  ? catalogResults.map((song, index) => renderSong(song, catalogResults, index))
                  : null}
              </section>
            ) : null}

            {results.length === 0 && !libraryState.loading && !libraryState.error && (catalogQuery.length < 2 || (!catalogState.loading && !catalogState.error && catalogResults.length === 0)) ? (
              <div className="py-12 text-center text-sm opacity-70">No songs found</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
