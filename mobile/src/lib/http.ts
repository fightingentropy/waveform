import { API_ORIGIN } from "@/lib/config";
import { markOffline, markOnline } from "@/lib/connectivity";
import { RequestTimeoutError, withRequestTimeout } from "@/lib/request-timeout";

// Resolve an API path against the backend origin. Absolute URLs pass through.
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Low-level data fetch. Data/API calls authenticate with the session cookie, which
// RN's fetch persists in the native cookie store (NSHTTPCookieStorage /
// CookieManager) — see §2 of the port brief. Media streaming does NOT share this
// jar, which is why media URLs are signed instead.
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(apiUrl(path), { credentials: "include", ...init });
    // Even an HTTP error proves end-to-end network reachability.
    markOnline();
    return response;
  } catch (error) {
    // Caller cancellation is not a reachability signal. Timeouts explicitly mark
    // offline at their call site before aborting.
    if ((error as { name?: string })?.name !== "AbortError") markOffline();
    throw error;
  }
}

export const DEFAULT_API_REQUEST_TIMEOUT_MS = 15_000;

// Interactive writes/auth calls use this wrapper instead of raw apiFetch so a
// blackholed-but-"connected" iOS route cannot leave a button spinning forever.
// Long-running media imports choose a larger budget at their call site.
export async function apiFetchWithTimeout(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_API_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await withRequestTimeout(
      (signal) =>
        apiFetch(path, {
          ...init,
          signal,
        }),
      {
        timeoutMs,
        signal: init?.signal,
      },
    );
  } catch (error) {
    // apiFetch deliberately ignores AbortError because user cancellation is not
    // a reachability signal. A deadline is different: the backend was
    // unreachable for the full client budget, so fail over to offline behavior.
    if (error instanceof RequestTimeoutError) markOffline();
    throw error;
  }
}
