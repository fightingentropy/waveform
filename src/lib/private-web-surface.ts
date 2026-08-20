const LEGACY_PUBLIC_PROFILE_PATH = "/profile.jpg";

function decodedPathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function isLegacyPublicProfilePath(pathname: string): boolean {
  return decodedPathname(pathname).toLowerCase() === LEGACY_PUBLIC_PROFILE_PATH;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isWorkersDevHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "workers.dev" || normalized.endsWith(".workers.dev");
}

export function safePrivatePageNext(rawUri: string | null | undefined): string {
  const raw = rawUri?.trim() || "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  try {
    const parsed = new URL(raw, "https://private.invalid");
    if (parsed.origin !== "https://private.invalid") return "/";
    if (parsed.pathname === "/signin" || parsed.pathname === "/register") return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
