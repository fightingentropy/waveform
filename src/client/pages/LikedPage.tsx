import { Link } from "react-router-dom";
import { useEffect } from "react";
import { useApiData, withAccountScope, type LikedPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";

function SongGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" aria-hidden>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
        <div key={item} className="space-y-3">
          <div className="wf-skeleton aspect-square rounded-lg" />
          <div className="wf-skeleton h-4 rounded-full" />
          <div className="wf-skeleton h-3 w-2/3 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function LikedPage() {
  const { user, status, refresh } = useAuth();
  const authSettled = status !== "loading";
  const { data, loading, error, retry } = useApiData<LikedPayload>(
    withAccountScope(user ? "/api/liked" : "/api/likes", user?.id ?? status),
    {
      songs: [],
      likedSongIds: [],
    },
    {
      enabled: authSettled,
      keepPreviousData: true,
    },
  );
  // useApiData surfaces errors as plain strings (no status code), so detect
  // auth failures by matching the 401/Unauthorized copy the Worker returns.
  // Broadened from exact equality to a substring check so variants like
  // "Request failed with 401" or a server-supplied "Unauthorized" message all
  // trigger a session refresh.
  const isAuthError = !!error && (/\b401\b/.test(error) || /unauthor/i.test(error));
  const songs = Array.isArray(data.songs) ? data.songs : [];
  const legacyLikes = (data as unknown as { likes?: unknown }).likes;
  const likedSongIds = Array.isArray(data.likedSongIds)
    ? data.likedSongIds
    : Array.isArray(legacyLikes)
      ? legacyLikes.filter((id): id is string => typeof id === "string")
      : [];

  useEffect(() => {
    if (isAuthError) void refresh();
  }, [isAuthError, refresh]);

  if (!authSettled) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
        <div className="mx-auto max-w-7xl">
          <h1 className="mb-6 text-2xl font-semibold">Liked Songs</h1>
          <SongGridSkeleton />
        </div>
      </div>
    );
  }

  if (!user || isAuthError) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
        <div className="mx-auto max-w-7xl">
          <h1 className="mb-6 text-2xl font-semibold">Liked Songs</h1>
          <div className="opacity-70">
            <Link className="underline" to="/signin">Sign in</Link> to view and manage your liked songs.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-4 text-2xl font-semibold leading-tight sm:mb-6">Liked Songs</h1>
        {loading && songs.length === 0 ? (
          <SongGridSkeleton />
        ) : error ? (
          <div>
            <p className="text-red-300">{error}</p>
            <button type="button" onClick={retry} className="mt-4 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">Try again</button>
          </div>
        ) : songs.length === 0 ? (
          <div className="opacity-70">You haven&apos;t liked any songs yet.</div>
        ) : (
          <SongGrid
            songs={songs}
            likedSongIds={likedSongIds}
            hideIfUnliked
            canLike
            emptyLabel="You haven't liked any songs yet."
            viewToggleClassName="mb-8 sm:-mt-14"
          />
        )}
      </div>
    </div>
  );
}
