import { Component, lazy, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "@/client/auth";
import { AuthButtons } from "@/components/AuthButtons";
import EmailVerificationBanner from "@/components/EmailVerificationBanner";
import { HomeSearchCommandPalette } from "@/components/HomeSearchCommandPalette";
import LibrarySidebarClient from "@/components/LibrarySidebarClient";
import MobileNav from "@/components/MobileNav";
import NowPlayingSidebar from "@/components/NowPlayingSidebar";
import { PlayerBar } from "@/components/PlayerBar";
import { DiscoverQueueStager } from "@/client/DiscoverQueueStager";
import PwaRegister from "@/components/PwaRegister";
import HomePage from "@/client/pages/HomePage";
import ProfilePage from "@/client/pages/ProfilePage";
import { useApiData, withAccountScope, type LibraryPayload } from "@/client/api";
import { usePlayerStore } from "@/store/player";

const loadSearchPage = () => import("@/client/pages/SearchPage");
const loadLibraryPage = () => import("@/client/pages/LibraryPage");
const loadSongsPage = () => import("@/client/pages/SongsPage");
const loadLikedPage = () => import("@/client/pages/LikedPage");
const loadRadioPage = () => import("@/client/pages/RadioPage");
const loadPodcastsPage = () => import("@/client/pages/PodcastsPage");
const loadEventsPage = () => import("@/client/pages/EventsPage");
const loadPlaylistPage = () => import("@/client/pages/PlaylistPage");
const loadUploadPage = () => import("@/client/pages/UploadPage");
const loadSettingsPage = () => import("@/client/pages/SettingsPage");
const loadSignInPage = () => import("@/client/pages/SignInPage");
type RoutePrefetcher = () => Promise<unknown>;
const ROUTE_PREFETCHERS: RoutePrefetcher[] = [
  loadSearchPage,
  loadLibraryPage,
  loadSongsPage,
  loadLikedPage,
  loadRadioPage,
  loadPodcastsPage,
  loadEventsPage,
  loadPlaylistPage,
  loadUploadPage,
  loadSettingsPage,
  loadSignInPage,
];
const prefetchedRouteModules = new Set<RoutePrefetcher>();
const ROUTE_PREFETCH_IDLE_TIMEOUT_MS = 2_000;
const ROUTE_PREFETCH_FALLBACK_DELAY_MS = 1_000;

const SearchPage = lazy(loadSearchPage);
const LibraryPage = lazy(loadLibraryPage);
const SongsPage = lazy(loadSongsPage);
const LikedPage = lazy(loadLikedPage);
const RadioPage = lazy(loadRadioPage);
const PodcastsPage = lazy(loadPodcastsPage);
const EventsPage = lazy(loadEventsPage);
const PlaylistPage = lazy(loadPlaylistPage);
const UploadPage = lazy(loadUploadPage);
const SettingsPage = lazy(loadSettingsPage);
const SignInPage = lazy(loadSignInPage);

function RouteLoading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="min-h-[calc(100dvh-3.5rem)] px-4 py-8 text-white/[0.7] sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 text-sm">{label}</div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {[0, 1, 2, 3, 4, 5].map((item) => (
            <div key={item} className="space-y-3">
              <div className="wf-skeleton aspect-square rounded-lg" />
              <div className="wf-skeleton h-4 rounded-full" />
              <div className="wf-skeleton h-3 w-2/3 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RouteUnavailable() {
  return (
    <div className="min-h-[calc(100dvh-3.5rem)] px-4 py-8 text-white sm:px-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-white/[0.62]">
        This page failed to load. Try reloading, or come back in a moment.
      </p>
    </div>
  );
}

class RouteErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Route failed to render", error);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function lazyRoute(element: ReactNode, label?: string) {
  return (
    <RouteErrorBoundary fallback={<RouteUnavailable />}>
      <Suspense fallback={<RouteLoading label={label} />}>{element}</Suspense>
    </RouteErrorBoundary>
  );
}

async function prefetchRouteModules(): Promise<void> {
  for (const load of ROUTE_PREFETCHERS) {
    if (prefetchedRouteModules.has(load)) continue;
    try {
      await load();
      prefetchedRouteModules.add(load);
    } catch {}
  }
}

function shouldSkipRoutePrefetch(): boolean {
  if (navigator.onLine === false) return true;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return Boolean(
    connection?.saveData ||
      connection?.effectiveType === "slow-2g" ||
      connection?.effectiveType === "2g",
  );
}

function useIdleRoutePrefetch() {
  useEffect(() => {
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;
    let cancelled = false;
    const prefetch = () => {
      if (cancelled) return;
      if (shouldSkipRoutePrefetch()) return;
      void prefetchRouteModules();
    };
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const clearScheduledPrefetch = () => {
      if (idleHandle !== undefined) {
        idleWindow.cancelIdleCallback?.(idleHandle);
        idleHandle = undefined;
      }
      if (timeoutHandle !== undefined) {
        window.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    };

    const schedulePrefetch = () => {
      clearScheduledPrefetch();
      if (shouldSkipRoutePrefetch()) return;
      if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(prefetch, { timeout: ROUTE_PREFETCH_IDLE_TIMEOUT_MS });
      } else {
        timeoutHandle = window.setTimeout(prefetch, ROUTE_PREFETCH_FALLBACK_DELAY_MS);
      }
    };

    window.addEventListener("online", schedulePrefetch);
    schedulePrefetch();

    return () => {
      cancelled = true;
      clearScheduledPrefetch();
      window.removeEventListener("online", schedulePrefetch);
    };
  }, []);
}

const AUTH_PUBLIC_PATHS = new Set(["/signin"]);

function Shell() {
  const { user, status } = useAuth();
  const location = useLocation();
  const currentSong = usePlayerStore((state) => state.currentSong);
  const [initialSidebarCollapsed] = useState(
    () => localStorage.getItem("spotify_left_sidebar_collapsed") === "1",
  );
  const isAuthPublicPath = AUTH_PUBLIC_PATHS.has(location.pathname);
  const { data: library } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    {
      playlists: [],
      userId: null,
    },
    {
      enabled: status === "authenticated",
      keepPreviousData: true,
    },
  );
  useIdleRoutePrefetch();
  useLayoutEffect(() => {
    document.querySelector(".wf-main")?.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    document.body.classList.toggle("wf-has-mobile-player", Boolean(currentSong));
    return () => {
      document.body.classList.remove("wf-has-mobile-player");
    };
  }, [currentSong]);
  const visibleLibrary =
    library.userId && library.userId === user?.id
      ? library
      : { playlists: [], userId: user?.id ?? null };

  if (status === "loading") {
    return (
      <div className="min-h-dvh bg-background px-4 py-16 text-center text-white/[0.7]">
        Checking session...
      </div>
    );
  }

  if (!user && !isAuthPublicPath) {
    return (
      <Navigate to="/signin" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  if (user && isAuthPublicPath) {
    return <Navigate to="/" replace />;
  }

  if (!user) {
    return (
      <main className="wf-main min-h-dvh bg-background pt-[env(safe-area-inset-top)]">
        <div key={location.pathname} className="wf-route-surface">
          <Routes location={location}>
            <Route path="/signin" element={lazyRoute(<SignInPage />, "Loading sign in...")} />
          </Routes>
        </div>
      </main>
    );
  }

  return (
    <>
      <PwaRegister />
      <header className="fixed top-0 inset-x-0 z-50 border-b border-white/[0.12] bg-background text-white pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 w-screen max-w-none min-w-0 items-center justify-between px-4 sm:px-6 lg:grid lg:max-w-7xl lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {/* On lg+ the logo leaves the centered grid and pins to the header's
              left edge (the fixed header is its containing block), so it hugs
              the screen edge on big displays instead of the max-w-7xl gutter. */}
          <Link
            to="/"
            className="font-semibold inline-flex shrink-0 items-center touch-manipulation lg:absolute lg:left-4 lg:top-1/2 lg:-translate-y-1/2"
          >
            <img src="/logo.png" alt="Music" width={40} height={40} className="h-10 w-10 lg:h-7 lg:w-7" />
          </Link>
          <HomeSearchCommandPalette
            className="hidden w-[22rem] lg:col-start-2 lg:block lg:justify-self-center xl:w-[30rem]"
          />
          <nav className="hidden lg:col-start-3 lg:flex items-center gap-4 xl:gap-6 lg:justify-self-end">
            <Link to="/" className="text-white/[0.68] transition hover:text-white">Home</Link>
            <Link to="/library" className="text-white/[0.68] transition hover:text-white">Library</Link>
            <Link to="/upload" className="text-white/[0.68] transition hover:text-white">Upload</Link>
            <AuthButtons />
          </nav>
          <div className="ml-auto flex min-w-0 justify-end overflow-hidden lg:hidden">
            <AuthButtons compact />
          </div>
        </div>
      </header>
      <LibrarySidebarClient
        userId={user?.id ?? null}
        playlists={visibleLibrary.playlists}
        initialCollapsed={initialSidebarCollapsed}
      />
      <NowPlayingSidebar />
      <main className="wf-main pt-[calc(3.5rem+env(safe-area-inset-top))]">
        <EmailVerificationBanner />
        <div key={location.pathname} className="wf-route-surface">
        <Routes location={location}>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={lazyRoute(<SearchPage />, "Loading search...")} />
          <Route path="/library" element={lazyRoute(<LibraryPage />, "Loading library...")} />
          <Route path="/songs" element={lazyRoute(<SongsPage />, "Loading songs...")} />
          <Route path="/liked" element={lazyRoute(<LikedPage />, "Loading liked songs...")} />
          <Route path="/radio" element={lazyRoute(<RadioPage />, "Loading radio stations...")} />
          <Route path="/podcasts" element={lazyRoute(<PodcastsPage />, "Loading podcasts...")} />
          <Route path="/events" element={lazyRoute(<EventsPage />, "Loading events...")} />
          <Route path="/playlist/:id" element={lazyRoute(<PlaylistPage />, "Loading playlist...")} />
          <Route path="/upload" element={lazyRoute(<UploadPage />, "Loading upload...")} />
          <Route path="/settings" element={lazyRoute(<SettingsPage />, "Loading settings...")} />
          <Route path="/profile" element={lazyRoute(<ProfilePage />, "Loading profile...")} />
          <Route path="/signin" element={lazyRoute(<SignInPage />, "Loading sign in...")} />
          <Route path="/register" element={<Navigate to="/signin" replace />} />
          <Route
            path="*"
            element={
              <div className="px-4 sm:px-6 py-10 max-w-3xl mx-auto">
                <h1 className="text-2xl font-semibold mb-2">Not found</h1>
                <Link to="/" className="underline">Back home</Link>
              </div>
            }
          />
        </Routes>
        </div>
      </main>
      <PlayerBar />
      <DiscoverQueueStager />
      <MobileNav />
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
