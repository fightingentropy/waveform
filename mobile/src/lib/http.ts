import { API_ORIGIN } from "@/lib/config";
import { markOffline, markOnline } from "@/lib/connectivity";

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
