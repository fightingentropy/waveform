import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Library, Heart, ListMusic, Plus } from "lucide-react";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export default async function LibrarySidebar() {
  const session = await getServerSession(authOptions);

  // Count local library files as "Liked Songs"
  let likesCount = 0;
  try {
    const top100Dir = join(process.cwd(), "public", "uploads", "audio", "top 100");
    const files = await readdir(top100Dir);
    likesCount = files.filter((f) => f.toLowerCase().endsWith(".mp3")).length;
  } catch {
    likesCount = 0;
  }

  const userId = (session?.user as { id?: string } | undefined)?.id;
  const playlists = userId
    ? await prisma.playlist.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { songs: true } } },
      })
    : [];

  return (
    <aside className="hidden lg:flex fixed top-14 bottom-0 left-0 w-64 z-40 border-r border-black/10 dark:border-white/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-sm font-medium opacity-80">
            <Library size={16} />
            <span>Your Library</span>
          </div>
          <button
            title="Create playlist (coming soon)"
            className="h-7 w-7 rounded-md grid place-items-center bg-black/5 dark:bg-white/10 opacity-70 cursor-default"
            aria-disabled
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="space-y-1">
          <Link href="/liked" className="flex items-center gap-3 px-2 py-2 rounded hover:bg-black/5 dark:hover:bg-white/5">
            <div className="h-8 w-8 rounded bg-gradient-to-br from-emerald-500 to-emerald-700 text-white grid place-items-center">
              <Heart size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">Liked Songs</div>
              <div className="text-xs opacity-70">{likesCount} liked</div>
            </div>
          </Link>

          {userId ? (
            playlists.length > 0 && (
            <div className="mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              <div className="px-2 mb-2 text-xs uppercase tracking-wide opacity-60">Playlists</div>
              <div className="space-y-1">
                {playlists.map((pl) => (
                  <Link
                    key={pl.id}
                    href={`/playlist/${pl.id}`}
                    className="flex items-center gap-3 px-2 py-2 rounded hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <div className="h-8 w-8 rounded bg-black/5 dark:bg-white/10 grid place-items-center">
                      <ListMusic size={16} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{pl.name}</div>
                      <div className="text-xs opacity-70">{pl._count?.songs ?? 0} tracks</div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
            )
          ) : (
            <div className="mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              <div className="px-2 mb-2 text-xs uppercase tracking-wide opacity-60">Playlists</div>
              <div className="px-2 text-sm opacity-70">
                <Link className="underline" href="/signin">Sign in</Link> to manage playlists.
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}


