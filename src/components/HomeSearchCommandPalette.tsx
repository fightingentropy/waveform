"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { warmPlaybackSong } from "@/client/playback-warm";
import { useApiData, withAccountScope, type SearchIndexPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { usePlayerStore } from "@/store/player";
import { CoverImage } from "@/components/CoverImage";
import { PageError } from "@/components/PageError";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { dedupeSongsByTitleArtist } from "@/lib/song-dedupe";
import { useModalDialogFocus } from "@/lib/use-modal-dialog";
import { cn } from "@/lib/utils";

type HomeSearchCommandPaletteProps = {
  className?: string;
};

export function HomeSearchCommandPalette({ className }: HomeSearchCommandPaletteProps) {
  const { user, status } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const setQueue = usePlayerStore((state) => state.setQueue);

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => setLibraryQuery(trimmed), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const { data, loading, error } = useApiData<SearchIndexPayload>(
    withAccountScope(
      `/api/search-index?q=${encodeURIComponent(libraryQuery)}&limit=20`,
      user?.id ?? status,
    ),
    { songs: [] },
    { enabled: open && status !== "loading" && libraryQuery.length > 0, keepPreviousData: true },
  );
  const songs = libraryQuery.length > 0 ? data.songs : [];

  useModalDialogFocus(open, dialogRef);

  const results = useMemo(() => dedupeSongsByTitleArtist(songs).slice(0, 20), [songs]);

  const resolvedResults = results;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setLibraryQuery("");
    setActiveIndex(0);
  }, [open]);

  // Reset the active row whenever the result set changes (e.g. the query
  // shrinks the list). Without this, activeIndex can point past the new
  // results and Enter would no-op.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Lock background scroll (body + the .wf-main scroll container) while the
  // palette is open so the page underneath doesn't move.
  useEffect(() => {
    if (!open) return;
    const main = document.querySelector<HTMLElement>(".wf-main");
    const prevBody = document.body.style.overflow;
    const prevMain = main?.style.overflow ?? "";
    document.body.style.overflow = "hidden";
    if (main) main.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      if (main) main.style.overflow = prevMain;
    };
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, Math.max(0, resolvedResults.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = resolvedResults[activeIndex];
        if (!selected) return;
        requestImmediatePlayback(selected);
        setQueue(resolvedResults, activeIndex);
        setOpen(false);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, open, resolvedResults, setQueue]);

  return (
    <div className={className}>
      <button
        type="button"
        aria-label="Search songs, Command K"
        aria-keyshortcuts="Meta+K Control+K"
        title="Search (Command K)"
        onClick={() => setOpen(true)}
        className="group flex h-12 w-full min-w-0 items-center gap-3 rounded-full bg-[#1f1f1f] pl-4 pr-3 text-left text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition hover:bg-[#2a2a2a] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
      >
        <Search size={25} strokeWidth={2.15} className="shrink-0 text-white/70 transition group-hover:text-white" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-white/[0.64]">
          What do you want to play?
        </span>
        <kbd className="hidden h-6 shrink-0 items-center rounded-md border border-white/[0.16] px-2 text-[11px] font-semibold leading-none text-white/[0.56] xl:inline-flex">
          ⌘ K
        </kbd>
      </button>

      {open ? (
        <div className="fixed inset-0 z-[70] bg-black/70 p-4 backdrop-blur-sm sm:p-8" onClick={() => setOpen(false)}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search songs"
            className="mx-auto mt-10 max-w-2xl overflow-hidden rounded-3xl border border-white/15 bg-zinc-950/95 shadow-2xl sm:mt-16"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex h-14 items-center gap-3 border-b border-white/10 px-4">
              <Search size={18} className="text-foreground/60" />
              <input
                type="search"
                role="combobox"
                aria-label="Search songs"
                aria-expanded={resolvedResults.length > 0}
                aria-controls="home-search-results"
                aria-activedescendant={
                  resolvedResults.length > 0 ? `home-search-option-${activeIndex}` : undefined
                }
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="What do you want to play?"
                className="w-full bg-transparent text-base outline-none placeholder:text-foreground/50"
              />
              <kbd className="rounded-md border border-white/20 px-2 py-1 text-[10px] text-foreground/60">
                ESC
              </kbd>
            </div>

            <div
              id="home-search-results"
              role="listbox"
              aria-label="Search results"
              className="max-h-[60vh] overflow-y-auto p-2"
            >
              {query.trim().length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-foreground/65">
                  Start typing to search songs
                </div>
              ) : loading ? (
                <div className="px-3 py-10 text-center text-sm text-foreground/65">
                  Loading songs...
                </div>
              ) : error ? (
                <div className="px-3 py-10 text-center">
                  <PageError compact message={error} />
                </div>
              ) : results.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-foreground/65">
                  No songs found
                </div>
              ) : (
                resolvedResults.map((song, index) => (
                  <button
                    key={song.id}
                    id={`home-search-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    type="button"
                    onPointerEnter={() => warmPlaybackSong(song, true)}
                    onFocus={() => warmPlaybackSong(song, true)}
                    onClick={() => {
                      requestImmediatePlayback(song);
                      setQueue(resolvedResults, index);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex h-14 w-full items-center gap-3 rounded-xl px-3 text-left transition",
                      index === activeIndex ? "bg-white/10" : "hover:bg-white/5",
                    )}
                  >
                    <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md">
                      <CoverImage
                        src={song.imageUrl}
                        alt={song.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{song.title}</div>
                      <div className="truncate text-xs text-foreground/65">{song.artist}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
