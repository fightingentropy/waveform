import { Link } from "react-router-dom";
import { Heart, ListMusic, Podcast, RadioTower, Ticket, Upload } from "lucide-react";
import { useApiData, withAccountScope, type LibraryPayload } from "@/client/api";
import { useAuth } from "@/client/auth";

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

export default function LibraryPage() {
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<LibraryPayload>(
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

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-5 text-2xl font-bold">Your Library</h1>
        <div className="space-y-2">
          <Link to="/liked" className="wf-list-row wf-pressable flex min-h-[64px] items-center gap-3 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-b from-[#4c1d95] to-emerald-500 text-white">
              <Heart size={24} fill="currentColor" />
            </div>
            <div>
              <div className="text-[15px] leading-snug">Liked Songs</div>
              <div className="mt-0.5 text-[13px] leading-snug text-[#b3b3b3]">Your favorites</div>
            </div>
          </Link>

          <Link to="/radio" className="wf-list-row wf-pressable flex min-h-[64px] items-center gap-3 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-b from-[#0e7490] to-[#22d3ee] text-white">
              <RadioTower size={24} />
            </div>
            <div>
              <div className="text-[15px] leading-snug">Radio Stations</div>
              <div className="mt-0.5 text-[13px] leading-snug text-[#b3b3b3]">Dromos 89.8 and BBC Radio 1</div>
            </div>
          </Link>

          <Link to="/podcasts" className="wf-list-row wf-pressable flex min-h-[64px] items-center gap-3 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-b from-[#86198f] to-[#d946ef] text-white">
              <Podcast size={24} />
            </div>
            <div>
              <div className="text-[15px] leading-snug">Podcasts</div>
              <div className="mt-0.5 text-[13px] leading-snug text-[#b3b3b3]">Huberman Lab and Modern Wisdom</div>
            </div>
          </Link>

          <Link to="/events" className="wf-list-row wf-pressable flex min-h-[64px] items-center gap-3 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-b from-[#7c3aed] to-[#4c1d95] text-white">
              <Ticket size={24} />
            </div>
            <div>
              <div className="text-[15px] leading-snug">Live Events</div>
              <div className="mt-0.5 text-[13px] leading-snug text-[#b3b3b3]">Concerts &amp; venues near you</div>
            </div>
          </Link>

          {showSkeleton ? (
            <PlaylistSkeletonRows />
          ) : (
            <>
              {signedIn && data.playlists.length > 0 ? (
                <div className="px-3 pb-2 pt-4 text-xs uppercase tracking-wide opacity-60">Playlists</div>
              ) : null}

              {signedIn
                ? data.playlists.map((playlist) => (
                    <Link
                      key={playlist.id}
                      to={`/playlist/${playlist.id}`}
                      className="wf-list-row wf-pressable flex min-h-[64px] items-center gap-3 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5"
                    >
                      <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-black/5 dark:bg-white/10">
                        <ListMusic size={24} className="opacity-80" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[15px] leading-snug">{playlist.name}</div>
                        <div className="mt-0.5 text-[13px] leading-snug text-[#b3b3b3]">Playlist • {playlist.songsCount} tracks</div>
                      </div>
                    </Link>
                  ))
                : null}

              {signedIn && data.playlists.length === 0 ? (
                <div className="px-3 pb-2 pt-4">
                  <div className="text-xs uppercase tracking-wide opacity-60">Playlists</div>
                  <div className="mt-2 text-sm opacity-70">
                    {error ?? "You don’t have any playlists yet."}
                  </div>
                </div>
              ) : null}

              {!signedIn ? (
                <div className="px-3 py-6 text-sm opacity-70">
                  <Link className="text-emerald-500 underline" to="/signin">Sign in</Link> to view your playlists.
                </div>
              ) : null}
            </>
          )}

          <Link to="/upload" className="wf-list-row wf-pressable flex min-h-[64px] items-center gap-3 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5 lg:hidden">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-b from-[#374151] to-[#6b7280] text-white"><Upload size={24} /></div>
            <div>
              <div className="text-[15px] leading-snug">Upload</div>
              <div className="mt-0.5 text-[13px] leading-snug text-[#b3b3b3]">Add new music</div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
