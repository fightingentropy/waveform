import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  communitySessionFromEnv,
  parseSpotiflacCommunitySession,
  type SpotiflacCommunitySession,
} from "../lib/spotiflac-community";

export function loadDesktopSpotiflacCommunitySession(): SpotiflacCommunitySession | null {
  const fromEnv = communitySessionFromEnv(process.env);
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), ".spotiflac", "community_session.json"), "utf8");
    return parseSpotiflacCommunitySession(JSON.parse(raw) as { session_id?: string; session_secret?: string });
  } catch {
    return null;
  }
}
