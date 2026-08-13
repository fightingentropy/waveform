export const ANONYMOUS_ACCOUNT_SCOPE = "anonymous";
export const LEGACY_API_AUTH_SCOPE = "legacy";

export function normalizeAccountScope(scope: string | null | undefined): string {
  const value = scope?.trim();
  return value && value !== "loading" ? value : ANONYMOUS_ACCOUNT_SCOPE;
}

export function getApiPath(url: string): string {
  try {
    return new URL(url, "http://spotify.local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

export function getApiAuthScope(url: string): string {
  try {
    return new URL(url, "http://spotify.local").searchParams.get("auth")?.trim() || LEGACY_API_AUTH_SCOPE;
  } catch {
    return LEGACY_API_AUTH_SCOPE;
  }
}

export function withAccountScope(url: string, scope: string | null | undefined): string {
  const value = scope?.trim() || ANONYMOUS_ACCOUNT_SCOPE;
  try {
    const parsed = new URL(url, "http://spotify.local");
    parsed.searchParams.set("auth", value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    params.set("auth", value);
    const serialized = params.toString();
    return serialized ? `${path}?${serialized}` : path;
  }
}
