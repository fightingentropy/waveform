"use client";

import { useEffect, useRef, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import Link from "next/link";
import { ChevronDown, LogOut, Settings } from "lucide-react";

export function AuthButtons() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="text-sm opacity-70">Checking auth…</div>;
  }

  if (!session) {
    return (
      <div className="flex items-center gap-2">
        <Link className="underline" href="/signin">
          Sign in
        </Link>
        <span className="opacity-60">/</span>
        <Link className="underline" href="/register">
          Register
        </Link>
      </div>
    );
  }

  return (
    <UserMenu
      name={session.user?.name ?? session.user?.email ?? "Account"}
      onSignOut={() => signOut({ callbackUrl: "/" })}
    />
  );
}

function UserMenu({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="relative" ref={menuRef}>
      <button
        className="inline-flex items-center gap-2 px-3 h-9 rounded-md border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
     >
        <span className="text-sm max-w-[180px] truncate">{name}</span>
        <ChevronDown size={16} className="opacity-70" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-48 rounded-md border border-black/10 dark:border-white/10 bg-background shadow-lg z-50 overflow-hidden"
        >
          <Link
            href="/settings"
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/5"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <Settings size={16} />
            <span>Settings</span>
          </Link>
          <button
            className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/5"
            role="menuitem"
            onClick={onSignOut}
          >
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}


