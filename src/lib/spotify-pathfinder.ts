import { looksNonCanonicalTrack, normalizeSongPart } from "@/lib/song-dedupe";

const SPOTIFY_TOKEN_URL = "https://open.spotify.com/api/token";
const SPOTIFY_SERVER_TIME_URL = "https://open.spotify.com/api/server-time";
const SPOTIFY_PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const PAGE_SIZE = 100;
const PATHFINDER_REQUEST_TIMEOUT_MS = 20_000;
const CATALOG_REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_PRODUCT_TYPE = "web-player";
const TOKEN_TOTP_PERIOD_SECONDS = 30;
const TOKEN_TOTP_DIGITS = 6;
const TOKEN_TOTP_ALGORITHM = "SHA-1";

const PATHFINDER_QUERIES = {
  fetchPlaylistContents: "c56c706a062f82052d87fdaeeb300a258d2d54153222ef360682a0ee625284d9",
  fetchPlaylistMetadata: "6f7fef1ef9760ba77aeb68d8153d458eeec2dce3430cef02b5f094a8ef9a465d",
  fetchLibraryTracks: "8474ec383b530ce3e54611fca2d8e3da57ef5612877838b8dbf00bd9fc692dfb",
  getAlbum: "46ae954ef2d2fe7732b4b2b4022157b2e18b7ea84f70591ceb164e4de1b5d5d3",
  searchTracks: "16c02d6304f5f721fc2eb39dacf2361a4543815112506a9c05c9e0bc9733a679",
  searchDesktop: "21969b655b795601fb2d2204a4243188e75fdc6d3520e7b9cd3f4db2aff9591e",
} as const;

const TOKEN_TOTP_SECRETS = [
  { secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N', version: 61 },
  { secret: 'OmE{ZA.J^":0FG\\Uz?[@WW', version: 60 },
  { secret: "{iOFn;4}<1PFYKPV?5{%u14]M>/V0hDH", version: 59 },
] as const;

export class SpotifyPathfinderError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export type SpotifyBatchTrack = {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  releaseDate?: string;
  durationMs?: number;
  imageUrl?: string;
};

export type SpotifyCatalogPlaylist = {
  kind: "playlist";
  provider: "spotify";
  id: string;
  name: string;
  imageUrl: string | null;
  description?: string;
  ownerName?: string;
  trackCount?: number;
  externalUrl: string;
};

export type SpotifyCatalogArtist = {
  kind: "artist";
  provider: "spotify";
  id: string;
  name: string;
  imageUrl: string | null;
  externalUrl: string;
};

export type SpotifyArtistProfile = SpotifyCatalogArtist & {
  genres?: string[];
  followers?: number;
};

export type SpotifyCatalogSearchResult = {
  tracks: SpotifyBatchTrack[];
  playlists: SpotifyCatalogPlaylist[];
  artists: SpotifyCatalogArtist[];
};

export type SpotifyArtistCatalog = {
  artist: SpotifyArtistProfile;
  tracks: SpotifyBatchTrack[];
};

export type SpotifyPlaylistCatalog = {
  playlist: SpotifyCatalogPlaylist;
  tracks: SpotifyBatchTrack[];
};

export type SpotifyPlaylistCatalogPage = SpotifyPlaylistCatalog & {
  offset: number;
  totalCount: number;
  nextOffset: number | null;
};

const SPOTIFY_ENTITY_ID = /^[0-9A-Za-z]{22}$/;

export function isSpotifyCatalogId(value: string): boolean {
  return SPOTIFY_ENTITY_ID.test(value);
}

type SpotifyAccessTokenCache = {
  accessToken: string;
  expiresAtMs: number;
  cookieKey: string;
};

let tokenCache: SpotifyAccessTokenCache | null = null;

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toFiniteNumber(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : null;
}

function largestImageUrl(value: unknown): string {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((entry) => {
      const object = toObject(entry);
      return {
        url: toStringValue(object?.url),
        width: toFiniteNumber(object?.width) ?? toFiniteNumber(object?.maxWidth) ?? 0,
      };
    })
    .filter((entry) => entry.url)
    .sort((left, right) => right.width - left.width)[0]?.url ?? "";
}

function imageUrlFromAlbum(albumValue: Record<string, unknown> | null): string {
  const coverArt = toObject(albumValue?.coverArt);
  return largestImageUrl(coverArt?.sources);
}

function releaseDateFromAlbum(albumValue: Record<string, unknown> | null): string {
  const date = toObject(albumValue?.date);
  return toStringValue(date?.isoString) || toStringValue(date?.year);
}

function durationMsFromTrackData(data: Record<string, unknown>): number {
  const duration = toObject(data.duration);
  return toFiniteNumber(duration?.totalMilliseconds) ?? toFiniteNumber(data.durationMs) ?? 0;
}

function normalizeCookie(cookie?: string): string {
  const trimmed = toStringValue(cookie);
  if (!trimmed) return "";
  return trimmed.includes("=") ? trimmed : `sp_dc=${trimmed}`;
}

function cookieKey(cookie?: string): string {
  return normalizeCookie(cookie) || "__anonymous__";
}

// Bare fetch() has no timeout, so a hung Spotify endpoint would stall the
// import/token flow indefinitely (browser + Worker). Wrap each request with an
// AbortController-backed timeout; on timeout/network error resolve to null so
// callers keep their existing `response?.ok`/`.catch(() => null)` handling.
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = PATHFINDER_REQUEST_TIMEOUT_MS,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function tokenSecretBytes(secret: string): Uint8Array {
  const decoded = secret
    .split("")
    .map((char, index) => char.charCodeAt(0) ^ ((index % 33) + 9))
    .join("");
  return new TextEncoder().encode(decoded);
}

function hotpMessage(counter: number): Uint8Array {
  const message = new Uint8Array(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  message[0] = (high >>> 24) & 0xff;
  message[1] = (high >>> 16) & 0xff;
  message[2] = (high >>> 8) & 0xff;
  message[3] = high & 0xff;
  message[4] = (low >>> 24) & 0xff;
  message[5] = (low >>> 16) & 0xff;
  message[6] = (low >>> 8) & 0xff;
  message[7] = low & 0xff;
  return message;
}

async function hmacSha1(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const secretBuffer = new ArrayBuffer(secret.byteLength);
  new Uint8Array(secretBuffer).set(secret);
  const messageBuffer = new ArrayBuffer(message.byteLength);
  new Uint8Array(messageBuffer).set(message);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBuffer,
    { name: "HMAC", hash: TOKEN_TOTP_ALGORITHM },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, messageBuffer));
}

async function generateTotp(secret: Uint8Array, timestampMs: number): Promise<string> {
  const counter = Math.floor(timestampMs / 1000 / TOKEN_TOTP_PERIOD_SECONDS);
  const digest = await hmacSha1(secret, hotpMessage(counter));
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 10 ** TOKEN_TOTP_DIGITS).padStart(TOKEN_TOTP_DIGITS, "0");
}

async function fetchSpotifyServerTime(): Promise<number | null> {
  const response = await fetchWithTimeout(SPOTIFY_SERVER_TIME_URL, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response?.ok) return null;
  const payload = toObject(await response.json().catch(() => null));
  const serverTime = Number(payload?.serverTime);
  return Number.isFinite(serverTime) ? serverTime : null;
}

async function tokenQueryParams(reason: string, productType: string): Promise<URLSearchParams> {
  const { secret, version } = TOKEN_TOTP_SECRETS[0];
  const secretBytes = tokenSecretBytes(secret);
  const serverTime = await fetchSpotifyServerTime();
  return new URLSearchParams({
    reason,
    productType,
    totp: await generateTotp(secretBytes, Date.now()),
    totpServer: serverTime === null ? "unavailable" : await generateTotp(secretBytes, serverTime * 1000),
    totpVer: String(version),
  });
}

function parseTrackIdFromUri(uri: string): string | null {
  const match = uri.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  return match?.[1] ?? null;
}

function trackFromPathfinderItem(item: unknown): SpotifyBatchTrack | null {
  const root = toObject(item);
  const itemV2 = toObject(root?.itemV2);
  const data = toObject(itemV2?.data);
  if (!data) return null;
  const uri = toStringValue(data?.uri);
  const id = parseTrackIdFromUri(uri);
  if (!id) return null;

  const artistsValue = toObject(data?.artists);
  const artistItems = Array.isArray(artistsValue?.items) ? artistsValue.items : [];
  const artists = artistItems
    .map((entry) => toStringValue(toObject(toObject(entry)?.profile)?.name))
    .filter(Boolean);

  const albumValue = toObject(data?.albumOfTrack);
  if (artists.length === 0) {
    const albumArtists = toObject(albumValue?.artists);
    const albumArtistItems = Array.isArray(albumArtists?.items) ? albumArtists.items : [];
    for (const entry of albumArtistItems) {
      const name = toStringValue(toObject(toObject(entry)?.profile)?.name);
      if (name) artists.push(name);
    }
  }

  return {
    id,
    name: toStringValue(data?.name) || "Unknown Track",
    artists: artists.length > 0 ? artists : ["Unknown Artist"],
    album: toStringValue(albumValue?.name),
    releaseDate: releaseDateFromAlbum(albumValue),
    durationMs: durationMsFromTrackData(data),
    imageUrl: imageUrlFromAlbum(albumValue),
  };
}

function trackFromLibraryItem(item: unknown): SpotifyBatchTrack | null {
  const root = toObject(item);
  const trackWrapper = toObject(root?.track);
  const data = toObject(trackWrapper?.data);
  if (!data) return null;

  const uri = toStringValue(trackWrapper?._uri) || toStringValue(data?.uri);
  const id = parseTrackIdFromUri(uri);
  if (!id) return null;

  const artistsValue = toObject(data?.artists);
  const artistItems = Array.isArray(artistsValue?.items) ? artistsValue.items : [];
  const artists = artistItems
    .map((entry) => toStringValue(toObject(toObject(entry)?.profile)?.name))
    .filter(Boolean);

  const albumValue = toObject(data?.albumOfTrack);
  if (artists.length === 0) {
    const albumArtists = toObject(albumValue?.artists);
    const albumArtistItems = Array.isArray(albumArtists?.items) ? albumArtists.items : [];
    for (const entry of albumArtistItems) {
      const name = toStringValue(toObject(toObject(entry)?.profile)?.name);
      if (name) artists.push(name);
    }
  }

  return {
    id,
    name: toStringValue(data?.name) || "Unknown Track",
    artists: artists.length > 0 ? artists : ["Unknown Artist"],
    album: toStringValue(albumValue?.name),
    releaseDate: releaseDateFromAlbum(albumValue),
    durationMs: durationMsFromTrackData(data),
    imageUrl: imageUrlFromAlbum(albumValue),
  };
}

async function fetchSpotifyAccessToken(spotifyCookie?: string): Promise<string> {
  const key = cookieKey(spotifyCookie);
  if (tokenCache && tokenCache.cookieKey === key && tokenCache.expiresAtMs > Date.now()) {
    return tokenCache.accessToken;
  }

  const headers: Record<string, string> = {
    "user-agent": DEFAULT_USER_AGENT,
    "app-platform": "WebPlayer",
    accept: "application/json",
    referer: "https://open.spotify.com/",
  };
  const cookie = normalizeCookie(spotifyCookie);
  if (cookie) headers.cookie = cookie;

  const tokenUrl = `${SPOTIFY_TOKEN_URL}?${(await tokenQueryParams("transport", TOKEN_PRODUCT_TYPE)).toString()}`;
  const response = await fetchWithTimeout(tokenUrl, {
    headers,
    credentials: "include",
  });
  if (!response?.ok) {
    throw new SpotifyPathfinderError(
      cookie
        ? "Could not authenticate with Spotify. Check your sp_dc cookie in Settings."
        : "Could not reach Spotify. For private playlists or Liked Songs, add your sp_dc cookie in Settings.",
      response?.status === 403 ? 403 : 502,
    );
  }

  const payload = toObject(await response.json().catch(() => null));
  const accessToken = toStringValue(payload?.accessToken);
  const expiresAtMs = Number(payload?.accessTokenExpirationTimestampMs);
  if (!accessToken) {
    throw new SpotifyPathfinderError("Spotify returned an empty access token", 502);
  }

  tokenCache = {
    accessToken,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 3_600_000,
    cookieKey: key,
  };
  return accessToken;
}

export type SpotifyTrackMetadata = {
  title: string;
  artist: string;
  album: string;
  isrc: string;
  imageUrl: string;
};

const SPOTIFY_BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Convert a base62 Spotify track id (22 chars) to the 128-bit hex gid that the
// internal spclient metadata API keys on.
function spotifyTrackGid(trackId: string): string | null {
  if (!/^[0-9A-Za-z]{22}$/.test(trackId)) return null;
  const bytes = new Array<number>(16).fill(0); // big-endian 128-bit accumulator
  for (const char of trackId) {
    const digit = SPOTIFY_BASE62.indexOf(char);
    if (digit < 0) return null;
    let carry = digit;
    for (let i = 15; i >= 0; i -= 1) {
      const value = bytes[i] * 62 + carry;
      bytes[i] = value & 0xff;
      carry = value >>> 8;
    }
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Fetch a single track's canonical metadata (incl. ISRC) straight from Spotify
// via the internal spclient metadata API (the high-volume endpoint Spotiflac
// uses, not the rate-limited public Web API), authenticated with the web-player
// token (sp_dc). Returns null on any failure so callers can fall back.
export async function fetchSpotifyTrackMetadata(
  trackId: string,
  spotifyCookie?: string,
): Promise<SpotifyTrackMetadata | null> {
  const gid = spotifyTrackGid(trackId);
  if (!gid) return null;
  let accessToken: string;
  try {
    accessToken = await fetchSpotifyAccessToken(spotifyCookie);
  } catch {
    return null;
  }
  const response = await fetchWithTimeout(`https://spclient.wg.spotify.com/metadata/4/track/${gid}?market=US`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": DEFAULT_USER_AGENT,
    },
  });
  if (!response?.ok) return null;
  const payload = toObject(await response.json().catch(() => null));
  if (!payload) return null;
  const title = toStringValue(payload.name);
  if (!title) return null;
  const artists = Array.isArray(payload.artist) ? payload.artist : [];
  const album = toObject(payload.album);
  const externalIds = Array.isArray(payload.external_id) ? payload.external_id : [];
  const isrc = externalIds
    .map((entry) => toObject(entry))
    .map((entry) => (toStringValue(entry?.type).toLowerCase() === "isrc" ? toStringValue(entry?.id) : ""))
    .find((id) => id.length > 0);
  const coverGroup = toObject(album?.cover_group);
  const coverImages = Array.isArray(coverGroup?.image) ? coverGroup.image : [];
  const fileId = toStringValue(toObject(coverImages[0])?.file_id);
  return {
    title,
    artist: toStringValue(toObject(artists[0])?.name),
    album: toStringValue(album?.name),
    isrc: (isrc ?? "").toUpperCase(),
    imageUrl: fileId ? `https://i.scdn.co/image/${fileId}` : "",
  };
}

async function pathfinderQuery(
  operationName: string,
  variables: Record<string, unknown>,
  hash: string,
  spotifyCookie?: string,
  timeoutMs = PATHFINDER_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const accessToken = await fetchSpotifyAccessToken(spotifyCookie);
  const params = new URLSearchParams({
    operationName,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: hash },
    }),
  });

  const response = await fetchWithTimeout(
    `${SPOTIFY_PATHFINDER_URL}?${params.toString()}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "user-agent": DEFAULT_USER_AGENT,
        accept: "application/json",
      },
    },
    timeoutMs,
  );

  if (!response?.ok) {
    throw new SpotifyPathfinderError(`Spotify pathfinder returned ${response?.status ?? "unknown"}`, 502);
  }

  const payload = toObject(await response.json().catch(() => null));
  if (!payload) throw new SpotifyPathfinderError("Spotify pathfinder returned invalid JSON", 502);
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((entry) => toStringValue(toObject(entry)?.message))
      .filter(Boolean)
      .join(" | ");
    throw new SpotifyPathfinderError(message || "Spotify pathfinder query failed", 502);
  }
  return payload;
}

export type SearchCandidate = {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  imageUrl?: string;
  durationMs?: number;
};

function candidateToTrack(candidate: SearchCandidate): SpotifyBatchTrack {
  return {
    id: candidate.id,
    name: candidate.name,
    artists: candidate.artists,
    album: candidate.album,
    imageUrl: candidate.imageUrl,
    durationMs: candidate.durationMs,
  };
}

// Recursively walk an arbitrary GraphQL `data` blob collecting every object that
// looks like a track: it carries a `uri` matching spotify:track:<22> and a
// readable `name`. Search results nest under data.searchV2.tracksV2.items[].item
// .data, but Spotify reshuffles these shapes often, so we walk generically and
// pull name + artists[].profile.name off whichever object holds the uri.
function collectSearchCandidates(value: unknown, out: SearchCandidate[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectSearchCandidates(entry, out, depth + 1);
    return;
  }
  const object = toObject(value);
  if (!object) return;

  const id = parseTrackIdFromUri(toStringValue(object.uri));
  const name = toStringValue(object.name);
  if (id && name) {
    const artistsValue = toObject(object.artists);
    const artistItems = Array.isArray(artistsValue?.items) ? artistsValue.items : [];
    const artists = artistItems
      .map((entry) => toStringValue(toObject(toObject(entry)?.profile)?.name))
      .filter(Boolean);
    // The same object that carries the uri also carries albumOfTrack (cover art +
    // name) and a duration — pull them so recommendation rows render real art and
    // a duration instead of the placeholder, even before the track is staged.
    const albumValue = toObject(object.albumOfTrack) ?? toObject(object.album);
    const durationMs = durationMsFromTrackData(object);
    const imageUrl = imageUrlFromAlbum(albumValue);
    out.push({
      id,
      name,
      artists: artists.length > 0 ? artists : ["Unknown Artist"],
      album: toStringValue(albumValue?.name) || undefined,
      imageUrl: imageUrl || undefined,
      durationMs: durationMs > 0 ? durationMs : undefined,
    });
  }

  for (const child of Object.values(object)) {
    if (child && typeof child === "object") collectSearchCandidates(child, out, depth + 1);
  }
}

// Narrow a search payload to just its TRACK-results section before harvesting, so a
// free-text list search doesn't scoop up unrelated tracks from the "top results"
// carousel or album/artist sub-sections (which is fine for a single best-match
// resolve, but pollutes a results list). Returns the `tracksV2` (or `tracks`) node
// nearest the root; null when the shape doesn't expose one, so the caller can fall
// back to a generic walk.
function findTrackResultsSection(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  const object = toObject(value);
  if (!object) return null;
  if (object.tracksV2 && typeof object.tracksV2 === "object") return object.tracksV2;
  // Plain `tracks` only when it's a section wrapper, not a track object itself.
  if (object.tracks && typeof object.tracks === "object" && !("uri" in object)) return object.tracks;
  for (const child of Object.values(object)) {
    if (child && typeof child === "object") {
      const found = findTrackResultsSection(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function spotifyEntityId(value: Record<string, unknown>, kind: "playlist" | "artist"): string {
  const uriMatch = toStringValue(value.uri).match(new RegExp(`^spotify:${kind}:([0-9A-Za-z]{22})$`));
  const id = uriMatch?.[1] ?? toStringValue(value.id);
  return isSpotifyCatalogId(id) ? id : "";
}

function findSearchV2(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8) return null;
  const object = toObject(value);
  if (!object) return null;
  const direct = toObject(object.searchV2);
  if (direct) return direct;
  for (const child of Object.values(object)) {
    if (!child || typeof child !== "object") continue;
    const found = findSearchV2(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function pathfinderArtistImage(value: Record<string, unknown>): string {
  const visuals = toObject(value.visuals);
  const avatar = toObject(visuals?.avatarImage) ?? toObject(value.avatarImage);
  return largestImageUrl(avatar?.sources);
}

function pathfinderPlaylistOwner(value: Record<string, unknown>): string {
  const owner = toObject(value.ownerV2) ?? toObject(value.owner);
  const data = toObject(owner?.data) ?? owner;
  const profile = toObject(data?.profile);
  return (
    toStringValue(profile?.name) ||
    toStringValue(data?.displayName) ||
    toStringValue(data?.name) ||
    toStringValue(data?.username)
  );
}

function collectPathfinderPlaylists(
  value: unknown,
  out: SpotifyCatalogPlaylist[],
  seen: Set<string>,
  limit: number,
  depth = 0,
): void {
  if (depth > 8 || out.length >= limit) return;
  if (Array.isArray(value)) {
    for (const child of value) {
      collectPathfinderPlaylists(child, out, seen, limit, depth + 1);
      if (out.length >= limit) break;
    }
    return;
  }
  const object = toObject(value);
  if (!object) return;
  const id = spotifyEntityId(object, "playlist");
  const name = toStringValue(object.name);
  if (id && name && !seen.has(id)) {
    const content = toObject(object.content);
    const tracks = toObject(object.tracks);
    const trackCount = toFiniteNumber(content?.totalCount) ?? toFiniteNumber(tracks?.total);
    const description = toStringValue(object.description);
    const ownerName = pathfinderPlaylistOwner(object);
    seen.add(id);
    out.push({
      kind: "playlist",
      provider: "spotify",
      id,
      name,
      imageUrl: imageUrlFromPlaylistImages(object) || null,
      ...(description ? { description } : {}),
      ...(ownerName ? { ownerName } : {}),
      ...(trackCount !== null && trackCount >= 0 ? { trackCount } : {}),
      externalUrl: `https://open.spotify.com/playlist/${id}`,
    });
  }
  for (const child of Object.values(object)) {
    if (!child || typeof child !== "object") continue;
    collectPathfinderPlaylists(child, out, seen, limit, depth + 1);
    if (out.length >= limit) break;
  }
}

function collectPathfinderArtists(
  value: unknown,
  out: SpotifyCatalogArtist[],
  seen: Set<string>,
  limit: number,
  depth = 0,
): void {
  if (depth > 8 || out.length >= limit) return;
  if (Array.isArray(value)) {
    for (const child of value) {
      collectPathfinderArtists(child, out, seen, limit, depth + 1);
      if (out.length >= limit) break;
    }
    return;
  }
  const object = toObject(value);
  if (!object) return;
  const id = spotifyEntityId(object, "artist");
  const name = toStringValue(toObject(object.profile)?.name) || toStringValue(object.name);
  if (id && name && !seen.has(id)) {
    seen.add(id);
    out.push({
      kind: "artist",
      provider: "spotify",
      id,
      name,
      imageUrl: pathfinderArtistImage(object) || null,
      externalUrl: `https://open.spotify.com/artist/${id}`,
    });
  }
  for (const child of Object.values(object)) {
    if (!child || typeof child !== "object") continue;
    collectPathfinderArtists(child, out, seen, limit, depth + 1);
    if (out.length >= limit) break;
  }
}

// Parse only the dedicated searchV2 playlist/artist sections. In particular, do
// not recursively harvest artist URIs from track rows: those are credits, not
// artist search results, and surfacing them would fabricate Spotify's ranking.
export function parseSpotifyPathfinderSearchEntities(
  payload: unknown,
  limits: { playlists?: number; artists?: number } = {},
): { playlists: SpotifyCatalogPlaylist[]; artists: SpotifyCatalogArtist[] } {
  const search = findSearchV2(payload);
  if (!search) return { playlists: [], artists: [] };
  const playlistSection = search.playlistsV2 ?? search.playlists;
  const artistSection = search.artistsV2 ?? search.artists;
  const playlists: SpotifyCatalogPlaylist[] = [];
  const artists: SpotifyCatalogArtist[] = [];
  collectPathfinderPlaylists(playlistSection, playlists, new Set<string>(), Math.max(0, limits.playlists ?? 8));
  collectPathfinderArtists(artistSection, artists, new Set<string>(), Math.max(0, limits.artists ?? 8));
  return { playlists, artists };
}

// Pick the best candidate whose normalized title matches the query AND whose
// artist tokens overlap the query artist — the guard against resolving to a wrong
// (but similarly-named) track. Among the matches it prefers the most canonical: a
// full artist agreement (then exact-artist equality) beats a loose token overlap,
// and earlier (more relevance-ranked → usually more popular) results break ties.
// A junk/cover candidate is skipped outright when a clean track was requested, so
// the real recording — or nothing — wins instead of an obscure SEO cover. Returns
// null when nothing clears the bar.
export function bestSearchCandidate(
  candidates: SearchCandidate[],
  query: SpotifyBatchTrack,
): SearchCandidate | null {
  const wantTitle = normalizeSongPart(query.name);
  const wantArtist = query.artists.join(" ");
  const wantArtistNorm = normalizeSongPart(wantArtist);
  const wantArtistTokens = new Set(wantArtistNorm.split(" ").filter(Boolean));
  // Only enforce the canonical-title guard when we actually asked for a clean
  // track; if the query itself is a version edit, a matching version is correct.
  const wantIsClean = !looksNonCanonicalTrack(query.name, wantArtist);

  let best: SearchCandidate | null = null;
  let bestScore = -Infinity;
  candidates.forEach((candidate, position) => {
    if (normalizeSongPart(candidate.name) !== wantTitle) return;
    const candidateArtistNorm = normalizeSongPart(candidate.artists.join(" "));
    const candidateTokens = candidateArtistNorm.split(" ").filter(Boolean);
    if (!candidateTokens.some((token) => wantArtistTokens.has(token))) return;
    if (wantIsClean && looksNonCanonicalTrack(candidate.name, candidate.artists.join(" "))) return;

    let score = 0;
    if ([...wantArtistTokens].every((token) => candidateTokens.includes(token))) score += 4;
    if (candidateArtistNorm === wantArtistNorm) score += 3;
    score -= position * 0.1; // earlier result = slightly better (relevance/popularity proxy)
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  });
  return best;
}

// Resolve a free-text {title, artist} to a Spotify track id. Tries the proven
// Pathfinder search persisted queries first (same partner endpoint + web-player
// token the importer already uses), then falls back to the public /v1/search as
// a LAST resort — that surface is authorized but heavily rate-limited (429), so
// it only runs when both Pathfinder hashes miss. Returns null on no confident
// match so a wrong-track guess never leaks downstream.
export async function searchSpotifyTrackId(
  query: { title: string; artist: string },
  spotifyCookie?: string,
): Promise<SpotifyBatchTrack | null> {
  const title = toStringValue(query.title);
  const artist = toStringValue(query.artist);
  if (!title || !artist) return null;
  const want: SpotifyBatchTrack = { id: "", name: title, artists: [artist] };
  const searchTerm = `${title} ${artist}`;

  // (1) Pathfinder searchTracks.
  try {
    const payload = await pathfinderQuery(
      "searchTracks",
      {
        searchTerm,
        offset: 0,
        limit: 5,
        numberOfTopResults: 5,
        includeAudiobooks: false,
        includePreReleases: false,
      },
      PATHFINDER_QUERIES.searchTracks,
      spotifyCookie,
    );
    const candidates: SearchCandidate[] = [];
    collectSearchCandidates(toObject(payload.data), candidates);
    const match = bestSearchCandidate(candidates, want);
    if (match) return candidateToTrack(match);
  } catch {
    // fall through to the next surface
  }

  // (2) Pathfinder searchDesktop (drops includePreReleases).
  try {
    const payload = await pathfinderQuery(
      "searchDesktop",
      {
        searchTerm,
        offset: 0,
        limit: 5,
        numberOfTopResults: 5,
        includeAudiobooks: false,
      },
      PATHFINDER_QUERIES.searchDesktop,
      spotifyCookie,
    );
    const candidates: SearchCandidate[] = [];
    collectSearchCandidates(toObject(payload.data), candidates);
    const match = bestSearchCandidate(candidates, want);
    if (match) return candidateToTrack(match);
  } catch {
    // fall through to the rate-limited public API
  }

  // (3) Last resort: public /v1/search (heavily rate-limited, 429 under load).
  try {
    const accessToken = await fetchSpotifyAccessToken(spotifyCookie);
    const params = new URLSearchParams({
      q: `track:"${title}" artist:"${artist}"`,
      type: "track",
      limit: "5",
    });
    const response = await fetchWithTimeout(`${SPOTIFY_SEARCH_URL}?${params.toString()}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": DEFAULT_USER_AGENT,
      },
    });
    if (response?.ok) {
      const payload = toObject(await response.json().catch(() => null));
      const items = Array.isArray(toObject(payload?.tracks)?.items) ? toObject(payload?.tracks)?.items : [];
      const candidates: SearchCandidate[] = (items as unknown[])
        .map((entry) => {
          const data = toObject(entry);
          const id = parseTrackIdFromUri(toStringValue(data?.uri)) || toStringValue(data?.id);
          const name = toStringValue(data?.name);
          if (!id || !name) return null;
          const artistRows = Array.isArray(data?.artists) ? data.artists : [];
          const artists = artistRows.map((row) => toStringValue(toObject(row)?.name)).filter(Boolean);
          // Public Web API shape: album.images[].url + duration_ms (flat, unlike Pathfinder).
          const albumValue = toObject(data?.album);
          const images = Array.isArray(albumValue?.images) ? albumValue.images : [];
          const imageUrl = toStringValue(toObject(images[0])?.url);
          const durationMs = toFiniteNumber(data?.duration_ms) ?? 0;
          return {
            id,
            name,
            artists: artists.length > 0 ? artists : ["Unknown Artist"],
            album: toStringValue(albumValue?.name) || undefined,
            imageUrl: imageUrl || undefined,
            durationMs: durationMs > 0 ? durationMs : undefined,
          } as SearchCandidate;
        })
        .filter((candidate): candidate is SearchCandidate => candidate !== null);
      const match = bestSearchCandidate(candidates, want);
      if (match) return candidateToTrack(match);
    }
  } catch {
    // give up
  }

  return null;
}

function webApiTrackCandidate(value: unknown): SearchCandidate | null {
  const data = toObject(value);
  if (!data) return null;
  const id = parseTrackIdFromUri(toStringValue(data.uri)) || toStringValue(data.id);
  const name = toStringValue(data.name);
  if (!isSpotifyCatalogId(id) || !name) return null;
  const artistRows = Array.isArray(data.artists) ? data.artists : [];
  const artists = artistRows.map((row) => toStringValue(toObject(row)?.name)).filter(Boolean);
  const albumValue = toObject(data.album);
  const imageUrl = largestImageUrl(albumValue?.images);
  const durationMs = toFiniteNumber(data.duration_ms) ?? 0;
  return {
    id,
    name,
    artists: artists.length > 0 ? artists : ["Unknown Artist"],
    album: toStringValue(albumValue?.name) || undefined,
    imageUrl: imageUrl || undefined,
    durationMs: durationMs > 0 ? durationMs : undefined,
  };
}

function webApiPlaylist(value: unknown): SpotifyCatalogPlaylist | null {
  const data = toObject(value);
  if (!data) return null;
  const id = spotifyEntityId(data, "playlist");
  const name = toStringValue(data.name);
  if (!id || !name) return null;
  const description = toStringValue(data.description);
  const ownerName = toStringValue(toObject(data.owner)?.display_name);
  const trackCount = toFiniteNumber(toObject(data.tracks)?.total);
  return {
    kind: "playlist",
    provider: "spotify",
    id,
    name,
    imageUrl: largestImageUrl(data.images) || null,
    ...(description ? { description } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(trackCount !== null && trackCount >= 0 ? { trackCount } : {}),
    externalUrl: `https://open.spotify.com/playlist/${id}`,
  };
}

function webApiArtist(value: unknown): SpotifyCatalogArtist | null {
  const data = toObject(value);
  if (!data) return null;
  const id = spotifyEntityId(data, "artist");
  const name = toStringValue(data.name);
  if (!id || !name) return null;
  return {
    kind: "artist",
    provider: "spotify",
    id,
    name,
    imageUrl: largestImageUrl(data.images) || null,
    externalUrl: `https://open.spotify.com/artist/${id}`,
  };
}

function dedupeValuesById<T extends { id: string }>(values: T[], limit: number): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.id || seen.has(value.id)) continue;
    seen.add(value.id);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

export function parseSpotifyWebApiSearchEntities(
  payload: unknown,
  limits: { playlists?: number; artists?: number } = {},
): { playlists: SpotifyCatalogPlaylist[]; artists: SpotifyCatalogArtist[] } {
  const root = toObject(payload);
  const playlistItems = Array.isArray(toObject(root?.playlists)?.items) ? toObject(root?.playlists)?.items : [];
  const artistItems = Array.isArray(toObject(root?.artists)?.items) ? toObject(root?.artists)?.items : [];
  return {
    playlists: dedupeValuesById(
      (playlistItems as unknown[]).map(webApiPlaylist).filter((item): item is SpotifyCatalogPlaylist => item !== null),
      Math.max(0, limits.playlists ?? 8),
    ),
    artists: dedupeValuesById(
      (artistItems as unknown[]).map(webApiArtist).filter((item): item is SpotifyCatalogArtist => item !== null),
      Math.max(0, limits.artists ?? 8),
    ),
  };
}

const SEARCH_STOPWORDS = new Set([
  "the", "and", "for", "you", "with", "that", "this", "from", "feat", "ft", "a", "an", "of", "to", "in", "on", "my",
]);

function dedupeRelevantSearchCandidates(
  candidates: SearchCandidate[],
  searchTerm: string,
  limit: number,
): SpotifyBatchTrack[] {
  const queryTokens = searchTerm
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !SEARCH_STOPWORDS.has(token));
  const seen = new Set<string>();
  const out: SpotifyBatchTrack[] = [];
  for (const candidate of candidates) {
    const haystack = `${candidate.name} ${candidate.artists.join(" ")}`.toLowerCase();
    if (
      !candidate.id ||
      seen.has(candidate.id) ||
      (queryTokens.length > 0 && !queryTokens.some((token) => haystack.includes(token)))
    ) {
      continue;
    }
    seen.add(candidate.id);
    out.push(candidateToTrack(candidate));
    if (out.length >= limit) break;
  }
  return out;
}

// One bounded mixed search for the UI. Pathfinder's dedicated searchV2 sections
// are primary; Spotify's Web API is the fallback if that persisted query fails.
// Both are authoritative Spotify payloads. A total provider failure throws so
// the API can distinguish "no matches" from "Spotify unavailable".
export async function searchSpotifyCatalog(
  query: string,
  spotifyCookie?: string,
  limits: { tracks?: number; playlists?: number; artists?: number } = {},
): Promise<SpotifyCatalogSearchResult> {
  const searchTerm = toStringValue(query).slice(0, 100);
  if (!searchTerm) return { tracks: [], playlists: [], artists: [] };
  const trackLimit = Math.min(24, Math.max(0, limits.tracks ?? 24));
  const playlistLimit = Math.min(8, Math.max(0, limits.playlists ?? 8));
  const artistLimit = Math.min(8, Math.max(0, limits.artists ?? 8));

  try {
    const payload = await pathfinderQuery(
      "searchDesktop",
      {
        searchTerm,
        offset: 0,
        limit: Math.max(trackLimit, playlistLimit, artistLimit),
        numberOfTopResults: 5,
        includeAudiobooks: false,
      },
      PATHFINDER_QUERIES.searchDesktop,
      spotifyCookie,
      CATALOG_REQUEST_TIMEOUT_MS,
    );
    const data = toObject(payload.data);
    const trackCandidates: SearchCandidate[] = [];
    collectSearchCandidates(findTrackResultsSection(data) ?? data, trackCandidates);
    const entities = parseSpotifyPathfinderSearchEntities(payload, {
      playlists: playlistLimit,
      artists: artistLimit,
    });
    return {
      tracks: dedupeRelevantSearchCandidates(trackCandidates, searchTerm, trackLimit),
      ...entities,
    };
  } catch {
    // Fall through to Spotify's Web API.
  }

  const accessToken = await fetchSpotifyAccessToken(spotifyCookie);
  const params = new URLSearchParams({
    q: searchTerm,
    type: "track,playlist,artist",
    limit: String(Math.max(trackLimit, playlistLimit, artistLimit)),
  });
  const response = await fetchWithTimeout(
    `${SPOTIFY_SEARCH_URL}?${params.toString()}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": DEFAULT_USER_AGENT,
      },
    },
    CATALOG_REQUEST_TIMEOUT_MS,
  );
  if (!response?.ok) {
    throw new SpotifyPathfinderError(`Spotify search returned ${response?.status ?? "unknown"}`, 502);
  }
  const payload = toObject(await response.json().catch(() => null));
  if (!payload) throw new SpotifyPathfinderError("Spotify search returned invalid JSON", 502);
  const trackItems = Array.isArray(toObject(payload.tracks)?.items) ? toObject(payload.tracks)?.items : [];
  const trackCandidates = (trackItems as unknown[])
    .map(webApiTrackCandidate)
    .filter((candidate): candidate is SearchCandidate => candidate !== null);
  const entities = parseSpotifyWebApiSearchEntities(payload, {
    playlists: playlistLimit,
    artists: artistLimit,
  });
  return {
    tracks: dedupeRelevantSearchCandidates(trackCandidates, searchTerm, trackLimit),
    ...entities,
  };
}

// Free-text catalog search → a ranked LIST of track candidates (deduped by id).
// Mirrors searchSpotifyTrackId's surface fallback chain (Pathfinder searchTracks →
// searchDesktop → public /v1/search), but returns the whole list for a
// search-results view instead of collapsing to the single best match. There is no
// title/artist guard here: the caller typed free text, so Spotify's own relevance
// ordering is exactly what we want to surface. Returns [] on total failure.
export async function searchSpotifyTracks(
  query: string,
  spotifyCookie?: string,
  limit = 24,
): Promise<SpotifyBatchTrack[]> {
  const searchTerm = toStringValue(query).trim();
  if (!searchTerm) return [];

  // Relevance guard: even scoped to the tracks section, Spotify mixes in related /
  // popular tracks. Keep only results whose title or artist actually contains one of
  // the query's meaningful tokens (drop short/stopword tokens so "die with a smile"
  // keys on die/smile, "sabrina carpenter" on sabrina/carpenter). An all-stopword or
  // very short query keeps everything rather than filtering to nothing.
  const STOPWORDS = new Set([
    "the", "and", "for", "you", "with", "that", "this", "from", "feat", "ft", "a", "an", "of", "to", "in", "on", "my",
  ]);
  const queryTokens = searchTerm
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  const isRelevant = (candidate: SearchCandidate): boolean => {
    if (queryTokens.length === 0) return true;
    const haystack = `${candidate.name} ${candidate.artists.join(" ")}`.toLowerCase();
    return queryTokens.some((token) => haystack.includes(token));
  };

  const dedupe = (candidates: SearchCandidate[]): SpotifyBatchTrack[] => {
    const seen = new Set<string>();
    const out: SpotifyBatchTrack[] = [];
    for (const candidate of candidates) {
      if (!candidate.id || seen.has(candidate.id) || !isRelevant(candidate)) continue;
      seen.add(candidate.id);
      out.push(candidateToTrack(candidate));
      if (out.length >= limit) break;
    }
    return out;
  };

  // (1) Pathfinder searchTracks, then (2) searchDesktop — same persisted queries the
  // single-match resolver uses, so no extra hashes to maintain.
  for (const surface of [
    { name: "searchTracks" as const, query: PATHFINDER_QUERIES.searchTracks, extra: { includePreReleases: false } },
    { name: "searchDesktop" as const, query: PATHFINDER_QUERIES.searchDesktop, extra: {} },
  ]) {
    try {
      const payload = await pathfinderQuery(
        surface.name,
        { searchTerm, offset: 0, limit, numberOfTopResults: 5, includeAudiobooks: false, ...surface.extra },
        surface.query,
        spotifyCookie,
      );
      const data = toObject(payload.data);
      const candidates: SearchCandidate[] = [];
      // Harvest only the track-results section so unrelated "top results" carousel
      // entries don't leak in; fall back to a full walk if the shape changed.
      collectSearchCandidates(findTrackResultsSection(data) ?? data, candidates);
      const tracks = dedupe(candidates);
      if (tracks.length > 0) return tracks;
    } catch {
      // try the next surface
    }
  }

  // (3) Last resort: public /v1/search (heavily rate-limited).
  try {
    const accessToken = await fetchSpotifyAccessToken(spotifyCookie);
    const params = new URLSearchParams({ q: searchTerm, type: "track", limit: String(limit) });
    const response = await fetchWithTimeout(`${SPOTIFY_SEARCH_URL}?${params.toString()}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": DEFAULT_USER_AGENT,
      },
    });
    if (response?.ok) {
      const payload = toObject(await response.json().catch(() => null));
      const items = Array.isArray(toObject(payload?.tracks)?.items) ? toObject(payload?.tracks)?.items : [];
      const candidates: SearchCandidate[] = (items as unknown[])
        .map((entry) => {
          const data = toObject(entry);
          const id = parseTrackIdFromUri(toStringValue(data?.uri)) || toStringValue(data?.id);
          const name = toStringValue(data?.name);
          if (!id || !name) return null;
          const artistRows = Array.isArray(data?.artists) ? data.artists : [];
          const artists = artistRows.map((row) => toStringValue(toObject(row)?.name)).filter(Boolean);
          const albumValue = toObject(data?.album);
          const images = Array.isArray(albumValue?.images) ? albumValue.images : [];
          const imageUrl = toStringValue(toObject(images[0])?.url);
          const durationMs = toFiniteNumber(data?.duration_ms) ?? 0;
          return {
            id,
            name,
            artists: artists.length > 0 ? artists : ["Unknown Artist"],
            album: toStringValue(albumValue?.name) || undefined,
            imageUrl: imageUrl || undefined,
            durationMs: durationMs > 0 ? durationMs : undefined,
          } as SearchCandidate;
        })
        .filter((candidate): candidate is SearchCandidate => candidate !== null);
      const tracks = dedupe(candidates);
      if (tracks.length > 0) return tracks;
    }
  } catch {
    // give up
  }

  return [];
}

export function parseSpotifyArtistCatalogPayload(
  profilePayload: unknown,
  topTracksPayload: unknown,
  expectedArtistId: string,
): SpotifyArtistCatalog | null {
  if (!isSpotifyCatalogId(expectedArtistId)) return null;
  const profile = toObject(profilePayload);
  if (!profile) return null;
  const id = spotifyEntityId(profile, "artist");
  const name = toStringValue(profile.name);
  if (id !== expectedArtistId || !name) return null;

  const genres = Array.isArray(profile.genres)
    ? profile.genres.map(toStringValue).filter(Boolean).slice(0, 20)
    : [];
  const followers = toFiniteNumber(toObject(profile.followers)?.total);
  const trackRows = Array.isArray(toObject(topTracksPayload)?.tracks)
    ? (toObject(topTracksPayload)?.tracks as unknown[])
    : [];
  const tracks = dedupeValuesById(
    trackRows
      .filter((row) => {
        const artists = Array.isArray(toObject(row)?.artists) ? toObject(row)?.artists : [];
        return (artists as unknown[]).some((artist) => spotifyEntityId(toObject(artist) ?? {}, "artist") === id);
      })
      .map(webApiTrackCandidate)
      .filter((track): track is SearchCandidate => track !== null)
      .map(candidateToTrack),
    20,
  );

  return {
    artist: {
      kind: "artist",
      provider: "spotify",
      id,
      name,
      imageUrl: largestImageUrl(profile.images) || null,
      externalUrl: `https://open.spotify.com/artist/${id}`,
      ...(genres.length > 0 ? { genres } : {}),
      ...(followers !== null && followers >= 0 ? { followers } : {}),
    },
    tracks,
  };
}

export function parseSpotifyArtistEmbedPayload(
  payload: unknown,
  expectedArtistId: string,
): SpotifyArtistCatalog | null {
  if (!isSpotifyCatalogId(expectedArtistId)) return null;
  const props = toObject(toObject(payload)?.props);
  const pageProps = toObject(props?.pageProps);
  const state = toObject(pageProps?.state);
  const data = toObject(state?.data);
  const entity = toObject(data?.entity);
  if (!entity || toStringValue(entity.type) !== "artist") return null;
  const id = spotifyEntityId(entity, "artist");
  const name = toStringValue(entity.name) || toStringValue(entity.title);
  if (id !== expectedArtistId || !name) return null;
  const imageUrl = largestImageUrl(toObject(entity.visualIdentity)?.image) || null;
  const trackRows = Array.isArray(entity.trackList) ? entity.trackList : [];
  const candidates: SpotifyBatchTrack[] = [];
  for (const row of trackRows) {
    const track = toObject(row);
    if (!track || track.isPlayable === false) continue;
    const trackId = parseTrackIdFromUri(toStringValue(track.uri));
    const title = toStringValue(track.title);
    if (!trackId || !title) continue;
    const artistDisplay = toStringValue(track.subtitle) || name;
    const durationMs = toFiniteNumber(track.duration) ?? 0;
    candidates.push({
      id: trackId,
      name: title,
      artists: [artistDisplay],
      imageUrl: imageUrl || undefined,
      durationMs: durationMs > 0 ? durationMs : undefined,
    });
  }
  return {
    artist: {
      kind: "artist",
      provider: "spotify",
      id,
      name,
      imageUrl,
      externalUrl: `https://open.spotify.com/artist/${id}`,
    },
    tracks: dedupeValuesById(candidates, 20),
  };
}

export function parseSpotifyArtistEmbedHtml(
  html: string,
  expectedArtistId: string,
): SpotifyArtistCatalog | null {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    return parseSpotifyArtistEmbedPayload(JSON.parse(match[1]), expectedArtistId);
  } catch {
    return null;
  }
}

export async function fetchSpotifyArtistCatalog(
  artistId: string,
  _spotifyCookie?: string,
  _market = "US",
): Promise<SpotifyArtistCatalog> {
  if (!isSpotifyCatalogId(artistId)) {
    throw new SpotifyPathfinderError("Invalid Spotify artist ID", 400);
  }
  const response = await fetchWithTimeout(
    `https://open.spotify.com/embed/artist/${artistId}`,
    {
      headers: {
        accept: "text/html",
        "user-agent": DEFAULT_USER_AGENT,
        referer: "https://open.spotify.com/",
      },
    },
    CATALOG_REQUEST_TIMEOUT_MS,
  );
  if (!response?.ok) {
    throw new SpotifyPathfinderError(
      response?.status === 404 ? "Spotify artist not found" : "Could not load Spotify artist",
      response?.status === 404 ? 404 : 502,
    );
  }
  const catalog = parseSpotifyArtistEmbedHtml(await response.text(), artistId);
  if (!catalog) throw new SpotifyPathfinderError("Spotify returned invalid artist metadata", 502);
  return catalog;
}

async function fetchPaginatedTracks(options: {
  fetchPage: (offset: number, limit: number) => Promise<{ items: unknown[]; totalCount: number }>;
  maxTracks?: number;
}): Promise<SpotifyBatchTrack[]> {
  const maxTracks = options.maxTracks ?? 10_000;
  const seen = new Set<string>();
  const tracks: SpotifyBatchTrack[] = [];
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  while (offset < totalCount && tracks.length < maxTracks) {
    const page = await options.fetchPage(offset, PAGE_SIZE);
    totalCount = Number.isFinite(page.totalCount) ? page.totalCount : totalCount;
    if (page.items.length === 0) break;

    for (const item of page.items) {
      const track = trackFromPathfinderItem(item) ?? trackFromLibraryItem(item);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
      if (tracks.length >= maxTracks) break;
    }

    offset += PAGE_SIZE;
    if (page.items.length < PAGE_SIZE) break;
  }

  return tracks;
}

// Pull the largest cover-art source URL out of a playlistV2 `images` block.
// Editorial/algorithmic playlists expose a single rendered cover here; regular
// playlists expose a 4-up mosaic — we just take the widest source either way.
function imageUrlFromPlaylistImages(playlistMeta: Record<string, unknown> | null): string {
  const images = toObject(playlistMeta?.images);
  const items = Array.isArray(images?.items) ? images.items : [];
  for (const item of items) {
    const sources = Array.isArray(toObject(item)?.sources) ? (toObject(item)?.sources as unknown[]) : [];
    const ranked = sources
      .map((source) => {
        const object = toObject(source);
        return { url: toStringValue(object?.url), width: toFiniteNumber(object?.width) ?? 0 };
      })
      .filter((source) => source.url)
      .sort((left, right) => right.width - left.width);
    if (ranked[0]?.url) return ranked[0].url;
  }
  return "";
}

export type SpotifyPlaylistMetadata = { name: string; imageUrl: string; description: string };

// Fetch just a playlist's display metadata (name, cover image, description) —
// without paging through its tracks. Used to render curated-playlist cards.
// Returns null on any failure so callers can fall back to static defaults.
export async function fetchSpotifyPlaylistMetadata(
  playlistId: string,
  spotifyCookie?: string,
): Promise<SpotifyPlaylistMetadata | null> {
  try {
    const metadata = await pathfinderQuery(
      "fetchPlaylistMetadata",
      { uri: `spotify:playlist:${playlistId}`, offset: 0, limit: 1 },
      PATHFINDER_QUERIES.fetchPlaylistMetadata,
      spotifyCookie,
    );
    const playlistMeta = toObject(toObject(metadata.data)?.playlistV2);
    const name = toStringValue(playlistMeta?.name);
    if (!name) return null;
    return {
      name,
      imageUrl: imageUrlFromPlaylistImages(playlistMeta),
      description: toStringValue(playlistMeta?.description),
    };
  } catch {
    return null;
  }
}

function playlistSummaryFromPathfinder(
  playlistMeta: Record<string, unknown> | null,
  playlistId: string,
): SpotifyCatalogPlaylist | null {
  if (!playlistMeta || !isSpotifyCatalogId(playlistId)) return null;
  const uriId = spotifyEntityId(playlistMeta, "playlist");
  if (uriId && uriId !== playlistId) return null;
  const name = toStringValue(playlistMeta.name);
  if (!name) return null;
  const description = toStringValue(playlistMeta.description);
  const ownerName = pathfinderPlaylistOwner(playlistMeta);
  const content = toObject(playlistMeta.content);
  const trackCount = toFiniteNumber(content?.totalCount);
  return {
    kind: "playlist",
    provider: "spotify",
    id: playlistId,
    name,
    imageUrl: imageUrlFromPlaylistImages(playlistMeta) || null,
    ...(description ? { description } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(trackCount !== null && trackCount >= 0 ? { trackCount } : {}),
    externalUrl: `https://open.spotify.com/playlist/${playlistId}`,
  };
}

export async function fetchSpotifyPlaylistCatalog(
  playlistId: string,
  spotifyCookie?: string,
  maxTracks = 100,
): Promise<SpotifyPlaylistCatalog> {
  if (!isSpotifyCatalogId(playlistId)) {
    throw new SpotifyPathfinderError("Invalid Spotify playlist ID", 400);
  }
  const boundedMaxTracks = Math.min(100, Math.max(1, Math.floor(maxTracks)));
  const metadata = await pathfinderQuery(
    "fetchPlaylistMetadata",
    { uri: `spotify:playlist:${playlistId}`, offset: 0, limit: 1 },
    PATHFINDER_QUERIES.fetchPlaylistMetadata,
    spotifyCookie,
    CATALOG_REQUEST_TIMEOUT_MS,
  );
  const playlistMeta = toObject(toObject(metadata.data)?.playlistV2);
  const playlist = playlistSummaryFromPathfinder(playlistMeta, playlistId);
  if (!playlist) throw new SpotifyPathfinderError("Spotify playlist not found", 404);

  const tracks = await fetchPaginatedTracks({
    maxTracks: boundedMaxTracks,
    fetchPage: async (offset, limit) => {
      const payload = await pathfinderQuery(
        "fetchPlaylistContents",
        { uri: `spotify:playlist:${playlistId}`, offset, limit },
        PATHFINDER_QUERIES.fetchPlaylistContents,
        spotifyCookie,
        CATALOG_REQUEST_TIMEOUT_MS,
      );
      const content = toObject(toObject(toObject(payload.data)?.playlistV2)?.content);
      const items = Array.isArray(content?.items) ? content.items : [];
      return {
        items,
        totalCount: Number(content?.totalCount ?? items.length),
      };
    },
  });
  return {
    playlist: {
      ...playlist,
      ...(playlist.trackCount === undefined ? { trackCount: tracks.length } : {}),
    },
    tracks,
  };
}

export async function fetchSpotifyPlaylistCatalogPage(
  playlistId: string,
  spotifyCookie?: string,
  offset = 0,
  limit = PAGE_SIZE,
): Promise<SpotifyPlaylistCatalogPage> {
  if (!isSpotifyCatalogId(playlistId)) {
    throw new SpotifyPathfinderError("Invalid Spotify playlist ID", 400);
  }
  const boundedOffset = Math.min(10_000, Math.max(0, Math.floor(offset)));
  const boundedLimit = Math.min(PAGE_SIZE, Math.max(1, Math.floor(limit)));
  const [metadata, contents] = await Promise.all([
    pathfinderQuery(
      "fetchPlaylistMetadata",
      { uri: `spotify:playlist:${playlistId}`, offset: 0, limit: 1 },
      PATHFINDER_QUERIES.fetchPlaylistMetadata,
      spotifyCookie,
      CATALOG_REQUEST_TIMEOUT_MS,
    ),
    pathfinderQuery(
      "fetchPlaylistContents",
      { uri: `spotify:playlist:${playlistId}`, offset: boundedOffset, limit: boundedLimit },
      PATHFINDER_QUERIES.fetchPlaylistContents,
      spotifyCookie,
      CATALOG_REQUEST_TIMEOUT_MS,
    ),
  ]);
  const playlistMeta = toObject(toObject(metadata.data)?.playlistV2);
  const playlist = playlistSummaryFromPathfinder(playlistMeta, playlistId);
  if (!playlist) throw new SpotifyPathfinderError("Spotify playlist not found", 404);

  const content = toObject(toObject(toObject(contents.data)?.playlistV2)?.content);
  const items = Array.isArray(content?.items) ? content.items : [];
  const totalCountValue = toFiniteNumber(content?.totalCount) ?? playlist.trackCount ?? items.length;
  const totalCount = Math.max(0, Math.floor(totalCountValue));
  const tracks = dedupeValuesById(
    items
      .map((item) => trackFromPathfinderItem(item) ?? trackFromLibraryItem(item))
      .filter((track): track is SpotifyBatchTrack => track !== null),
    boundedLimit,
  );
  const consumed = boundedOffset + items.length;
  const nextOffset = items.length > 0 && consumed < totalCount ? consumed : null;
  return {
    playlist: {
      ...playlist,
      trackCount: totalCount,
    },
    tracks,
    offset: boundedOffset,
    totalCount,
    nextOffset,
  };
}

export async function fetchSpotifyPlaylistTracks(
  playlistId: string,
  spotifyCookie?: string,
  maxTracks = 10_000,
): Promise<{ title: string; tracks: SpotifyBatchTrack[] }> {
  const metadata = await pathfinderQuery(
    "fetchPlaylistMetadata",
    { uri: `spotify:playlist:${playlistId}`, offset: 0, limit: 1 },
    PATHFINDER_QUERIES.fetchPlaylistMetadata,
    spotifyCookie,
  );
  const playlistMeta = toObject(toObject(toObject(metadata.data)?.playlistV2));
  const title = toStringValue(playlistMeta?.name) || "Playlist";

  const tracks = await fetchPaginatedTracks({
    maxTracks,
    fetchPage: async (offset, limit) => {
      const payload = await pathfinderQuery(
        "fetchPlaylistContents",
        { uri: `spotify:playlist:${playlistId}`, offset, limit },
        PATHFINDER_QUERIES.fetchPlaylistContents,
        spotifyCookie,
      );
      const content = toObject(toObject(toObject(payload.data)?.playlistV2)?.content);
      const items = Array.isArray(content?.items) ? content.items : [];
      return {
        items,
        totalCount: Number(content?.totalCount ?? items.length),
      };
    },
  });

  return { title, tracks };
}

export async function fetchSpotifyLikedTracks(
  spotifyCookie: string,
  maxTracks = 10_000,
): Promise<{ title: string; tracks: SpotifyBatchTrack[] }> {
  const cookie = normalizeCookie(spotifyCookie);
  if (!cookie) {
    throw new SpotifyPathfinderError(
      "Liked Songs import requires a Spotify sp_dc cookie.",
      400,
    );
  }

  const tracks = await fetchPaginatedTracks({
    maxTracks,
    fetchPage: async (offset, limit) => {
      const payload = await pathfinderQuery(
        "fetchLibraryTracks",
        { offset, limit },
        PATHFINDER_QUERIES.fetchLibraryTracks,
        cookie,
      );
      const me = toObject(toObject(payload.data)?.me);
      const tracksRoot = toObject(toObject(me?.library)?.tracks);
      const items = Array.isArray(tracksRoot?.items) ? tracksRoot.items : [];
      return {
        items,
        totalCount: Number(tracksRoot?.totalCount ?? items.length),
      };
    },
  });

  return { title: "Liked Songs", tracks };
}

export async function fetchSpotifyAlbumTracks(
  albumId: string,
  spotifyCookie?: string,
  maxTracks = 500,
): Promise<{ title: string; artist: string; tracks: SpotifyBatchTrack[] }> {
  const payload = await pathfinderQuery(
    "getAlbum",
    { uri: `spotify:album:${albumId}`, locale: "", offset: 0, limit: maxTracks },
    PATHFINDER_QUERIES.getAlbum,
    spotifyCookie,
  );
  const album = toObject(toObject(payload.data)?.albumUnion) ?? toObject(toObject(payload.data)?.album);
  const title = toStringValue(album?.name) || "Unknown Album";
  const artistsValue = toObject(album?.artists);
  const artistItems = Array.isArray(artistsValue?.items) ? artistsValue.items : [];
  const artist =
    toStringValue(toObject(artistItems[0]?.profile)?.name) ||
    toStringValue(toObject(artistItems[0])?.name) ||
    "Unknown Artist";

  const tracksRoot = toObject(album?.tracks);
  const items = Array.isArray(tracksRoot?.items) ? tracksRoot.items : [];
  const seen = new Set<string>();
  const tracks: SpotifyBatchTrack[] = [];

  for (const item of items) {
    const data = toObject(item);
    const uri = toStringValue(data?.uri);
    const id = parseTrackIdFromUri(uri) || toStringValue(data?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const trackArtistsValue = toObject(data?.artists);
    const trackArtistItems = Array.isArray(trackArtistsValue?.items) ? trackArtistsValue.items : [];
    const trackArtists = trackArtistItems
      .map((entry) => toStringValue(toObject(toObject(entry)?.profile)?.name))
      .filter(Boolean);
    tracks.push({
      id,
      name: toStringValue(data?.name) || "Unknown Track",
      artists: trackArtists.length > 0 ? trackArtists : [artist],
    });
  }

  return { title, artist, tracks };
}

export function scrapeSpotifyTrackIdsFromHtml(html: string): string[] {
  const seen = new Set<string>();
  const trackIds: string[] = [];
  for (const match of html.matchAll(/spotify:track:([A-Za-z0-9]{22})/g)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    trackIds.push(match[1]);
  }
  return trackIds;
}
