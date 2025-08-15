import { SongGrid } from "@/components/SongGrid";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function LikedPage() {
  // Mirror the Home page: treat local Top 100 folder as the user's liked library
  const top100Dir = join(process.cwd(), "public", "uploads", "audio", "top 100");
  let files: string[] = [];
  try {
    files = await readdir(top100Dir);
  } catch {
    files = [];
  }
  const folderEncoded = encodeURIComponent("top 100");
  const mp3Files = files.filter((f) => f.toLowerCase().endsWith(".mp3")).sort();
  const songs = mp3Files.map((f) => {
    const withoutExt = f.replace(/\.[^.]+$/, "");
    const withoutIndex = withoutExt.replace(/^\s*\d+\.\s*/, "");
    const sep = " - ";
    const idx = withoutIndex.indexOf(sep);
    const artist = idx !== -1 ? withoutIndex.slice(0, idx).trim() : "Unknown";
    const title = idx !== -1 ? withoutIndex.slice(idx + sep.length).trim() : withoutIndex.trim();
    return {
      id: `top100-${f}`,
      title,
      artist,
      imageUrl: `/api/artwork/${folderEncoded}/${encodeURIComponent(f)}`,
      audioUrl: `/uploads/audio/${folderEncoded}/${encodeURIComponent(f)}`,
    };
  });

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


