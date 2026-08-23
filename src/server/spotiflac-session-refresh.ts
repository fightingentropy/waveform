import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  SPOTIFLAC_SESSION_REFRESH_AHEAD_MS,
  spotiflacCommunitySessionNeedsRefresh,
} from "../lib/spotiflac-community";

const DEFAULT_VERIFY_URL = "https://verify.spotbye.qzz.io";
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 32 * 1024;

export type DesktopSpotiflacSessionRecord = {
  install_id?: string;
  session_id?: string;
  session_secret?: string;
  expires_at?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function sameSecretText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function desktopSpotiflacSessionPath(): string {
  return process.env.SPOTIFLAC_SESSION_FILE?.trim() || join(homedir(), ".spotiflac", "community_session.json");
}

export async function readDesktopSpotiflacSession(
  path = desktopSpotiflacSessionPath(),
): Promise<DesktopSpotiflacSessionRecord> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as DesktopSpotiflacSessionRecord;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON object");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the SpotiFLAC session: ${error instanceof Error ? error.message : "invalid file"}`, {
      cause: error,
    });
  }
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomHex(4)}`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function installedAppVersion(): string {
  const result = Bun.spawnSync([
    "/usr/bin/defaults",
    "read",
    "/Applications/SpotiFLAC.app/Contents/Info.plist",
    "CFBundleShortVersionString",
  ]);
  const version = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
  if (!version) throw new Error("SpotiFLAC is not installed in /Applications");
  return version;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("SpotiFLAC verification returned an oversized response");
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error("SpotiFLAC verification returned invalid JSON");
  }
}

function verificationBaseUrl(): URL {
  const base = new URL(process.env.SPOTIFLAC_VERIFY_URL?.trim() || DEFAULT_VERIFY_URL);
  if (base.protocol !== "https:") throw new Error("SpotiFLAC verification must use HTTPS");
  return base;
}

async function openVerificationPage(url: URL): Promise<void> {
  const processHandle = Bun.spawn(["/usr/bin/open", url.toString()], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error("Could not open the SpotiFLAC verification page");
}

const VERIFIED_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verified</title></head><body style="font:16px system-ui;background:#000;color:#fff;display:grid;place-items:center;min-height:100vh"><main><h1>Verified</h1><p>You can close this tab.</p></main><script>setTimeout(()=>window.close(),700)</script></body></html>`;

async function requestVerificationGrant(record: DesktopSpotiflacSessionRecord, appVersion: string): Promise<string> {
  const installId = text(record.install_id);
  if (!installId) throw new Error("SpotiFLAC install ID is missing");
  const callbackState = randomHex(16);
  let resolveGrant!: (grant: string) => void;
  const grantPromise = new Promise<string>((resolve) => {
    resolveGrant = resolve;
  });
  const callbackServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/session-grant") {
        return new Response("Not found", { status: 404 });
      }
      if (!sameSecretText(url.searchParams.get("state") || "", callbackState)) {
        return new Response("Invalid verification callback state", { status: 400 });
      }
      const grant = text(url.searchParams.get("grant"));
      if (!grant) return new Response("Missing verification grant", { status: 400 });
      resolveGrant(grant);
      return new Response(VERIFIED_HTML, {
        headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const callbackUrl = `http://127.0.0.1:${callbackServer.port}/session-grant?state=${callbackState}`;
    const bootstrapUrl = new URL("/bootstrap", verificationBaseUrl());
    bootstrapUrl.searchParams.set("install_id", installId);
    bootstrapUrl.searchParams.set("app_version", appVersion);
    bootstrapUrl.searchParams.set("platform", "desktop");
    const bootstrapResponse = await fetch(bootstrapUrl, { signal: AbortSignal.timeout(15_000) });
    if (!bootstrapResponse.ok) {
      throw new Error(`SpotiFLAC verification bootstrap returned HTTP ${bootstrapResponse.status}`);
    }
    const bootstrap = await boundedJson(bootstrapResponse);
    const challengeUrl = new URL(text(bootstrap.challenge_url));
    if (challengeUrl.protocol !== "https:") throw new Error("SpotiFLAC returned an invalid challenge URL");
    challengeUrl.searchParams.set("cb", callbackUrl);
    await openVerificationPage(challengeUrl);

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("SpotiFLAC verification timed out")), VERIFICATION_TIMEOUT_MS);
    });
    return await Promise.race([grantPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    callbackServer.stop(true);
  }
}

async function exchangeGrant(
  record: DesktopSpotiflacSessionRecord,
  appVersion: string,
  grant: string,
): Promise<DesktopSpotiflacSessionRecord> {
  const response = await fetch(new URL("/session/exchange", verificationBaseUrl()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant,
      install_id: text(record.install_id),
      app_version: appVersion,
      platform: "desktop",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SpotiFLAC session exchange returned HTTP ${response.status}`);
  const exchanged = await boundedJson(response);
  const sessionId = text(exchanged.session_id);
  const sessionSecret = text(exchanged.session_secret);
  const expiresAt = text(exchanged.expires_at);
  if (!sessionId || !sessionSecret || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("SpotiFLAC session exchange response is incomplete");
  }
  return {
    install_id: text(record.install_id),
    session_id: sessionId,
    session_secret: sessionSecret,
    expires_at: expiresAt,
  };
}

export async function refreshDesktopSpotiflacSession(options: { force?: boolean } = {}): Promise<{
  expiresAt: string;
  refreshed: boolean;
}> {
  const path = desktopSpotiflacSessionPath();
  const record = await readDesktopSpotiflacSession(path);
  if (!record.install_id) {
    record.install_id = randomHex(16);
    await writePrivateFile(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (
    !options.force &&
    !spotiflacCommunitySessionNeedsRefresh(record, { refreshAheadMs: SPOTIFLAC_SESSION_REFRESH_AHEAD_MS })
  ) {
    return { expiresAt: text(record.expires_at), refreshed: false };
  }

  const appVersion = installedAppVersion();
  const grant = await requestVerificationGrant(record, appVersion);
  const refreshed = await exchangeGrant(record, appVersion, grant);
  await writePrivateFile(path, `${JSON.stringify(refreshed, null, 2)}\n`);
  return { expiresAt: text(refreshed.expires_at), refreshed: true };
}
