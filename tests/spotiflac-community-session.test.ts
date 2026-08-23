import { describe, expect, test } from "bun:test";
import {
  ensureDesktopSpotiflacCommunitySession,
  forceRefreshDesktopSpotiflacCommunitySession,
  spotiflacProviderRejectedSession,
} from "../src/server/spotiflac-community-session";
import type { DesktopSpotiflacSessionRecord } from "../src/server/spotiflac-session-refresh";

const freshRecord = (): DesktopSpotiflacSessionRecord => ({
  install_id: "install-test",
  session_id: "session-fresh",
  session_secret: "secret-fresh",
  expires_at: "2099-01-01T00:00:00.000Z",
});

describe("request-time SpotiFLAC session renewal", () => {
  test("does no renewal work while the session is fresh", async () => {
    let refreshCalls = 0;
    const session = await ensureDesktopSpotiflacCommunitySession({
      environment: null,
      readSession: async () => freshRecord(),
      refreshSession: async () => {
        refreshCalls += 1;
        return { expiresAt: freshRecord().expires_at!, refreshed: true };
      },
    });

    expect(session.sessionId).toBe("session-fresh");
    expect(refreshCalls).toBe(0);
  });

  test("coalesces concurrent stale-session renewals", async () => {
    let record: DesktopSpotiflacSessionRecord = {
      install_id: "install-test",
      session_id: "session-stale",
      session_secret: "secret-stale",
      expires_at: "2020-01-01T00:00:00.000Z",
    };
    let refreshCalls = 0;
    const refreshSession = async (options: { force?: boolean } = {}) => {
      refreshCalls += 1;
      expect(options.force).toBe(false);
      await Promise.resolve();
      record = freshRecord();
      return { expiresAt: record.expires_at!, refreshed: true };
    };
    const options = {
      environment: null,
      readSession: async () => record,
      refreshSession,
    };

    const [first, second] = await Promise.all([
      ensureDesktopSpotiflacCommunitySession(options),
      ensureDesktopSpotiflacCommunitySession(options),
    ]);

    expect(first.sessionId).toBe("session-fresh");
    expect(second.sessionId).toBe("session-fresh");
    expect(refreshCalls).toBe(1);
  });

  test("forces one renewal after a provider rejects a nominally fresh session", async () => {
    let record = freshRecord();
    let forced = false;
    const session = await forceRefreshDesktopSpotiflacCommunitySession({
      environment: null,
      readSession: async () => record,
      refreshSession: async (options = {}) => {
        forced = options.force === true;
        record = { ...freshRecord(), session_id: "session-replaced" };
        return { expiresAt: record.expires_at!, refreshed: true };
      },
    });

    expect(forced).toBe(true);
    expect(session.sessionId).toBe("session-replaced");
  });

  test("recognizes provider-side session rejection", () => {
    expect(spotiflacProviderRejectedSession({ status: 401 })).toBe(true);
    expect(spotiflacProviderRejectedSession({ status: 428 })).toBe(true);
    expect(spotiflacProviderRejectedSession(new Error("Signed request validation failed."))).toBe(true);
    expect(spotiflacProviderRejectedSession({ status: 429 })).toBe(false);
    expect(spotiflacProviderRejectedSession(new Error("scheduled short break"))).toBe(false);
  });
});
