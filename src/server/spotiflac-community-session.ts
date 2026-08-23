import {
  communitySessionFromEnv,
  parseSpotiflacCommunitySession,
  SPOTIFLAC_SESSION_REFRESH_AHEAD_MS,
  spotiflacCommunitySessionNeedsRefresh,
  type SpotiflacCommunitySession,
} from "../lib/spotiflac-community";
import {
  readDesktopSpotiflacSession,
  refreshDesktopSpotiflacSession,
  type DesktopSpotiflacSessionRecord,
} from "./spotiflac-session-refresh";

type RefreshSession = typeof refreshDesktopSpotiflacSession;

export type EnsureDesktopSpotiflacSessionOptions = {
  environment?: object | null;
  nowMs?: number;
  readSession?: () => Promise<DesktopSpotiflacSessionRecord>;
  refreshSession?: RefreshSession;
};

let renewalInFlight: Promise<void> | null = null;

async function renewDesktopSpotiflacCommunitySession(
  force: boolean,
  options: EnsureDesktopSpotiflacSessionOptions,
): Promise<SpotiflacCommunitySession> {
  const refreshSession = options.refreshSession ?? refreshDesktopSpotiflacSession;
  if (!renewalInFlight) {
    renewalInFlight = refreshSession({ force })
      .then(() => undefined)
      .finally(() => {
        renewalInFlight = null;
      });
  }
  await renewalInFlight;
  const record = await (options.readSession ?? readDesktopSpotiflacSession)();
  const session = parseSpotiflacCommunitySession(record);
  if (!session) throw new Error("SpotiFLAC returned an invalid refreshed session");
  return session;
}

/**
 * Check the desktop session only when a provider request needs it. This follows
 * SpotiFLAC's five-minute freshness window and coalesces concurrent renewals.
 */
export async function ensureDesktopSpotiflacCommunitySession(
  options: EnsureDesktopSpotiflacSessionOptions = {},
): Promise<SpotiflacCommunitySession> {
  const environment = options.environment === undefined ? process.env : options.environment;
  const fromEnv = communitySessionFromEnv(environment);
  if (fromEnv) return fromEnv;
  const record = await (options.readSession ?? readDesktopSpotiflacSession)();
  if (
    spotiflacCommunitySessionNeedsRefresh(record, {
      nowMs: options.nowMs,
      refreshAheadMs: SPOTIFLAC_SESSION_REFRESH_AHEAD_MS,
    })
  ) {
    return renewDesktopSpotiflacCommunitySession(false, options);
  }
  const session = parseSpotiflacCommunitySession(record);
  if (!session) throw new Error("SpotiFLAC session is invalid");
  return session;
}

export function forceRefreshDesktopSpotiflacCommunitySession(
  options: EnsureDesktopSpotiflacSessionOptions = {},
): Promise<SpotiflacCommunitySession> {
  return renewDesktopSpotiflacCommunitySession(true, options);
}

export function spotiflacProviderRejectedSession(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status) || 0;
  const message = error instanceof Error ? error.message : "";
  return status === 401 || status === 403 || status === 428 || /verification session|signed request validation/i.test(message);
}
