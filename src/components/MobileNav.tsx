"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { createPlaylist } from "@/client/playlist-actions";
import { cn } from "@/lib/utils";
import { useModalDialogFocus } from "@/lib/use-modal-dialog";

type TabIconProps = { active: boolean };

// Spotify Encore tab icons (24px grid): outline at rest, filled when active.
function HomeTabIcon({ active }: TabIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden>
      {active ? (
        <path d="M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z" />
      ) : (
        <path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z" />
      )}
    </svg>
  );
}

function SearchTabIcon({ active }: TabIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden>
      <path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" />
      {active ? <circle cx="10.533" cy="10.558" r="4.75" /> : null}
    </svg>
  );
}

function LibraryTabIcon({ active }: TabIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden>
      {active ? (
        <path d="M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z" />
      ) : (
        <path d="M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM16 4.732V20h4V7.041l-4-2.309zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z" />
      )}
    </svg>
  );
}

function CreateTabIcon({ active }: TabIconProps) {
  return (
    <span
      aria-hidden
      className={[
        "grid h-[22px] w-[22px] place-items-center rounded-md border transition-colors",
        active ? "border-white bg-white text-black" : "border-current",
      ].join(" ")}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.2}>
        <path d="M12 5v14M5 12h14" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const tabs = [
  {
    href: "/",
    label: "Home",
    Icon: HomeTabIcon,
    match: (path: string) => path === "/" || path === "/settings" || path === "/profile",
  },
  {
    href: "/search",
    label: "Search",
    Icon: SearchTabIcon,
    match: (path: string) => path.startsWith("/search"),
  },
  {
    href: "/library",
    label: "Library",
    Icon: LibraryTabIcon,
    match: (path: string) =>
      path.startsWith("/library") ||
      path.startsWith("/liked") ||
      path.startsWith("/radio") ||
      path.startsWith("/podcasts") ||
      path.startsWith("/events") ||
      path.startsWith("/playlist") ||
      path.startsWith("/songs") ||
      path.startsWith("/upload"),
  },
] as const;

export default function MobileNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPanelRef = useRef<HTMLElement | null>(null);
  useModalDialogFocus(createOpen, createPanelRef);

  const closeCreateSheet = () => {
    if (creating) return;
    setCreateOpen(false);
    setPlaylistName("");
    setCreateError(null);
  };

  useEffect(() => {
    if (!createOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCreateSheet();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createOpen, creating]);

  const handleCreatePlaylist = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = playlistName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const playlist = await createPlaylist(name);
      setCreateOpen(false);
      setPlaylistName("");
      navigate(`/playlist/${playlist.id}`);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Couldn't create the playlist.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      {createOpen ? (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button
            type="button"
            aria-label="Close create menu"
            onClick={closeCreateSheet}
            className="absolute inset-0 h-full w-full bg-black/60"
          />
          <section
            ref={createPanelRef}
            id="mobile-create-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-create-title"
            aria-describedby="mobile-create-description"
            tabIndex={-1}
            className="absolute inset-x-0 bottom-0 rounded-t-[28px] border-t border-white/[0.1] bg-[#0c0c0d] px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-2 text-white shadow-2xl"
          >
          <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/[0.28]" />
          <h2 id="mobile-create-title" className="text-xl font-semibold tracking-[-0.3px]">
            Create
          </h2>
          <p id="mobile-create-description" className="mt-1 text-sm text-white/[0.6]">
            Make a playlist for songs or episodes.
          </p>

          <form onSubmit={handleCreatePlaylist} className="mt-5">
            <label htmlFor="mobile-playlist-name" className="text-sm font-semibold text-[#f2f2f2]">
              Playlist name
            </label>
            <input
              id="mobile-playlist-name"
              value={playlistName}
              onChange={(event) => setPlaylistName(event.target.value)}
              placeholder="My playlist"
              maxLength={120}
              autoComplete="off"
              disabled={creating}
              className="mt-2 h-12 w-full rounded-xl border border-white/[0.1] bg-white/[0.08] px-4 text-base text-white outline-none placeholder:text-white/[0.42] focus:border-white/[0.32] focus:ring-2 focus:ring-white/[0.12] disabled:opacity-60"
            />
            {createError ? (
              <p role="alert" className="mt-2 text-sm text-red-300">
                {createError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeCreateSheet}
                disabled={creating}
                className="wf-control-button min-h-11 rounded-full px-5 text-sm font-semibold text-white/[0.68] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating || !playlistName.trim()}
                className="wf-control-button min-h-11 rounded-full bg-white px-6 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                {creating ? "Creating..." : "Create playlist"}
              </button>
            </div>
          </form>
          </section>
        </div>
      ) : null}

      <nav
        aria-label="Main navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.11] bg-[rgba(6,6,7,0.98)] pb-[var(--wf-mobile-bottom-gutter)] text-white lg:hidden"
      >
        <div className="grid h-[var(--wf-mobile-nav-height)] grid-cols-4 px-2.5 pb-1 pt-[5px]">
          {tabs.map((tab) => {
            const active = tab.match(pathname);
            return (
              <Link
                key={tab.href}
                to={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "wf-control-button flex min-h-[44px] flex-col items-center justify-center gap-0.5 touch-manipulation transition-colors",
                  active ? "text-white" : "text-white/[0.58]",
                )}
              >
                <tab.Icon active={active} />
                <span className={cn("text-[10px] tracking-[0.1px]", active ? "font-bold" : "font-semibold")}>
                  {tab.label}
                </span>
              </Link>
            );
          })}
          <button
            type="button"
            aria-label="Create"
            aria-expanded={createOpen}
            aria-controls="mobile-create-sheet"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            className="wf-control-button flex min-h-[44px] flex-col items-center justify-center gap-0.5 touch-manipulation text-white/[0.58] transition-colors"
          >
            <CreateTabIcon active={false} />
            <span className="text-[10px] font-semibold tracking-[0.1px]">Create</span>
          </button>
        </div>
      </nav>
    </>
  );
}
