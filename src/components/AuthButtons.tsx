"use client";

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronDown, LogIn, LogOut, Settings, UserRound } from "lucide-react";
import { useAuth } from "@/client/auth";

export function AccountAvatar({
  src,
  alt,
  className,
  iconSize = 17,
}: {
  src?: string | null;
  alt: string;
  className: string;
  iconSize?: number;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const displaySrc = src && src !== failedSrc ? src : null;

  if (displaySrc) {
    return (
      <img
        src={displaySrc}
        alt={alt}
        className={className}
        onError={() => setFailedSrc(displaySrc)}
      />
    );
  }

  return (
    <span
      aria-label={alt}
      className={`grid place-items-center bg-white/[0.12] text-white/[0.72] ${className}`}
    >
      <UserRound size={iconSize} strokeWidth={2.2} />
    </span>
  );
}

export function AuthButtons({ compact = false }: { compact?: boolean }) {
  const { user, status, signOut } = useAuth();
  const navigate = useNavigate();

  if (compact) {
    if (status === "loading") {
      return (
        <div
          className="h-10 w-10 shrink-0 rounded-full border border-white/[0.12] bg-white/[0.06]"
          aria-label="Checking session"
          title="Checking session"
        />
      );
    }

    if (!user) {
      return (
        <Link
          to="/signin"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/[0.16] bg-white/[0.06] text-white/[0.76] transition hover:border-white/[0.32] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label="Sign in"
          title="Sign in"
        >
          <LogIn size={20} />
        </Link>
      );
    }

    return (
      <Link
        to="/profile"
        className="block h-10 w-10 shrink-0 rounded-full border border-white/[0.16] bg-white/[0.06] p-0.5 transition hover:border-white/[0.32] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        aria-label="Open profile"
        title="Profile"
      >
        <AccountAvatar
          src={user.image}
          alt={user?.name || "Profile"}
          className="h-full w-full rounded-full object-cover"
          iconSize={20}
        />
      </Link>
    );
  }

  if (status === "loading") {
    return <div className="truncate text-[15px] text-white/[0.62]">Checking...</div>;
  }

  if (!user) {
    return (
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 text-[15px] whitespace-nowrap">
        <Link className="text-white/[0.76] underline underline-offset-2 transition hover:text-white" to="/signin">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <UserMenu
      name={user.name ?? user.email ?? "Account"}
      imageUrl={user.image}
      onSignOut={async () => {
        await signOut();
        navigate("/");
      }}
    />
  );
}

function UserMenu({
  name,
  imageUrl,
  onSignOut,
}: {
  name: string;
  imageUrl?: string | null;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

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
  }, [open]);

  // Treated as a disclosure (not an ARIA menu), so items keep normal tab
  // order. On open, move focus to the first item; on close, restore focus to
  // the trigger so keyboard users aren't dropped at the top of the page.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      const first = panelRef.current?.querySelector<HTMLElement>("a, button");
      first?.focus();
    } else if (wasOpenRef.current) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={triggerRef}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-white/[0.12] px-2.5 text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account menu"
     >
        <AccountAvatar src={imageUrl} alt="" className="h-6 w-6 rounded-full object-cover" iconSize={15} />
        <span className="max-w-[180px] truncate text-[15px]">{name}</span>
        <ChevronDown size={16} className="text-white/[0.62]" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 mt-2 w-48 rounded-md border border-white/[0.12] bg-background text-white shadow-lg z-50 overflow-hidden"
        >
          <Link
            to="/profile"
            className="flex items-center gap-2 px-3 py-2.5 text-[15px] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
            onClick={() => setOpen(false)}
          >
            <UserRound size={16} />
            <span>Profile</span>
          </Link>
          <Link
            to="/settings"
            className="flex items-center gap-2 px-3 py-2.5 text-[15px] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
            onClick={() => setOpen(false)}
          >
            <Settings size={16} />
            <span>Settings</span>
          </Link>
          <button
            className="w-full text-left flex items-center gap-2 px-3 py-2.5 text-[15px] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
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
