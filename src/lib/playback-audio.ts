export const PLAYBACK_SEEK_LANDING_TOLERANCE_SECONDS = 0.75;

export type HlsInstance = {
  attachMedia: (media: HTMLMediaElement) => void;
  destroy: () => void;
  loadSource: (src: string) => void;
};

export type HlsConstructor = {
  new (config?: { enableWorker?: boolean; lowLatencyMode?: boolean }): HlsInstance;
  isSupported: () => boolean;
};

let hlsConstructorPromise: Promise<HlsConstructor | null> | null = null;

export function resolvePlayableSrc(src: string): string {
  if (/^(blob:|data:|https?:)/i.test(src)) return src;
  return `${location.origin}${src}`;
}

export function finiteMediaDuration(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function seekIsCloseEnough(
  actual: number,
  target: number,
  toleranceSeconds = PLAYBACK_SEEK_LANDING_TOLERANCE_SECONDS,
): boolean {
  return Number.isFinite(actual) && Math.abs(actual - target) <= toleranceSeconds;
}

export function isHlsPlaylistSrc(src: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(src);
}

export function canPlayHlsNatively(audio: HTMLAudioElement): boolean {
  return (
    audio.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    audio.canPlayType("application/x-mpegURL") !== ""
  );
}

export function loadHlsConstructor(): Promise<HlsConstructor | null> {
  hlsConstructorPromise ??= import("hls.js/light")
    .then((module) => module.default as HlsConstructor)
    .catch(() => null);
  return hlsConstructorPromise;
}

export function errorName(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) return "";
  return String((error as { name?: unknown }).name || "");
}

// iOS/iPadOS ignore writes to HTMLMediaElement.volume (the element stays at 1).
// Detect this once and cache it so we can skip the overlapping volume-ramp
// crossfade on those platforms (a clean cut is used instead, so two tracks never
// play simultaneously at full volume).
let audioVolumeWritableCache: boolean | null = null;
export function audioVolumeIsWritable(audio: HTMLAudioElement): boolean {
  if (audioVolumeWritableCache !== null) return audioVolumeWritableCache;
  const original = audio.volume;
  try {
    const probe = original > 0.5 ? 0.123 : 0.876;
    audio.volume = probe;
    audioVolumeWritableCache = Math.abs(audio.volume - probe) < 0.01;
  } catch {
    audioVolumeWritableCache = false;
  } finally {
    try { audio.volume = original; } catch {}
  }
  return audioVolumeWritableCache;
}

// iOS (incl. iPadOS in desktop-UA mode, and the Capacitor WKWebView) never lets
// JS change the actual output volume — but as of iOS 26 a write to .volume now
// READS BACK the written value, so the probe above false-positives and the app
// wrongly takes the audio.volume crossfade path (which is silent on iOS: both
// tracks stay at full and the outgoing is hard-paused at the window's end). So
// detect iOS directly and force the Web Audio gain-node path there regardless of
// what the probe reports.
export function isIosLikePlatform(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints ?? 0,
): boolean {
  if (!userAgent) return false;
  if (/iP(hone|od|ad)/.test(userAgent)) return true;
  // iPadOS 13+ Safari reports as "Macintosh"; real Macs have no touch points.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

// Our own origins whose authed audio endpoints need the session cookie, so the
// <audio> element must fetch them with credentials when routed through the Web
// Audio API (otherwise the credentialed-CORS response isn't sent and the source
// node outputs silence). Third-party hosts (radio) use anonymous CORS instead;
// same-origin / blob / capacitor sources need no crossOrigin at all.
const CREDENTIALED_AUDIO_ORIGINS = new Set<string>([
  "https://music.streamarena.xyz",
]);

// The crossOrigin mode the <audio> element must use for a resolved src so that,
// when routed through Web Audio, the MediaElementSourceNode is CORS-clean (audible
// rather than silenced). null => remove the attribute (no-cors, same-origin).
export function crossOriginForAudioSrc(
  src: string,
  pageOrigin = typeof location !== "undefined" ? location.origin : undefined,
): "anonymous" | "use-credentials" | null {
  if (/^(blob:|data:|file:|capacitor:)/i.test(src)) return null;
  try {
    const url = new URL(src, pageOrigin);
    if (pageOrigin && url.origin === pageOrigin) return null;
    if (CREDENTIALED_AUDIO_ORIGINS.has(url.origin)) return "use-credentials";
    return "anonymous";
  } catch {
    return null;
  }
}
