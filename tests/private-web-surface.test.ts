import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  isApiPath,
  isLegacyPublicProfilePath,
  isWorkersDevHost,
  safePrivatePageNext,
} from "../src/lib/private-web-surface";
import { withNoIndexHeader } from "../src/server/local-http";
import worker, { isAuthOpenApiPath } from "../src/worker/index";

class FakePreparedStatement {
  constructor(
    private readonly sql: string,
    private readonly authenticated: boolean,
  ) {}

  bind(): D1PreparedStatement {
    return this as unknown as D1PreparedStatement;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results =
      this.authenticated && this.sql.includes('INNER JOIN "User"')
        ? [{
            id: "test-user",
            email: "listener@example.test",
            name: "Listener",
            image: null,
            emailVerified: "2026-01-01",
          }]
        : [];
    return { success: true, results: results as T[], meta: {} } as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    return { success: true, results: [], meta: {} } as unknown as D1Result<T>;
  }
}

function workerHarness(authenticated = false) {
  let assetFetches = 0;
  const env = {
    APP_ORIGIN: "https://music.streamarena.xyz",
    DB: {
      prepare(sql: string) {
        return new FakePreparedStatement(sql, authenticated);
      },
    },
    ASSETS: {
      fetch() {
        assetFetches += 1;
        return Promise.resolve(new Response("<!doctype html><title>Music</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }));
      },
    },
  } as unknown as CloudflareEnv;
  const executionContext = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const fetch = (url: string, init?: RequestInit) =>
    worker.fetch(new Request(url, init), env, executionContext);
  return { fetch, get assetFetches() { return assetFetches; } };
}

describe("private web path policy", () => {
  test("recognizes the API namespace, legacy profile path, and workers.dev hosts", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/auth/session")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isLegacyPublicProfilePath("/profile.jpg")).toBe(true);
    expect(isLegacyPublicProfilePath("/pr%6Ffile%2Ejpg")).toBe(true);
    expect(isLegacyPublicProfilePath("/profile.png")).toBe(false);
    expect(isWorkersDevHost("spotify.example.workers.dev")).toBe(true);
    expect(isWorkersDevHost("music.streamarena.xyz")).toBe(false);
  });

  test("keeps forward-auth redirects same-origin and out of auth loops", () => {
    expect(safePrivatePageNext("/library?view=albums")).toBe("/library?view=albums");
    expect(safePrivatePageNext("//example.test/steal")).toBe("/");
    expect(safePrivatePageNext("https://example.test/steal")).toBe("/");
    expect(safePrivatePageNext("/signin")).toBe("/");
    expect(safePrivatePageNext("/register")).toBe("/");
  });

  test("opens only the constrained native profile-avatar object shape", () => {
    expect(isAuthOpenApiPath("/api/files/users/user-123/profile/avatar.jpg")).toBe(true);
    expect(isAuthOpenApiPath("/api/files/users/user-123/profile/avatar.webp")).toBe(true);

    expect(isAuthOpenApiPath("/api/files/users/user-123/audio/song.mp3")).toBe(false);
    expect(isAuthOpenApiPath("/api/files/users/user-123/profile/avatar.html")).toBe(false);
    expect(isAuthOpenApiPath("/api/files/users/user-123/profile/nested/avatar.jpg")).toBe(false);
    expect(isAuthOpenApiPath("/api/files/users/user-123%2Fother/profile/avatar.jpg")).toBe(false);
  });
});

describe("Worker private page gate", () => {
  test("redirects anonymous private pages to the canonical sign-in page", async () => {
    const harness = workerHarness(false);
    const response = await harness.fetch("https://spotify.example.workers.dev/api/auth/page-gate", {
      headers: { "x-forwarded-uri": "/library?view=albums" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://music.streamarena.xyz/signin?next=%2Flibrary%3Fview%3Dalbums",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive, nosnippet",
    );
  });

  test("grants an authenticated Caddy forward-auth request", async () => {
    const harness = workerHarness(true);
    const response = await harness.fetch("https://spotify.example.workers.dev/api/auth/page-gate", {
      headers: {
        cookie: "spotify_session=test-session",
        "x-forwarded-uri": "/library",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("closes the workers.dev SPA while retaining the custom-domain asset binding", async () => {
    const harness = workerHarness(false);
    const workerResponse = await harness.fetch("https://spotify.example.workers.dev/");
    expect(workerResponse.status).toBe(404);
    expect(workerResponse.headers.get("content-type")).toContain("application/json");
    expect(harness.assetFetches).toBe(0);

    const customResponse = await harness.fetch("https://music.streamarena.xyz/signin");
    expect(customResponse.status).toBe(200);
    expect(customResponse.headers.get("content-type")).toContain("text/html");
    expect(customResponse.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive, nosnippet",
    );
    expect(harness.assetFetches).toBe(1);
  });

  test("returns explicit JSON misses instead of falling through to the SPA", async () => {
    const harness = workerHarness(true);
    const profileResponse = await harness.fetch("https://music.streamarena.xyz/pr%6Ffile.jpg");
    expect(profileResponse.status).toBe(404);
    expect(profileResponse.headers.get("content-type")).toContain("application/json");
    expect(harness.assetFetches).toBe(0);

    const apiResponse = await harness.fetch("https://music.streamarena.xyz/api/not-a-route", {
      headers: { cookie: "spotify_session=test-session" },
    });
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get("content-type")).toContain("application/json");
    expect(await apiResponse.json()).toEqual({ error: "Not found" });
    expect(harness.assetFetches).toBe(0);
  });
});

describe("persistent private-site deployment contract", () => {
  test("ships no legacy profile asset and emits crawler exclusion in every web layer", () => {
    expect(existsSync(new URL("../public/profile.jpg", import.meta.url))).toBe(false);
    expect(readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8")).toBe(
      "User-agent: *\nDisallow: /\n",
    );
    expect(readFileSync(new URL("../index.html", import.meta.url), "utf8")).toContain(
      'name="robots" content="noindex, nofollow, noarchive, nosnippet"',
    );
    expect(readFileSync(new URL("../public/_headers", import.meta.url), "utf8")).toContain(
      "X-Robots-Tag: noindex, nofollow, noarchive, nosnippet",
    );
    expect(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).toContain(
      '"run_worker_first": true',
    );
  });

  test("keeps only the sign-in shell assets public and forward-auths all other Caddy pages", () => {
    const caddyInstaller = readFileSync(
      new URL("../scripts/install-mini-caddy.sh", import.meta.url),
      "utf8",
    );
    expect(caddyInstaller).toContain("\\t@spotify_register path /register /register/");
    expect(caddyInstaller).toContain("\\t\\tredir * /signin 302");
    expect(caddyInstaller).toContain("\\t@spotify_legacy_profile path /profile.jpg");
    expect(caddyInstaller).toContain("\\t\\trespond 404");
    expect(caddyInstaller).toContain("\\t@spotify_public_web path /signin /signin/ /assets/*");
    expect(caddyInstaller).toContain("\\t\\tforward_auth https://{worker_host}");
    expect(caddyInstaller).toContain("\\t\\t\\turi /api/auth/page-gate");
    expect(caddyInstaller).toContain(
      '\\t\\tX-Robots-Tag "noindex, nofollow, noarchive, nosnippet"',
    );
  });

  test("keeps deployment checks for every anonymous public boundary", () => {
    const miniCheck = readFileSync(
      new URL("../scripts/check-mini.sh", import.meta.url),
      "utf8",
    );
    for (const path of [
      '/settings"',
      '/register"',
      '/signin"',
      '/profile.jpg"',
      '/robots.txt"',
      '/api/auth/page-gate"',
    ]) {
      expect(miniCheck).toContain(path);
    }
    expect(miniCheck).toContain('"${WORKER_ORIGIN%/}/"');
    expect(miniCheck).toContain("wrong-method API miss returns JSON, not the SPA");
  });

  test("adds noindex to direct local-server responses, including immutable upstream responses", () => {
    const upstream = new Response("ok");
    Object.defineProperty(upstream.headers, "set", {
      value: () => {
        throw new TypeError("immutable");
      },
    });
    const secured = withNoIndexHeader(upstream);
    expect(secured).not.toBe(upstream);
    expect(secured.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive, nosnippet",
    );
  });
});
