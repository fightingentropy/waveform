import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Heart, ListMusic, Music2, Plus, Podcast, RadioTower, Search, Ticket, Upload } from "lucide-react";
import { AuthButtons } from "@/components/AuthButtons";
import { CoverImage } from "@/components/CoverImage";
import { PageError } from "@/components/PageError";
import { PlaylistArtwork } from "@/components/PlaylistArtwork";
import { useApiData, withAccountScope, type LibraryPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { createPlaylist } from "@/client/playlist-actions";
import { PODCAST_SHOWS, podcastMediaProxyUrl } from "@/lib/podcasts";

type LibraryFilter = "all" | "playlists" | "podcasts";

function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "relative mr-6 min-h-11 px-0 text-sm transition-colors",
        active ? "font-semibold text-[#f2f2f2]" : "font-medium text-white/60 hover:text-white",
      ].join(" ")}
    >
      {label}
      <span
        aria-hidden
        className={[
          "absolute inset-x-0 bottom-0 h-[1.5px] bg-[#f2f2f2] transition-opacity",
          active ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />
    </button>
  );
}

function LibraryShortcut({
  to,
  title,
  subtitle,
  artwork,
  children,
}: {
  to: string;
  title: string;
  subtitle: string;
  artwork?: {
    src?: string | null;
  };
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="wf-list-row wf-pressable flex min-h-[62px] items-center gap-3 px-0 py-[7px] touch-manipulation hover:bg-white/[0.045]"
    >
      <span
        className={[
          "grid shrink-0 place-items-center overflow-hidden rounded-lg bg-white/[0.075] text-white/60",
          artwork ? "h-[62px] w-[62px]" : "h-11 w-11",
        ].join(" ")}
      >
        {artwork?.src ? (
          <CoverImage
            src={artwork.src}
            alt=""
            width={62}
            height={62}
            className="h-full w-full object-cover"
            sizes="62px"
          />
        ) : (
          children
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-semibold tracking-[-0.2px] text-[#f2f2f2]">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-sm text-white/60">{subtitle}</span>
      </span>
    </Link>
  );
}

function PlaylistSkeletonRows() {
  return (
    <div className="space-y-2 px-3 py-2" aria-hidden>
      {[0, 1, 2].map((item) => (
        <div key={item} className="flex min-h-[64px] items-center gap-3 rounded-xl">
          <div className="wf-skeleton h-14 w-14 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="wf-skeleton h-4 w-44 max-w-full rounded-full" />
            <div className="wf-skeleton h-3 w-24 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PlaylistGridSkeleton() {
  return (
    <div
      className="grid gap-x-3 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(164px,1fr))]"
      aria-hidden
    >
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="min-w-0">
          <div className="wf-skeleton aspect-square rounded-xl" />
          <div className="mt-3 space-y-2">
            <div className="wf-skeleton h-4 w-4/5 rounded-full" />
            <div className="wf-skeleton h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LibraryPage({ playlistOnly = false }: { playlistOnly?: boolean }) {
  const { user, status } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get("filter");
  const filter: LibraryFilter =
    playlistOnly
      ? "playlists"
      : requestedFilter === "playlists" || requestedFilter === "podcasts"
        ? requestedFilter
        : "all";
  const [creating, setCreating] = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, loading, error, retry } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    {
      playlists: [],
      userId: null,
    },
  );
  // Drive the playlists section from real auth state — NOT data.userId, which is
  // null during the cold-load window (and on a fetch error) even for a signed-in
  // user, which would otherwise flash a "Sign in" prompt at them.
  const signedIn = !!user;
  const showSkeleton = status === "loading" || (signedIn && loading && data.playlists.length === 0);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const name = playlistName.trim();
    if (!name) return;
    setCreating(true);
    setActionError(null);
    try {
      const playlist = await createPlaylist(name);
      setPlaylistName("");
      retry();
      navigate(`/playlist/${playlist.id}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't create the playlist.");
    } finally {
      setCreating(false);
    }
  };

  const showPlaylists = filter === "all" || filter === "playlists";
  const toggleFilter = (nextFilter: LibraryFilter) => {
    const resolvedFilter = filter === nextFilter ? "all" : nextFilter;
    const nextSearchParams = new URLSearchParams(searchParams);
    if (resolvedFilter === "all") nextSearchParams.delete("filter");
    else nextSearchParams.set("filter", resolvedFilter);
    setSearchParams(nextSearchParams);
  };

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-black px-4 pb-8 pt-[18px] text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-[18px] flex items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="lg:hidden">
              <AuthButtons compact />
            </div>
            <h1 className="truncate text-[34px] font-bold leading-10 tracking-[-0.9px] text-[#f2f2f2]">
              {filter === "playlists" ? "Playlists" : "Library"}
            </h1>
          </div>
          <div className="flex items-center">
            <Link
              to="/search"
              aria-label="Search"
              className="wf-control-button grid h-11 w-11 place-items-center rounded-full text-[#f2f2f2] hover:bg-white/[0.06]"
            >
              <Search size={20} strokeWidth={2.2} />
            </Link>
            <Link
              to="/upload"
              aria-label="Add music"
              className="wf-control-button grid h-11 w-11 place-items-center rounded-full text-[#f2f2f2] hover:bg-white/[0.06]"
            >
              <Plus size={22} strokeWidth={2.2} />
            </Link>
          </div>
        </div>

        {!playlistOnly ? (
          <div className="mb-3 flex">
            <FilterButton label="All" active={filter === "all"} onClick={() => toggleFilter("all")} />
            <FilterButton
              label="Playlists"
              active={filter === "playlists"}
              onClick={() => toggleFilter("playlists")}
            />
            <FilterButton
              label="Podcasts"
              active={filter === "podcasts"}
              onClick={() => toggleFilter("podcasts")}
            />
          </div>
        ) : null}

        <div>
          {filter === "all" ? (
            <LibraryShortcut to="/liked" title="Liked Songs" subtitle={`Playlist • ${user?.name || "You"}`}>
              <Heart size={20} fill="currentColor" className="text-[#f2f2f2]" />
            </LibraryShortcut>
          ) : null}

          {filter === "all" ? (
            <>
              <LibraryShortcut to="/songs" title="All Songs" subtitle="Browse your full library">
                <Music2 size={20} />
              </LibraryShortcut>
              <LibraryShortcut to="/radio" title="Radio Stations" subtitle="Live streams">
                <RadioTower size={20} />
              </LibraryShortcut>
            </>
          ) : null}

          {filter === "all" ? (
            <LibraryShortcut to="/podcasts" title="Podcasts" subtitle="Shows & episodes">
              <Podcast size={20} />
            </LibraryShortcut>
          ) : null}

          {filter === "podcasts"
            ? PODCAST_SHOWS.map((podcastShow) => (
                <LibraryShortcut
                  key={podcastShow.id}
                  to={`/podcasts?show=${encodeURIComponent(podcastShow.id)}`}
                  title={podcastShow.title}
                  subtitle={`Podcast • ${podcastShow.author}`}
                  artwork={{
                    src: podcastMediaProxyUrl(podcastShow.id, podcastShow.imageUrl),
                  }}
                >
                  <Podcast size={22} />
                </LibraryShortcut>
              ))
            : null}

          {filter === "all" ? (
            <LibraryShortcut to="/events" title="Live Events" subtitle="Concerts & venues near you">
              <Ticket size={20} />
            </LibraryShortcut>
          ) : null}

          {showPlaylists ? (
            showSkeleton ? (
              filter === "playlists" ? <PlaylistGridSkeleton /> : <PlaylistSkeletonRows />
            ) : (
              <>
                <div className="flex items-center justify-between pb-2 pt-5">
                  <span className="text-[13px] font-medium text-white/60">
                    {filter === "playlists"
                      ? `${data.playlists.length} ${data.playlists.length === 1 ? "playlist" : "playlists"}`
                      : "Playlists"}
                  </span>
                  <label htmlFor="new-playlist-name" className="inline-flex items-center gap-1 text-[13px] font-medium text-white/60">
                    <Plus size={14} /> New playlist
                  </label>
                </div>

                {signedIn ? (
                  <form onSubmit={handleCreate} className="mb-3 flex gap-2">
                    <input
                      id="new-playlist-name"
                      value={playlistName}
                      onChange={(event) => setPlaylistName(event.target.value)}
                      placeholder="Playlist name"
                      maxLength={80}
                      className="h-11 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#0c0c0d] px-3 text-sm outline-none focus:border-white/20 focus:ring-2 focus:ring-white/10"
                    />
                    <button
                      type="submit"
                      disabled={creating || !playlistName.trim()}
                      className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black disabled:opacity-45"
                    >
                      {creating ? "Creating..." : "Create"}
                    </button>
                  </form>
                ) : null}

                {actionError ? <div className="mb-3 text-sm text-red-300">{actionError}</div> : null}

                {signedIn ? (
                  filter === "playlists" ? (
                    <div className="grid gap-x-3 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(164px,1fr))]">
                      {data.playlists.map((playlist, index) => (
                        <Link
                          key={playlist.id}
                          to={`/playlist/${playlist.id}`}
                          className="wf-song-card group min-w-0 touch-manipulation"
                        >
                          <PlaylistArtwork
                            coverImageUrls={playlist.coverImageUrls}
                            imageUrl={playlist.imageUrl}
                            sizes="(max-width: 639px) 45vw, 190px"
                            loading={index < 6 ? "eager" : "lazy"}
                            className="w-full"
                          />
                          <div className="min-h-12 min-w-0 px-px pt-[9px]">
                            <div className="truncate text-[15.5px] font-bold leading-[21px] tracking-[-0.15px] text-[#f2f2f2]">
                              {playlist.name}
                            </div>
                            <div className="mt-px truncate text-[13.5px] leading-[19px] text-white/[0.58]">
                              {playlist.songsCount} {playlist.songsCount === 1 ? "track" : "tracks"}
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    data.playlists.map((playlist) => (
                        <LibraryShortcut
                          key={playlist.id}
                          to={`/playlist/${playlist.id}`}
                          title={playlist.name}
                          subtitle={`Playlist • ${playlist.songsCount} tracks`}
                          artwork={{
                            src: playlist.imageUrl,
                          }}
                        >
                          <ListMusic size={22} />
                        </LibraryShortcut>
                      ))
                  )
                ) : null}

                {signedIn && error ? (
                  <div className="pb-2 pt-4">
                    <PageError compact message={error} onRetry={retry} />
                  </div>
                ) : null}

                {signedIn && !error && data.playlists.length === 0 ? (
                  <div className="pb-2 text-sm text-white/60">You don’t have any playlists yet.</div>
                ) : null}

                {!signedIn ? (
                  <div className="py-6 text-sm text-white/60">
                    <Link className="text-white underline" to="/signin">Sign in</Link> to view your playlists.
                  </div>
                ) : null}
              </>
            )
          ) : null}

          {filter === "all" ? (
            <LibraryShortcut to="/upload" title="Import your music" subtitle="Add new music">
              <Upload size={20} />
            </LibraryShortcut>
          ) : null}
        </div>
      </div>
    </div>
  );
}
