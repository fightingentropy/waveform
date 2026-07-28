import { describe, expect, spyOn, test } from "bun:test";
import { hash } from "bcryptjs";
import {
  collectManagedStorageKeys,
  exclusiveManagedStorageKeys,
  managedStorageKeyFromUrl,
  type AccountMediaRow,
} from "../src/lib/account-deletion";
import worker from "../src/worker/index";

type TestUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: string | null;
  passwordHash: string;
};

class FakePreparedStatement {
  readonly sql: string;
  params: unknown[] = [];

  constructor(
    sql: string,
    private readonly database: FakeD1,
  ) {
    this.sql = sql.replace(/\s+/g, " ").trim();
  }

  bind(...params: unknown[]) {
    this.params = params;
    return this as unknown as D1PreparedStatement;
  }

  async all<T>(): Promise<D1Result<T>> {
    this.database.reads.push(this);
    let results: unknown[] = [];
    if (this.sql.includes('INNER JOIN "User"')) {
      results = this.database.authenticated ? [this.database.publicUser()] : [];
    } else if (this.sql.includes('SELECT "count", "resetAt" FROM "RateLimit"')) {
      results = [];
    } else if (this.sql.includes('SELECT "id", "email", "passwordHash" FROM "User"')) {
      results = [this.database.user];
    } else if (this.sql.includes("UNION ALL") && this.sql.includes('WHERE "id" <>')) {
      results = this.database.otherMedia;
    } else if (this.sql.includes("UNION ALL") && this.sql.includes('WHERE "id" =')) {
      results = this.database.accountMedia;
    }
    return { success: true, results: results as T[], meta: {} } as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    this.database.writes.push(this);
    return { success: true, results: [], meta: {} } as unknown as D1Result<T>;
  }
}

class FakeD1 {
  readonly reads: FakePreparedStatement[] = [];
  readonly writes: FakePreparedStatement[] = [];
  readonly batches: FakePreparedStatement[][] = [];
  failBatch = false;
  authenticated = true;
  accountMedia: AccountMediaRow[] = [];
  otherMedia: AccountMediaRow[] = [];

  constructor(readonly user: TestUser) {}

  publicUser() {
    return {
      id: this.user.id,
      email: this.user.email,
      name: this.user.name,
      image: this.user.image,
      emailVerified: this.user.emailVerified,
    };
  }

  prepare(sql: string): D1PreparedStatement {
    return new FakePreparedStatement(sql, this) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    if (this.failBatch) throw new Error("batch failed");
    this.batches.push(statements as unknown as FakePreparedStatement[]);
    return statements.map(
      () => ({ success: true, results: [], meta: {} }) as unknown as D1Result<unknown>,
    );
  }
}

async function makeHarness(options?: {
  password?: string;
  authenticated?: boolean;
  failBatch?: boolean;
}) {
  const password = options?.password ?? "correct horse";
  const user: TestUser = {
    id: "user-123",
    email: "listener@example.com",
    name: "Listener",
    image: "/api/files/users/user-123/profile/avatar.jpg",
    emailVerified: "2026-01-01",
    passwordHash: await hash(password, 4),
  };
  const db = new FakeD1(user);
  db.authenticated = options?.authenticated ?? true;
  db.failBatch = options?.failBatch ?? false;
  db.accountMedia = [
    { url: user.image },
    { url: "/api/files/music/Artist/Song/audio/owned.flac" },
    { url: "/api/files/music/Artist/Song/cover/shared.jpg" },
    { url: "https://cdn.example.com/not-ours.jpg" },
  ];
  db.otherMedia = [{ url: "/api/files/music/Artist/Song/cover/shared.jpg" }];

  const deletedMedia: string[][] = [];
  const pending: Promise<unknown>[] = [];
  const env = {
    DB: db,
    MEDIA: {
      list: async () => ({
        objects: [{ key: "users/user-123/profile/previous.jpg" }],
        truncated: false,
      }),
      delete: async (keys: string | string[]) => {
        deletedMedia.push(Array.isArray(keys) ? keys : [keys]);
      },
    },
  } as unknown as CloudflareEnv;
  const executionContext = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;

  const request = (body: Record<string, unknown>, cookie = "spotify_session=test-session") =>
    new Request("https://music.streamarena.xyz/api/account", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify(body),
    });

  return { db, deletedMedia, env, executionContext, password, pending, request };
}

describe("account deletion media policy", () => {
  test("accepts only app-managed relative file URLs", () => {
    expect(managedStorageKeyFromUrl("/api/files/music/Artist/Song/audio/file.flac?sig=1")).toBe(
      "music/Artist/Song/audio/file.flac",
    );
    expect(managedStorageKeyFromUrl("https://music.streamarena.xyz/api/files/music/file.flac")).toBeNull();
    expect(managedStorageKeyFromUrl("/api/files/%2e%2e/secrets.txt")).toBeNull();
    expect(managedStorageKeyFromUrl("/apple-icon.png")).toBeNull();
  });

  test("deduplicates keys and retains anything referenced by another account", () => {
    const accountRows = [
      { url: "/api/files/users/u/profile/a.jpg" },
      { url: "/api/files/users/u/profile/a.jpg" },
      { url: "/api/files/music/shared.flac" },
    ];
    expect(collectManagedStorageKeys(accountRows)).toEqual([
      "users/u/profile/a.jpg",
      "music/shared.flac",
    ]);
    expect(
      exclusiveManagedStorageKeys(accountRows, [{ url: "/api/files/music/shared.flac" }]),
    ).toEqual(["users/u/profile/a.jpg"]);
  });
});

describe("DELETE /api/account", () => {
  test("requires an authenticated session", async () => {
    const harness = await makeHarness({ authenticated: false });
    const response = await worker.fetch(
      harness.request({ password: harness.password, confirmation: "DELETE" }),
      harness.env,
      harness.executionContext,
    );
    expect(response.status).toBe(401);
    expect(harness.db.batches).toHaveLength(0);
  });

  test("requires both explicit confirmation and the current password", async () => {
    const harness = await makeHarness();
    const missingConfirmation = await worker.fetch(
      harness.request({ password: harness.password }),
      harness.env,
      harness.executionContext,
    );
    expect(missingConfirmation.status).toBe(400);

    const wrongPassword = await worker.fetch(
      harness.request({ password: "wrong", confirmation: "DELETE" }),
      harness.env,
      harness.executionContext,
    );
    expect(wrongPassword.status).toBe(401);
    expect(harness.db.batches).toHaveLength(0);
  });

  test("atomically removes account rows, revokes sessions, and cleans exclusive media", async () => {
    const harness = await makeHarness();
    const response = await worker.fetch(
      harness.request({ password: harness.password, confirmation: "DELETE" }),
      harness.env,
      harness.executionContext,
    );
    await Promise.all(harness.pending);

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("spotify_session=");
    expect(harness.db.batches).toHaveLength(1);

    const statements = harness.db.batches[0].map((statement) => statement.sql);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM "PlaybackState"'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM "SongRef"'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM "Session"'))).toBe(true);
    expect(statements.at(-1)).toBe('DELETE FROM "User" WHERE "id" = ?');

    expect(harness.deletedMedia.flat().sort()).toEqual([
      "music/Artist/Song/audio/owned.flac",
      "users/user-123/profile/avatar.jpg",
      "users/user-123/profile/previous.jpg",
    ]);
  });

  test("does not schedule media cleanup when the atomic database deletion fails", async () => {
    const harness = await makeHarness({ failBatch: true });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(
        harness.request({ password: harness.password, confirmation: "DELETE" }),
        harness.env,
        harness.executionContext,
      );

      expect(response.status).toBe(500);
      expect(harness.pending).toHaveLength(0);
      expect(harness.deletedMedia).toHaveLength(0);
    } finally {
      errorLog.mockRestore();
    }
  });
});
