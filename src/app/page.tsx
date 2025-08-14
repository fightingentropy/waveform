import Link from "next/link";
import { SongGrid } from "@/components/SongGrid";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const revalidate = 0;
export const runtime = "nodejs";

function parseArtistAndTitle(fileName: string): { artist: string; title: string } {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  const withoutIndex = withoutExt.replace(/^\s*\d+\.\s*/, "");
  const sep = " - ";
  const idx = withoutIndex.indexOf(sep);
  if (idx !== -1) {
    const artist = withoutIndex.slice(0, idx).trim();
    const title = withoutIndex.slice(idx + sep.length).trim();
    return { artist: artist || "Unknown", title: title || withoutIndex };
  }
  return { artist: "Unknown", title: withoutIndex.trim() };
}

export default async function Home() {
  const top100Dir = join(process.cwd(), "public", "uploads", "audio", "top 100");
  let files: string[] = [];
  try {
    files = await readdir(top100Dir);
  } catch {
    files = [];
  }

  const folderEncoded = encodeURIComponent("top 100");
  const mp3Files = files.filter((f) => f.toLowerCase().endsWith(".mp3")).sort();
  const songs = mp3Files.map((f, i) => {
    const { artist, title } = parseArtistAndTitle(f);
    return {
      id: `top100-${f}`,
      title,
      artist,
      imageUrl: `/uploads/images/helix-${(i % 3) + 1}.jpg`,
      audioUrl: `/uploads/audio/${folderEncoded}/${encodeURIComponent(f)}`,
    };
  });

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Home</h1>
        <Link href="/upload" className="h-9 px-4 rounded bg-foreground text-background">
          Upload
        </Link>
      </div>
      {songs.length === 0 ? (
        <div className="opacity-70">No songs found in Top 100.</div>
      ) : (
        <SongGrid songs={songs} />
      )}
      <div className="h-24" />
    </div>
  );
}
