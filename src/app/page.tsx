import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { SongGrid } from "@/components/SongGrid";

export default async function Home() {
  const songs = await prisma.song.findMany({ orderBy: { createdAt: "desc" } });
  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Home</h1>
        <Link href="/upload" className="h-9 px-4 rounded bg-foreground text-background">
          Upload
        </Link>
      </div>
      {songs.length === 0 ? (
        <div className="opacity-70">No songs yet. Upload your first song.</div>
      ) : (
        <SongGrid
          songs={songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, imageUrl: s.imageUrl, audioUrl: s.audioUrl }))}
        />
      )}
      <div className="h-24" />
    </div>
  );
}
