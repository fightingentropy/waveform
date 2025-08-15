import { SongGrid } from "@/components/SongGrid";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function LikedPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;

  const liked = userId
    ? await prisma.like.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { song: true },
      })
    : [];

  const songs = liked.map((l) => ({
    id: l.song.id,
    title: l.song.title,
    artist: l.song.artist,
    imageUrl: l.song.imageUrl,
    audioUrl: l.song.audioUrl,
  }));

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Liked Songs</h1>
      {!userId ? (
        <div className="opacity-70">Sign in to see your liked songs.</div>
      ) : songs.length === 0 ? (
        <div className="opacity-70">No liked songs yet.</div>
      ) : (
        <SongGrid songs={songs} />
      )}
      <div className="h-24" />
    </div>
  );
}


