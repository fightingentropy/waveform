import { prisma } from "@/lib/prisma";
import { SongGrid } from "@/components/SongGrid";
import { notFound } from "next/navigation";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const playlist = await prisma.playlist.findUnique({
    where: { id },
    include: { songs: { include: { song: true }, orderBy: { order: "asc" } } },
  });
  if (!playlist) return notFound();

  const songs = playlist.songs.map((ps) => ({
    id: ps.song.id,
    title: ps.song.title,
    artist: ps.song.artist,
    imageUrl: ps.song.imageUrl,
    audioUrl: ps.song.audioUrl,
  }));

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold mb-1">{playlist.name}</h1>
      <div className="text-sm opacity-70 mb-6">{songs.length} tracks</div>
      {songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <SongGrid songs={songs} />
      )}
      <div className="h-24" />
    </div>
  );
}


