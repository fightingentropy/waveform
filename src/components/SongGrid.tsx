"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LayoutGrid, Pause, Play, Rows3, Shuffle } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { SongCard } from "@/components/SongCard";
import { SongListItem } from "@/components/SongListItem";

type SongGridProps = {
  songs: PlayerSong[];
  // null when the server couldn't determine the like set (e.g. owner's mini
  // unreachable for a converted folder) — must NOT trigger the non-additive merge.
  likedSongIds?: string[] | null;
  hideIfUnliked?: boolean;
  canLike?: boolean;
  showLikeControls?: boolean;
  // When false, hides the per-row "add to queue" button.
  showQueueButton?: boolean;
  emptyLabel?: string;
  viewToggleClassName?: string;
};

type SongSortMode = "default" | "uploaded_desc" | "uploaded_asc";
type VirtualGridRange = {
  start: number;
  end: number;
  columns: number;
  rowHeight: number;
  rowGap: number;
};

const VIRTUAL_ROW_HEIGHT = 72;
const VIRTUAL_OVERSCAN_ROWS = 8;
const VIRTUALIZATION_MIN_ITEMS = 80;
const VIRTUAL_GRID_OVERSCAN_ROWS = 4;
const VIRTUAL_GRID_FALLBACK_COLUMNS = 2;
const VIRTUAL_GRID_FALLBACK_ROW_HEIGHT = 160;
const VIRTUAL_GRID_FALLBACK_ROW_GAP = 16;
const VIRTUAL_GRID_INITIAL_ROWS = 12;

function haveSameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const id of left) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of right) {
    const current = counts.get(id);
    if (!current) return false;
    if (current === 1) counts.delete(id);
    else counts.set(id, current - 1);
  }
  return counts.size === 0;
}

function parseCssPixels(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function SongGrid({
  songs,
  likedSongIds = [],
  hideIfUnliked = false,
  canLike = false,
  showLikeControls = true,
  showQueueButton = true,
  emptyLabel,
  viewToggleClassName,
}: SongGridProps) {
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortMode, setSortMode] = useState<SongSortMode>("default");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [virtualRange, setVirtualRange] = useState({ start: 0, end: 0 });
  const [virtualGridRange, setVirtualGridRange] = useState<VirtualGridRange>({
    start: 0,
    end: VIRTUAL_GRID_FALLBACK_COLUMNS * VIRTUAL_GRID_INITIAL_ROWS,
    columns: VIRTUAL_GRID_FALLBACK_COLUMNS,
    rowHeight: VIRTUAL_GRID_FALLBACK_ROW_HEIGHT,
    rowGap: VIRTUAL_GRID_FALLBACK_ROW_GAP,
  });
  const navigate = useNavigate();
  const setQueue = usePlayerStore((state) => state.setQueue);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const mergeInitial = useLikesStore((state) => state.mergeInitial);
  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const hydrated = useLikesStore((state) => state.hydrated);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("spotify_song_view_mode");
      if (stored === "list" || stored === "grid") {
        setViewMode(stored);
      }
      const storedSort = localStorage.getItem("spotify_song_sort_mode");
      if (
        storedSort === "default" ||
        storedSort === "uploaded_desc" ||
        storedSort === "uploaded_asc"
      ) {
        setSortMode(storedSort);
      }
    } catch {}
    setPreferencesReady(true);
  }, []);

  const setNextViewMode = useCallback((nextMode: "grid" | "list") => {
    setViewMode(nextMode);
    try {
      localStorage.setItem("spotify_song_view_mode", nextMode);
    } catch {}
  }, []);

  const setNextSortMode = useCallback((nextMode: SongSortMode) => {
    setSortMode(nextMode);
    try {
      localStorage.setItem("spotify_song_sort_mode", nextMode);
    } catch {}
  }, []);

  // Only hydrate likes once on mount, not on every prop change
  const likedSongIdsRef = useRef<string[]>([]);
  useEffect(() => {
    // Skip when the server sent no like set (null): merging is non-additive and
    // would wipe every local-server heart until the next successful load.
    if (!Array.isArray(likedSongIds)) return;
    if (!haveSameIds(likedSongIdsRef.current, likedSongIds)) {
      likedSongIdsRef.current = likedSongIds.slice();
      mergeInitial(likedSongIds);
    }
  }, [mergeInitial, likedSongIds]);

  const initialLookup = useMemo(() => {
    const map: Record<string, true> = {};
    for (const id of likedSongIds ?? []) {
      if (typeof id === "string" && id.length > 0) {
        map[id] = true;
      }
    }
    return map;
  }, [likedSongIds]);

  const likedMap = hydrated ? likedLookup : initialLookup;

  // Sort + id dedup is expensive for large libraries but doesn't depend on
  // likedMap. Keeping it in its own memo prevents every like toggle from
  // re-running it on pages where `hideIfUnliked` is false.
  const sortedDedupedSongs = useMemo(() => {
    const sorted = sortMode === "default" ? songs : [...songs];
    if (sortMode !== "default") {
      sorted.sort((left, right) => {
        const leftTime = Date.parse(left.createdAt || "");
        const rightTime = Date.parse(right.createdAt || "");
        const a = Number.isFinite(leftTime) ? leftTime : 0;
        const b = Number.isFinite(rightTime) ? rightTime : 0;
        return sortMode === "uploaded_desc" ? b - a : a - b;
      });
    }

    const seen = new Set<string>();
    const deduped: PlayerSong[] = [];
    for (const song of sorted) {
      if (seen.has(song.id)) continue;
      seen.add(song.id);
      deduped.push(song);
    }
    return deduped;
  }, [songs, sortMode]);

  const visibleSongs = useMemo(() => {
    if (!hideIfUnliked) return sortedDedupedSongs;
    return sortedDedupedSongs.filter((song) => !!likedMap[song.id]);
  }, [hideIfUnliked, likedMap, sortedDedupedSongs]);

  const currentSongId = currentSong?.id ?? null;
  const currentSongIsInList = useMemo(() => {
    return currentSongId ? visibleSongs.some((song) => song.id === currentSongId) : false;
  }, [currentSongId, visibleSongs]);
  const listIsPlaying = currentSongIsInList && isPlaying;

  const visibleSongsRef = useRef<PlayerSong[]>([]);
  useEffect(() => {
    visibleSongsRef.current = visibleSongs;
  }, [visibleSongs]);

  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const gridMeasureRef = useRef<HTMLDivElement | null>(null);
  const enableVirtualGrid = viewMode === "grid" && visibleSongs.length >= VIRTUALIZATION_MIN_ITEMS;
  const enableVirtualList =
    viewMode === "list" &&
    visibleSongs.length >= VIRTUALIZATION_MIN_ITEMS;

  useEffect(() => {
    if (!enableVirtualList) {
      setVirtualRange({ start: 0, end: visibleSongs.length });
      return;
    }

    let frameId = 0;
    const updateRange = () => {
      frameId = 0;
      const el = listContainerRef.current;
      if (!el) {
        setVirtualRange({ start: 0, end: Math.min(visibleSongs.length, 40) });
        return;
      }

      const rect = el.getBoundingClientRect();
      const scrollContainer = el.closest(".wf-main") as HTMLElement | null;
      const scrollRect = scrollContainer?.getBoundingClientRect();
      const viewportTop = scrollRect?.top ?? 0;
      const viewportBottom = scrollRect?.bottom ?? window.innerHeight;
      const localViewportTop = Math.max(0, viewportTop - rect.top);
      const localViewportBottom = Math.max(0, viewportBottom - rect.top);

      const nextStart = Math.max(
        0,
        Math.floor(localViewportTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS,
      );
      const nextEnd = Math.min(
        visibleSongs.length,
        Math.ceil(localViewportBottom / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN_ROWS,
      );

      setVirtualRange((current) =>
        current.start === nextStart && current.end === nextEnd
          ? current
          : { start: nextStart, end: Math.max(nextStart, nextEnd) },
      );
    };

    const scheduleRangeUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateRange);
    };

    const scrollContainer = listContainerRef.current?.closest(".wf-main") as HTMLElement | null;
    updateRange();
    scrollContainer?.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("resize", scheduleRangeUpdate);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      scrollContainer?.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("resize", scheduleRangeUpdate);
    };
  }, [enableVirtualList, visibleSongs.length]);

  useEffect(() => {
    if (!enableVirtualGrid) {
      const nextEnd = Math.min(
        visibleSongs.length,
        VIRTUAL_GRID_FALLBACK_COLUMNS * VIRTUAL_GRID_INITIAL_ROWS,
      );
      setVirtualGridRange((current) =>
        current.start === 0 && current.end === nextEnd
          ? current
          : { ...current, start: 0, end: nextEnd },
      );
      return;
    }

    let frameId = 0;
    let resizeObserver: ResizeObserver | null = null;
    const updateRange = () => {
      frameId = 0;
      const containerEl = gridContainerRef.current;
      const measureEl = gridMeasureRef.current ?? containerEl;
      if (!containerEl || !measureEl) {
        const nextEnd = Math.min(
          visibleSongs.length,
          VIRTUAL_GRID_FALLBACK_COLUMNS * VIRTUAL_GRID_INITIAL_ROWS,
        );
        setVirtualGridRange((current) =>
          current.start === 0 && current.end === nextEnd
            ? current
            : { ...current, start: 0, end: nextEnd },
        );
        return;
      }

      const styles = window.getComputedStyle(measureEl);
      const columns =
        styles.gridTemplateColumns
          .split(/\s+/)
          .filter((column) => column && column !== "none").length ||
        VIRTUAL_GRID_FALLBACK_COLUMNS;
      const columnGap = Math.max(
        0,
        parseCssPixels(styles.columnGap) ??
          parseCssPixels(styles.gap) ??
          VIRTUAL_GRID_FALLBACK_ROW_GAP,
      );
      const rowGap = Math.max(
        0,
        parseCssPixels(styles.rowGap) ??
          parseCssPixels(styles.gap) ??
          VIRTUAL_GRID_FALLBACK_ROW_GAP,
      );
      const measuredCardHeight =
        measureEl.querySelector<HTMLElement>(".wf-song-card")?.getBoundingClientRect().height ?? 0;
      const calculatedCardHeight =
        measureEl.clientWidth > 0
          ? (measureEl.clientWidth - columnGap * (columns - 1)) / columns
          : VIRTUAL_GRID_FALLBACK_ROW_HEIGHT;
      const rowHeight = Math.max(1, measuredCardHeight || calculatedCardHeight);
      const rowStride = rowHeight + rowGap;
      const totalRows = Math.ceil(visibleSongs.length / columns);

      const rect = containerEl.getBoundingClientRect();
      const scrollContainer = containerEl.closest(".wf-main") as HTMLElement | null;
      const scrollRect = scrollContainer?.getBoundingClientRect();
      const viewportTop = scrollRect?.top ?? 0;
      const viewportBottom = scrollRect?.bottom ?? window.innerHeight;
      const localViewportTop = Math.max(0, viewportTop - rect.top);
      const localViewportBottom = Math.max(0, viewportBottom - rect.top);

      const nextStartRow = Math.min(
        totalRows,
        Math.max(0, Math.floor(localViewportTop / rowStride) - VIRTUAL_GRID_OVERSCAN_ROWS),
      );
      const nextEndRow = Math.min(
        totalRows,
        Math.max(
          nextStartRow,
          Math.ceil(localViewportBottom / rowStride) + VIRTUAL_GRID_OVERSCAN_ROWS,
        ),
      );
      const nextStart = Math.min(visibleSongs.length, nextStartRow * columns);
      const nextEnd = Math.min(visibleSongs.length, Math.max(nextStart, nextEndRow * columns));

      setVirtualGridRange((current) =>
        current.start === nextStart &&
        current.end === nextEnd &&
        current.columns === columns &&
        current.rowHeight === rowHeight &&
        current.rowGap === rowGap
          ? current
          : {
              start: nextStart,
              end: nextEnd,
              columns,
              rowHeight,
              rowGap,
            },
      );
    };

    const scheduleRangeUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateRange);
    };

    const scrollContainer = gridContainerRef.current?.closest(".wf-main") as HTMLElement | null;
    const observedEl = gridMeasureRef.current ?? gridContainerRef.current;
    updateRange();
    scrollContainer?.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("resize", scheduleRangeUpdate);
    if (observedEl && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleRangeUpdate);
      resizeObserver.observe(observedEl);
    }

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      scrollContainer?.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("resize", scheduleRangeUpdate);
    };
  }, [enableVirtualGrid, visibleSongs.length]);

  const onPlayAt = useCallback((index: number) => {
    setQueue(visibleSongsRef.current, index);
  }, [setQueue]);

  const handlePlayVisibleSongs = useCallback(() => {
    const songsToPlay = visibleSongsRef.current;
    if (songsToPlay.length === 0) return;

    if (currentSongIsInList) {
      if (isPlaying) pause();
      else {
        requestImmediatePlayback(currentSong);
        play();
      }
      return;
    }

    const startedSong = setQueue(songsToPlay, 0, { respectShuffle: true });
    requestImmediatePlayback(startedSong);
  }, [currentSong, currentSongIsInList, isPlaying, pause, play, setQueue]);

  const handleToggleLike = useCallback(async (songId: string, nextLiked: boolean) => {
    if (!canLike) {
      navigate("/signin");
      return;
    }
    const result = await toggleLike(
      songId,
      nextLiked,
      visibleSongsRef.current.find((song) => song.id === songId),
    );
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }, [canLike, navigate, toggleLike]);

  const virtualGridRows = Math.ceil(visibleSongs.length / virtualGridRange.columns);
  const virtualGridHeight =
    virtualGridRows > 0
      ? virtualGridRows * virtualGridRange.rowHeight +
        Math.max(0, virtualGridRows - 1) * virtualGridRange.rowGap
      : 0;
  const virtualGridTop =
    Math.floor(virtualGridRange.start / virtualGridRange.columns) *
    (virtualGridRange.rowHeight + virtualGridRange.rowGap);

  const renderSongCard = (song: PlayerSong, index: number) => (
    <SongCard
      key={song.id}
      song={song}
      songIndex={index}
      onPlayAt={onPlayAt}
      liked={!!likedMap[song.id]}
      likePending={!!pendingLookup[song.id]}
      canLike={canLike}
      showLike={showLikeControls}
      showQueue={showQueueButton}
      onToggleLike={handleToggleLike}
      hideIfUnliked={hideIfUnliked}
      priority={index < 6}
    />
  );

  if (visibleSongs.length === 0) {
    if (hideIfUnliked && emptyLabel) {
      return <div className="opacity-70">{emptyLabel}</div>;
    }
    return null;
  }

  return (
    <div className={cn(!preferencesReady && "opacity-0")}>
      <div className={cn("mb-3 flex w-full items-center gap-2", viewToggleClassName)}>
        <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
          <button
            type="button"
            aria-label={listIsPlaying ? "Pause songs" : "Play songs"}
            title={listIsPlaying ? "Pause songs" : "Play songs"}
            onClick={handlePlayVisibleSongs}
            disabled={visibleSongs.length === 0}
            className="wf-control-button grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#1ed760] text-black shadow-[0_8px_18px_rgba(0,0,0,0.22)] transition hover:bg-[#1fdf64] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#1ed760]"
          >
            {listIsPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="translate-x-0.5" />}
          </button>
          <button
            type="button"
            aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
            title={shuffle ? "Disable shuffle" : "Enable shuffle"}
            onClick={toggleShuffle}
            className={cn(
              "relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-black/10 bg-black/5 text-foreground/70 transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:text-white",
              "wf-control-button",
              shuffle && "text-[#1ed760] dark:text-[#1ed760]",
            )}
          >
            <Shuffle size={19} />
            <span
              className={cn(
                "absolute bottom-1 h-1 w-1 rounded-full bg-[#1ed760] transition-opacity",
                shuffle ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
          <select
            value={sortMode}
            onChange={(event) => setNextSortMode(event.target.value as SongSortMode)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-black/10 bg-black/5 px-3 text-sm dark:border-white/10 dark:bg-white/5 sm:w-64 sm:flex-none"
            aria-label="Sort songs"
            title="Sort songs"
          >
            <option value="default">Sort: Default</option>
            <option value="uploaded_desc">Sort: Upload date (newest)</option>
            <option value="uploaded_asc">Sort: Upload date (oldest)</option>
          </select>
          <div className="inline-flex h-10 shrink-0 items-center rounded-lg border border-black/10 bg-black/5 p-1 dark:border-white/10 dark:bg-white/5">
            <button
              type="button"
              onClick={() => setNextViewMode("grid")}
              className={cn(
                "inline-flex h-8 w-9 items-center justify-center gap-2 rounded-md text-sm transition sm:w-auto sm:px-3",
                "wf-control-button",
                viewMode === "grid" && "bg-black/10 font-medium dark:bg-white/10",
              )}
              aria-pressed={viewMode === "grid"}
              title="Grid view"
            >
              <LayoutGrid size={16} />
              <span className="hidden sm:inline">Grid</span>
            </button>
            <button
              type="button"
              onClick={() => setNextViewMode("list")}
              className={cn(
                "inline-flex h-8 w-9 items-center justify-center gap-2 rounded-md text-sm transition sm:w-auto sm:px-3",
                "wf-control-button",
                viewMode === "list" && "bg-black/10 font-medium dark:bg-white/10",
              )}
              aria-pressed={viewMode === "list"}
              title="List view"
            >
              <Rows3 size={16} />
              <span className="hidden sm:inline">List</span>
            </button>
          </div>
        </div>
      </div>

      {viewMode === "grid" ? (
        enableVirtualGrid ? (
          <div
            ref={gridContainerRef}
            className="relative"
            style={{ height: `${virtualGridHeight}px` }}
          >
            <div
              ref={gridMeasureRef}
              className="absolute left-0 right-0 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4"
              style={{ top: `${virtualGridTop}px` }}
            >
              {visibleSongs
                .slice(virtualGridRange.start, virtualGridRange.end)
                .map((song, offset) => renderSongCard(song, virtualGridRange.start + offset))}
            </div>
          </div>
        ) : (
          <div
            ref={gridContainerRef}
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4"
          >
            {visibleSongs.map(renderSongCard)}
          </div>
        )
      ) : (
        <div ref={listContainerRef}>
          {enableVirtualList ? (
            <div
              className="relative"
              style={{ height: `${visibleSongs.length * VIRTUAL_ROW_HEIGHT}px` }}
            >
              {visibleSongs.slice(virtualRange.start, virtualRange.end).map((song, offset) => {
                const index = virtualRange.start + offset;
                return (
                  <div
                    key={song.id}
                    className="absolute left-0 right-0 pb-2"
                    style={{ top: `${index * VIRTUAL_ROW_HEIGHT}px` }}
                  >
                    <SongListItem
                      song={song}
                      songIndex={index}
                      onPlayAt={onPlayAt}
                      liked={!!likedMap[song.id]}
                      likePending={!!pendingLookup[song.id]}
                      canLike={canLike}
                      showLike={showLikeControls}
                      showQueue={showQueueButton}
                      onToggleLike={handleToggleLike}
                      priority={index < 6}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleSongs.map((song, index) => (
                <SongListItem
                  key={song.id}
                  song={song}
                  songIndex={index}
                  onPlayAt={onPlayAt}
                  liked={!!likedMap[song.id]}
                  likePending={!!pendingLookup[song.id]}
                  canLike={canLike}
                  showLike={showLikeControls}
                  showQueue={showQueueButton}
                  onToggleLike={handleToggleLike}
                  priority={index < 6}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
