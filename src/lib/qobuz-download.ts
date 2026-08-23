import { createDecipheriv, createHash } from "node:crypto";

import { gdStudioSignature, gdStudioUrlEncode } from "./gdstudio";
import {
  fetchWithTimeout as fetchWithTimeoutShared,
  toObject,
  toStringValue,
  type FetchWithTimeoutOptions,
} from "./provider-http";
import { scoreTitleArtistAlbum } from "./search-scoring";
import {
  communitySessionFromEnv,
  communityUserAgent,
  signSpotiflacCommunityHeaders,
  type SpotiflacCommunitySession,
} from "./spotiflac-community";

const QOBUZ_API_BASE_URL = "https://www.qobuz.com/api.json/0.2";
const QOBUZ_DEFAULT_APP_ID = "712109809";
const QOBUZ_DEFAULT_APP_SECRET = "589be88e4538daea11f509d29e4a23b1";
const QOBUZ_OPEN_TRACK_PROBE_URL = "https://open.qobuz.com/track/1";
const QOBUZ_REQUEST_TIMEOUT_MS = 60_000;
// The provider fallback chain runs ~12 sequential attempts (20-25s each), which
// can serialize for minutes. Cap the whole chain with a wall-clock deadline so
// the request can't tie up the Worker/Mac-mini indefinitely.
const QOBUZ_STREAM_RESOLUTION_BUDGET_MS = 90_000;
const QOBUZ_GDSTUDIO_VERSION = "2026.5.10";

const qobuzOpenBundleScriptPattern =
  /<script[^>]+src="([^"]+\/js\/main\.js|\/resources\/[^"]+\/js\/main\.js)"/;
const qobuzOpenAPIConfigPattern =
  /app_id:"(\d{9})",app_secret:"([a-f0-9]{32})"/;
const qobuzStreamingURLPattern = /https?:\/\/[^\s"'<>\\)]+/g;

const QOBUZ_WJHE_STREAM_API_URL = "https://music.wjhe.top/api/music/qobuz/url";
const QOBUZ_MUSICDL_DOWNLOAD_API_URL = "https://www.musicdl.me/api/qobuz/download";
const QOBUZ_GDSTUDIO_API_URLS = [
  "https://music.gdstudio.xyz/api.php",
  "https://music.gdstudio.org/api.php",
];
const QOBUZ_LEGACY_STREAM_API_BASES = [
  "https://dab.yeet.su/api/stream?trackId=",
  "https://dabmusic.xyz/api/stream?trackId=",
  "https://qobuz.squid.wtf/api/download-music?track_id=",
];
const QOBUZ_SPOTBYE_COMMUNITY_API_URL = "https://qbz-oss.spotbye.qzz.io/api/dl";

const qobuzMusicDLDebugKeySeedParts = [
  Buffer.from([0x73, 0x70, 0x6f, 0x74, 0x69, 0x66]),
  Buffer.from([0x6c, 0x61, 0x63, 0x3a, 0x71, 0x6f]),
  Buffer.from([
    0x62, 0x75, 0x7a, 0x3a, 0x6d, 0x75, 0x73, 0x69, 0x63, 0x64, 0x6c, 0x3a,
    0x76, 0x31,
  ]),
];
const qobuzMusicDLDebugKeyAAD = Buffer.from([
  0x71, 0x6f, 0x62, 0x75, 0x7a, 0x7c, 0x6d, 0x75, 0x73, 0x69, 0x63, 0x64,
  0x6c, 0x7c, 0x64, 0x65, 0x62, 0x75, 0x67, 0x7c, 0x76, 0x31,
]);
const qobuzMusicDLDebugKeyNonce = Buffer.from([
  0x91, 0x2a, 0x5c, 0x77, 0x0f, 0x33, 0xa8, 0x14, 0x62, 0x9d, 0xce, 0x41,
]);
const qobuzMusicDLDebugKeyCiphertext = Buffer.from([
  0xf3, 0x4a, 0x83, 0x45, 0x24, 0xb6, 0x22, 0xaf, 0xd6, 0xc3, 0x6e, 0x2d,
  0x56, 0xd1, 0xbb, 0x0b, 0xe9, 0x1b, 0x4f, 0x1c, 0x5f, 0x41, 0x55, 0xc2,
  0xc6, 0xdf, 0xad, 0x21, 0x58, 0xfe, 0xd5, 0xb8, 0x2d, 0x29, 0xf9, 0x9e,
  0x6f, 0xd6,
]);
const qobuzMusicDLDebugKeyTag = Buffer.from([
  0x69, 0x0c, 0x42, 0x70, 0x14, 0x83, 0xff, 0x14, 0xc8, 0xbe, 0x17, 0x00,
  0x69, 0xb1, 0xfe, 0xbb,
]);

export type QobuzCredentials = {
  appId: string;
  appSecret: string;
};

type QobuzSearchResponse = {
  tracks?: {
    total?: number | string;
    items?: QobuzTrack[];
  };
};

export type QobuzTrack = {
  id: number | string;
  title?: string;
  version?: string;
  isrc?: string;
  maximum_bit_depth?: number;
  maximum_sampling_rate?: number;
  hires?: boolean;
  hires_streamable?: boolean;
  performer?: {
    name?: string;
  };
  album?: {
    title?: string;
    artist?: {
      name?: string;
    };
  };
};

export class QobuzDownloadError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

let qobuzCredentials: QobuzCredentials | null = null;
let qobuzMusicDLDebugKey: string | null = null;

function fetchWithTimeout(
  url: string,
  options?: FetchWithTimeoutOptions,
): Promise<Response> {
  return fetchWithTimeoutShared(url, options, {
    defaultTimeoutMs: QOBUZ_REQUEST_TIMEOUT_MS,
    onTimeout: () => new QobuzDownloadError("Qobuz provider request timed out", 504),
  });
}

async function scrapeQobuzOpenCredentials(): Promise<QobuzCredentials> {
  const shellResponse = await fetchWithTimeout(QOBUZ_OPEN_TRACK_PROBE_URL);
  if (!shellResponse.ok) {
    throw new QobuzDownloadError(`Qobuz open shell returned ${shellResponse.status}`);
  }

  const shell = await shellResponse.text();
  const scriptPath = shell.match(qobuzOpenBundleScriptPattern)?.[1] ?? "";
  if (!scriptPath) {
    throw new QobuzDownloadError("Qobuz open bundle URL not found");
  }

  const scriptUrl = scriptPath.startsWith("/")
    ? `https://open.qobuz.com${scriptPath}`
    : scriptPath;
  const scriptResponse = await fetchWithTimeout(scriptUrl);
  if (!scriptResponse.ok) {
    throw new QobuzDownloadError(`Qobuz open bundle returned ${scriptResponse.status}`);
  }

  const script = await scriptResponse.text();
  const match = script.match(qobuzOpenAPIConfigPattern);
  const appId = match?.[1] ?? "";
  const appSecret = match?.[2] ?? "";
  if (!appId || !appSecret) {
    throw new QobuzDownloadError("Qobuz app credentials not found in open bundle");
  }
  return { appId, appSecret };
}

function validQobuzCredentials(credentials?: QobuzCredentials): QobuzCredentials | null {
  const appId = toStringValue(credentials?.appId);
  const appSecret = toStringValue(credentials?.appSecret);
  return appId && appSecret ? { appId, appSecret } : null;
}

async function getQobuzCredentials(
  forceRefresh = false,
  credentialsOverride?: QobuzCredentials,
): Promise<QobuzCredentials> {
  const override = validQobuzCredentials(credentialsOverride);
  if (override) return override;

  if (!forceRefresh && qobuzCredentials) {
    return qobuzCredentials;
  }

  if (forceRefresh) {
    qobuzCredentials = await scrapeQobuzOpenCredentials().catch(() => null);
  }

  qobuzCredentials ??= {
    appId: QOBUZ_DEFAULT_APP_ID,
    appSecret: QOBUZ_DEFAULT_APP_SECRET,
  };
  return qobuzCredentials;
}

function qobuzSignaturePayload(
  path: string,
  params: URLSearchParams,
  timestamp: string,
  secret: string,
): string {
  const normalizedPath = path.replaceAll("/", "");
  const keys = Array.from(new Set(Array.from(params.keys())))
    .filter((key) => key !== "app_id" && key !== "request_ts" && key !== "request_sig")
    .sort();

  let payload = normalizedPath;
  for (const key of keys) {
    const values = params.getAll(key);
    if (values.length === 0) {
      payload += key;
      continue;
    }
    for (const value of values) {
      payload += `${key}${value}`;
    }
  }
  return `${payload}${timestamp}${secret}`;
}

function qobuzRequestSignature(
  path: string,
  params: URLSearchParams,
  timestamp: string,
  secret: string,
): string {
  return createHash("md5")
    .update(qobuzSignaturePayload(path, params, timestamp, secret))
    .digest("hex");
}

async function qobuzSignedFetch(
  path: string,
  params: URLSearchParams,
  forceRefresh = false,
  credentialsOverride?: QobuzCredentials,
): Promise<Response> {
  const credentials = await getQobuzCredentials(forceRefresh, credentialsOverride);
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const requestParams = new URLSearchParams(params);
  requestParams.set("app_id", credentials.appId);
  requestParams.set("request_ts", timestamp);
  requestParams.set(
    "request_sig",
    qobuzRequestSignature(path, params, timestamp, credentials.appSecret),
  );

  return fetchWithTimeout(`${QOBUZ_API_BASE_URL}/${path}?${requestParams.toString()}`, {
    headers: {
      "x-app-id": credentials.appId,
    },
  });
}

async function qobuzSignedJson<T>(
  path: string,
  params: URLSearchParams,
  credentials?: QobuzCredentials,
): Promise<T> {
  let response = await qobuzSignedFetch(path, params, false, credentials);
  if (response.status === 400 || response.status === 401) {
    response.body?.cancel().catch(() => {});
    response = await qobuzSignedFetch(path, params, true, credentials);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new QobuzDownloadError(
      body
        ? `Qobuz API returned ${response.status}: ${body.slice(0, 240)}`
        : `Qobuz API returned ${response.status}`,
      response.status >= 500 ? 502 : 400,
    );
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    throw new QobuzDownloadError("Qobuz API returned invalid JSON");
  }
  return payload as T;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = toStringValue(value);
    if (trimmed) return trimmed;
  }
  return "";
}

function qobuzTrackDisplayArtist(track: QobuzTrack): string {
  return firstNonEmpty(track.performer?.name, track.album?.artist?.name);
}

function qobuzTrackSupportsHiRes(track: QobuzTrack): boolean {
  return Boolean(
    track.hires ||
      track.hires_streamable ||
      (track.maximum_bit_depth ?? 0) >= 24 ||
      (track.maximum_sampling_rate ?? 0) > 48,
  );
}

function scoreQobuzSearchCandidate(
  track: QobuzTrack,
  title: string,
  artist: string,
  album: string,
): number {
  let score = scoreTitleArtistAlbum(
    { title, artist, album },
    {
      title: toStringValue(track.title),
      artist: qobuzTrackDisplayArtist(track),
      album: toStringValue(track.album?.title),
    },
  );

  if (qobuzTrackSupportsHiRes(track)) {
    score += 40;
  } else if ((track.maximum_bit_depth ?? 0) >= 16) {
    score += 20;
  }

  return score;
}

function qobuzTrackId(track: QobuzTrack): string {
  const id = track.id;
  return typeof id === "number" ? `${id}` : toStringValue(id);
}

export async function resolveQobuzTrack(options: {
  isrc?: string;
  title?: string;
  artist?: string;
  album?: string;
  credentials?: QobuzCredentials;
}): Promise<QobuzTrack> {
  const isrc = toStringValue(options.isrc).toUpperCase();
  const title = toStringValue(options.title);
  const artist = toStringValue(options.artist);
  const album = toStringValue(options.album);
  const fallbackQuery = [title, artist].filter(Boolean).join(" ");
  const queries = Array.from(new Set([isrc, fallbackQuery].filter(Boolean)));
  let lastError = "";

  for (const query of queries) {
    try {
      const payload = await qobuzSignedJson<QobuzSearchResponse>(
        "track/search",
        new URLSearchParams({
          query,
          limit: "10",
        }),
        options.credentials,
      );
      const items = Array.isArray(payload.tracks?.items) ? payload.tracks.items : [];
      if (items.length === 0) {
        lastError = `track not found for query: ${query}`;
        continue;
      }

      let selected = items[0];
      let selectedScore = -1;
      for (const item of items) {
        const score = scoreQobuzSearchCandidate(item, title, artist, album);
        if (score > selectedScore) {
          selected = item;
          selectedScore = score;
        }
      }
      if (qobuzTrackId(selected)) {
        return selected;
      }
      lastError = `Qobuz returned a track without an ID for query: ${query}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : `Qobuz search failed for ${query}`;
    }
  }

  throw new QobuzDownloadError(lastError || "Could not resolve Qobuz track", 400);
}

export async function resolveQobuzTrackId(options: {
  isrc?: string;
  title?: string;
  artist?: string;
  album?: string;
  credentials?: QobuzCredentials;
}): Promise<string> {
  const track = await resolveQobuzTrack(options);
  const trackId = qobuzTrackId(track);
  if (!trackId) {
    throw new QobuzDownloadError("Qobuz track ID is missing", 400);
  }
  return trackId;
}

function qobuzURLLooksStreamable(raw: string): boolean {
  const candidate = raw.trim().replaceAll("\\/", "/");
  if (!candidate) {
    return false;
  }
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
  } catch {
    return false;
  }
}

function findQobuzStreamingURLInPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return qobuzURLLooksStreamable(payload) ? payload.replaceAll("\\/", "/") : "";
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const url = findQobuzStreamingURLInPayload(item);
      if (url) return url;
    }
    return "";
  }
  const obj = toObject(payload);
  if (!obj) return "";

  for (const key of ["download_url", "url", "play_url", "stream_url", "link", "file"]) {
    const url = findQobuzStreamingURLInPayload(obj[key]);
    if (url) return url;
  }
  for (const value of Object.values(obj)) {
    const url = findQobuzStreamingURLInPayload(value);
    if (url) return url;
  }
  return "";
}

function extractQobuzStreamingURL(body: string): string {
  const trimmed = body.trim();
  if (
    !trimmed ||
    trimmed.startsWith("<") ||
    trimmed.includes("Just a moment") ||
    trimmed.includes("Captcha required")
  ) {
    return "";
  }

  try {
    const parsedJson = JSON.parse(trimmed) as unknown;
    if (parsedJson) {
      const url = findQobuzStreamingURLInPayload(parsedJson);
      if (url) return url;
    }
  } catch {
    // Some public providers return JSONP, redirects, or plain-text URLs.
  }

  const callbackStart = trimmed.indexOf("(");
  const callbackEnd = trimmed.lastIndexOf(")");
  if (callbackStart >= 0 && callbackEnd > callbackStart + 1) {
    const url = extractQobuzStreamingURL(trimmed.slice(callbackStart + 1, callbackEnd));
    if (url) return url;
  }

  for (const match of trimmed.match(qobuzStreamingURLPattern) ?? []) {
    const candidate = match.replaceAll("\\/", "/");
    if (qobuzURLLooksStreamable(candidate)) return candidate;
  }

  return "";
}

async function extractStreamUrlFromResponse(response: Response): Promise<string> {
  const location = response.headers.get("location")?.trim() ?? "";
  if (qobuzURLLooksStreamable(location)) {
    return location;
  }

  const body = await response.text().catch(() => "");
  if (!body) {
    return "";
  }
  try {
    return extractQobuzStreamingURL(body);
  } catch {
    return "";
  }
}

function mapQobuzWJHEQuality(quality: string): { quality: string; format: string } {
  if (quality === "27" || quality === "24" || quality === "7") {
    return { quality: "2000", format: "flac" };
  }
  if (!quality || quality === "16" || quality === "6") {
    return { quality: "1000", format: "flac" };
  }
  return { quality: "320", format: "mp3" };
}

async function downloadFromWJHE(trackId: string, quality: string): Promise<string> {
  const mapped = mapQobuzWJHEQuality(quality);
  const params = new URLSearchParams({
    ID: trackId,
    quality: mapped.quality,
    format: mapped.format,
  });
  const apiUrl = `${QOBUZ_WJHE_STREAM_API_URL}?${params.toString()}`;
  let response = await fetchWithTimeout(apiUrl, {
    method: "HEAD",
    redirect: "manual",
    timeoutMs: 20_000,
  });
  if (response.status === 405 || response.status === 501 || response.status === 404) {
    response.body?.cancel().catch(() => {});
    response = await fetchWithTimeout(apiUrl, { timeoutMs: 20_000 });
  }

  const streamUrl = await extractStreamUrlFromResponse(response);
  if (streamUrl) return streamUrl;
  throw new QobuzDownloadError(`WJHE returned ${response.status}`);
}

function qobuzGDStudioSignature(apiUrl: string, value: string, ts9: string): string {
  const host = new URL(apiUrl).host;
  return gdStudioSignature(host, gdStudioUrlEncode(value.trim()), ts9, QOBUZ_GDSTUDIO_VERSION);
}

function mapQobuzGDStudioBitrate(quality: string): string {
  if (quality === "27" || quality === "24" || quality === "7") return "999";
  if (!quality || quality === "16" || quality === "6") return "740";
  return "320";
}

async function downloadFromGDStudio(
  trackId: string,
  quality: string,
  apiUrl: string,
): Promise<string> {
  const host = new URL(apiUrl).host;
  const fallbackTs = `${Date.now()}`.slice(0, 9);
  const tsResponse = await fetchWithTimeout(`https://${host}/time`, {
    timeoutMs: 8_000,
  }).catch(() => null);
  const ts = tsResponse?.ok ? (await tsResponse.text()).trim().slice(0, 9) : fallbackTs;
  const ts9 = ts.length >= 9 ? ts : fallbackTs;
  const body = new URLSearchParams({
    types: "url",
    id: trackId,
    source: "qobuz",
    br: mapQobuzGDStudioBitrate(quality),
    s: qobuzGDStudioSignature(apiUrl, trackId, ts9),
  });

  const response = await fetchWithTimeout(apiUrl, {
    method: "POST",
    body,
    timeoutMs: 20_000,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: `https://${host}`,
      referer: `https://${host}/`,
    },
  });
  const streamUrl = await extractStreamUrlFromResponse(response);
  if (streamUrl) return streamUrl;
  throw new QobuzDownloadError(`GDStudio returned ${response.status} without a stream URL`);
}

function getQobuzMusicDLDebugKey(): string {
  if (qobuzMusicDLDebugKey) return qobuzMusicDLDebugKey;

  const hash = createHash("sha256");
  for (const part of qobuzMusicDLDebugKeySeedParts) {
    hash.update(part);
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    hash.digest(),
    qobuzMusicDLDebugKeyNonce,
  );
  decipher.setAAD(qobuzMusicDLDebugKeyAAD);
  decipher.setAuthTag(qobuzMusicDLDebugKeyTag);
  qobuzMusicDLDebugKey = Buffer.concat([
    decipher.update(qobuzMusicDLDebugKeyCiphertext),
    decipher.final(),
  ]).toString("utf8");
  return qobuzMusicDLDebugKey;
}

async function downloadFromMusicDL(trackId: string, quality: string): Promise<string> {
  const response = await fetchWithTimeout(QOBUZ_MUSICDL_DOWNLOAD_API_URL, {
    method: "POST",
    timeoutMs: 25_000,
    headers: {
      "content-type": "application/json",
      "x-debug-key": getQobuzMusicDLDebugKey(),
    },
    body: JSON.stringify({
      url: `https://open.qobuz.com/track/${trackId}`,
      quality: quality || "6",
    }),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new QobuzDownloadError(`MusicDL returned ${response.status}: ${body.slice(0, 160)}`);
  }

  try {
    const payload = JSON.parse(body) as unknown;
    const url = findQobuzStreamingURLInPayload(payload);
    if (url) return url;
    const obj = toObject(payload);
    const message = toStringValue(obj?.error) || toStringValue(obj?.message);
    throw new QobuzDownloadError(message || "MusicDL response did not include a download URL");
  } catch (error) {
    if (error instanceof QobuzDownloadError) throw error;
    throw new QobuzDownloadError("MusicDL returned an unsupported response");
  }
}

function mapQobuzSpotbyeQuality(quality: string): string {
  const normalized = quality.trim();
  if (normalized === "27") return "24";
  if (normalized === "7") return "16";
  if (normalized === "24" || normalized === "16" || normalized === "6") return normalized;
  return "";
}

async function downloadFromSpotbyeCommunity(
  trackId: string,
  quality: string,
  communitySession?: SpotiflacCommunitySession | null,
): Promise<string> {
  const spotbyeQuality = mapQobuzSpotbyeQuality(quality);
  if (!spotbyeQuality) {
    throw new QobuzDownloadError(
      `Spotbye community Qobuz does not support quality ${quality || "default"}`,
    );
  }
  const session = communitySession ?? communitySessionFromEnv(process.env);
  if (!session) {
    throw new QobuzDownloadError("Spotbye community Qobuz needs a SpotiFLAC HMAC session");
  }

  const bodyText = JSON.stringify({ id: trackId, quality: spotbyeQuality });
  const endpoint = new URL(QOBUZ_SPOTBYE_COMMUNITY_API_URL);
  const signed = await signSpotiflacCommunityHeaders({
    method: "POST",
    pathname: endpoint.pathname,
    query: "",
    body: new TextEncoder().encode(bodyText),
    session,
  });
  const response = await fetchWithTimeout(QOBUZ_SPOTBYE_COMMUNITY_API_URL, {
    method: "POST",
    timeoutMs: 25_000,
    redirect: "manual",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "user-agent": communityUserAgent(session),
      ...signed,
    },
    body: bodyText,
  });

  // The community tier rate-limits aggressively (429 / 503 + Retry-After). Don't
  // block staging on a long backoff — fail fast so the chain falls through to the
  // other Qobuz providers below, and the next play retries from a fresh slot.
  if (response.status === 429 || response.status === 503) {
    response.body?.cancel().catch(() => {});
    throw new QobuzDownloadError(
      `Spotbye community Qobuz is rate-limited (${response.status})`,
      503,
    );
  }

  const streamUrl = await extractStreamUrlFromResponse(response);
  if (streamUrl) return streamUrl;
  throw new QobuzDownloadError(
    `Spotbye community Qobuz returned ${response.status} without a stream URL`,
  );
}

async function downloadFromLegacyProvider(
  trackId: string,
  quality: string,
  apiBase: string,
): Promise<string> {
  const response = await fetchWithTimeout(
    `${apiBase}${encodeURIComponent(trackId)}&quality=${encodeURIComponent(quality || "6")}`,
    { timeoutMs: 25_000 },
  );
  const streamUrl = await extractStreamUrlFromResponse(response);
  if (streamUrl) return streamUrl;
  throw new QobuzDownloadError(`legacy Qobuz provider returned ${response.status}`);
}

export async function resolveQobuzStreamUrl(options: {
  isrc?: string;
  title?: string;
  artist?: string;
  album?: string;
  quality: string;
  credentials?: QobuzCredentials;
  communitySession?: SpotiflacCommunitySession | null;
}): Promise<string> {
  const track = await resolveQobuzTrack(options);
  const trackId = qobuzTrackId(track);
  if (!trackId) {
    throw new QobuzDownloadError("Qobuz track ID is missing", 400);
  }

  const attempts: Array<() => Promise<string>> = [
    () => downloadFromSpotbyeCommunity(trackId, options.quality, options.communitySession),
    () => downloadFromWJHE(trackId, options.quality),
    ...QOBUZ_GDSTUDIO_API_URLS.map(
      (apiUrl) => () => downloadFromGDStudio(trackId, options.quality, apiUrl),
    ),
    ...QOBUZ_LEGACY_STREAM_API_BASES.map(
      (apiBase) => () => downloadFromLegacyProvider(trackId, options.quality, apiBase),
    ),
    () => downloadFromMusicDL(trackId, options.quality),
  ];

  const deadline = Date.now() + QOBUZ_STREAM_RESOLUTION_BUDGET_MS;
  const errors: string[] = [];
  for (const attempt of attempts) {
    if (Date.now() >= deadline) {
      errors.push("overall Qobuz stream resolution budget exceeded");
      break;
    }
    try {
      const streamUrl = await attempt();
      if (streamUrl) return streamUrl;
      errors.push("provider returned no stream URL");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Qobuz stream provider failed");
    }
  }

  throw new QobuzDownloadError(
    `Qobuz found track ${trackId}, but its stream providers are currently unavailable: ${errors.join(" | ")}`,
  );
}

export async function resolveQobuzAvailability(options: {
  isrc?: string;
  title?: string;
  artist?: string;
  album?: string;
  credentials?: QobuzCredentials;
}): Promise<{ available: boolean; qobuzUrl: string }> {
  try {
    const track = await resolveQobuzTrack(options);
    const trackId = qobuzTrackId(track);
    return {
      available: Boolean(trackId),
      qobuzUrl: trackId ? `https://open.qobuz.com/track/${trackId}` : "",
    };
  } catch {
    return { available: false, qobuzUrl: "" };
  }
}
