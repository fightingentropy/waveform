// Soundcharts ISRC → platform IDs (same flow as SpotiFLAC-Next / spotiflac-cli).

import { toObject, toStringValue } from "./provider-http";

const SEARCH_BASE = "https://search.soundcharts.com";
const GRAPHQL_URL = "https://graphql.soundcharts.com/";
const APP_BASE = "https://app.soundcharts.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const OPERATION = "getSongPlatformIdentifiers";
const QUERY =
  "query getSongPlatformIdentifiers($songUuid: String!) { SongPlatformIdentifiers(songUuid: $songUuid) { platformCode identifiers { identifier url __typename } __typename } }";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIDAL_RE = /tidal\.com\/(?:browse\/)?track\/(\d+)/i;
const QOBUZ_RE = /qobuz\.com\/(?:[\w-]+\/)*track(?:\/[\w-]+)*\/(\d+)/i;
const DEEZER_RE = /deezer\.com\/(?:[a-z-]+\/)?track\/(\d+)/i;
const AMAZON_RE = /(?:music\.amazon\.[^/]+\/tracks\/|amazon\.[^/]+\/.*\/)(B0[A-Z0-9]{8})/i;

export type SoundchartsIDs = {
  tidal?: number;
  qobuz?: number;
  deezer?: number;
  amazon?: string;
};

export type SoundchartsOptions = {
  token?: string;
  timeoutMs?: number;
};

function normalizeToken(raw: string | undefined | null): string {
  let t = (raw || "").trim().replace(/^["']|["']$/g, "");
  if (t.toLowerCase().startsWith("bearer ")) t = t.slice(7).trim();
  return t;
}

function extractSongUuid(doc: unknown): string {
  const root = toObject(doc);
  const sResults = toObject(root?.sResults);
  const song = toObject(sResults?.song);
  const results = Array.isArray(song?.results) ? song.results : [];
  for (const item of results) {
    const uuid = toStringValue(toObject(item)?.uuid);
    if (uuid && UUID_RE.test(uuid)) return uuid;
  }
  return "";
}

function mergeUrl(ids: SoundchartsIDs, rawUrl: string): void {
  let m = rawUrl.match(TIDAL_RE);
  if (m && !ids.tidal) ids.tidal = Number(m[1]);
  m = rawUrl.match(QOBUZ_RE);
  if (m && !ids.qobuz) ids.qobuz = Number(m[1]);
  m = rawUrl.match(DEEZER_RE);
  if (m && !ids.deezer) ids.deezer = Number(m[1]);
  m = rawUrl.match(AMAZON_RE);
  if (m && !ids.amazon) ids.amazon = m[1];
}

function applyIdentifier(ids: SoundchartsIDs, platformCode: string, identifier: string): void {
  const code = platformCode.trim().toLowerCase();
  const id = identifier.trim();
  if (!id) return;
  if (code === "tidal" && !ids.tidal) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) ids.tidal = n;
  } else if (code === "qobuz" && !ids.qobuz) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) ids.qobuz = n;
  } else if (code === "deezer" && !ids.deezer) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) ids.deezer = n;
  } else if ((code === "amazon" || code === "amazonmusic" || code === "amazon_music") && !ids.amazon) {
    if (/^B0[A-Z0-9]{8}$/i.test(id)) ids.amazon = id.toUpperCase();
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve platform IDs from an ISRC via Soundcharts.
 * Soft-fails (returns null) when token is missing or the song is not found.
 */
export async function lookupSoundcharts(
  isrc: string,
  options: SoundchartsOptions = {},
): Promise<SoundchartsIDs | null> {
  const token = normalizeToken(options.token);
  const trimmed = isrc.trim();
  if (!token || !trimmed) return null;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const search = await fetchJson(
    `${SEARCH_BASE}/search/all?query=${encodeURIComponent(trimmed)}`,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        authorization: `Bearer ${token}`,
        cookie: `soundcharts_token=${token}`,
        "user-agent": USER_AGENT,
      },
    },
    timeoutMs,
  );
  if (search.status === 401 || search.status === 403) return null;
  if (!search.ok) return null;
  const uuid = extractSongUuid(search.json);
  if (!uuid) return null;

  const gql = await fetchJson(
    GRAPHQL_URL,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        referer: `${APP_BASE}/app/song/${uuid}/overview`,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        operationName: OPERATION,
        variables: { songUuid: uuid },
        query: QUERY,
      }),
    },
    timeoutMs,
  );
  if (gql.status === 401 || gql.status === 403) return null;
  if (!gql.ok) return null;

  const data = toObject(toObject(gql.json)?.data);
  const platforms = Array.isArray(data?.SongPlatformIdentifiers) ? data.SongPlatformIdentifiers : [];
  const ids: SoundchartsIDs = {};
  for (const platform of platforms) {
    const p = toObject(platform);
    const code = toStringValue(p?.platformCode);
    const identifiers = Array.isArray(p?.identifiers) ? p.identifiers : [];
    for (const entry of identifiers) {
      const e = toObject(entry);
      const url = toStringValue(e?.url);
      const identifier = toStringValue(e?.identifier);
      if (url) mergeUrl(ids, url);
      applyIdentifier(ids, code, identifier);
    }
  }
  if (!ids.tidal && !ids.qobuz && !ids.deezer && !ids.amazon) return null;
  return ids;
}

/** Load token from env (SOUNDCHARTS_TOKEN) or a Next cookies JSON string. */
export function soundchartsTokenFromEnv(env: {
  SOUNDCHARTS_TOKEN?: string;
  SOUNDCHARTS_COOKIES_JSON?: string;
}): string {
  const direct = normalizeToken(env.SOUNDCHARTS_TOKEN);
  if (direct) return direct;
  const raw = env.SOUNDCHARTS_COOKIES_JSON?.trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { authorization?: string; token?: string; cookies?: { soundcharts_token?: string } };
    return (
      normalizeToken(parsed.authorization) ||
      normalizeToken(parsed.token) ||
      normalizeToken(parsed.cookies?.soundcharts_token)
    );
  } catch {
    return normalizeToken(raw);
  }
}
