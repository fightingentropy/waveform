import Constants from "expo-constants";

// Base origin for the Cloudflare Worker backend. Everything — API data calls and
// signed media — goes here. Native integration builds can point at a local
// read-only fixture server without editing app.json; production keeps the fixed
// HTTPS origin unless an explicit Expo config override is present.
const DEFAULT_API_ORIGIN = "https://music.streamarena.xyz";

export const API_ORIGIN: string = (
  (Constants.expoConfig?.extra as { apiOrigin?: string } | undefined)?.apiOrigin ||
  process.env.EXPO_PUBLIC_API_ORIGIN ||
  DEFAULT_API_ORIGIN
).replace(/\/+$/, "");

// Prefix a path-relative URL with the API origin. Absolute (http(s)://, //host)
// and local (file:, data:, blob:) URLs are returned UNCHANGED so signed query
// strings survive verbatim — see §1 of the port brief: an unsigned/re-encoded
// media URL returns 403 and the track silently fails.
export function toAbsoluteApiUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;
  return `${API_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}
