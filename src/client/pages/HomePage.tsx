import { useCallback, useEffect, useMemo } from "react";
import { Link } from "react-router";
import { Pause, Play } from "lucide-react";
import { AuthButtons } from "@/components/AuthButtons";
import { CoverImage } from "@/components/CoverImage";
import {
  useApiData,
  withAccountScope,
  type DiscoverPlaylistsPayload,
  type HomePayload,
  type StatsHomePayload,
} from "@/client/api";
import { useAuth } from "@/client/auth";
import { warmPlaybackSong } from "@/client/playback-warm";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn } from "@/lib/utils";
import type { PlayerSong } from "@/types/player";

type HomeSong = PlayerSong & {
  album?: string | null;
  duration?: number | null;
  durationMs?: number | null;
};

function greetingForNow(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const { user, status } = useAuth();
  const { data: homeData, loading, error, retry } = useApiData<HomePayload>(
    withAccountScope("/api/home", user?.id ?? status),
    {
      songs: [],
      likedSongIds: [],
    },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );
  // Hydrate the likes store from Home. Home no longer renders a SongGrid (which
  // used to do this), so without this the like buttons stay disabled until the
  // user opens a page that lists songs — including the heart for Discover tracks.
  const mergeInitialLikes = useLikesStore((state) => state.mergeInitial);
  useEffect(() => {
    mergeInitialLikes(homeData.likedSongIds);
  }, [mergeInitialLikes, homeData.likedSongIds]);
  const { data: statsData } = useApiData<StatsHomePayload>(
    withAccountScope("/api/stats/home", user?.id ?? status),
    {
      recentlyPlayed: [],
      mostPlayed: [],
    },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );
  // The Discover row: auto-updating PLAYLIST cards (Top 50 + the YouTube Music
  // Discover Mix), not individual tracks — same as the iOS app. Each card opens
  // its playlist detail page. Scoped by account: the mix card is only returned
  // for signed-in callers.
  const { data: discoverData } = useApiData<DiscoverPlaylistsPayload>(
    withAccountScope("/api/discover/playlists", user?.id ?? status),
    { playlists: [] },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );
  const discoverPlaylists = discoverData.playlists;

  const setQueue = usePlayerStore((state) => state.setQueue);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const currentSongId = usePlayerStore((state) => state.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((state) => state.isPlaying);

  const resolveHomeSong = useCallback((song: HomeSong): HomeSong => song, []);

  const warmSongSoon = useCallback((song: HomeSong) => {
    warmPlaybackSong(song, true);
  }, []);

  const recentlyPlayedSongs = statsData.recentlyPlayed as HomeSong[];
  const mostPlayedSongs = useMemo(
    () => statsData.mostPlayed.map((entry) => entry.song as HomeSong),
    [statsData.mostPlayed],
  );

  const handlePlayScrollerSong = (songs: HomeSong[], index: number) => {
    const song = songs[index];
    if (!song) return;
    if (song.id === currentSongId) {
      if (isPlaying) pause();
      else {
        requestImmediatePlayback(song);
        play();
      }
      return;
    }
    requestImmediatePlayback(song);
    setQueue(songs, index);
  };

  const renderScrollerTile = (songs: HomeSong[], index: number, subtitle?: string) => {
    const song = songs[index];
    if (!song) return null;
    const displaySong = resolveHomeSong(song);
    const active = currentSongId === song.id;

    return (
      <div
        key={song.id}
        onPointerEnter={() => warmSongSoon(displaySong)}
        onFocus={() => warmSongSoon(displaySong)}
        // The whole card plays on tap: the floating play button only appears
        // on hover, which touch devices never see. It stopPropagation()s, so
        // pointer users don't double-toggle.
        onClick={() => handlePlayScrollerSong(songs, index)}
        className={cn(
          "wf-song-card group w-[164px] shrink-0 cursor-pointer touch-manipulation",
          "focus-within:outline-none",
        )}
      >
        <div
          className={cn(
            "relative aspect-square overflow-hidden rounded-xl bg-white/[0.045]",
            active && "ring-1 ring-inset ring-white/30",
          )}
        >
          <CoverImage
            src={displaySong.imageUrl}
            networkSrc={displaySong.networkImageUrl}
            alt={displaySong.title}
            fill
            sizes="160px"
            className="wf-song-cover object-cover"
            loading={index < 6 ? "eager" : "lazy"}
          />
          <button
            type="button"
            aria-label={active && isPlaying ? `Pause ${displaySong.title}` : `Play ${displaySong.title}`}
            onClick={(event) => {
              event.stopPropagation();
              handlePlayScrollerSong(songs, index);
            }}
            className={cn(
              "absolute bottom-2.5 right-2.5 grid h-[42px] w-[42px] place-items-center rounded-full border border-white/25 bg-black/55 text-white shadow-lg backdrop-blur-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              "wf-control-button",
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            {active && isPlaying ? (
              <Pause size={21} fill="currentColor" />
            ) : (
              <Play size={21} fill="currentColor" className="translate-x-0.5" />
            )}
          </button>
        </div>
        <div className="min-h-12 min-w-0 px-px pt-[9px]">
          <div className="truncate text-[15.5px] font-bold leading-[21px] tracking-[-0.15px] text-[#f2f2f2]">
            {displaySong.title}
          </div>
          <div className="mt-px truncate text-[13.5px] leading-[19px] text-white/[0.62]">
            {displaySong.artist || "Unknown Artist"}
          </div>
          {subtitle ? (
            <div className="mt-0.5 truncate text-[12.5px] leading-[17px] text-white/40">{subtitle}</div>
          ) : null}
        </div>
      </div>
    );
  };

  const renderDiscoverPlaylistTile = (playlist: DiscoverPlaylistsPayload["playlists"][number]) => (
    <Link
      key={playlist.id}
      to={`/playlist/${playlist.id}`}
      className="wf-song-card group w-[164px] shrink-0 cursor-pointer touch-manipulation"
    >
      <div className="relative aspect-square overflow-hidden rounded-xl bg-white/[0.045]">
        <CoverImage
          src={playlist.imageUrl || undefined}
          alt={playlist.name}
          fill
          sizes="160px"
          className="wf-song-cover object-cover"
          loading="lazy"
        />
      </div>
      <div className="min-h-12 min-w-0 px-px pt-[9px]">
        <div className="truncate text-[15.5px] font-bold leading-[21px] tracking-[-0.15px] text-[#f2f2f2]">
          {playlist.name}
        </div>
        <div className="mt-px truncate text-[13.5px] leading-[19px] text-white/[0.58]">
          {playlist.songsCount > 0 ? `Playlist • ${playlist.songsCount} songs` : "Playlist"}
        </div>
      </div>
    </Link>
  );

  if (loading || status === "loading") {
    return (
      <div className="min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-12">
        <div className="opacity-70">Loading library...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-12">
        <div role="alert" className="max-w-md rounded-lg border border-white/10 bg-white/[0.04] p-6">
          <h1 className="text-xl font-semibold">Your library couldn’t load</h1>
          <p className="mt-2 text-sm leading-6 text-white/65">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:scale-[1.02] hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-[calc(100vh-3.5rem)] overflow-x-hidden bg-background text-white">
      <div className="relative px-4 pb-10 pt-3.5 sm:px-6 lg:px-6 lg:pt-8 xl:px-8 2xl:px-10">
        <div className="mb-7 flex items-center gap-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-[18px] text-white/60">
              {user?.name?.trim()
                ? `${greetingForNow()}, ${user.name.trim().split(/\s+/)[0]}`
                : greetingForNow()}
            </p>
            <h1 className="mt-1 text-[34px] font-bold leading-[39px] tracking-[-0.9px] text-[#f2f2f2]">
              Listen now
            </h1>
          </div>
          <div className="lg:hidden">
            <AuthButtons compact />
          </div>
        </div>

        {discoverPlaylists.length > 0 ? (
          <section aria-label="Discover" className="mb-[34px]">
            <h2 className="mb-3.5 text-[22px] font-bold tracking-[-0.35px]">Discover</h2>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
              {discoverPlaylists.map((playlist) => renderDiscoverPlaylistTile(playlist))}
            </div>
          </section>
        ) : null}

        {recentlyPlayedSongs.length > 0 ? (
          <section aria-label="Continue listening" className="mb-[34px]">
            <h2 className="mb-3.5 text-[22px] font-bold tracking-[-0.35px]">Continue listening</h2>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
              {recentlyPlayedSongs.map((_, index) => renderScrollerTile(recentlyPlayedSongs, index))}
            </div>
          </section>
        ) : null}

        {statsData.mostPlayed.length > 0 ? (
          <section aria-label="Most played" className="mb-[34px]">
            <h2 className="mb-3.5 text-[22px] font-bold tracking-[-0.35px]">Most played</h2>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
              {statsData.mostPlayed.map((entry, index) =>
                renderScrollerTile(
                  mostPlayedSongs,
                  index,
                  entry.playCount > 0
                    ? `${entry.playCount} ${entry.playCount === 1 ? "play" : "plays"}`
                    : undefined,
                ),
              )}
            </div>
          </section>
        ) : null}

        {discoverPlaylists.length === 0 &&
        recentlyPlayedSongs.length === 0 &&
        statsData.mostPlayed.length === 0 ? (
          <div className="mx-auto mt-9 max-w-[270px] px-7 py-6 text-center">
            <h2 className="text-[17px] font-bold text-[#f2f2f2]">Nothing here yet</h2>
            <p className="mt-1.5 text-sm leading-5 text-white/60">
              Start playing something and it will appear here.
            </p>
          </div>
        ) : null}

        <div className="h-8 lg:h-20" />
      </div>
    </div>
  );
}
