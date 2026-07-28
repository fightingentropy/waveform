import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ArrowDown, ArrowUp, Pause, Pencil, Play, Trash2, X } from "lucide-react";
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
import { SongGrid } from "@/components/SongGrid";
import { cn } from "@/lib/utils";
import type { PlayerSong } from "@/types/player";
import { deletePlaylist, removeSongFromPlaylist, renamePlaylist, reorderPlaylist } from "@/client/playlist-actions";

function PlaylistLoadingSkeleton() {
  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="mb-8 space-y-3">
        <div className="wf-skeleton h-7 w-56 max-w-full rounded-full" />
        <div className="wf-skeleton h-4 w-24 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="space-y-3">
            <div className="wf-skeleton aspect-square rounded-lg" />
            <div className="wf-skeleton h-4 rounded-full" />
            <div className="wf-skeleton h-3 w-2/3 rounded-full" />
          </div>
        ))}
      </div>
    </div>
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
    <div className="px-6 py-8 max-w-5xl mx-auto">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="relative h-44 w-44 shrink-0 overflow-hidden rounded-lg bg-white/[0.08] shadow-[0_10px_28px_rgba(0,0,0,0.45)]">
          <CoverImage src={playlist.imageUrl || undefined} alt={playlist.name} fill sizes="176px" className="object-cover" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Playlist</div>
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
          <div className="mb-5">
            <button
              type="button"
              onClick={handleHeaderPlay}
              aria-label={headerIsPlaying ? `Pause ${playlist.name}` : `Play ${playlist.name}`}
              className="grid h-14 w-14 place-items-center rounded-full bg-[#1ed760] text-black shadow-lg transition hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121212] wf-control-button"
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
                        <Pause size={16} className="text-[#1ed760]" fill="currentColor" />
                      ) : active ? (
                        <Play size={16} className="text-[#1ed760]" fill="currentColor" />
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
                      <div className={cn("truncate text-[15px] leading-snug text-white", active && "text-[#1ed760]")}>
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const runAction = async (key: string, action: () => Promise<unknown>) => {
    setPendingAction(key);
    setActionError(null);
    try {
      await action();
      retry();
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
      <p className="text-red-300">{error}</p>
      <button type="button" onClick={retry} className="mt-4 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">Try again</button>
    </div>
  );

  if (data.kind === "curated") return <CuratedPlaylistView data={data} />;

  if (!data.playlist) return <div className="px-6 py-8 max-w-7xl mx-auto opacity-70">Playlist not found.</div>;

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="mb-4 flex flex-col items-start gap-3 sm:mb-6 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{data.playlist.name}</h1>
          <div className="mt-1 text-sm opacity-70">{data.songs.length} tracks</div>
        </div>
        {data.playlist.editable ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                const next = window.prompt("Playlist name", data.playlist?.name ?? "");
                if (next?.trim() && next.trim() !== data.playlist?.name) {
                  void runAction("rename", () => renamePlaylist(id, next));
                }
              }}
              disabled={pendingAction !== null}
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.16] px-3 py-2 text-sm disabled:opacity-45"
            >
              <Pencil size={15} /> Rename
            </button>
            <button
              type="button"
              onClick={() => setManaging((value) => !value)}
              className="rounded-full border border-white/[0.16] px-3 py-2 text-sm"
            >
              {managing ? "Done" : "Manage tracks"}
            </button>
            {!id.startsWith("local-folder-") ? (
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(`Delete “${data.playlist?.name}”?`)) return;
                  void runAction("delete", () => deletePlaylist(id)).then((deleted) => {
                    if (deleted) navigate("/library");
                  });
                }}
                disabled={pendingAction !== null}
                className="inline-flex items-center gap-2 rounded-full border border-red-400/40 px-3 py-2 text-sm text-red-300 disabled:opacity-45"
              >
                <Trash2 size={15} /> Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {actionError ? <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{actionError}</div> : null}
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
          likedSongIds={data.likedSongIds}
          canLike={!!user}
          viewToggleClassName="mb-8 sm:-mt-14"
        />
      )}
    </div>
  );
}
