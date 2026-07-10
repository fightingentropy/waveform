import { useAuth } from "@/client/auth";
import { type HomePayload, useApiData, withAccountScope } from "@/client/api";
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
        <p className="mt-3 text-sm text-red-300">{songsState.error}</p>
        <button type="button" onClick={songsState.retry} className="mt-4 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">All Songs</h1>
        <p className="mt-1 text-sm text-white/[0.62]">{songsState.data.length} tracks in your library</p>
      </div>
      <SongGrid
        songs={songsState.data}
        likedSongIds={likesState.error ? null : likesState.data.likedSongIds}
        canLike={Boolean(user)}
        emptyLabel="Your library is empty. Upload music to get started."
      />
    </div>
  );
}
