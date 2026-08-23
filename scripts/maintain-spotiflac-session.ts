import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPOTIFLAC_SESSION_REFRESH_AHEAD_MS,
  spotiflacCommunitySessionNeedsRefresh,
} from "../src/lib/spotiflac-community";
import {
  desktopSpotiflacSessionPath,
  readDesktopSpotiflacSession,
  refreshDesktopSpotiflacSession,
} from "./refresh-spotiflac-session";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const STATE_DIR = process.env.SPOTIFLAC_MAINTENANCE_STATE_DIR?.trim() || join(homedir(), ".local", "state", "spotify");
const LAST_ATTEMPT_FILE = join(STATE_DIR, "spotiflac-session-last-attempt");
const SYNC_STATE_FILE = join(STATE_DIR, "spotiflac-session-sync.json");
const RETRY_AFTER_MS = 30 * 60 * 1000;
const RESYNC_AFTER_MS = 60 * 60 * 1000;

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

async function writePrivateText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function syncState(): Promise<{ fingerprint: string; syncedAt: number }> {
  try {
    const parsed = JSON.parse(await readFile(SYNC_STATE_FILE, "utf8")) as Record<string, unknown>;
    return {
      fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : "",
      syncedAt: Number(parsed.syncedAt) || 0,
    };
  } catch {
    return { fingerprint: "", syncedAt: 0 };
  }
}

async function syncSessionIfNeeded(nowMs: number): Promise<void> {
  const sessionFile = desktopSpotiflacSessionPath();
  const bytes = await readFile(sessionFile);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const previous = await syncState();
  if (previous.fingerprint === fingerprint && nowMs - previous.syncedAt < RESYNC_AFTER_MS) return;

  const child = Bun.spawn(["/bin/bash", join(ROOT_DIR, "scripts", "sync-spotiflac-session.sh")], {
    cwd: ROOT_DIR,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`SpotiFLAC session sync exited with code ${exitCode}`);
  await writePrivateText(SYNC_STATE_FILE, `${JSON.stringify({ fingerprint, syncedAt: Date.now() })}\n`);
}

export async function maintainSpotiflacSession(nowMs = Date.now()): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
  const session = await readDesktopSpotiflacSession();
  const refreshAheadMs = Math.max(
    0,
    Number(process.env.SPOTIFLAC_REFRESH_AHEAD_MS) || SPOTIFLAC_SESSION_REFRESH_AHEAD_MS,
  );
  if (spotiflacCommunitySessionNeedsRefresh(session, { nowMs, refreshAheadMs })) {
    const lastAttempt = Number((await readText(LAST_ATTEMPT_FILE)).trim()) || 0;
    if (nowMs - lastAttempt < RETRY_AFTER_MS) return;
    await writePrivateText(LAST_ATTEMPT_FILE, `${nowMs}\n`);
    const result = await refreshDesktopSpotiflacSession({ force: true });
    console.log(`Refreshed SpotiFLAC session until ${result.expiresAt}`);
  }
  await syncSessionIfNeeded(nowMs);
}

if (import.meta.main) {
  try {
    await maintainSpotiflacSession();
  } catch (error) {
    console.error(`SpotiFLAC session maintenance failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
