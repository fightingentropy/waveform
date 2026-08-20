const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // SAFE SUBSET ONLY: no default-src/script-src/connect-src so the SPA keeps working.
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
};

function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}

const CORS_ALLOWED_ORIGINS = new Set<string>([
  "https://music.streamarena.xyz",
]);

export function corsAllowOrigin(origin: string | undefined | null): string | null {
  if (!origin) return null;
  if (CORS_ALLOWED_ORIGINS.has(origin)) return origin;
  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      return origin;
    }
  } catch {}
  return null;
}

function applyCorsHeaders(headers: Headers, allowOrigin: string): void {
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  headers.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
}

export function withSecurityHeaders(res: Response, corsAllow: string | null = null): Response {
  try {
    applySecurityHeaders(res.headers);
    if (corsAllow) applyCorsHeaders(res.headers, corsAllow);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    applySecurityHeaders(headers);
    if (corsAllow) applyCorsHeaders(headers, corsAllow);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
