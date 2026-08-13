import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  ListChecks,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Trash2,
  X,
} from "lucide-react";
import {
  useApiData,
  withAccountScope,
  type CuratedPlaylistPayload,
  type PlaylistPayload,
} from "@/client/api";
import { useAuth } from "@/client/auth";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { usePlayerStore } from "@/store/player";
import { CoverImage } from "@/components/CoverImage";
import { PageError } from "@/components/PageError";
import { PlaylistArtwork } from "@/components/PlaylistArtwork";
import { SongGrid } from "@/components/SongGrid";
import { cn } from "@/lib/utils";
import { useModalDialogFocus } from "@/lib/use-modal-dialog";
import type { PlayerSong } from "@/types/player";
import { deletePlaylist, removeSongFromPlaylist, renamePlaylist, reorderPlaylist } from "@/client/playlist-actions";

function PlaylistLoadingSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-7 flex items-end gap-5 border-b border-white/[0.08] pb-7">
        <div className="wf-skeleton hidden h-40 w-40 shrink-0 rounded-xl sm:block" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="wf-skeleton h-3 w-20 rounded-full" />
          <div className="wf-skeleton h-9 w-72 max-w-full rounded-full" />
          <div className="wf-skeleton h-4 w-24 rounded-full" />
        </div>
      </div>
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="flex h-16 items-center gap-3 px-2">
            <div className="wf-skeleton h-3 w-5 rounded-full" />
            <div className="wf-skeleton h-11 w-11 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="wf-skeleton h-4 w-48 max-w-full rounded-full" />
              <div className="wf-skeleton h-3 w-28 max-w-full rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaylistActionsMenu({
  managing,
  pending,
  deletable,
  onRename,
  onToggleManaging,
  onDelete,
}: {
  managing: boolean;
  pending: boolean;
  deletable: boolean;
  onRename: () => void;
  onToggleManaging: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const runAndClose = (action: () => void) => {
    setOpen(false);
    triggerRef.current?.focus();
    action();
  };

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Playlist options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Playlist options"
        disabled={pending}
        onClick={() => setOpen((value) => !value)}
        className="wf-control-button grid h-11 w-11 place-items-center rounded-full border border-white/[0.12] text-white/70 hover:bg-white/[0.07] hover:text-white disabled:cursor-wait disabled:opacity-45"
      >
        <MoreHorizontal size={20} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Playlist options"
          onKeyDown={moveMenuFocus}
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-52 rounded-xl border border-white/[0.12] bg-[#121213] p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => runAndClose(onRename)}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-white/85 hover:bg-white/[0.08] focus:outline-none focus-visible:bg-white/[0.08]"
          >
            <Pencil size={17} className="text-white/60" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runAndClose(onToggleManaging)}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-white/85 hover:bg-white/[0.08] focus:outline-none focus-visible:bg-white/[0.08]"
          >
            <ListChecks size={17} className="text-white/60" />
            {managing ? "Finish managing" : "Manage tracks"}
          </button>
          {deletable ? (
            <>
              <div className="my-1 border-t border-white/[0.08]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onDelete)}
                className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-red-300 hover:bg-red-400/[0.09] focus:outline-none focus-visible:bg-red-400/[0.09]"
              >
                <Trash2 size={17} />
                Delete playlist
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlaylistDeleteDialog({
  name,
  songsCount,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  name: string;
  songsCount: number;
  pending: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useModalDialogFocus(true, dialogRef);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, pending]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-playlist-title"
        aria-describedby="delete-playlist-description"
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-white/[0.12] bg-[#121213] p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.65)] outline-none"
      >
        <h2 id="delete-playlist-title" className="text-lg font-semibold">
          Delete “{name}”?
        </h2>
        <p id="delete-playlist-description" className="mt-2 text-sm leading-6 text-white/60">
          This removes only the playlist. Its {songsCount} {songsCount === 1 ? "song stays" : "songs stay"} in your library.
        </p>
        {error ? (
          <p role="alert" className="mt-3 rounded-lg border border-red-400/25 bg-red-400/[0.08] px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="wf-control-button rounded-full px-4 py-2 text-sm font-semibold text-white/75 hover:bg-white/[0.08] hover:text-white disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="wf-control-button rounded-full bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-400 disabled:cursor-wait disabled:opacity-60"
          >
            {pending ? "Deleting..." : "Delete playlist"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

// Discover playlists (Top 50 / the YouTube Music Discover Mix) aren't backed by
// library rows — their tracks stream read-through (no library writes). The
// payload's songs are already PlayerSongs: staged ones fully playable, the rest
// placeholders (empty audioUrl); the whole list is loaded into the player queue
// and DiscoverQueueStager materializes each placeholder just-in-time as it
// becomes current, so the playlist auto-advances track to track.
//
// A song and the current queue entry are matched by discoverTrackId (falling
// back to id): staging swaps the placeholder queue entry for the real song (new
// id), but discoverTrackId survives the swap, so the row highlight holds.
const songKeyOf = (song: Pick<PlayerSong, "id" | "discoverTrackId"> | null | undefined): string | null =>
  song ? song.discoverTrackId ?? song.id : null;

function CuratedPlaylistView({ data }: { data: CuratedPlaylistPayload }) {
  const { playlist } = data;
  const songs = data.songs ?? [];
  const setQueue = usePlayerStore((s) => s.setQueue);
  const play = usePlayerStore((s) => s.play);
  const pause = usePlayerStore((s) => s.pause);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentSongKey = usePlayerStore((s) => songKeyOf(s.currentSong));
  // The current track is "loading" while it's still a placeholder (no real src).
  const currentHasAudio = usePlayerStore((s) => Boolean(s.currentSong?.audioUrl));

  const playlistIsActive = songs.some((song) => songKeyOf(song) === currentSongKey);

  const playFromIndex = useCallback(
    (index: number) => {
      const song = setQueue(songs, index);
      // Staged tracks have a real src — start them inside the click gesture.
      // Placeholders (empty src) are materialized + played by DiscoverQueueStager.
      if (song?.audioUrl) requestImmediatePlayback(song);
    },
    [songs, setQueue],
  );

  const handleTrackTap = useCallback(
    (index: number) => {
      const song = songs[index];
      if (!song) return;
      if (songKeyOf(song) === currentSongKey) {
        if (isPlaying) pause();
        else play();
        return;
      }
      playFromIndex(index);
    },
    [songs, currentSongKey, isPlaying, pause, play, playFromIndex],
  );

  const handleHeaderPlay = useCallback(() => {
    if (playlistIsActive) {
      if (isPlaying) pause();
      else play();
      return;
    }
    if (songs.length > 0) playFromIndex(0);
  }, [playlistIsActive, isPlaying, pause, play, playFromIndex, songs.length]);

  const headerIsPlaying = playlistIsActive && isPlaying;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-7 flex flex-col items-center gap-4 text-center sm:flex-row sm:items-end sm:text-left">
        <div className="relative h-[132px] w-[132px] shrink-0 overflow-hidden rounded-3xl bg-white/[0.045] shadow-[0_10px_28px_rgba(0,0,0,0.45)] sm:h-44 sm:w-44 sm:rounded-2xl">
          <CoverImage src={playlist.imageUrl || undefined} alt={playlist.name} fill sizes="176px" className="object-cover" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[1.2px] text-white/60">Playlist</div>
          <h1 className="mt-1 truncate text-3xl font-bold sm:text-4xl">{playlist.name}</h1>
          {playlist.description ? (
            <p className="mt-2 line-clamp-2 text-sm text-white/[0.62]">{playlist.description}</p>
          ) : null}
          <div className="mt-2 text-sm opacity-70">
            {songs.length} {songs.length === 1 ? "track" : "tracks"}
          </div>
        </div>
      </header>

      {songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <>
          <div className="mb-5 flex justify-end">
            <button
              type="button"
              onClick={handleHeaderPlay}
              aria-label={headerIsPlaying ? `Pause ${playlist.name}` : `Play ${playlist.name}`}
              className="wf-control-button grid h-14 w-14 place-items-center rounded-full bg-white text-black shadow-lg transition hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              {headerIsPlaying ? (
                <Pause size={26} fill="currentColor" />
              ) : (
                <Play size={26} fill="currentColor" className="translate-x-0.5" />
              )}
            </button>
          </div>
          <ol className="space-y-1">
            {songs.map((track, index) => {
              const active = songKeyOf(track) === currentSongKey;
              const loading = active && !currentHasAudio;
              const activePlaying = active && isPlaying && currentHasAudio;
              return (
                <li key={track.id}>
                  <button
                    type="button"
                    onClick={() => handleTrackTap(index)}
                    aria-label={activePlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition sm:px-3",
                      active ? "bg-white/[0.12]" : "hover:bg-white/[0.07]",
                    )}
                  >
                    <div className="grid w-6 shrink-0 place-items-center text-sm tabular-nums text-white/[0.5]">
                      {loading ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white" />
                      ) : activePlaying ? (
                        <Pause size={16} className="text-white" fill="currentColor" />
                      ) : active ? (
                        <Play size={16} className="text-white" fill="currentColor" />
                      ) : (
                        <>
                          <span className="group-hover:hidden">{index + 1}</span>
                          <Play size={16} className="hidden translate-x-px group-hover:block" fill="currentColor" />
                        </>
                      )}
                    </div>
                    <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded bg-white/[0.08]">
                      <CoverImage src={track.imageUrl} alt="" fill sizes="40px" className="object-cover" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-[15px] leading-snug text-white", active && "font-semibold")}>
                        {track.title}
                      </div>
                      <div className="truncate text-[13px] leading-snug text-white/[0.6]">
                        {track.artist || "Unknown Artist"}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

export default function PlaylistPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user, status } = useAuth();
  const { data, loading, error, retry } = useApiData<PlaylistPayload>(
    withAccountScope(`/api/playlist/${encodeURIComponent(id)}`, user?.id ?? status),
    {
      playlist: null,
      songs: [],
      likedSongIds: null,
    },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );
  const [managing, setManaging] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const runAction = async (
    key: string,
    action: () => Promise<unknown>,
    refreshAfter = true,
  ) => {
    setPendingAction(key);
    setActionError(null);
    try {
      await action();
      if (refreshAfter) retry();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The playlist couldn't be updated.");
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  if (loading || status === "loading") return <PlaylistLoadingSkeleton />;
  if (error) return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <PageError compact message={error} onRetry={retry} />
    </div>
  );

  if (data.kind === "curated") return <CuratedPlaylistView data={data} />;

  if (!data.playlist) return <div className="px-6 py-8 max-w-7xl mx-auto opacity-70">Playlist not found.</div>;

  const deletable = data.playlist.deletable ?? !id.startsWith("local-folder-");
  const serverCoverImageUrls = data.playlist.coverImageUrls ?? [];
  const songCoverImageUrls = Array.from(
    new Set(
      data.songs
        .map((song) => song.imageUrl?.trim())
        .filter((imageUrl): imageUrl is string => Boolean(imageUrl)),
    ),
  ).slice(0, 4);
  const coverImageUrls =
    serverCoverImageUrls.length > 0
      ? serverCoverImageUrls
      : id.startsWith("local-folder-") || !data.playlist.imageUrl
        ? songCoverImageUrls
        : [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-col items-center gap-5 border-b border-white/[0.08] pb-7 text-center sm:flex-row sm:items-end sm:text-left">
        <PlaylistArtwork
          coverImageUrls={coverImageUrls}
          imageUrl={data.playlist.imageUrl}
          className="w-[132px] shrink-0 shadow-[0_14px_40px_rgba(0,0,0,0.42)] sm:w-44"
          sizes="176px"
          loading="eager"
        />
        <div className="flex min-w-0 w-full flex-1 items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[1.35px] text-white/45">
              Playlist
            </div>
            <h1 className="mt-1 truncate text-3xl font-bold tracking-[-0.8px] text-[#f2f2f2] sm:text-[42px] sm:leading-[1.05]">
              {data.playlist.name}
            </h1>
            <div className="mt-3 text-sm text-white/55">
              {data.songs.length} {data.songs.length === 1 ? "track" : "tracks"}
            </div>
          </div>
          {data.playlist.editable ? (
            <PlaylistActionsMenu
              managing={managing}
              pending={pendingAction !== null}
              deletable={deletable}
              onRename={() => {
                const next = window.prompt("Playlist name", data.playlist?.name ?? "");
                if (next?.trim() && next.trim() !== data.playlist?.name) {
                  void runAction("rename", () => renamePlaylist(id, next));
                }
              }}
              onToggleManaging={() => setManaging((value) => !value)}
              onDelete={() => {
                setActionError(null);
                setDeleteDialogOpen(true);
              }}
            />
          ) : null}
        </div>
      </header>
      {actionError ? <div role="alert" className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{actionError}</div> : null}
      {managing && data.playlist.editable && data.songs.length > 0 ? (
        <ol className="mb-7 space-y-1 rounded-xl border border-white/[0.12] bg-white/[0.03] p-2">
          {data.songs.map((song, index) => (
            <li key={song.id} className="flex min-h-12 items-center gap-3 rounded-lg px-2">
              <span className="w-6 text-right text-xs text-white/[0.45]">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{song.title} <span className="text-white/[0.55]">— {song.artist}</span></span>
              <button
                type="button"
                aria-label={`Move ${song.title} up`}
                disabled={index === 0 || pendingAction !== null}
                onClick={() => {
                  const ids = data.songs.map((item) => item.id);
                  [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                  void runAction(`up-${song.id}`, () => reorderPlaylist(id, ids));
                }}
                className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/[0.09] disabled:opacity-30"
              ><ArrowUp size={16} /></button>
              <button
                type="button"
                aria-label={`Move ${song.title} down`}
                disabled={index === data.songs.length - 1 || pendingAction !== null}
                onClick={() => {
                  const ids = data.songs.map((item) => item.id);
                  [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                  void runAction(`down-${song.id}`, () => reorderPlaylist(id, ids));
                }}
                className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/[0.09] disabled:opacity-30"
              ><ArrowDown size={16} /></button>
              <button
                type="button"
                aria-label={`Remove ${song.title} from playlist`}
                disabled={pendingAction !== null}
                onClick={() => void runAction(`remove-${song.id}`, () => removeSongFromPlaylist(id, song.id))}
                className="grid h-10 w-10 place-items-center rounded-full text-red-300 hover:bg-red-400/10 disabled:opacity-30"
              ><X size={16} /></button>
            </li>
          ))}
        </ol>
      ) : null}
      {data.songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <SongGrid
          songs={data.songs}
          variant="playlist"
          likedSongIds={data.likedSongIds}
          canLike={!!user}
        />
      )}
      {deleteDialogOpen ? (
        <PlaylistDeleteDialog
          name={data.playlist.name}
          songsCount={data.songs.length}
          pending={pendingAction === "delete"}
          error={actionError}
          onCancel={() => setDeleteDialogOpen(false)}
          onConfirm={() => {
            void runAction("delete", () => deletePlaylist(id), false).then((deleted) => {
              if (!deleted) return;
              setDeleteDialogOpen(false);
              navigate("/playlists");
            });
          }}
        />
      ) : null}
    </div>
  );
}
