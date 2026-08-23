import {
  QobuzDownloadError,
  resolveQobuzTrackId,
  resolveQobuzStreamUrl as resolveQobuzProviderStreamUrl,
  type QobuzCredentials,
} from "@/lib/qobuz-download";
import {
  TidalDownloadError,
  resolveTidalStreamUrl as resolveTidalProviderStreamUrl,
} from "@/lib/tidal-download";
import {
  LicensedSourceDownloadError,
  materializeLicensedSourceStream,
  resolveLicensedSourceStreamUrl as resolveLicensedSourceProviderStreamUrl,
  type LicensedSourceStream,
} from "@/lib/licensed-source-download";
import {
  communitySessionFromEnv,
  communityUserAgent,
  isSpotiflacCommunityHost,
} from "@/lib/spotiflac-community";
import { canUseMacMiniProxy, fetchMacMini } from "./mac-mini-proxy";
import {
  AmazonDownloadError,
  resolveAmazonAsinFromSpotify,
  resolveAmazonStreamUrl,
} from "@/lib/amazon-download";
import { classifyAudioBytes, classifyAudioContentType, type AudioCodecInfo } from "@/lib/audio-codec-detect";
import {
  SpotifyPathfinderError,
  fetchSpotifyAlbumTracks as fetchPathfinderAlbumTracks,
  fetchSpotifyPlaylistTracks as fetchPathfinderPlaylistTracks,
  fetchSpotifyTrackMetadata,
  scrapeSpotifyTrackIdsFromHtml,
  type SpotifyBatchTrack,
} from "@/lib/spotify-pathfinder";
import { resolveTidalTrackIdByIsrc } from "@/lib/tidal-isrc";
import { lookupSoundcharts, soundchartsTokenFromEnv } from "@/lib/soundcharts";
import { peekAndReplayStream } from "./streaming-multipart";
import { ApiError } from "./http";
import { MAX_AUDIO_BYTES } from "./r2-put";
import { envString, envStringList, toNumberValue, toObject, toStringValue } from "./values";
import {
  DOWNLOAD_REQUEST_TIMEOUT_MS,
  SPOTIFY_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
} from "./fetch";
import { SERVER_IMPORT_OUTPUT_FORMAT, type BatchResponseTrack, type SongPayload } from "./payloads";

export type DownloadProviderService =
  | "licensed"
  | "tidal"
  | "tidal_x"
  | "tidal_custom"
  | "qobuz"
  | "qobuz_x"
  | "qobuz_custom"
  | "amazon"
  | "amazon_x"
  | "deezer"
  | "deezer_x"
  | "deezer_custom"
  | "apple";

export type ResolvedAudioDownloadCandidate = {
  service: DownloadProviderService;
  streamUrl: string;
  headers?: Record<string, string>;
  contentType?: string;
  licensedStream?: LicensedSourceStream;
  userAgent?: string;
  minimumQuality?: "lossless";
};

export type ResolvedAudioDownload = ResolvedAudioDownloadCandidate & {
  fallbacks?: ResolvedAudioDownloadCandidate[];
};

export type EnhancedMetadata = {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  releaseDate?: string;
  trackNumber?: number;
  totalTracks?: number;
  discNumber?: number;
  totalDiscs?: number;
  genre?: string;
  isrc?: string;
  upc?: string;
  composer?: string;
  publisher?: string;
  copyright?: string;
  lyrics?: string;
  duration?: number;
  bitDepth?: number;
  sampleRate?: number;
};

export function parseSpotifyTrackId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "spotify.com" && host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const trackIndex = parts.findIndex((part) => part === "track");
  const trackId = trackIndex >= 0 ? parts[trackIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(trackId) ? trackId : null;
}

export function parseSpotifyAlbumId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "spotify.com" && host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const albumIndex = parts.findIndex((part) => part === "album");
  const albumId = albumIndex >= 0 ? parts[albumIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(albumId) ? albumId : null;
}

export function parseSpotifyPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "spotify.com" && host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const playlistIndex = parts.findIndex((part) => part === "playlist");
  const playlistId = playlistIndex >= 0 ? parts[playlistIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(playlistId) ? playlistId : null;
}

export function determineSpotifyUrlType(url: string): "track" | "album" | "playlist" | "collection" | null {
  try {
    const parsed = new URL(url.trim());
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.includes("track")) return "track";
    if (parts.includes("album")) return "album";
    if (parts.includes("playlist")) return "playlist";
    if (parts.includes("collection")) return "collection";
  } catch {}
  return null;
}

function parseTrackIdFromUrl(url: string): string | null {
  return url.match(/\/track\/([A-Za-z0-9]+)/i)?.[1] ?? null;
}

function parsePlatformId(entityUniqueId: string, prefix: string): string {
  return entityUniqueId.startsWith(prefix) ? entityUniqueId.slice(prefix.length).trim() : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJsonObject(url: string, timeoutMs = SPOTIFY_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const maxAttempts = 3;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response | null;
    try {
      response = await fetchWithTimeout(url, timeoutMs);
    } catch {
      response = null;
    }
    if (!response) throw new ApiError("Upstream request failed", 502);
    if (response.ok) {
      const payload = toObject(await response.json().catch(() => null));
      if (!payload) throw new ApiError("Invalid upstream JSON", 502);
      return payload;
    }
    lastStatus = response.status;
    // Retry transient rate-limit / server errors; honor Retry-After when present.
    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : 400 * attempt;
      await delay(backoffMs);
      continue;
    }
    throw new ApiError(`Upstream request returned ${response.status}`, 502);
  }
  throw new ApiError(`Upstream request returned ${lastStatus}`, 502);
}

async function fetchSongLinkPayload(trackId: string, region: string): Promise<Record<string, unknown>> {
  const spotifyUrl = `https://open.spotify.com/track/${trackId}`;
  const params = new URLSearchParams({ url: spotifyUrl });
  if (region) params.set("userCountry", region);
  return fetchJsonObject(`https://api.song.link/v1-alpha.1/links?${params.toString()}`);
}

const SONG_LINK_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

type SongLinkPlatformName =
  | "tidal"
  | "qobuz"
  | "deezer"
  | "amazonMusic"
  | "amazon"
  | "appleMusic"
  | "itunes";

function songLinkEntityPrefix(platform: SongLinkPlatformName): string {
  switch (platform) {
    case "tidal":
      return "TIDAL_SONG::";
    case "qobuz":
      return "QOBUZ_SONG::";
    case "deezer":
      return "DEEZER_SONG::";
    case "amazonMusic":
    case "amazon":
      return "AMAZON_SONG::";
    case "appleMusic":
      return "APPLE_MUSIC_SONG::";
    case "itunes":
      return "ITUNES_SONG::";
  }
}

function platformIdFromSongLinkUrl(platform: SongLinkPlatformName, url: string): string {
  if (platform === "tidal" || platform === "deezer" || platform === "qobuz") {
    return url.match(/\/(?:track|tracks)\/(\d+)/i)?.[1] ?? "";
  }
  if (platform === "amazonMusic" || platform === "amazon") {
    return amazonAsinFromValue(url);
  }
  try {
    const parsed = new URL(url);
    const queryId = parsed.searchParams.get("i") || "";
    if (/^\d+$/.test(queryId)) return queryId;
    return parsed.pathname.match(/\/(\d+)(?:$|\/)/)?.[1] ?? "";
  } catch {
    return url.match(/\/(\d+)(?:$|[?#/])/)?.[1] ?? "";
  }
}

function normalizeSongLinkPlatform(value: string): SongLinkPlatformName | "" {
  const platform = value.trim();
  if (
    platform === "tidal" ||
    platform === "qobuz" ||
    platform === "deezer" ||
    platform === "amazonMusic" ||
    platform === "amazon" ||
    platform === "appleMusic" ||
    platform === "itunes"
  ) {
    return platform;
  }
  return "";
}

export function parseSpotiflacStatusPayload(payload: unknown): Record<string, string> | null {
  const root = toObject(payload);
  if (!root) return null;
  const buckets = [
    toObject(root.status),
    toObject(toObject(root.next)?.status),
    toObject(toObject(root.standard)?.status),
    toObject(toObject(root.community)?.status),
    toObject(toObject(root.spotiflac)?.status),
  ];
  const out: Record<string, string> = {};
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const [key, value] of Object.entries(bucket)) {
      const normalized = toStringValue(value).toLowerCase();
      if (!key || !normalized || out[key]) continue;
      out[key] = normalized;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseSongLinkNextDataHtml(html: string, trackId: string): Record<string, unknown> | null {
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const nextData = toObject(parsed);
  const pageData = toObject(toObject(toObject(nextData?.props)?.pageProps)?.pageData);
  if (!pageData) return null;

  const entity = toObject(pageData.entityData) ?? {};
  const title = toStringValue(entity.title) || toStringValue(entity.name);
  const artist = toStringValue(entity.artistName);
  const thumbnailUrl = toStringValue(entity.thumbnailUrl);
  const isrc = toStringValue(entity.isrc).toUpperCase();
  const spotifyKey = `SPOTIFY_SONG::${trackId}`;
  const linksByPlatform: Record<string, { url: string; entityUniqueId: string }> = {};

  const sections = Array.isArray(pageData.sections) ? pageData.sections : [];
  for (const section of sections) {
    const sectionObject = toObject(section);
    const links = Array.isArray(sectionObject?.links) ? sectionObject.links : [];
    for (const rawLink of links) {
      const link = toObject(rawLink);
      const platform = normalizeSongLinkPlatform(toStringValue(link?.platform));
      const url = toStringValue(link?.url);
      if (!platform || !url || linksByPlatform[platform]) continue;
      const id = platformIdFromSongLinkUrl(platform, url);
      linksByPlatform[platform] = {
        url,
        entityUniqueId: `${songLinkEntityPrefix(platform)}${id || url}`,
      };
    }
  }

  if (!title && !artist && Object.keys(linksByPlatform).length === 0) return null;
  return {
    entityUniqueId: spotifyKey,
    entitiesByUniqueId: {
      [spotifyKey]: {
        title,
        artistName: artist,
        thumbnailUrl,
        ...(isrc ? { isrc } : {}),
      },
    },
    linksByPlatform,
  };
}

export function parseSongstatsSameAsLinks(html: string): Partial<Record<SongLinkPlatformName, string>> {
  const out: Partial<Record<SongLinkPlatformName, string>> = {};
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const raw = match[1]?.trim().replace(/&quot;/g, '"').replace(/&amp;/g, "&") ?? "";
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    collectSongstatsSameAs(parsed, out);
  }
  return out;
}

function collectSongstatsSameAs(
  value: unknown,
  out: Partial<Record<SongLinkPlatformName, string>>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSongstatsSameAs(item, out);
    return;
  }
  const object = toObject(value);
  if (!object) return;
  const sameAs = object.sameAs;
  if (typeof sameAs === "string") assignSongstatsLink(sameAs, out);
  else if (Array.isArray(sameAs)) {
    for (const item of sameAs) {
      if (typeof item === "string") assignSongstatsLink(item, out);
    }
  }
  for (const nested of Object.values(object)) collectSongstatsSameAs(nested, out);
}

function assignSongstatsLink(raw: string, out: Partial<Record<SongLinkPlatformName, string>>): void {
  const link = raw.trim();
  if (!link) return;
  if (!out.tidal && /listen\.tidal\.com\/track/i.test(link)) out.tidal = link;
  else if (!out.amazonMusic && /music\.amazon\./i.test(link)) out.amazonMusic = link;
  else if (!out.deezer && /deezer\.com/i.test(link)) out.deezer = link;
}

function injectSongLinkPlatform(
  payload: Record<string, unknown>,
  platform: SongLinkPlatformName,
  url: string,
): void {
  if (!url || getPlatformLink(payload, platform)) return;
  const id = platformIdFromSongLinkUrl(platform, url);
  injectPlatformLink(payload, platform, url, `${songLinkEntityPrefix(platform)}${id || url}`);
}

function mergeSongLinkPayloads(
  ...payloads: Array<Record<string, unknown> | null>
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    entityUniqueId: "",
    entitiesByUniqueId: {},
    linksByPlatform: {},
  };
  for (const payload of payloads) {
    if (!payload) continue;
    if (!toStringValue(out.entityUniqueId)) {
      out.entityUniqueId = toStringValue(payload.entityUniqueId);
    }
    const entities = toObject(payload.entitiesByUniqueId);
    if (entities) {
      const dest = toObject(out.entitiesByUniqueId) ?? {};
      for (const [key, value] of Object.entries(entities)) {
        const incoming = toObject(value);
        const existing = toObject(dest[key]);
        dest[key] = existing ? { ...incoming, ...existing } : incoming;
        const merged = toObject(dest[key]);
        if (merged && incoming) {
          for (const [field, fieldValue] of Object.entries(incoming)) {
            if (!toStringValue(merged[field]) && fieldValue) merged[field] = fieldValue;
          }
          dest[key] = merged;
        }
      }
      out.entitiesByUniqueId = dest;
    }
    const links = toObject(payload.linksByPlatform);
    if (links) {
      const dest = toObject(out.linksByPlatform) ?? {};
      for (const [platform, value] of Object.entries(links)) {
        if (!getPlatformLink({ linksByPlatform: dest }, platform)) dest[platform] = value;
      }
      out.linksByPlatform = dest;
    }
  }
  return out;
}

function isrcFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const entities = toObject(songLinkPayload.entitiesByUniqueId);
  if (entities) {
    for (const value of Object.values(entities)) {
      const isrc = toStringValue(toObject(value)?.isrc).toUpperCase();
      if (isrc) return isrc;
    }
  }
  return toStringValue(songLinkPayload.isrc).toUpperCase();
}

function songLinkPayloadHasProviderLink(payload: Record<string, unknown>): boolean {
  return Boolean(
    getPlatformLink(payload, "tidal") ||
      getPlatformLink(payload, "qobuz") ||
      getPlatformLink(payload, "deezer") ||
      getPlatformLink(payload, "amazonMusic") ||
      getPlatformLink(payload, "amazon") ||
      getPlatformLink(payload, "appleMusic"),
  );
}

async function scrapeSongLinkPayload(trackId: string, region: string): Promise<Record<string, unknown> | null> {
  const pageUrl = new URL(`https://song.link/s/${trackId}`);
  if (region) pageUrl.searchParams.set("country", region);
  const response = await fetchWithTimeout(pageUrl.toString(), SPOTIFY_REQUEST_TIMEOUT_MS, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": SONG_LINK_PAGE_USER_AGENT,
    },
  }).catch(() => null);
  if (!response?.ok) return null;
  const html = await response.text().catch(() => "");
  return html ? parseSongLinkNextDataHtml(html, trackId) : null;
}

async function enrichSongstatsLinks(songLinkPayload: Record<string, unknown>): Promise<void> {
  const missingTidal = !getPlatformLink(songLinkPayload, "tidal");
  const missingAmazon = !getPlatformLink(songLinkPayload, "amazonMusic") && !getPlatformLink(songLinkPayload, "amazon");
  const missingDeezer = !getPlatformLink(songLinkPayload, "deezer");
  if (!missingTidal && !missingAmazon && !missingDeezer) return;
  const isrc = isrcFromSongLinkPayload(songLinkPayload);
  if (!isrc) return;
  const response = await fetchWithTimeout(
    `https://songstats.com/${encodeURIComponent(isrc)}?ref=ISRCFinder`,
    SPOTIFY_REQUEST_TIMEOUT_MS,
    {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": SONG_LINK_PAGE_USER_AGENT,
      },
    },
  ).catch(() => null);
  if (!response?.ok) return;
  const html = await response.text().catch(() => "");
  if (!html) return;
  const links = parseSongstatsSameAsLinks(html);
  if (links.tidal) injectSongLinkPlatform(songLinkPayload, "tidal", links.tidal);
  if (links.amazonMusic) injectSongLinkPlatform(songLinkPayload, "amazonMusic", links.amazonMusic);
  if (links.deezer) injectSongLinkPlatform(songLinkPayload, "deezer", links.deezer);
}

const SPOTIFY_FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function decodeJsonUnicode(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(["\\/])/g, "$1");
}

// Auth-free title/artist lookup from Spotify's embed page. The embed HTML
// inlines a JSON island with the track entity, which lets us seed a Deezer
// search when the Odesli resolver is unavailable.
async function fetchSpotifyEmbedMetadata(trackId: string): Promise<{ title: string; artist: string }> {
  const response = await fetchWithTimeout(
    `https://open.spotify.com/embed/track/${trackId}`,
    SPOTIFY_REQUEST_TIMEOUT_MS,
    { headers: { "user-agent": SPOTIFY_FALLBACK_USER_AGENT, accept: "text/html" } },
  ).catch(() => null);
  if (!response || !response.ok) return { title: "", artist: "" };
  const html = await response.text().catch(() => "");
  if (!html) return { title: "", artist: "" };
  const title =
    html.match(/"name"\s*:\s*"([^"]+)"\s*,\s*"uri"\s*:\s*"spotify:track:/)?.[1] ||
    html.match(/"title"\s*:\s*"([^"]+)"/)?.[1] ||
    "";
  const artist = html.match(/"artists"\s*:\s*\[\s*\{\s*"name"\s*:\s*"([^"]+)"/)?.[1] || "";
  return { title: decodeJsonUnicode(title), artist: decodeJsonUnicode(artist) };
}

// Find a track on Deezer (auth-free) by artist/title, returning its numeric id.
async function searchDeezerTrackId(title: string, artist: string): Promise<string> {
  const queries = [
    artist && title ? `artist:"${artist}" track:"${title}"` : "",
    [artist, title].filter(Boolean).join(" "),
  ].filter(Boolean);
  for (const query of queries) {
    const payload = await fetchJsonObject(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=1`,
    ).catch(() => null);
    const data = payload && Array.isArray(payload.data) ? payload.data : [];
    const rawId = toObject(data[0])?.id;
    const id = typeof rawId === "number" ? String(rawId) : toStringValue(rawId);
    if (/^\d+$/.test(id)) return id;
  }
  return "";
}

// Build a minimal song.link-shaped payload from a Deezer match so the existing
// metadata / ISRC / Qobuz-availability code keeps working when Odesli is down.
function buildFallbackSongLinkPayload(
  trackId: string,
  deezerId: string,
  title: string,
  artist: string,
  thumbnailUrl = "",
  isrc = "",
): Record<string, unknown> {
  const spotifyKey = `SPOTIFY_SONG::${trackId}`;
  const entity = {
    title,
    artistName: artist,
    thumbnailUrl,
    ...(isrc ? { isrc: isrc.toUpperCase() } : {}),
  };
  const linksByPlatform: Record<string, { url: string; entityUniqueId: string }> = {};
  const entitiesByUniqueId: Record<string, unknown> = { [spotifyKey]: entity };
  if (deezerId) {
    const deezerKey = `DEEZER_SONG::${deezerId}`;
    entitiesByUniqueId[deezerKey] = entity;
    linksByPlatform.deezer = { url: `https://www.deezer.com/track/${deezerId}`, entityUniqueId: deezerKey };
  }
  return {
    entityUniqueId: spotifyKey,
    entitiesByUniqueId,
    linksByPlatform,
  };
}

// Resolve a Spotify track to a song.link-shaped payload. Primary source is
// Odesli (which retries on 429); when that is rate-limited or down, fall back
// to an auth-free Spotify-embed -> Deezer lookup so uploads keep working.
// Look up a track on Deezer by its exact ISRC (auth-free), returning the numeric id.
async function deezerIdByIsrc(isrc: string): Promise<string> {
  if (!isrc) return "";
  const payload = await fetchJsonObject(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`).catch(() => null);
  const rawId = payload?.id;
  const id = typeof rawId === "number" ? String(rawId) : toStringValue(rawId);
  return /^\d+$/.test(id) ? id : "";
}

// Resolve via Spotify's authenticated API (sp_dc): canonical metadata + exact
// ISRC, then pin the matching Deezer track by that ISRC so downstream ISRC /
// Qobuz logic works unchanged. Returns null when Spotify is unavailable.
async function resolveViaSpotify(trackId: string, spotifyCookie: string): Promise<Record<string, unknown> | null> {
  const meta = await fetchSpotifyTrackMetadata(trackId, spotifyCookie || undefined).catch(() => null);
  if (!meta || !meta.title) return null;
  let deezerId = meta.isrc ? await deezerIdByIsrc(meta.isrc).catch(() => "") : "";
  if (!deezerId) deezerId = await searchDeezerTrackId(meta.title, meta.artist).catch(() => "");
  return buildFallbackSongLinkPayload(trackId, deezerId, meta.title, meta.artist, meta.imageUrl, meta.isrc);
}

// Resolve a Spotify track to a song.link-shaped payload. SpotiFLAC 7.2.2
// scrapes song.link HTML (the public Odesli API now returns 401
// PUBLIC_API_ACCESS_DEPRECATED) and falls back to Songstats. We do the same,
// then merge Spotify/Deezer metadata so Tidal/Amazon IDs survive even when
// the authenticated Spotify path would previously return Deezer-only.
export async function resolveTrackPayload(
  trackId: string,
  region: string,
  spotifyCookie = "",
): Promise<Record<string, unknown>> {
  const [scraped, viaSpotify] = await Promise.all([
    scrapeSongLinkPayload(trackId, region).catch(() => null),
    resolveViaSpotify(trackId, spotifyCookie).catch(() => null),
  ]);
  let merged = mergeSongLinkPayloads(scraped, viaSpotify);
  if (!getPlatformLink(merged, "deezer")) {
    const isrc = isrcFromSongLinkPayload(merged);
    const deezerId = isrc
      ? await deezerIdByIsrc(isrc).catch(() => "")
      : await searchDeezerTrackId(
          parseSongLinkMetadata(merged, trackId).title,
          parseSongLinkMetadata(merged, trackId).artist,
        ).catch(() => "");
    if (deezerId) {
      injectSongLinkPlatform(merged, "deezer", `https://www.deezer.com/track/${deezerId}`);
    }
  }
  if (songLinkPayloadHasProviderLink(merged) || parseSongLinkMetadata(merged, trackId).title) {
    await enrichSongstatsLinks(merged).catch(() => undefined);
    return merged;
  }

  const odesli = await fetchSongLinkPayload(trackId, region).catch(() => null);
  if (odesli && toObject(odesli.entitiesByUniqueId)) return odesli;

  const meta = await fetchSpotifyEmbedMetadata(trackId);
  const deezerId = await searchDeezerTrackId(meta.title, meta.artist);
  if (!deezerId) throw new ApiError("Could not resolve this track on any provider", 502);
  merged = buildFallbackSongLinkPayload(trackId, deezerId, meta.title, meta.artist);
  await enrichSongstatsLinks(merged).catch(() => undefined);
  return merged;
}

// Best-effort: when a resolved payload has an ISRC (via its Deezer link) but no
// Tidal link, look the Tidal id up by ISRC and inject it so the Hi-Res spotbye
// Tidal source can be used instead of the lossy GDStudio fallback.
async function enrichTidalLink(songLinkPayload: Record<string, unknown>, region: string): Promise<void> {
  if (!songLinkPayload || typeof songLinkPayload !== "object") return;
  if (tidalTrackIdFromSongLinkPayload(songLinkPayload)) return;
  const isrc = await resolveDeezerIsrc(songLinkPayload).catch(() => "");
  if (!isrc) return;
  const tidalId = await resolveTidalTrackIdByIsrc(isrc, region).catch(() => "");
  if (!tidalId) return;
  const links = toObject(songLinkPayload.linksByPlatform) ?? {};
  links.tidal = {
    url: `https://tidal.com/browse/track/${tidalId}`,
    entityUniqueId: `TIDAL_SONG::${tidalId}`,
  };
  songLinkPayload.linksByPlatform = links;
}

function injectPlatformLink(
  songLinkPayload: Record<string, unknown>,
  platform: string,
  url: string,
  entityUniqueId: string,
): void {
  if (getPlatformLink(songLinkPayload, platform)) return;
  const links = toObject(songLinkPayload.linksByPlatform) ?? {};
  links[platform] = { url, entityUniqueId };
  songLinkPayload.linksByPlatform = links;
}

/** Fill missing Tidal/Qobuz/Amazon/Deezer IDs via Soundcharts (Next parity). */
async function enrichSoundchartsLinks(
  env: CloudflareEnv,
  songLinkPayload: Record<string, unknown>,
): Promise<void> {
  if (!songLinkPayload || typeof songLinkPayload !== "object") return;
  const token = soundchartsTokenFromEnv({
    SOUNDCHARTS_TOKEN: envString(env, "SOUNDCHARTS_TOKEN"),
    SOUNDCHARTS_COOKIES_JSON: envString(env, "SOUNDCHARTS_COOKIES_JSON"),
  });
  if (!token) return;
  const missing =
    !getPlatformLink(songLinkPayload, "tidal") ||
    !getPlatformLink(songLinkPayload, "qobuz") ||
    !getPlatformLink(songLinkPayload, "amazonMusic") ||
    !getPlatformLink(songLinkPayload, "amazon") ||
    !getPlatformLink(songLinkPayload, "deezer");
  if (!missing) return;
  const isrc = await resolveDeezerIsrc(songLinkPayload).catch(() => "");
  if (!isrc) return;
  const ids = await lookupSoundcharts(isrc, { token }).catch(() => null);
  if (!ids) return;
  if (ids.tidal) {
    injectPlatformLink(
      songLinkPayload,
      "tidal",
      `https://tidal.com/browse/track/${ids.tidal}`,
      `TIDAL_SONG::${ids.tidal}`,
    );
  }
  if (ids.qobuz) {
    injectPlatformLink(
      songLinkPayload,
      "qobuz",
      `https://open.qobuz.com/track/${ids.qobuz}`,
      `QOBUZ_SONG::${ids.qobuz}`,
    );
  }
  if (ids.deezer) {
    injectPlatformLink(
      songLinkPayload,
      "deezer",
      `https://www.deezer.com/track/${ids.deezer}`,
      `DEEZER_SONG::${ids.deezer}`,
    );
  }
  if (ids.amazon) {
    injectPlatformLink(
      songLinkPayload,
      "amazonMusic",
      `https://music.amazon.com/tracks/${ids.amazon}`,
      `AMAZON_SONG::${ids.amazon}`,
    );
  }
}

export function getPlatformLink(
  songLinkPayload: Record<string, unknown>,
  platform: string,
): { url: string; entityUniqueId: string } | null {
  const linksByPlatform = toObject(songLinkPayload.linksByPlatform);
  if (!linksByPlatform) return null;
  const platformData = toObject(linksByPlatform[platform]);
  if (!platformData) return null;
  const url = toStringValue(platformData.url);
  const entityUniqueId = toStringValue(platformData.entityUniqueId);
  if (!url && !entityUniqueId) return null;
  return { url, entityUniqueId };
}

export function parseSongLinkMetadata(songLinkPayload: Record<string, unknown>, spotifyTrackId: string) {
  const entities = toObject(songLinkPayload.entitiesByUniqueId);
  if (!entities) return { title: "", artist: "", imageUrl: "" };
  const keys = [toStringValue(songLinkPayload.entityUniqueId), `SPOTIFY_SONG::${spotifyTrackId}`];
  for (const key of keys) {
    if (!key) continue;
    const entity = toObject(entities[key]);
    if (!entity) continue;
    return {
      title: toStringValue(entity.title),
      artist: toStringValue(entity.artistName),
      imageUrl: toStringValue(entity.thumbnailUrl),
    };
  }
  return { title: "", artist: "", imageUrl: "" };
}

export function parseDeezerTrackId(songLinkPayload: Record<string, unknown>): string {
  const deezer = getPlatformLink(songLinkPayload, "deezer");
  const entityId = deezer ? parsePlatformId(deezer.entityUniqueId, "DEEZER_SONG::") : "";
  const urlId = deezer?.url ? parseTrackIdFromUrl(deezer.url) : "";
  const id = entityId || urlId || "";
  return /^\d+$/.test(id) ? id : "";
}

export async function fetchDeezerTrackInfo(deezerTrackId: string) {
  if (!deezerTrackId) return null;
  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerTrackId}`).catch(() => null);
  if (!deezerPayload) return null;
  const albumObj = toObject(deezerPayload.album);
  const artistObj = toObject(deezerPayload.artist);
  const durationRaw = deezerPayload.duration;
  const playsRaw = deezerPayload.rank;
  const durationSec =
    typeof durationRaw === "number" ? durationRaw : typeof durationRaw === "string" ? Number(durationRaw) : 0;
  const plays = typeof playsRaw === "number" ? playsRaw : typeof playsRaw === "string" ? Number(playsRaw) : 0;
  const genresObj = toObject(deezerPayload.genres);
  const genreItems = Array.isArray(genresObj?.data) ? genresObj.data : [];
  const firstGenre = toObject(genreItems[0]);

  return {
    album: toStringValue(albumObj?.title),
    albumArtist: toStringValue(artistObj?.name),
    coverUrl:
      toStringValue(albumObj?.cover_xl) ||
      toStringValue(albumObj?.cover_big) ||
      toStringValue(albumObj?.cover_medium) ||
      toStringValue(albumObj?.cover) ||
      "",
    releaseDate: toStringValue(deezerPayload.release_date),
    trackNumber: typeof deezerPayload.track_position === "number" ? deezerPayload.track_position : undefined,
    totalTracks: typeof albumObj?.nb_tracks === "number" ? albumObj.nb_tracks : undefined,
    discNumber: typeof deezerPayload.disk_number === "number" ? deezerPayload.disk_number : undefined,
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    plays: Number.isFinite(plays) ? plays : 0,
    isrc: toStringValue(deezerPayload.isrc).toUpperCase(),
    upc: toStringValue(albumObj?.upc),
    genre: toStringValue(firstGenre?.name) || undefined,
  };
}

export async function fetchEnhancedMetadata(trackId: string, songLinkPayload: Record<string, unknown>): Promise<EnhancedMetadata> {
  const metadata = parseSongLinkMetadata(songLinkPayload, trackId);
  const deezerInfo = await fetchDeezerTrackInfo(parseDeezerTrackId(songLinkPayload));

  // Try to get additional metadata from MusicBrainz using ISRC
  let musicBrainzData = null;
  if (deezerInfo?.isrc) {
    try {
      const mbResponse = await fetchWithTimeout(
        `https://musicbrainz.org/ws/2/recording?query=isrc:${deezerInfo.isrc}&fmt=json`,
        SPOTIFY_REQUEST_TIMEOUT_MS
      );
      if (mbResponse.ok) {
        const mbPayload = await mbResponse.json();
        const recording = mbPayload?.recordings?.[0];
        if (recording) {
          musicBrainzData = {
            composer: recording.relations
              ?.filter((rel: any) => rel.type === "composer")
              ?.map((rel: any) => rel.artist?.name)
              ?.join(", ") || undefined,
            publisher: recording.relations
              ?.filter((rel: any) => rel.type === "publisher")
              ?.map((rel: any) => rel.label?.name)
              ?.join(", ") || undefined,
          };
        }
      }
    } catch {
      // MusicBrainz lookup failed, continue without composer/publisher data
    }
  }

  return {
    title: metadata.title || "Unknown Title",
    artist: metadata.artist || "Unknown Artist",
    album: deezerInfo?.album || "",
    albumArtist: deezerInfo?.albumArtist,
    releaseDate: deezerInfo?.releaseDate,
    trackNumber: deezerInfo?.trackNumber,
    totalTracks: deezerInfo?.totalTracks,
    discNumber: deezerInfo?.discNumber,
    genre: deezerInfo?.genre,
    isrc: deezerInfo?.isrc,
    upc: deezerInfo?.upc,
    composer: musicBrainzData?.composer,
    publisher: musicBrainzData?.publisher,
    duration: deezerInfo?.durationSec,
  };
}

export async function getPreviewUrl(trackId: string): Promise<string> {
  const response = await fetchWithTimeout(`https://open.spotify.com/embed/track/${trackId}`, 20_000).catch(() => null);
  if (!response?.ok) return "";
  const html = await response.text().catch(() => "");
  return html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9?&=._-]+/)?.[0] ?? "";
}

type SpotifyFallbackTrack = {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album?: string;
  releaseDate?: string;
  durationMs?: number;
  imageUrl?: string;
};

export async function fetchSpotifyAlbumTracks(albumId: string, spotifyCookie = ""): Promise<SpotifyFallbackTrack[]> {
  try {
    const result = await fetchPathfinderAlbumTracks(albumId, spotifyCookie || undefined);
    return result.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      artists: track.artists.map((name) => ({ name })),
      album: track.album,
      releaseDate: track.releaseDate,
      durationMs: track.durationMs,
      imageUrl: track.imageUrl,
    }));
  } catch {
    try {
      const response = await fetchWithTimeout(`https://open.spotify.com/album/${albumId}`, SPOTIFY_REQUEST_TIMEOUT_MS);
      if (!response.ok) return [];
      const html = await response.text();
      return scrapeSpotifyTrackIdsFromHtml(html).map((id) => ({
        id,
        name: "Unknown Track",
        artists: [{ name: "Unknown Artist" }],
      }));
    } catch {
      return [];
    }
  }
}

export async function fetchSpotifyPlaylistTracks(playlistId: string, spotifyCookie = ""): Promise<Array<{ track: SpotifyFallbackTrack }>> {
  try {
    const result = await fetchPathfinderPlaylistTracks(playlistId, spotifyCookie || undefined);
    return result.tracks.map((track) => ({
      track: {
        id: track.id,
        name: track.name,
        artists: track.artists.map((name) => ({ name })),
        album: track.album,
        releaseDate: track.releaseDate,
        durationMs: track.durationMs,
        imageUrl: track.imageUrl,
      },
    }));
  } catch (error) {
    if (error instanceof SpotifyPathfinderError && error.status !== 502) throw error;
    try {
      const response = await fetchWithTimeout(`https://open.spotify.com/playlist/${playlistId}`, SPOTIFY_REQUEST_TIMEOUT_MS);
      if (!response.ok) return [];
      const html = await response.text();
      return scrapeSpotifyTrackIdsFromHtml(html).map((id) => ({
        track: { id, name: "Unknown Track", artists: [{ name: "Unknown Artist" }] },
      }));
    } catch {
      return [];
    }
  }
}

export function batchTrackForResponse(track: SpotifyBatchTrack): BatchResponseTrack {
  return {
    spotifyId: track.id,
    title: track.name || "Unknown Track",
    artist: track.artists.filter(Boolean).join(", ") || "Unknown Artist",
    album: track.album || "",
    releaseDate: track.releaseDate || "",
    totalPlays: 0,
    durationMs: track.durationMs || 0,
    imageUrl: track.imageUrl || "",
    previewUrl: "",
  };
}

export function dedupeBatchTracks(tracks: SpotifyBatchTrack[]): SpotifyBatchTrack[] {
  const seen = new Set<string>();
  const result: SpotifyBatchTrack[] = [];
  for (const track of tracks) {
    if (!track.id || seen.has(track.id)) continue;
    seen.add(track.id);
    result.push(track);
  }
  return result;
}

function extractLrcFromSpotifyLyricsApi(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  const obj = toObject(payload);
  if (!obj) return "";
  const direct = toStringValue(obj.lyrics || obj.lrc || obj.syncedLyrics);
  if (direct) return direct;
  const linesValue = obj.lines;
  if (!Array.isArray(linesValue)) return "";
  const lines: string[] = [];
  for (const item of linesValue) {
    const line = toObject(item);
    if (!line) continue;
    const words = toStringValue(line.words || line.text);
    if (!words) continue;
    const timeTag = toStringValue(line.timeTag || line.startTimeMs || line.time);
    lines.push(timeTag ? `[${timeTag}]${words}` : words);
  }
  return lines.join("\n").trim();
}

const MUSIXMATCH_BASE = "https://apic-desktop.musixmatch.com/ws/1.1";
const MUSIXMATCH_APP_ID = "web-desktop-app-v1.0";
const MUSIXMATCH_COOKIE = "AWSELB=0; AWSELBCORS=0";

let musixmatchTokenCache: { token: string; expiresAtMs: number } | null = null;

// Musixmatch's desktop API bootstraps an anonymous user token via token.get,
// which is then required for lyrics lookups — no stored credential needed.
async function musixmatchUserToken(): Promise<string> {
  if (musixmatchTokenCache && musixmatchTokenCache.expiresAtMs > Date.now()) {
    return musixmatchTokenCache.token;
  }
  const response = await fetchWithTimeout(
    `${MUSIXMATCH_BASE}/token.get?app_id=${MUSIXMATCH_APP_ID}&format=json`,
    SPOTIFY_REQUEST_TIMEOUT_MS,
    { headers: { cookie: MUSIXMATCH_COOKIE, "user-agent": SPOTIFY_FALLBACK_USER_AGENT } },
  ).catch(() => null);
  if (!response?.ok) return "";
  const payload = toObject(await response.json().catch(() => null));
  const body = toObject(toObject(payload?.message)?.body);
  const token = toStringValue(body?.user_token);
  if (!token || token === "UpgradeOnlyUrlError") return "";
  musixmatchTokenCache = { token, expiresAtMs: Date.now() + 9 * 60 * 1000 };
  return token;
}

// Fetch synced (LRC) lyrics from Musixmatch by track/artist match.
async function fetchMusixmatchLyrics(title: string, artist: string): Promise<string> {
  if (!title || !artist) return "";
  const token = await musixmatchUserToken();
  if (!token) return "";
  const params = new URLSearchParams({
    format: "json",
    app_id: MUSIXMATCH_APP_ID,
    usertoken: token,
    q_track: title,
    q_artist: artist,
    subtitle_format: "lrc",
  });
  const response = await fetchWithTimeout(
    `${MUSIXMATCH_BASE}/matcher.subtitle.get?${params.toString()}`,
    SPOTIFY_REQUEST_TIMEOUT_MS,
    { headers: { cookie: MUSIXMATCH_COOKIE, "user-agent": SPOTIFY_FALLBACK_USER_AGENT } },
  ).catch(() => null);
  if (!response?.ok) return "";
  const payload = toObject(await response.json().catch(() => null));
  const body = toObject(toObject(payload?.message)?.body);
  const subtitle = toObject(body?.subtitle);
  return toStringValue(subtitle?.subtitle_body);
}

export async function fetchLyricsText(trackId: string, title: string, artist: string): Promise<string> {
  const spotifyLyricsUrl = `https://spotify-lyrics-api-pi.vercel.app/?trackid=${encodeURIComponent(trackId)}&format=lrc`;
  const spotifyLyricsRes = await fetchWithTimeout(spotifyLyricsUrl, SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (spotifyLyricsRes?.ok) {
    const payload = await spotifyLyricsRes.json().catch(() => null);
    const obj = toObject(payload);
    if (!obj?.error) {
      const lrc = extractLrcFromSpotifyLyricsApi(payload);
      if (lrc) return lrc;
    }
  }
  const musixmatchLyrics = await fetchMusixmatchLyrics(title, artist).catch(() => "");
  if (musixmatchLyrics) return musixmatchLyrics;
  const lrclibUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
  const lrclibRes = await fetchWithTimeout(lrclibUrl, SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (lrclibRes?.ok) {
    const payload = toObject(await lrclibRes.json().catch(() => null));
    return toStringValue(payload?.syncedLyrics) || toStringValue(payload?.plainLyrics);
  }
  return "";
}

async function resolveDeezerIsrc(songLinkPayload: Record<string, unknown>): Promise<string> {
  const fromEntity = isrcFromSongLinkPayload(songLinkPayload);
  if (fromEntity) return fromEntity;
  const deezerId = parseDeezerTrackId(songLinkPayload);
  if (!deezerId) return "";
  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerId}`).catch(() => null);
  return toStringValue(deezerPayload?.isrc).toUpperCase();
}

function qualityLists(payload: SongPayload) {
  const qualityRaw = toStringValue(payload.quality);
  const profileRaw = toStringValue(payload.qualityProfile).toLowerCase();
  const qualityProfile = ["cd", "hires48", "max"].includes(profileRaw) ? profileRaw : "max";
  const qobuz = qualityProfile === "cd"
    ? ["16", "6"]
    : qualityProfile === "hires48"
      ? ["16", "7", "6"]
      : ["24", "27", "16", "7", "6"];
  const tidal =
    qualityProfile === "cd"
      ? ["LOSSLESS"]
      : qualityProfile === "hires48"
        ? ["HI_RES_LOSSLESS", "LOSSLESS"]
        : ["HI_RES_LOSSLESS", "LOSSLESS"];
  return {
    qobuz: qualityRaw ? [qualityRaw] : qobuz,
    tidal: qualityRaw ? [qualityRaw] : tidal,
  };
}

export function qobuzCredentialsFromEnv(env: CloudflareEnv): QobuzCredentials | undefined {
  const appId = envString(env, "QOBUZ_APP_ID") || envString(env, "QOBUZ_OPEN_APP_ID");
  const appSecret = envString(env, "QOBUZ_APP_SECRET") || envString(env, "QOBUZ_OPEN_APP_SECRET");
  return appId && appSecret ? { appId, appSecret } : undefined;
}

const DEFAULT_SPOTIFLAC_PROVIDER_ORDER: DownloadProviderService[] = [
  "tidal",
  "tidal_x",
  "tidal_custom",
  "qobuz",
  "qobuz_x",
  "qobuz_custom",
  "amazon",
  "amazon_x",
  "deezer",
  "deezer_x",
  "deezer_custom",
  "apple",
];

const DEFAULT_SPOTIFLAC_CONFIGURED_PROVIDER_URLS: Partial<Record<DownloadProviderService, string[]>> = {
  tidal: ["https://tdl-oss.spotbye.qzz.io/api/dl"],
  qobuz: ["https://qbz-oss.spotbye.qzz.io/api/dl"],
  amazon: ["https://amz-oss.spotbye.qzz.io/api/dl"],
};
const DEFAULT_SPOTIFLAC_STATUS_URL = "https://spotbye.qzz.io/api/status";
const SPOTIFLAC_STATUS_CACHE_MS = 30_000;
let spotiflacStatusCache: {
  expiresAt: number;
  url: string;
  promise: Promise<Record<string, string> | null>;
} | null = null;

function normalizeProviderService(value: string): DownloadProviderService | "" {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  return DEFAULT_SPOTIFLAC_PROVIDER_ORDER.includes(normalized as DownloadProviderService) ||
    normalized === "licensed"
    ? normalized as DownloadProviderService
    : "";
}

function spotiflacProviderOrder(env: CloudflareEnv): DownloadProviderService[] {
  const raw =
    envString(env, "SPOTIFLAC_PROVIDER_ORDER") ||
    envString(env, "SPOTIFLAC_AUTO_ORDER") ||
    DEFAULT_SPOTIFLAC_PROVIDER_ORDER.join("-");
  const parsed = raw
    .split(/[-,\s]+/)
    .map(normalizeProviderService)
    .filter((provider): provider is DownloadProviderService => Boolean(provider));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : DEFAULT_SPOTIFLAC_PROVIDER_ORDER;
}

function providerEnvStem(service: DownloadProviderService): string {
  return service.toUpperCase();
}

function isSpotiFlacApiDlHost(hostname: string): boolean {
  return /^(?:tdl|qbz|amz|dzr)-[a-zx]\.spotbye\.qzz\.io$/i.test(hostname) ||
    /^(?:tdl|qbz|amz)-oss\.spotbye\.qzz\.io$/i.test(hostname) ||
    hostname === "am.spotbye.qzz.io";
}

export function spotiflacStatusKeyForEndpoint(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl);
    if (url.hostname === "am.spotbye.qzz.io") return "apple";
    const oss = url.hostname.match(/^(tdl|qbz|amz)-oss\.spotbye\.qzz\.io$/i);
    if (oss) {
      return { tdl: "tidal", qbz: "qobuz", amz: "amazon" }[oss[1]?.toLowerCase() || ""] ?? "";
    }
    const match = url.hostname.match(/^(tdl|qbz|amz|dzr)-([a-ex])\.spotbye\.qzz\.io$/i);
    if (!match) return "";
    const provider = {
      tdl: "tidal",
      qbz: "qobuz",
      amz: "amazon",
      dzr: "deezer",
    }[match[1]?.toLowerCase() || ""];
    const slot = match[2]?.toLowerCase() || "";
    return provider && slot ? `${provider}_${slot}` : "";
  } catch {
    return "";
  }
}

function spotiflacStatusChecksEnabled(env: CloudflareEnv): boolean {
  const raw = envString(env, "SPOTIFLAC_STATUS_CHECKS").toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

async function spotiflacStatus(env: CloudflareEnv): Promise<Record<string, string> | null> {
  if (!spotiflacStatusChecksEnabled(env)) return null;
  const url = envString(env, "SPOTIFLAC_STATUS_URL") || DEFAULT_SPOTIFLAC_STATUS_URL;
  const now = Date.now();
  if (spotiflacStatusCache && spotiflacStatusCache.url === url && spotiflacStatusCache.expiresAt > now) {
    return spotiflacStatusCache.promise;
  }
  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(url, 5_000, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0",
        },
      });
      if (!response.ok) return null;
      const payload = toObject(await response.json().catch(() => null));
      return parseSpotiflacStatusPayload(payload);
    } catch {
      return null;
    }
  })();
  spotiflacStatusCache = { expiresAt: now + SPOTIFLAC_STATUS_CACHE_MS, url, promise };
  return promise;
}

function spotiflacEndpointIsDown(status: Record<string, string> | null, endpointUrl: string): string {
  const key = spotiflacStatusKeyForEndpoint(endpointUrl);
  if (!key || !status) return "";
  const state = status[key];
  return state && state !== "up" ? `${key} is ${state}` : "";
}

function normalizeSpotiFlacProviderUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if ((url.pathname === "" || url.pathname === "/") && isSpotiFlacApiDlHost(url.hostname)) {
      url.pathname = "/api/dl";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function configuredProviderUrls(env: CloudflareEnv, service: DownloadProviderService): string[] {
  const stem = providerEnvStem(service);
  const urls = [
    ...envStringList(env, `SPOTIFLAC_${stem}_PROVIDER_URLS`),
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_URL`),
    ...envStringList(env, `${stem}_SOURCE_PROVIDER_URLS`),
    envString(env, `${stem}_SOURCE_PROVIDER_URL`),
    ...envStringList(env, `LICENSED_${stem}_PROVIDER_URLS`),
    envString(env, `LICENSED_${stem}_PROVIDER_URL`),
  ].filter(Boolean);

  if (service === "licensed") {
    urls.push(licensedSourceProviderEndpoint(env));
  } else if (service === "tidal") {
    urls.push(...envStringList(env, "SPOTIFLAC_TIDAL_APIS"));
    urls.push(...envStringList(env, "TIDAL_SPOTBYE_PROVIDER_URLS"));
    urls.push(envString(env, "SPOTIFLAC_ACTIVE_TIDAL_API"));
  } else if (service === "tidal_x") {
    const legacy = licensedSourceProviderEndpoint(env);
    if (legacy && licensedSourceProviderUsesTidalId(legacy)) urls.push(legacy);
  }
  urls.push(...(DEFAULT_SPOTIFLAC_CONFIGURED_PROVIDER_URLS[service] ?? []));

  return Array.from(new Set(urls.map(normalizeSpotiFlacProviderUrl).filter(Boolean)));
}

function configuredProviderApiKey(env: CloudflareEnv, service: DownloadProviderService): string {
  const stem = providerEnvStem(service);
  return (
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_API_KEY`) ||
    envString(env, `${stem}_SOURCE_PROVIDER_API_KEY`) ||
    envString(env, `LICENSED_${stem}_PROVIDER_API_KEY`) ||
    (service === "licensed" || service === "tidal_x" ? licensedSourceProviderApiKey(env) : "")
  );
}

function configuredProviderUserAgent(
  env: CloudflareEnv,
  service: DownloadProviderService,
  endpointUrl: string,
): string {
  const stem = providerEnvStem(service);
  return (
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_USER_AGENT`) ||
    envString(env, `${stem}_SOURCE_PROVIDER_USER_AGENT`) ||
    envString(env, `LICENSED_${stem}_PROVIDER_USER_AGENT`) ||
    ((service === "licensed" || service === "tidal_x") ? licensedSourceProviderUserAgent(env) : "") ||
    (licensedSourceProviderUsesTidalId(endpointUrl) ? "SpotiFLAC-Mobile/4.5.6" : "")
  );
}

function configuredProviderResolveTimeoutMs(env: CloudflareEnv, service: DownloadProviderService): number {
  const stem = providerEnvStem(service);
  const raw =
    envString(env, `SPOTIFLAC_${stem}_PROVIDER_RESOLVE_TIMEOUT_MS`) ||
    envString(env, `${stem}_SOURCE_PROVIDER_RESOLVE_TIMEOUT_MS`) ||
    envString(env, `LICENSED_${stem}_PROVIDER_RESOLVE_TIMEOUT_MS`);
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(30_000, Math.max(1_000, parsed));
  }
  return licensedSourceProviderResolveTimeoutMs(env);
}

async function resolveTidalStreamUrl(
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: SongPayload,
): Promise<string> {
  const tidal = getPlatformLink(songLinkPayload, "tidal");
  const entityTrackId = tidal ? parsePlatformId(tidal.entityUniqueId, "TIDAL_SONG::") : "";
  const urlTrackId = tidal?.url ? parseTrackIdFromUrl(tidal.url) : "";
  try {
    return await resolveTidalProviderStreamUrl({
      tidalTrackId: entityTrackId || urlTrackId || "",
      title: toStringValue(payload.title),
      artist: toStringValue(payload.artist),
      album: toStringValue(payload.album),
      quality: quality || "LOSSLESS",
    });
  } catch (error) {
    if (error instanceof TidalDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Tidal stream", 502);
  }
}

async function resolveQobuzDownload(
  env: CloudflareEnv,
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: SongPayload,
): Promise<ResolvedAudioDownload> {
  const isrc = await resolveDeezerIsrc(songLinkPayload);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const album = toStringValue(payload.album);
  if (!isrc && !title && !artist) throw new ApiError("Qobuz needs an ISRC or title/artist metadata", 400);
  try {
    return {
      service: "qobuz",
      streamUrl: await resolveQobuzProviderStreamUrl({
        isrc,
        title,
        artist,
        album,
        quality: quality || "6",
        credentials: qobuzCredentialsFromEnv(env),
      }),
      minimumQuality: qobuzQualityIsLossless(quality),
    };
  } catch (error) {
    if (error instanceof QobuzDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Qobuz stream", 502);
  }
}

async function resolveAmazonDownload(trackId: string, payload: SongPayload): Promise<ResolvedAudioDownload> {
  try {
    const stream = await resolveAmazonStreamUrl({
      spotifyId: trackId,
      region: toStringValue(payload.region).toUpperCase(),
    });
    return {
      service: "amazon",
      streamUrl: stream.streamUrl,
      headers: stream.headers,
      minimumQuality: "lossless",
    };
  } catch (error) {
    if (error instanceof AmazonDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Amazon Music stream", 502);
  }
}

function qobuzQualityIsLossless(quality: string): "lossless" | undefined {
  return !quality || quality === "6" || quality === "7" || quality === "16" || quality === "24" || quality === "27"
    ? "lossless"
    : undefined;
}

function tidalQualityIsLossless(quality: string): "lossless" | undefined {
  const normalized = quality.trim().toUpperCase();
  return !normalized ||
    normalized === "LOSSLESS" ||
    normalized === "HI_RES_LOSSLESS" ||
    normalized === "HI_RES" ||
    normalized === "MAX" ||
    normalized === "FLAC" ||
    normalized === "CD"
    ? "lossless"
    : undefined;
}

function flattenResolvedAudioDownload(resolved: ResolvedAudioDownload): ResolvedAudioDownloadCandidate[] {
  return [resolved, ...(resolved.fallbacks ?? [])];
}

function resolvedAudioDownloadFromCandidates(candidates: ResolvedAudioDownloadCandidate[]): ResolvedAudioDownload {
  const [first, ...fallbacks] = candidates;
  if (!first) throw new ApiError("No downloadable provider found", 502);
  return { ...first, fallbacks };
}

function audioCodecLabel(info: AudioCodecInfo): string {
  return info.codec || "unknown codec";
}

export async function validateMinimumQualityResponse(
  response: Response,
  candidate: ResolvedAudioDownloadCandidate,
  onProgress?: (received: number, total: number) => void,
): Promise<Response | string> {
  const contentType = `${response.headers.get("content-type") || candidate.contentType || ""}`.toLowerCase();
  const contentTypeInfo = classifyAudioContentType(contentType);
  if (candidate.minimumQuality === "lossless" && contentTypeInfo.quality === "lossy") {
    await response.body?.cancel().catch(() => undefined);
    return `${candidate.service} returned a lossy ${audioCodecLabel(contentTypeInfo)} stream`;
  }

  const length = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return "Audio file is too large";
  }
  if (!response.body) return "Audio server returned an empty response";

  // Sniff only a bounded prefix, then replay it into a size-limited stream. This
  // keeps a lossless import off the Worker's heap while preserving validation,
  // progress reporting, and the 100 MB guard for responses without a trustworthy
  // Content-Length header.
  const total = Number.isFinite(length) && length > 0 ? length : 0;
  const replay = await peekAndReplayStream(response.body, {
    maxBytes: MAX_AUDIO_BYTES,
    peekBytes: candidate.minimumQuality === "lossless" ? 64 * 1024 : 1,
    onProgress: onProgress ? (received) => onProgress(received, total) : undefined,
  });
  if (candidate.minimumQuality === "lossless") {
    const byteInfo = classifyAudioBytes(replay.prefix);
    if (byteInfo.quality !== "lossless") {
      await replay.body.cancel().catch(() => undefined);
      return byteInfo.quality === "lossy"
        ? `${candidate.service} returned a lossy ${audioCodecLabel(byteInfo)} stream`
        : `${candidate.service} returned an unverified ${audioCodecLabel(byteInfo)} stream for a lossless request`;
    }
  }
  return new Response(replay.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

function licensedSourceProviderEndpoint(env: CloudflareEnv): string {
  return envString(env, "LICENSED_SOURCE_PROVIDER_URL") || envString(env, "LICENSED_AUDIO_PROVIDER_URL");
}

function licensedSourceProviderApiKey(env: CloudflareEnv): string {
  return envString(env, "LICENSED_SOURCE_PROVIDER_API_KEY") || envString(env, "LICENSED_AUDIO_PROVIDER_API_KEY");
}

function licensedSourceProviderUserAgent(env: CloudflareEnv): string {
  return envString(env, "LICENSED_SOURCE_PROVIDER_USER_AGENT") || envString(env, "LICENSED_AUDIO_PROVIDER_USER_AGENT");
}

function licensedSourceProviderResolveTimeoutMs(env: CloudflareEnv): number {
  const raw =
    envString(env, "LICENSED_SOURCE_PROVIDER_RESOLVE_TIMEOUT_MS") ||
    envString(env, "LICENSED_AUDIO_PROVIDER_RESOLVE_TIMEOUT_MS");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 8_000;
  return Math.min(30_000, Math.max(1_000, parsed));
}

function licensedSourceProviderUsesTidalId(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.hostname === "api.zarz.moe" && url.pathname.includes("/dl/tid")
    ) || (
      /^tdl-[a-z]\.spotbye\.qzz\.io$/i.test(url.hostname) && url.pathname === "/api/dl"
    );
  } catch {
    return false;
  }
}

function licensedSourceProviderQualities(endpoint: string, payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  const profile = toStringValue(payload.qualityProfile).toLowerCase();
  const isSpotbyeTidal = (() => {
    try {
      return /^tdl-[a-z]\.spotbye\.qzz\.io$/i.test(new URL(endpoint).hostname);
    } catch {
      return false;
    }
  })();
  if (isSpotbyeTidal) {
    return profile === "cd" ? ["16"] : ["24", "16"];
  }
  return profile === "cd" ? ["LOSSLESS"] : ["HI_RES_LOSSLESS", "LOSSLESS"];
}

type SpotiFlacApiDlProviderKind = "tidal" | "qobuz" | "amazon" | "deezer" | "apple";

function spotiflacApiDlProviderKind(endpoint: string): SpotiFlacApiDlProviderKind | "" {
  try {
    const url = new URL(endpoint);
    if (url.pathname !== "/api/dl") return "";
    if (/^tdl-(?:[a-z]|oss)\.spotbye\.qzz\.io$/i.test(url.hostname)) return "tidal";
    if (/^qbz-(?:[a-zx]|oss)\.spotbye\.qzz\.io$/i.test(url.hostname)) return "qobuz";
    if (/^amz-(?:[a-zx]|oss)\.spotbye\.qzz\.io$/i.test(url.hostname)) return "amazon";
    if (/^dzr-[a-zx]\.spotbye\.qzz\.io$/i.test(url.hostname)) return "deezer";
    if (url.hostname === "am.spotbye.qzz.io") return "apple";
  } catch {}
  return "";
}

function tidalTrackIdFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const tidal = getPlatformLink(songLinkPayload, "tidal");
  const entityTrackId = tidal ? parsePlatformId(tidal.entityUniqueId, "TIDAL_SONG::") : "";
  const urlTrackId = tidal?.url ? parseTrackIdFromUrl(tidal.url) : "";
  return entityTrackId || urlTrackId || "";
}

function qobuzTrackIdFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const qobuz = getPlatformLink(songLinkPayload, "qobuz");
  const entityTrackId = qobuz ? parsePlatformId(qobuz.entityUniqueId, "QOBUZ_SONG::") : "";
  const urlTrackId = qobuz?.url?.match(/\/track\/(\d+)/i)?.[1] ?? "";
  const id = entityTrackId || urlTrackId || "";
  return /^\d+$/.test(id) ? id : "";
}

function appleMusicTrackIdFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const apple = getPlatformLink(songLinkPayload, "appleMusic") || getPlatformLink(songLinkPayload, "itunes");
  const entityTrackId =
    (apple ? parsePlatformId(apple.entityUniqueId, "APPLE_MUSIC_SONG::") : "") ||
    (apple ? parsePlatformId(apple.entityUniqueId, "ITUNES_SONG::") : "");
  if (/^\d+$/.test(entityTrackId)) return entityTrackId;
  if (!apple?.url) return "";
  try {
    const url = new URL(apple.url);
    const queryId = url.searchParams.get("i") || "";
    if (/^\d+$/.test(queryId)) return queryId;
    return url.pathname.match(/\/(\d+)(?:$|\/)/)?.[1] ?? "";
  } catch {
    return apple.url.match(/\/(\d+)(?:$|[?#/])/)?.[1] ?? "";
  }
}

type ItunesSongSearchResult = {
  trackId?: number | string;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number | string;
};

function normalizeProviderMatchValue(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreAppleMusicSearchResult(result: ItunesSongSearchResult, payload: SongPayload): number {
  const title = normalizeProviderMatchValue(toStringValue(payload.title));
  const artist = normalizeProviderMatchValue(toStringValue(payload.artist));
  const album = normalizeProviderMatchValue(toStringValue(payload.album));
  const resultTitle = normalizeProviderMatchValue(toStringValue(result.trackName));
  const resultArtist = normalizeProviderMatchValue(toStringValue(result.artistName));
  const resultAlbum = normalizeProviderMatchValue(toStringValue(result.collectionName));
  const durationMs = toNumberValue(payload.durationMs);
  const resultDurationMs = toNumberValue(result.trackTimeMillis);
  let score = 0;

  if (title && resultTitle === title) score += 100;
  else if (title && (resultTitle.includes(title) || title.includes(resultTitle))) score += 55;
  if (artist && resultArtist === artist) score += 80;
  else if (artist && (resultArtist.includes(artist) || artist.includes(resultArtist))) score += 40;
  if (album && resultAlbum === album) score += 35;
  else if (album && (resultAlbum.includes(album) || album.includes(resultAlbum))) score += 15;
  if (durationMs != null && resultDurationMs != null) {
    const diff = Math.abs(durationMs - resultDurationMs);
    if (diff <= 2_500) score += 35;
    else if (diff <= 7_500) score += 15;
  }
  return score;
}

async function resolveAppleMusicTrackIdFromPayload(payload: SongPayload): Promise<string> {
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const term = [title, artist].filter(Boolean).join(" ");
  if (!term) return "";
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "10");
  url.searchParams.set("country", toStringValue(payload.region).toUpperCase() || "US");
  url.searchParams.set("term", term);

  const response = await fetchWithTimeout(url.toString(), SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (!response?.ok) return "";
  const searchPayload = toObject(await response.json().catch(() => null));
  const results = Array.isArray(searchPayload?.results) ? searchPayload.results : [];
  const best = results
    .map((candidate) => {
      const result = toObject(candidate) as ItunesSongSearchResult | null;
      return result ? { result, score: scoreAppleMusicSearchResult(result, payload) } : null;
    })
    .filter((item): item is { result: ItunesSongSearchResult; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score)[0];
  const id =
    typeof best?.result.trackId === "number" && Number.isFinite(best.result.trackId)
      ? `${best.result.trackId}`
      : toStringValue(best?.result.trackId);
  return best && best.score >= 140 && /^\d+$/.test(id) ? id : "";
}

function amazonAsinFromValue(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  return (
    decoded.match(/(?:trackAsin=|tracks\/)([A-Z0-9]{10})/)?.[1] ??
    decoded.match(/\b(B[0-9A-Z]{9})\b/)?.[1] ??
    ""
  );
}

function amazonAsinFromSongLinkPayload(songLinkPayload: Record<string, unknown>): string {
  const amazon = getPlatformLink(songLinkPayload, "amazonMusic") || getPlatformLink(songLinkPayload, "amazon");
  const entityTrackId =
    (amazon ? parsePlatformId(amazon.entityUniqueId, "AMAZON_SONG::") : "") ||
    (amazon ? parsePlatformId(amazon.entityUniqueId, "AMAZON_MUSIC_SONG::") : "");
  const entityAsin = amazonAsinFromValue(entityTrackId);
  if (entityAsin) return entityAsin;
  return amazon?.url ? amazonAsinFromValue(amazon.url) : "";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueProviderBodies(bodies: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const body of bodies) {
    const key = JSON.stringify(body);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(body);
  }
  return out;
}

function qobuzSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  const profile = toStringValue(payload.qualityProfile).toLowerCase();
  return profile === "cd" ? ["16"] : ["24", "16"];
}

function tidalSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  const profile = toStringValue(payload.qualityProfile).toLowerCase();
  return profile === "cd" ? ["16"] : ["24", "16"];
}

function amazonSpotbyeQualities(service: DownloadProviderService, payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  if (explicit) return [explicit];
  if (service === "amazon_x") return ["16", "atmos"];
  return ["16"];
}

function deezerSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  return explicit ? [explicit] : ["16"];
}

function appleSpotbyeQualities(payload: SongPayload): string[] {
  const explicit = toStringValue(payload.quality);
  return explicit ? [explicit] : [];
}

async function spotiflacApiDlProviderBodies(options: {
  env: CloudflareEnv;
  kind: SpotiFlacApiDlProviderKind;
  service: DownloadProviderService;
  trackId: string;
  songLinkPayload: Record<string, unknown>;
  payload: SongPayload;
}): Promise<Array<Record<string, unknown>>> {
  const { env, kind, service, trackId, songLinkPayload, payload } = options;
  if (kind === "tidal") {
    const tidalTrackId = tidalTrackIdFromSongLinkPayload(songLinkPayload);
    return tidalTrackId
      ? tidalSpotbyeQualities(payload).map((quality) => ({ id: tidalTrackId, quality }))
      : [];
  }

  if (kind === "qobuz") {
    const qobuzTrackId =
      qobuzTrackIdFromSongLinkPayload(songLinkPayload) ||
      await resolveQobuzTrackId({
        isrc: await resolveDeezerIsrc(songLinkPayload).catch(() => ""),
        title: toStringValue(payload.title),
        artist: toStringValue(payload.artist),
        album: toStringValue(payload.album),
        credentials: qobuzCredentialsFromEnv(env),
      }).catch(() => "");
    return qobuzTrackId
      ? qobuzSpotbyeQualities(payload).map((quality) => ({ id: qobuzTrackId, quality }))
      : [];
  }

  if (kind === "amazon") {
    const region = toStringValue(payload.region).toUpperCase() || "US";
    const asin =
      amazonAsinFromSongLinkPayload(songLinkPayload) ||
      await resolveAmazonAsinFromSpotify({ spotifyId: trackId, region }).catch(() => "");
    return asin
      ? amazonSpotbyeQualities(service, payload).map((quality) => ({ country: region, id: asin, quality }))
      : [];
  }

  if (kind === "deezer") {
    const ids = uniqueStrings([parseDeezerTrackId(songLinkPayload)]);
    const bodies: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      for (const quality of deezerSpotbyeQualities(payload)) bodies.push({ id, quality });
      bodies.push({ id });
    }
    return uniqueProviderBodies(bodies);
  }

  const ids = uniqueStrings([
    appleMusicTrackIdFromSongLinkPayload(songLinkPayload),
    await resolveAppleMusicTrackIdFromPayload(payload).catch(() => ""),
  ]);
  const bodies: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const qualities = appleSpotbyeQualities(payload);
    if (qualities.length === 0) bodies.push({ id });
    for (const quality of qualities) bodies.push({ id, quality });
    bodies.push({ id });
  }
  return uniqueProviderBodies(bodies);
}

async function resolveLicensedSourceOnMacMini(
  env: CloudflareEnv,
  options: Parameters<typeof resolveLicensedSourceProviderStreamUrl>[0],
): Promise<LicensedSourceStream> {
  const response = await fetchMacMini({
    env,
    target: "/api/licensed-source/resolve",
    method: "POST",
    user: null,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      endpointUrl: options.endpointUrl,
      body: options.body ?? null,
      userAgent: options.userAgent ?? "",
    }),
  });
  const payload = toObject(await response.json().catch(() => null));
  if (!response.ok) {
    throw new ApiError(
      toStringValue(payload?.error) || `Mac mini community resolve returned ${response.status}`,
      502,
    );
  }
  const streamUrl = toStringValue(payload?.streamUrl);
  if (!streamUrl && toStringValue(payload?.kind) !== "dash") {
    throw new ApiError("Mac mini community resolve returned no stream URL", 502);
  }
  return payload as LicensedSourceStream;
}

async function resolveLicensedSourceWithCommunityFallback(
  env: CloudflareEnv,
  options: Parameters<typeof resolveLicensedSourceProviderStreamUrl>[0],
): Promise<LicensedSourceStream> {
  const communityHost = isSpotiflacCommunityHost(options.endpointUrl);
  const canAskMini = communityHost && canUseMacMiniProxy(env);
  // Cloudflare cannot read ~/.spotiflac; skip the unsigned 428 and sign on the Mac.
  if (canAskMini && !options.communitySession) {
    return resolveLicensedSourceOnMacMini(env, options);
  }
  try {
    return await resolveLicensedSourceProviderStreamUrl(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!canAskMini || !/428|401|verification session/i.test(message)) throw error;
    return resolveLicensedSourceOnMacMini(env, options);
  }
}

async function resolveConfiguredLicensedProviderDownload(
  env: CloudflareEnv,
  service: DownloadProviderService,
  trackId: string,
  songLinkPayload: Record<string, unknown>,
  payload: SongPayload,
): Promise<ResolvedAudioDownload> {
  const endpoints = configuredProviderUrls(env, service);
  if (endpoints.length === 0) {
    throw new ApiError(`${service} provider is not configured`, 501);
  }

  const errors: string[] = [];
  const candidates: ResolvedAudioDownloadCandidate[] = [];
  const providerBodyCache = new Map<string, Array<Record<string, unknown>>>();
  const status = await spotiflacStatus(env);
  for (const endpointUrl of endpoints) {
    const downReason = spotiflacEndpointIsDown(status, endpointUrl);
    if (downReason) {
      errors.push(downReason);
      continue;
    }

    const providerBodies: Array<Record<string, unknown> | undefined> = [];
    const apiDlKind = spotiflacApiDlProviderKind(endpointUrl);
    if (apiDlKind) {
      const bodyCacheKey = `${service}:${apiDlKind}`;
      let bodies = providerBodyCache.get(bodyCacheKey);
      if (!bodies) {
        bodies = await spotiflacApiDlProviderBodies({
          env,
          kind: apiDlKind,
          service,
          trackId,
          songLinkPayload,
          payload,
        });
        providerBodyCache.set(bodyCacheKey, bodies);
      }
      if (bodies.length === 0) {
        errors.push(`${service} needs a ${apiDlKind} track ID`);
        continue;
      }
      providerBodies.push(...bodies);
    } else if (licensedSourceProviderUsesTidalId(endpointUrl)) {
      const tidalTrackId = tidalTrackIdFromSongLinkPayload(songLinkPayload);
      if (!tidalTrackId) {
        errors.push(`${service} needs a Tidal track ID`);
        continue;
      }
      for (const quality of licensedSourceProviderQualities(endpointUrl, payload)) {
        providerBodies.push({ id: tidalTrackId, quality });
      }
    } else {
      providerBodies.push(undefined);
    }

    const communitySession = communitySessionFromEnv(env);
    for (const providerBody of providerBodies) {
      try {
        const userAgent =
          configuredProviderUserAgent(env, service, endpointUrl) ||
          (isSpotiflacCommunityHost(endpointUrl) ? communityUserAgent(communitySession) : "");
        const stream = await resolveLicensedSourceWithCommunityFallback(env, {
          endpointUrl,
          apiKey: configuredProviderApiKey(env, service),
          userAgent,
          spotifyId: trackId,
          spotifyUrl: toStringValue(payload.spotifyUrl),
          region: toStringValue(payload.region).toUpperCase(),
          title: toStringValue(payload.title),
          artist: toStringValue(payload.artist),
          album: toStringValue(payload.album),
          durationMs: toStringValue(payload.durationMs),
          qualityProfile: toStringValue(payload.qualityProfile),
          outputFormat: toStringValue(payload.outputFormat) || SERVER_IMPORT_OUTPUT_FORMAT,
          body: providerBody,
          timeoutMs: configuredProviderResolveTimeoutMs(env, service),
          communitySession,
        });
        candidates.push({
          service,
          streamUrl: stream.streamUrl,
          headers: stream.headers,
          contentType: stream.contentType,
          licensedStream: stream,
          userAgent,
          minimumQuality: "lossless",
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `${service} provider failed`);
      }
    }
  }

  if (candidates.length > 0) return resolvedAudioDownloadFromCandidates(candidates);
  throw new ApiError(`${service} provider failed: ${errors.join(" | ")}`, 502);
}

export async function fetchResolvedAudioDownloadCandidate(resolved: ResolvedAudioDownloadCandidate): Promise<Response> {
  if (resolved.licensedStream) {
    try {
      return await materializeLicensedSourceStream(resolved.licensedStream, {
        maxBytes: MAX_AUDIO_BYTES,
        userAgent: resolved.userAgent,
      });
    } catch (error) {
      if (error instanceof LicensedSourceDownloadError) throw new ApiError(error.message, error.status);
      throw error;
    }
  }
  return fetchWithTimeout(resolved.streamUrl, DOWNLOAD_REQUEST_TIMEOUT_MS, { headers: resolved.headers });
}

export async function fetchResolvedAudioDownload(resolved: ResolvedAudioDownload): Promise<Response> {
  const candidates = [resolved, ...(resolved.fallbacks ?? [])];
  const errors: string[] = [];
  let lastResponse: Response | null = null;
  for (const candidate of candidates) {
    try {
      const response = await fetchResolvedAudioDownloadCandidate(candidate);
      if (response.ok) {
        const validated = await validateMinimumQualityResponse(response, candidate);
        if (validated instanceof Response) return validated;
        errors.push(validated);
        continue;
      }
      errors.push(`${candidate.service} returned ${response.status}`);
      lastResponse = response;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "download failed");
    }
  }
  if (lastResponse) return lastResponse;
  throw new ApiError(`No licensed source fallback succeeded: ${errors.join(" | ")}`, 502);
}

async function resolveProviderDownload(
  env: CloudflareEnv,
  provider: DownloadProviderService,
  trackId: string,
  songLinkPayload: Record<string, unknown>,
  payload: SongPayload,
  qualities: ReturnType<typeof qualityLists>,
): Promise<ResolvedAudioDownload> {
  const candidates: ResolvedAudioDownloadCandidate[] = [];
  const errors: string[] = [];

  const addConfigured = async (service: DownloadProviderService) => {
    if (configuredProviderUrls(env, service).length === 0) return;
    try {
      candidates.push(...flattenResolvedAudioDownload(
        await resolveConfiguredLicensedProviderDownload(env, service, trackId, songLinkPayload, payload),
      ));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${service} failed`);
    }
  };

  if (provider === "licensed") {
    await addConfigured("licensed");
  } else if (provider === "tidal") {
    await addConfigured("tidal");
    for (const quality of qualities.tidal) {
      try {
        candidates.push({
          service: "tidal",
          streamUrl: await resolveTidalStreamUrl(songLinkPayload, quality, payload),
          minimumQuality: tidalQualityIsLossless(quality),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `tidal quality ${quality} failed`);
      }
    }
  } else if (provider === "qobuz") {
    await addConfigured("qobuz");
    for (const quality of qualities.qobuz) {
      try {
        const resolved = flattenResolvedAudioDownload(await resolveQobuzDownload(env, songLinkPayload, quality, payload));
        if (resolved.length > 0) {
          candidates.push(...resolved);
          // One lossless Qobuz quality is enough — stop so we don't keep
          // probing the rest of the Qobuz fallback chain.
          break;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `qobuz quality ${quality} failed`);
      }
    }
  } else if (provider === "amazon") {
    await addConfigured("amazon");
    try {
      candidates.push(...flattenResolvedAudioDownload(await resolveAmazonDownload(trackId, payload)));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "amazon failed");
    }
  } else {
    await addConfigured(provider);
  }

  if (candidates.length > 0) return resolvedAudioDownloadFromCandidates(candidates);

  throw new ApiError(
    `No ${provider} provider candidate found${errors.length > 0 ? `: ${errors.join(" | ")}` : ""}`,
    502,
  );
}

async function resolveSpotiFlacDownloadStack(
  env: CloudflareEnv,
  trackId: string,
  songLinkPayload: Record<string, unknown>,
  payload: SongPayload,
  qualities: ReturnType<typeof qualityLists>,
): Promise<ResolvedAudioDownload> {
  const candidates: ResolvedAudioDownloadCandidate[] = [];
  const errors: string[] = [];

  for (const provider of spotiflacProviderOrder(env)) {
    try {
      candidates.push(...flattenResolvedAudioDownload(
        await resolveProviderDownload(env, provider, trackId, songLinkPayload, payload, qualities),
      ));
      // First provider that yields a candidate wins — stop probing the rest
      // to cut request pressure / rate-limit load.
      if (candidates.length > 0) break;
    } catch (error) {
      errors.push(error instanceof Error ? `${provider}: ${error.message}` : `${provider} failed`);
    }
  }

  if (candidates.length > 0) return resolvedAudioDownloadFromCandidates(candidates);
  throw new ApiError(`No downloadable provider found. ${errors.join(" | ")}`, 502);
}

export async function resolveStreamUrl(env: CloudflareEnv, payload: SongPayload): Promise<ResolvedAudioDownload> {
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl));
  if (!trackId) throw new ApiError("Invalid Spotify track URL or ID", 400);
  const songLinkPayload = await resolveTrackPayload(
    trackId,
    toStringValue(payload.region).toUpperCase(),
    envString(env, "SPOTIFY_SP_DC"),
  ).catch(() => ({}));
  await enrichTidalLink(songLinkPayload, toStringValue(payload.region).toUpperCase());
  await enrichSoundchartsLinks(env, songLinkPayload);
  const service = toStringValue(payload.service).toLowerCase();
  const qualities = qualityLists(payload);

  if (service === "licensed") {
    return await resolveProviderDownload(env, "licensed", trackId, songLinkPayload, payload, qualities);
  }
  const providerService = normalizeProviderService(service);
  if (providerService) {
    return await resolveProviderDownload(env, providerService, trackId, songLinkPayload, payload, qualities);
  }
  if (service) {
    throw new ApiError(
      'Unsupported service. Use "licensed", "tidal", "qobuz", "amazon", "deezer", or "apple".',
      400,
    );
  }

  return await resolveSpotiFlacDownloadStack(env, trackId, songLinkPayload, payload, qualities);
}
