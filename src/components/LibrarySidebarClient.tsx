"use client";

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, ChevronRight, Heart, Library, ListMusic, Music2, Podcast, RadioTower, Ticket } from "lucide-react";
import { cn } from "@/lib/utils";

type PlaylistEntry = {
  id: string;
  name: string;
  songsCount: number;
};

type LibrarySidebarClientProps = {
  userId: string | null;
  playlists: PlaylistEntry[];
  initialCollapsed: boolean;
};

const SIDEBAR_STATE_KEY = "spotify_left_sidebar_collapsed";

export default function LibrarySidebarClient({
  userId,
  playlists,
  initialCollapsed,
}: LibrarySidebarClientProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  useEffect(() => {
    // Persist to localStorage only. The cookie this used to write was a
    // Next.js leftover that nothing server-side reads (the SPA renders the
    // sidebar client-side and reads initialCollapsed from localStorage).
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0");
    } catch {}
    document.documentElement.style.setProperty(
      "--wf-left-sidebar-width",
      collapsed ? "4rem" : "16rem",
    );
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "hidden lg:flex fixed top-14 bottom-0 left-0 z-40 border-r border-white/[0.12] bg-background text-white transition-[width] duration-200",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className={cn("flex-1 overflow-y-auto", collapsed ? "p-2" : "p-4")}>
        <div className={cn("mb-4 flex items-center", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && (
            <div className="inline-flex items-center gap-2 text-[16px] font-medium text-white/[0.82]">
              <Library size={18} />
              <span>Your Library</span>
            </div>
          )}

          <div className={cn("flex items-center", collapsed ? "gap-0" : "gap-1")}>
            <button
              type="button"
              aria-label={collapsed ? "Expand library sidebar" : "Collapse library sidebar"}
              title={collapsed ? "Expand" : "Collapse"}
              onClick={() => setCollapsed((value) => !value)}
              className="h-8 w-8 rounded-full grid place-items-center text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white"
            >
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Link
            to="/liked"
            title="Liked Songs"
            className={cn(
                "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="h-10 w-10 rounded-[5px] bg-[#1ed760] text-black grid place-items-center shrink-0">
              <Heart size={18} />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[16px] font-medium leading-6 text-white">Liked Songs</div>
              </div>
            )}
          </Link>

          <Link
            to="/songs"
            title="All Songs"
            className={cn(
              "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[5px] bg-emerald-500/15 text-emerald-200">
              <Music2 size={18} />
            </div>
            {!collapsed && <div className="text-[16px] font-medium leading-6 text-white">All Songs</div>}
          </Link>

          <Link
            to="/radio"
            title="Radio Stations"
            className={cn(
                "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[5px] bg-cyan-500/15 text-cyan-200">
              <RadioTower size={18} />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[16px] font-medium leading-6 text-white">Radio Stations</div>
              </div>
            )}
          </Link>

          <Link
            to="/podcasts"
            title="Podcasts"
            className={cn(
                "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[5px] bg-fuchsia-500/15 text-fuchsia-200">
              <Podcast size={18} />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[16px] font-medium leading-6 text-white">Podcasts</div>
              </div>
            )}
          </Link>

          <Link
            to="/events"
            title="Live Events"
            className={cn(
                "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[5px] bg-violet-500/15 text-violet-200">
              <Ticket size={18} />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[16px] font-medium leading-6 text-white">Live Events</div>
              </div>
            )}
          </Link>

          {userId && playlists.length > 0 ? (
            <div className="mt-4 pt-4 border-t border-white/[0.12]">
              {!collapsed && (
                <div className="px-2.5 mb-2 text-[13px] uppercase tracking-wide text-white/[0.55]">
                  Custom playlists
                </div>
              )}
              <div className="space-y-1.5">
                {playlists.map((pl) => (
                  <Link
                    key={pl.id}
                    to={`/playlist/${pl.id}`}
                    title={pl.name}
                    className={cn(
                      "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
                      collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
                    )}
                  >
                    <div className="h-10 w-10 rounded-[5px] bg-white/[0.08] text-white/[0.78] grid place-items-center shrink-0">
                      <ListMusic size={18} />
                    </div>
                    {!collapsed && (
                      <div className="min-w-0">
                        <div className="text-[16px] font-medium leading-6 truncate text-white">{pl.name}</div>
                        <div className="text-[13px] leading-5 text-white/[0.62]">{pl.songsCount ?? 0} tracks</div>
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ) : !userId ? (
            <div className="mt-4 pt-4 border-t border-white/[0.12]">
              {!collapsed && (
                <>
                  <div className="px-2.5 mb-2 text-[13px] uppercase tracking-wide text-white/[0.55]">Custom playlists</div>
                  <div className="px-2.5 text-[15px] leading-6 text-white/[0.62]">
                    <Link className="underline underline-offset-2 hover:text-white" to="/signin">
                      Sign in
                    </Link>{" "}
                    to manage custom playlists.
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
