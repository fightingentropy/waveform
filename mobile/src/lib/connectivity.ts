// Reachability flag used by playback to prefer cached/downloaded songs when the
// backend path disappears, so it never flashes through tracks it cannot stream.
//
// Two complementary signals:
//   1. expo-network reports whether iOS has an active route. On iOS its
//      `isInternetReachable` is the same as `isConnected`, so a cellular route in
//      a Tube tunnel may still read "online" while the backend is unreachable.
//   2. Real API traffic proves end-to-end reachability. A network rejection or
//      client timeout therefore overrides the route hint immediately; any later
//      HTTP response restores online mode.
//
// We acquire the native module via requireOptionalNativeModule, which returns
// null (never throws) when it isn't linked into the running binary — so an older
// build degrades to the API-derived fallback instead of crashing at import.
// (The expo-network JS wrapper does `requireNativeModule(...)` at import time,
// which would throw before any guard could run, so we deliberately bypass it.)
//
// Optimistic by default, with a small active probe while offline so recovery
// does not depend on the user navigating to a page that happens to fetch data.

import { requireOptionalNativeModule } from "expo-modules-core";
import { API_ORIGIN } from "@/lib/config";
import { routeHintRestoresOnline } from "@/lib/reachability-policy";

type NetworkLike = { isConnected?: boolean; isInternetReachable?: boolean };
type ExpoNetworkModule = {
  getNetworkStateAsync: () => Promise<NetworkLike>;
  addListener: (event: string, listener: (state: NetworkLike) => void) => { remove: () => void };
};

const ExpoNetwork = requireOptionalNativeModule<ExpoNetworkModule>("ExpoNetwork");

let online = true;
let initStarted = false;
let routeAvailable: boolean | null = null;
let lastTransportFailureAt = 0;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeDelayMs = 5_000;
const listeners = new Set<(online: boolean) => void>();
const MAX_PROBE_DELAY_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_000;

function clearProbe(): void {
  if (probeTimer != null) clearTimeout(probeTimer);
  probeTimer = null;
  probeDelayMs = 5_000;
}

function scheduleProbe(): void {
  if (online || probeTimer != null) return;
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), PROBE_TIMEOUT_MS);
    try {
      // Any HTTP response proves the path is back; authentication status is
      // irrelevant for reachability.
      await fetch(`${API_ORIGIN}/api/auth/session`, {
        credentials: "include",
        cache: "no-store",
        signal: controller?.signal,
      });
      markOnline();
    } catch {
      probeDelayMs = Math.min(MAX_PROBE_DELAY_MS, probeDelayMs * 2);
      scheduleProbe();
    } finally {
      clearTimeout(timeout);
    }
  }, probeDelayMs);
}

// Single writer for `online`. Notifies subscribers only on an actual transition,
// so download pause/resume fires on edges (offline→pause, online→resume) rather
// than on every repeat reading of the same state.
function setOnline(next: boolean): void {
  if (next === online) return;
  online = next;
  if (next) clearProbe();
  else scheduleProbe();
  for (const cb of listeners) {
    try {
      cb(next);
    } catch {}
  }
}

function applyNetworkState(state: NetworkLike): void {
  const nextRouteAvailable = state.isConnected !== false && state.isInternetReachable !== false;
  const restoreOnline = routeHintRestoresOnline(routeAvailable, nextRouteAvailable, lastTransportFailureAt);
  routeAvailable = nextRouteAvailable;
  if (!nextRouteAvailable) {
    setOnline(false);
    return;
  }
  // A real interface transition from unavailable → available is useful recovery
  // evidence. The initial "connected" snapshot must not overwrite a transport
  // failure that raced it during cold start.
  if (restoreOnline) setOnline(true);
}

function ensureInit(): void {
  if (initStarted) return;
  initStarted = true;
  if (!ExpoNetwork) return; // native module absent → API-derived fallback below
  try {
    // Real-time changes (airplane mode on/off, Wi-Fi drop) while the app is open.
    ExpoNetwork.addListener("onNetworkStateChanged", applyNetworkState);
    // Seed the current value immediately rather than waiting for the first event.
    ExpoNetwork.getNetworkStateAsync()
      .then(applyNetworkState)
      .catch(() => {});
  } catch {
    // Defensive: any native hiccup → stay on the API-derived fallback.
  }
}

export function markOnline(): void {
  ensureInit();
  lastTransportFailureAt = 0;
  setOnline(true);
}

export function markOffline(): void {
  ensureInit();
  lastTransportFailureAt = Date.now();
  setOnline(false);
}

export function getIsOnline(): boolean {
  ensureInit();
  return online;
}

// Subscribe to online/offline edges; returns an unsubscribe fn. The download pump
// uses this to pause an in-flight download the instant connectivity drops (banking
// an NSURLSession resume blob) and to resume from the partial on recovery.
export function subscribeOnline(listener: (online: boolean) => void): () => void {
  ensureInit();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
