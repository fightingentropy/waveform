import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { API_AUTH_REQUIRED_EVENT, invalidateApiCache } from "@/lib/api";
import {
  isCurrentAuthMutation,
  resolveAuthBootstrap,
  type AuthSessionStatus,
} from "@/lib/auth-session-policy";
import { on } from "@/lib/events";
import { apiFetch, apiFetchWithTimeout } from "@/lib/http";
import { clearImportQueue } from "@/lib/import-queue";
import { removeLocalPlaybackState } from "@/lib/playback-state";
import { storage } from "@/lib/storage";
import { clearOfflineAccountData, setOfflineAccountScope } from "@/store/offline";
import { useLikesStore } from "@/store/likes";
import { usePlayerStore } from "@/store/player";

// Ported from src/client/auth.tsx. Logic preserved (auth generation guard, cached
// user, session refresh with a 2.5s timeout, forced-logout on 401). Changes:
// localStorage → MMKV storage; fetch → apiFetch; the LAN/localhost auto-trust,
// serviceWorker/Cache-API profile-image warming, navigator.onLine, and Capacitor
// multipart base64 workaround are all dropped (§9). The native cookie store keeps
// the session across launches, so no token persistence is needed here.

// An image picked via expo-image-picker (uri + name + mime), for multipart upload.
export type ProfileImageAsset = { uri: string; name: string; type: string };

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  status: AuthSessionStatus;
  refresh: (options?: { showLoading?: boolean }) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  updateProfileImage: (asset: ProfileImageAsset) => Promise<void>;
  resendVerification: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_AUTH_USER_KEY = "spotify_cached_auth_user";
const CACHED_AUTH_SIGNED_OUT_KEY = "spotify_auth_signed_out";
const ERLIN_PROFILE_IMAGE_URL = "/profile.jpg";
const SESSION_REFRESH_TIMEOUT_MS = 2_500;
const AUTH_ACTION_TIMEOUT_MS = 15_000;
const SIGN_OUT_TIMEOUT_MS = 5_000;
const PROFILE_UPLOAD_TIMEOUT_MS = 60_000;

function defaultAuthUserImage(email: string, name: string | null): string | null {
  const normalizedName = name?.trim().toLowerCase() || "";
  const emailLocalPart = email.split("@")[0]?.trim().toLowerCase() || "";
  if (
    normalizedName === "erlin" ||
    normalizedName === "erlin hoxha" ||
    emailLocalPart === "erlin" ||
    emailLocalPart === "erlinhoxha"
  ) {
    return ERLIN_PROFILE_IMAGE_URL;
  }
  return null;
}

function coerceAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Record<keyof AuthUser, unknown>>;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") return null;
  const name = typeof candidate.name === "string" ? candidate.name : null;
  const defaultImage = defaultAuthUserImage(candidate.email, name);
  const storedImage = typeof candidate.image === "string" && candidate.image.trim() ? candidate.image : null;
  return {
    id: candidate.id,
    email: candidate.email,
    name,
    image: storedImage || defaultImage,
    // Default to verified when the field is absent (older cached users / local
    // owner) so we never falsely nag; the server sends an explicit boolean.
    emailVerified: candidate.emailVerified !== false,
  };
}

function readCachedAuthUser(): AuthUser | null {
  try {
    return coerceAuthUser(JSON.parse(storage.getItem(CACHED_AUTH_USER_KEY) || "null"));
  } catch {
    return null;
  }
}

function readCachedAuthSignedOut(): boolean {
  try {
    return storage.getItem(CACHED_AUTH_SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCachedAuthUser(user: AuthUser | null, options?: { signedOut?: boolean }): void {
  try {
    if (user) {
      storage.setItem(CACHED_AUTH_USER_KEY, JSON.stringify(user));
      storage.removeItem(CACHED_AUTH_SIGNED_OUT_KEY);
    } else {
      storage.removeItem(CACHED_AUTH_USER_KEY);
      if (options?.signedOut) storage.setItem(CACHED_AUTH_SIGNED_OUT_KEY, "1");
    }
  } catch {}
}

async function fetchSession(): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = apiFetch("/api/auth/session", {
      cache: "no-store",
      signal: controller?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new Error("Session check timed out"));
      }, SESSION_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function stopAndClearAccountPlayback(): void {
  const player = usePlayerStore.getState();
  player.pause();
  player.setSong(null);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [bootstrap] = useState(() =>
    resolveAuthBootstrap(readCachedAuthUser(), readCachedAuthSignedOut()),
  );
  const [user, setUser] = useState<AuthUser | null>(bootstrap.user);
  const [status, setStatus] = useState<AuthContextValue["status"]>(bootstrap.status);
  const userIdRef = useRef<string | null>(bootstrap.user?.id ?? null);
  const serverSignOutAbortRef = useRef<AbortController | null>(null);
  // Bumped whenever auth state is set authoritatively (sign in/out, forced
  // logout). An in-flight refresh() captures this at its start and bails if it
  // changed, so a slow session check can't resurrect a just-signed-out user.
  const authGenerationRef = useRef(0);

  const cancelPendingServerSignOut = useCallback(() => {
    serverSignOutAbortRef.current?.abort();
    serverSignOutAbortRef.current = null;
  }, []);

  const requestServerSignOut = useCallback(async (): Promise<void> => {
    cancelPendingServerSignOut();
    const controller = new AbortController();
    serverSignOutAbortRef.current = controller;
    try {
      await apiFetchWithTimeout(
        "/api/auth/signout",
        { method: "POST", signal: controller.signal },
        SIGN_OUT_TIMEOUT_MS,
      );
    } catch {
      // Local sign-out remains authoritative. A later app launch retries.
    } finally {
      if (serverSignOutAbortRef.current === controller) {
        serverSignOutAbortRef.current = null;
      }
    }
  }, [cancelPendingServerSignOut]);

  const refresh = useCallback(async (options?: { showLoading?: boolean }) => {
    // Never let a surviving native cookie silently undo an explicit local
    // sign-out. The sign-in action below is the sole path that clears sentinel.
    if (readCachedAuthSignedOut()) {
      setUser(null);
      setStatus("unauthenticated");
      return;
    }
    const generation = authGenerationRef.current;
    const isStale = () => authGenerationRef.current !== generation;
    if (options?.showLoading) setStatus("loading");
    try {
      const response = await fetchSession();
      if (isStale()) return;
      if (response.status === 401 || response.status === 403) {
        invalidateApiCache();
        writeCachedAuthUser(null, { signedOut: true });
        setOfflineAccountScope("unauthenticated");
        stopAndClearAccountPlayback();
        setUser(null);
        setStatus("unauthenticated");
        return;
      }
      if (!response.ok) throw new Error(`Session check failed with ${response.status}`);
      const data = (await response.json().catch(() => ({}))) as { user?: AuthUser | null };
      if (isStale()) return;
      const nextUser = coerceAuthUser(data.user ?? null);
      writeCachedAuthUser(nextUser, { signedOut: !nextUser });
      setOfflineAccountScope(nextUser?.id ?? "unauthenticated");
      if (!nextUser) stopAndClearAccountPlayback();
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "unauthenticated");
    } catch {
      if (isStale()) return;
      const cachedUser = readCachedAuthUser();
      setOfflineAccountScope(cachedUser?.id ?? "unauthenticated");
      if (!cachedUser) stopAndClearAccountPlayback();
      setUser(cachedUser);
      setStatus(cachedUser ? "authenticated" : "unauthenticated");
    }
  }, []);

  useEffect(() => {
    if (bootstrap.shouldRetryServerSignOut) {
      void requestServerSignOut();
      return cancelPendingServerSignOut;
    }
    if (bootstrap.shouldRefreshSession) void refresh();
  }, [
    bootstrap.shouldRefreshSession,
    bootstrap.shouldRetryServerSignOut,
    cancelPendingServerSignOut,
    refresh,
    requestServerSignOut,
  ]);

  useEffect(() => {
    const off = on(API_AUTH_REQUIRED_EVENT, () => {
      authGenerationRef.current += 1;
      invalidateApiCache();
      writeCachedAuthUser(null, { signedOut: true });
      setOfflineAccountScope("unauthenticated");
      stopAndClearAccountPlayback();
      setUser(null);
      setStatus("unauthenticated");
    });
    return off;
  }, []);

  useEffect(() => {
    setOfflineAccountScope(user?.id ?? status);
  }, [status, user?.id]);

  useEffect(() => {
    const nextUserId = user?.id ?? null;
    if (userIdRef.current === nextUserId) return;
    userIdRef.current = nextUserId;
    useLikesStore.getState().resetRemote();
  }, [user?.id]);

  const signIn = useCallback(async (email: string, password: string) => {
    // A relaunch retry from an earlier sign-out must not race behind this request
    // and erase the newly-created session cookie.
    cancelPendingServerSignOut();
    const response = await apiFetchWithTimeout("/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }, AUTH_ACTION_TIMEOUT_MS);
    const data = (await response.json().catch(() => ({}))) as { user?: unknown; error?: string };
    const nextUser = coerceAuthUser(data.user ?? null);
    if (!response.ok || !nextUser) {
      throw new Error(data.error || "Invalid email or password");
    }
    authGenerationRef.current += 1;
    invalidateApiCache();
    writeCachedAuthUser(nextUser);
    setOfflineAccountScope(nextUser.id);
    if (userIdRef.current && userIdRef.current !== nextUser.id) {
      stopAndClearAccountPlayback();
    }
    setUser(nextUser);
    setStatus("authenticated");
  }, [cancelPendingServerSignOut]);

  const signOut = useCallback(async () => {
    authGenerationRef.current += 1;
    invalidateApiCache();
    writeCachedAuthUser(null, { signedOut: true });
    setOfflineAccountScope("unauthenticated");
    stopAndClearAccountPlayback();
    setUser(null);
    setStatus("unauthenticated");
    // Local state changes first for immediate UX; the native cookie cleanup is
    // best-effort and bounded, and will be retried on the next launch if needed.
    await requestServerSignOut();
  }, [requestServerSignOut]);

  const deleteAccount = useCallback(async (password: string) => {
    const accountId = user?.id;
    if (!accountId) throw new Error("You must be signed in to delete your account");
    const generation = authGenerationRef.current;
    const response = await apiFetchWithTimeout(
      "/api/account",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, confirmation: "DELETE" }),
      },
      AUTH_ACTION_TIMEOUT_MS,
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Could not delete your account");
    }

    // The server has atomically removed the account and every session. Mirror
    // that authoritative transition immediately. If another explicit auth
    // transition completed while deletion was in flight, accountId is still
    // deleted but must not sign out the newer user.
    // Start the targeted cleanup while this account is still the active offline
    // scope. That synchronously detaches any native download writer before the
    // auth transition below changes scopes.
    const offlineCleanup = clearOfflineAccountData(accountId);
    if (isCurrentAuthMutation(generation, authGenerationRef.current)) {
      authGenerationRef.current += 1;
      cancelPendingServerSignOut();
      invalidateApiCache();
      clearImportQueue();
      removeLocalPlaybackState();
      writeCachedAuthUser(null, { signedOut: true });
      setOfflineAccountScope("unauthenticated");
      stopAndClearAccountPlayback();
      useLikesStore.getState().resetRemote();
      setUser(null);
      setStatus("unauthenticated");
    }
    // Targeted cleanup is safe even if a different account became active: it
    // deletes only rows/outbox items carrying the deleted account's scope.
    await offlineCleanup;
  }, [cancelPendingServerSignOut, user?.id]);

  const updateProfileImage = useCallback(async (asset: ProfileImageAsset) => {
    const generation = authGenerationRef.current;
    // RN multipart: FormData accepts a { uri, name, type } file part natively.
    // (The web app's Capacitor base64-JSON workaround is dropped — §9.)
    const form = new FormData();
    form.append("image", {
      uri: asset.uri,
      name: asset.name,
      type: asset.type,
    } as unknown as Blob);
    const response = await apiFetchWithTimeout("/api/profile/image", {
      method: "POST",
      body: form,
    }, PROFILE_UPLOAD_TIMEOUT_MS);
    const data = (await response.json().catch(() => ({}))) as { user?: unknown; error?: string };
    const nextUser = coerceAuthUser(data.user ?? null);
    if (!response.ok || !nextUser) {
      throw new Error(data.error || "Failed to update profile image");
    }
    // Sign-out or another explicit auth transition happened while the upload was
    // in flight. Ignore the stale profile response; it must never resurrect the
    // prior account or clear the signed-out sentinel.
    if (!isCurrentAuthMutation(generation, authGenerationRef.current)) return;
    writeCachedAuthUser(nextUser);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const resendVerification = useCallback(async () => {
    const response = await apiFetchWithTimeout(
      "/api/auth/resend-verification",
      { method: "POST" },
      AUTH_ACTION_TIMEOUT_MS,
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Failed to resend verification email");
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      refresh,
      signIn,
      signOut,
      deleteAccount,
      updateProfileImage,
      resendVerification,
    }),
    [deleteAccount, refresh, signIn, signOut, status, updateProfileImage, resendVerification, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
