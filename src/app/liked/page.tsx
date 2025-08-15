import { SongGrid } from "@/components/SongGrid";
import { prisma } from "@/lib/prisma";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function LikedPage() {
  // Treat user's own created songs as "Liked" for now
  const rows = await prisma.song.findMany({ orderBy: { createdAt: "desc" } });
  const songs = rows.map((r) => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    imageUrl: r.imageUrl,
    audioUrl: r.audioUrl,
  }));

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Liked Songs</h1>
      {songs.length === 0 ? (
        <div className="opacity-70">No liked songs yet.</div>
      ) : (
        <SongGrid songs={songs} />
      )}
      <div className="h-24" />
    </div>
  );
}


