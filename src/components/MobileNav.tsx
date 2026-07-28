"use client";

import { Link, useLocation } from "react-router";
import { cn } from "@/lib/utils";

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

const tabs = [
  {
    href: "/",
    label: "Home",
    Icon: HomeTabIcon,
    match: (path: string) => path === "/",
  },
  {
    href: "/search",
    label: "Search",
    Icon: SearchTabIcon,
    match: (path: string) => path.startsWith("/search"),
  },
  {
    href: "/library",
    label: "Your Library",
    Icon: LibraryTabIcon,
    match: (path: string) =>
      path.startsWith("/library") ||
      path.startsWith("/liked") ||
      path.startsWith("/radio") ||
      path.startsWith("/podcasts") ||
      path.startsWith("/events") ||
      path.startsWith("/playlist"),
  },
] as const;

export default function MobileNav() {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Main navigation"
      className="lg:hidden fixed inset-x-0 bottom-0 z-40 text-white pb-[var(--wf-mobile-bottom-gutter)] bg-gradient-to-t from-black via-black/[0.85] to-black/[0.38] backdrop-blur-md"
    >
      <div className="h-[var(--wf-mobile-nav-height)] grid grid-cols-3">
        {tabs.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              to={tab.href}
              className={cn(
                "wf-control-button flex flex-col items-center justify-center gap-1 min-h-[44px] touch-manipulation transition-colors",
                active ? "text-white" : "text-[#b3b3b3]",
              )}
            >
              <tab.Icon active={active} />
              <span className="text-[10px] font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
