export type SharedClientCapability = {
  id: string;
  webRoute: string;
  mobileRoute: string;
};

/**
 * User-facing workflows that must remain reachable in both clients. The route
 * syntax differs, but a source-level contract test guards accidental removals.
 */
export const SHARED_CLIENT_CAPABILITIES: readonly SharedClientCapability[] = [
  { id: "home", webRoute: "/", mobileRoute: "index" },
  { id: "search", webRoute: "/search", mobileRoute: "search" },
  { id: "library", webRoute: "/library", mobileRoute: "library" },
  { id: "liked songs", webRoute: "/liked", mobileRoute: "liked" },
  { id: "radio", webRoute: "/radio", mobileRoute: "radio" },
  { id: "podcasts", webRoute: "/podcasts", mobileRoute: "podcasts" },
  { id: "events", webRoute: "/events", mobileRoute: "events" },
  { id: "upload/import", webRoute: "/upload", mobileRoute: "upload" },
  { id: "settings", webRoute: "/settings", mobileRoute: "settings" },
  { id: "profile", webRoute: "/profile", mobileRoute: "profile" },
  { id: "listening stats", webRoute: "/listening-stats", mobileRoute: "listening-stats" },
] as const;
