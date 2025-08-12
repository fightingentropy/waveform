"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import Link from "next/link";

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
    <div className="flex items-center gap-3">
      <span className="text-sm">{session.user?.name ?? session.user?.email}</span>
      <button
        className="text-sm underline"
        onClick={() => signOut({ callbackUrl: "/" })}
      >
        Sign out
      </button>
    </div>
  );
}


