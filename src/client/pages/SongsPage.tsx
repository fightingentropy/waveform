import { useAuth } from "@/client/auth";
import { type HomePayload, useApiData, withAccountScope } from "@/client/api";
import { PageError } from "@/components/PageError";
import { SongGrid } from "@/components/SongGrid";
import type { PlayerSong } from "@/types/player";

export default function SongsPage() {
  const { user, status } = useAuth();
  const scope = user?.id ?? status;
  const songsState = useApiData<PlayerSong[]>(withAccountScope("/api/songs", scope), [], {
    enabled: status !== "loading",
    keepPreviousData: true,
  });
  const likesState = useApiData<HomePayload>(
    withAccountScope("/api/home", scope),
    { likedSongIds: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );

  if ((songsState.loading && songsState.data.length === 0) || status === "loading") {
    return <div className="px-6 py-8 text-white/[0.68]">Loading songs...</div>;
  }

  if (songsState.error) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-8">
        <h1 className="text-2xl font-semibold">All Songs</h1>
        <div className="mt-3">
          <PageError compact message={songsState.error} onRetry={songsState.retry} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">All Songs</h1>
        <p className="mt-1 text-sm text-white/[0.62]">{songsState.data.length} tracks in your library</p>
      </div>
      {likesState.error ? (
        <div className="mb-4">
          <PageError
            compact
            message={`Liked songs couldn’t load. ${likesState.error}`}
            onRetry={likesState.retry}
          />
        </div>
      ) : null}
      <SongGrid
        songs={songsState.data}
        likedSongIds={likesState.data.likedSongIds}
        canLike={Boolean(user)}
        emptyLabel="Your library is empty. Upload music to get started."
      />
    </div>
  );
}
