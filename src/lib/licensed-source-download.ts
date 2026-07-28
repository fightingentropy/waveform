import { toObject, toStringValue } from "./provider-http";
import { fetchPublicHttpUrl } from "./safe-fetch";
import { isSpotByeEnvelopeHost, postSpotByeEnvelope } from "./spotbye-envelope";

// NOTE: this provider's DEFAULT_USER_AGENT and fetchWithTimeout deliberately
// diverge from the shared provider-http helpers: it advertises the app's own
// UA (not the Chrome string the public-API providers spoof) and its
// fetchWithTimeout takes a RequestInit + timeout rather than the option bag the
// other providers use. Both stay local on purpose.
const DEFAULT_USER_AGENT = "spotify/1.0 (+https://music.streamarena.xyz)";
const LICENSED_SOURCE_REQUEST_TIMEOUT_MS = 30_000;
const LICENSED_SOURCE_MAX_AUDIO_BYTES = 100 * 1024 * 1024;
// A malicious DASH manifest can request billions of segments (e.g. a single
// <S r="2000000000"/>) or an enormous zero-pad width; both blow up memory/CPU
// before any byte is fetched. Cap the totals so manifest parsing is provably
// bounded regardless of attacker input.
const LICENSED_SOURCE_MAX_DASH_SEGMENTS = 5_000;
const LICENSED_SOURCE_MAX_TEMPLATE_PAD_WIDTH = 12;

// Caller- and provider-supplied stream headers are untrusted. Only forward a
// small allowlist of innocuous request headers so a caller cannot inject
// Host/Authorization/Cookie (or similar) headers into an SSRF fetch.
const ALLOWED_MEDIA_HEADERS = new Set([
  "user-agent",
  "range",
  "accept",
  "accept-language",
  "x-captcha-token",
]);

type JsonObject = Record<string, unknown>;

export type LicensedSourceStream = {
  kind: "url" | "dash";
  streamUrl: string;
  headers: Record<string, string>;
  contentType: string;
  decryptionKey?: string;
  /** Deezer track id for BF-CBC stripe decrypt on the Mac mini. */
  deezerId?: number;
  codec?: string;
  outputFormat?: string;
  metadata: JsonObject;
  dash?: LicensedSourceDash;
};

export type LicensedSourceDash = {
  manifestXml?: string;
  manifestUrl?: string;
};

export class LicensedSourceDownloadError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function readNestedObject(payload: JsonObject, key: string): JsonObject | null {
  return toObject(payload[key]);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = toStringValue(value);
    if (text) return text;
  }
  return "";
}

function headersFromValue(value: unknown): Record<string, string> {
  const headers = toObject(value);
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    const normalizedKey = key.trim().toLowerCase();
    const value = toStringValue(rawValue);
    if (!normalizedKey || !value) continue;
    out[normalizedKey] = value;
  }
  return out;
}

function withHeaderIfMissing(headers: Record<string, string>, key: string, value: string): Record<string, string> {
  if (!value) return headers;
  const normalizedKey = key.toLowerCase();
  if (Object.keys(headers).some((header) => header.toLowerCase() === normalizedKey)) return headers;
  return { ...headers, [normalizedKey]: value };
}

// Build the request headers for an outbound media fetch from untrusted stream
// headers: drop everything outside ALLOWED_MEDIA_HEADERS so a caller cannot
// inject Host/Authorization/Cookie, then force our own user-agent.
function mediaRequestHeaders(
  streamHeaders: Record<string, string> | undefined,
  userAgent: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(streamHeaders ?? {})) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = typeof value === "string" ? value.trim() : "";
    if (!normalizedKey || !normalizedValue) continue;
    if (!ALLOWED_MEDIA_HEADERS.has(normalizedKey)) continue;
    headers[normalizedKey] = normalizedValue;
  }
  if (!headers["user-agent"]) headers["user-agent"] = userAgent;
  return headers;
}

function assertMediaResponseSize(response: Response, maxBytes: number): void {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
  }
}

// Read a response body into memory while enforcing a byte budget as bytes
// arrive, so a response with an absent/NaN Content-Length (which would slip past
// the header-only size check) still cannot exceed the budget. Aborts the stream
// the moment the budget is crossed instead of buffering the whole body first.
async function readBodyWithByteBudget(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (maxBytes < 0) {
    await response.body?.cancel().catch(() => undefined);
    throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function providerMetadata(payload: JsonObject, data: JsonObject, audio: JsonObject, stream: JsonObject): JsonObject {
  const metadata = {
    ...(toObject(payload.metadata) ?? {}),
    ...(toObject(data.metadata) ?? {}),
  };
  const lyrics = firstString(
    payload.lyric,
    data.lyric,
    audio.lyric,
    stream.lyric,
    payload.lyrics,
    data.lyrics,
    audio.lyrics,
    stream.lyrics,
    payload.lrc,
    data.lrc,
    payload.syncedLyrics,
    data.syncedLyrics,
  );
  const captchaToken = firstString(
    payload.captcha,
    data.captcha,
    audio.captcha,
    stream.captcha,
    payload.captchaToken,
    data.captchaToken,
    payload.token,
    data.token,
  );
  if (lyrics && !toStringValue(metadata.lyrics)) metadata.lyrics = lyrics;
  if (captchaToken) metadata.captchaToken = captchaToken;
  return metadata;
}

function decodeBase64Text(value: string): string {
  if (!value) return "";
  try {
    if (typeof atob === "function") {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
  } catch {}
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function maybeManifestXml(value: unknown): string {
  const text = toStringValue(value);
  if (!text) return "";
  if (text.includes("<MPD")) return text;
  const decoded = decodeBase64Text(text);
  return decoded.includes("<MPD") ? decoded : "";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = LICENSED_SOURCE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      // Resolver calls expect the stream URL/JSON in the body, not via a 3xx, so
      // don't auto-follow redirects out from under the SSRF guard.
      redirect: "manual",
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new LicensedSourceDownloadError("Licensed source provider timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(response: Response, fallbackMs: number): number {
  const raw = response.headers.get("retry-after") || "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, Math.max(1_000, seconds * 1000));
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.min(10_000, Math.max(1_000, dateMs - Date.now()));
  return fallbackMs;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch caller/provider-controlled media URLs through the SSRF guard
// (redirect:"manual" with per-hop re-validation), retrying on 429/503 while
// honoring Retry-After.
async function fetchMediaWithRetries(url: string, init: RequestInit): Promise<Response> {
  const parsed = parseHttpUrl(url);
  if (!parsed) throw new LicensedSourceDownloadError("Licensed source URL is invalid", 502);
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetchPublicHttpUrl(parsed, init, LICENSED_SOURCE_REQUEST_TIMEOUT_MS);
    if (response.status !== 429 && response.status !== 503) return response;
    lastResponse = response;
    if (attempt === 3) return response;
    await response.body?.cancel().catch(() => undefined);
    await wait(retryAfterMs(response, (attempt + 1) * 1500));
  }
  return lastResponse ?? fetchPublicHttpUrl(parsed, init, LICENSED_SOURCE_REQUEST_TIMEOUT_MS);
}

export async function resolveLicensedSourceStreamUrl(options: {
  endpointUrl: string;
  apiKey?: string;
  userAgent?: string;
  spotifyId: string;
  spotifyUrl: string;
  region?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: string;
  qualityProfile?: string;
  outputFormat?: string;
  body?: JsonObject;
  timeoutMs?: number;
}): Promise<LicensedSourceStream> {
  const endpoint = parseHttpUrl(options.endpointUrl);
  if (!endpoint) {
    throw new LicensedSourceDownloadError("Licensed source provider is not configured", 501);
  }

  const requestBody = options.body ?? {
    spotifyId: options.spotifyId,
    spotifyUrl: options.spotifyUrl,
    region: (options.region || "US").toUpperCase(),
    title: options.title || "",
    artist: options.artist || "",
    album: options.album || "",
    durationMs: options.durationMs || "",
    qualityProfile: options.qualityProfile || "max",
    outputFormat: options.outputFormat || "flac",
  };

  let responseOk = false;
  let responseStatus = 0;
  let text = "";

  // Lettered SpotBye Next hosts require the encrypted envelope; fall back to
  // plain JSON for FOSS / legacy / custom endpoints.
  if (isSpotByeEnvelopeHost(endpoint.toString())) {
    try {
      const enveloped = await postSpotByeEnvelope(endpoint.toString(), requestBody, {
        userAgent: options.userAgent || DEFAULT_USER_AGENT,
        timeoutMs: options.timeoutMs,
      });
      responseOk = enveloped.status >= 200 && enveloped.status < 300;
      responseStatus = enveloped.status;
      text = enveloped.text;
    } catch {
      // Fall through to plain JSON below.
    }
  }

  if (!text) {
    const headers = new Headers({
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "user-agent": options.userAgent || DEFAULT_USER_AGENT,
    });
    if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);

    const response = await fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, options.timeoutMs);
    responseOk = response.ok;
    responseStatus = response.status;
    text = await response.text();
  }

  let payload: JsonObject = {};
  if (text.trim().startsWith("http://") || text.trim().startsWith("https://")) {
    payload = { streamUrl: text.trim() };
  } else {
    try {
      payload = toObject(JSON.parse(text || "{}")) ?? {};
    } catch {
      if (!responseOk) {
        throw new LicensedSourceDownloadError(
          `Licensed source provider returned ${responseStatus}`,
          responseStatus,
        );
      }
      throw new LicensedSourceDownloadError("Licensed source provider returned invalid JSON", 502);
    }
  }
  const audio = readNestedObject(payload, "audio") ?? {};
  const stream = readNestedObject(payload, "stream") ?? {};
  const data = readNestedObject(payload, "data") ?? {};
  const message = firstString(payload.error, payload.message, data.error, data.message);

  if (!responseOk) {
    throw new LicensedSourceDownloadError(
      message || `Licensed source provider returned ${responseStatus}`,
      responseStatus,
    );
  }

  // spotbye returns Tidal/Qobuz lossless streams as an inline DASH manifest
  // ("url":"MANIFEST:<base64 mpd>"), not an HTTP URL — decode it into a dash stream.
  const inlineUrl = firstString(payload.url, data.url, audio.url, stream.url, payload.streamUrl, data.streamUrl);
  if (inlineUrl.startsWith("MANIFEST:")) {
    let manifestXml: string;
    try {
      const binary = atob(inlineUrl.slice("MANIFEST:".length));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      manifestXml = new TextDecoder().decode(bytes);
    } catch {
      throw new LicensedSourceDownloadError("Licensed source provider returned an unreadable manifest", 502);
    }
    if (!manifestXml.includes("<MPD")) {
      throw new LicensedSourceDownloadError("Licensed source provider returned an invalid manifest", 502);
    }
    const inlineCodec = firstString(payload.codec, data.codec, audio.codec, stream.codec, payload.format, data.format);
    return {
      kind: "dash",
      streamUrl: "",
      headers: {},
      contentType: "",
      ...(inlineCodec ? { codec: inlineCodec } : {}),
      ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
      metadata: providerMetadata(payload, data, audio, stream),
      dash: { manifestXml, manifestUrl: "" },
    };
  }

  const streamUrl = firstString(
    payload.streamUrl,
    payload.audioUrl,
    payload.downloadUrl,
    payload.url,
    data.streamUrl,
    data.audioUrl,
    data.downloadUrl,
    data.url,
    data.uri,
    data.manifestUrl,
    payload.mpdUri,
    audio.url,
    stream.url,
  );
  const parsedStreamUrl = parseHttpUrl(streamUrl);
  if (!parsedStreamUrl) {
    throw new LicensedSourceDownloadError("Licensed source provider returned no stream URL", 502);
  }
  const manifestXml = maybeManifestXml(data.manifest) || maybeManifestXml(payload.manifest);
  const contentType = firstString(payload.contentType, data.contentType, audio.contentType, stream.contentType);
  const looksLikeDash =
    Boolean(manifestXml) ||
    contentType.includes("dash") ||
    parsedStreamUrl.pathname.toLowerCase().endsWith(".mpd") ||
    firstString(data.manifestUrl, payload.mpdUri).startsWith("http");
  const keySpecs = (() => {
    const raw = payload.key_specs ?? data.key_specs ?? audio.key_specs ?? stream.key_specs;
    if (!Array.isArray(raw)) return [] as string[];
    return raw.map((v) => toStringValue(v)).filter(Boolean);
  })();
  const decryptionKey =
    firstString(payload.key, data.key, audio.key, stream.key, payload.decryptionKey, data.decryptionKey) ||
    keySpecs[0] ||
    "";
  const codec = firstString(payload.codec, data.codec, audio.codec, stream.codec, payload.format, data.format);
  const outputFormat = options.outputFormat || "";
  const metadata = providerMetadata(payload, data, audio, stream);
  if (keySpecs.length) metadata.keySpecs = keySpecs;
  // SpotBye Deezer bodies use { id, quality }; carry that id for BF-CBC decrypt.
  const bodyId = Number(options.body?.id);
  const deezerId =
    /dzcdn\.net|deezer\.com/i.test(parsedStreamUrl.hostname) || /dzr-/i.test(endpoint.hostname)
      ? Number.isFinite(bodyId) && bodyId > 0
        ? bodyId
        : Number(firstString(payload.id, data.id, metadata.deezerId)) || undefined
      : undefined;
  if (deezerId) metadata.deezerId = deezerId;
  let streamHeaders = {
    ...headersFromValue(payload.headers),
    ...headersFromValue(data.headers),
    ...headersFromValue(audio.headers),
    ...headersFromValue(stream.headers),
  };
  streamHeaders = withHeaderIfMissing(streamHeaders, "x-captcha-token", toStringValue(metadata.captchaToken));

  return {
    kind: looksLikeDash ? "dash" : "url",
    streamUrl: parsedStreamUrl.toString(),
    headers: streamHeaders,
    contentType,
    ...(decryptionKey ? { decryptionKey } : {}),
    ...(deezerId ? { deezerId } : {}),
    ...(codec ? { codec } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    metadata,
    dash: looksLikeDash
      ? {
          manifestXml,
          manifestUrl: firstString(data.manifestUrl, payload.mpdUri, data.uri, payload.uri, streamUrl),
        }
      : undefined,
  };
}

function xmlAttr(source: string, name: string): string {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match?.[1]?.replaceAll("&amp;", "&") ?? "";
}

// Substitute DASH SegmentTemplate identifiers ($Number$, $RepresentationID$,
// $Bandwidth$, $Time$) including the zero-padded/width form $Identifier%0Nd$,
// and the $$ -> $ literal escape. Throws if an unresolved "$...$" token remains.
function substituteTemplate(template: string, values: Record<string, number | string>): string {
  const result = template.replace(
    /\$\$|\$([A-Za-z]+)(%0\d+d)?\$/g,
    (match, identifier?: string, format?: string) => {
      if (match === "$$") return "$";
      if (!identifier || !(identifier in values)) return match;
      const value = values[identifier];
      if (format) {
        const width = Number(format.slice(2, -1));
        if (!Number.isFinite(width) || width > LICENSED_SOURCE_MAX_TEMPLATE_PAD_WIDTH) {
          throw new LicensedSourceDownloadError(
            "Licensed source DASH manifest uses an unreasonable template pad width",
            502,
          );
        }
        return String(value).padStart(width, "0");
      }
      return String(value);
    },
  );
  if (/\$[A-Za-z]+(%0\d+d)?\$/.test(result)) {
    throw new LicensedSourceDownloadError("Licensed source DASH manifest has an unresolved template token", 502);
  }
  return result;
}

function manifestBaseUrl(manifestXml: string, manifestUrl: string): string {
  const baseMatch = manifestXml.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/);
  const base = baseMatch?.[1]?.trim().replaceAll("&amp;", "&") ?? "";
  if (!base) return manifestUrl;
  try {
    return new URL(base, manifestUrl).toString();
  } catch {
    return base;
  }
}

function resolveSegmentUrl(template: string, baseUrl: string): string {
  try {
    return new URL(template, baseUrl).toString();
  } catch {
    return template;
  }
}

function chosenRepresentation(manifestXml: string): { id: string; bandwidth: string } {
  let best: { id: string; bandwidth: string; score: number } | null = null;
  for (const match of manifestXml.matchAll(/<Representation\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? "";
    const id = xmlAttr(attrs, "id");
    const bandwidth = xmlAttr(attrs, "bandwidth");
    const score = Number(bandwidth) || 0;
    if (!best || score > best.score) best = { id, bandwidth, score };
  }
  return best ? { id: best.id, bandwidth: best.bandwidth } : { id: "", bandwidth: "" };
}

function segmentUrlsFromManifest(manifestXml: string, manifestUrl: string): string[] {
  const templateMatch = manifestXml.match(
    /<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>|<SegmentTemplate\b[^>]*\/>/,
  );
  const template = templateMatch?.[0] ?? "";
  if (!template) throw new LicensedSourceDownloadError("Licensed source DASH manifest has no SegmentTemplate", 502);
  const initialization = xmlAttr(template, "initialization");
  const media = xmlAttr(template, "media");
  const startNumber = Number(xmlAttr(template, "startNumber") || "1");
  if (!initialization || !media || !Number.isFinite(startNumber)) {
    throw new LicensedSourceDownloadError("Licensed source DASH manifest is missing segment URLs", 502);
  }
  // startNumber is attacker-controlled and feeds the segment numbering; reject an
  // out-of-range value before it can be used to inflate the loop bound below.
  if (startNumber < 0 || startNumber > LICENSED_SOURCE_MAX_DASH_SEGMENTS) {
    throw new LicensedSourceDownloadError("Licensed source DASH manifest uses an out-of-range startNumber", 502);
  }

  const representation = chosenRepresentation(manifestXml);
  const baseUrl = manifestBaseUrl(manifestXml, manifestUrl);
  const sharedValues = {
    RepresentationID: representation.id,
    Bandwidth: representation.bandwidth,
  };

  // Build the (number, time) pairs from the SegmentTimeline. Each <S> entry
  // carries an optional explicit start time (t), a duration (d), and a repeat
  // count (r); r segments follow the first with monotonically increasing time.
  const segments: Array<{ number: number; time: number }> = [];
  let nextNumber = startNumber;
  let nextTime = 0;
  let sawTimeline = false;
  for (const match of template.matchAll(/<S\b([^>]*)\/>/g)) {
    sawTimeline = true;
    const attrs = match[1] ?? "";
    const explicitTime = attrs.match(/\bt="(\d+)"/)?.[1];
    const durationRaw = attrs.match(/\bd="(\d+)"/)?.[1];
    const repeatRaw = attrs.match(/\br="(-?\d+)"/)?.[1];
    const duration = durationRaw ? Number(durationRaw) : 0;
    const repeat = repeatRaw ? Number(repeatRaw) : 0;
    if (!Number.isFinite(repeat) || repeat < 0) {
      throw new LicensedSourceDownloadError("Licensed source DASH manifest uses unsupported open-ended segments", 502);
    }
    // A single <S r="..."/> can request billions of segments. Reject any repeat
    // count that would, on its own, exceed the overall cap before expanding it.
    if (repeat > LICENSED_SOURCE_MAX_DASH_SEGMENTS) {
      throw new LicensedSourceDownloadError("Licensed source DASH manifest requests too many segments", 502);
    }
    if (explicitTime !== undefined) nextTime = Number(explicitTime);
    for (let i = 0; i <= repeat; i += 1) {
      // Cap the cumulative segment count so a long run of <S> entries cannot
      // grow the array without bound either.
      if (segments.length >= LICENSED_SOURCE_MAX_DASH_SEGMENTS) {
        throw new LicensedSourceDownloadError("Licensed source DASH manifest requests too many segments", 502);
      }
      segments.push({ number: nextNumber, time: nextTime });
      nextNumber += 1;
      nextTime += duration;
    }
  }
  if (!sawTimeline || segments.length <= 0) {
    throw new LicensedSourceDownloadError("Licensed source DASH manifest has no segments", 502);
  }

  const urls = [resolveSegmentUrl(substituteTemplate(initialization, sharedValues), baseUrl)];
  for (const segment of segments) {
    const filled = substituteTemplate(media, {
      ...sharedValues,
      Number: segment.number,
      Time: segment.time,
    });
    urls.push(resolveSegmentUrl(filled, baseUrl));
  }
  return urls;
}

async function readManifest(stream: LicensedSourceStream): Promise<{ xml: string; url: string }> {
  const manifestUrl = stream.dash?.manifestUrl || stream.streamUrl;
  const inline = stream.dash?.manifestXml;
  if (inline) return { xml: inline, url: manifestUrl };
  const parsed = parseHttpUrl(manifestUrl);
  if (!parsed) throw new LicensedSourceDownloadError("Licensed source manifest URL is invalid", 502);
  const response = await fetchPublicHttpUrl(
    parsed,
    {
      method: "GET",
      headers: mediaRequestHeaders(stream.headers, DEFAULT_USER_AGENT),
    },
    LICENSED_SOURCE_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) throw new LicensedSourceDownloadError(`Licensed source manifest returned ${response.status}`, response.status);
  const text = await response.text();
  if (!text.includes("<MPD")) throw new LicensedSourceDownloadError("Licensed source manifest is not DASH MPD", 502);
  return { xml: text, url: parsed.toString() };
}

export async function materializeLicensedSourceStream(
  stream: LicensedSourceStream,
  options?: { maxBytes?: number; userAgent?: string },
): Promise<Response> {
  const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
  const maxBytes = options?.maxBytes ?? LICENSED_SOURCE_MAX_AUDIO_BYTES;
  if (stream.kind === "url") {
    const response = await fetchMediaWithRetries(stream.streamUrl, {
      method: "GET",
      headers: mediaRequestHeaders(stream.headers, userAgent),
    });
    if (response.ok) assertMediaResponseSize(response, maxBytes);
    return response;
  }

  const manifest = await readManifest(stream);
  const segmentUrls = segmentUrlsFromManifest(manifest.xml, manifest.url);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (const url of segmentUrls) {
    const response = await fetchMediaWithRetries(url, {
      method: "GET",
      headers: mediaRequestHeaders(stream.headers, userAgent),
    });
    if (!response.ok) throw new LicensedSourceDownloadError(`Licensed source segment returned ${response.status}`, response.status);
    // A missing/NaN Content-Length would bypass a header-only pre-check, so the
    // running byte budget is enforced while the body is read rather than after.
    assertMediaResponseSize(response, maxBytes - totalBytes);
    const bytes = await readBodyWithByteBudget(response, maxBytes - totalBytes);
    totalBytes += bytes.byteLength;
    chunks.push(bytes);
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(out, {
    headers: {
      "content-type": stream.contentType || "audio/mp4",
      "content-length": String(totalBytes),
    },
  });
}
