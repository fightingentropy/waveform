import { ApiError } from "./http";
import { toNumberValue, toStringValue } from "./values";

export type ActionPayload = {
  action?: unknown;
  spotifyUrl?: unknown;
  region?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  batchType?: unknown;
  outputFormat?: unknown;
};

export type BatchDownloadPayload = {
  spotifyUrl?: unknown;
  region?: unknown;
  qualityProfile?: unknown;
  service?: unknown;
  outputFormat?: unknown;
  includeMetadata?: unknown;
  includeLyrics?: unknown;
  includeCover?: unknown;
  spotifyCookie?: unknown;
};

export type SongPayload = {
  mode?: unknown;
  // Discover staging: when true, stage a cheap YouTube Opus preview (play/skip)
  // instead of resolving a lossless source. The lossless resolver is reserved
  // for the Add-to-library path so the library stays FLAC-only.
  preview?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  duration?: unknown;
  durationMs?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
  spotifyUrl?: unknown;
  service?: unknown;
  quality?: unknown;
  qualityProfile?: unknown;
  outputFormat?: unknown;
  region?: unknown;
  lyricsText?: unknown;
  replaceExisting?: unknown;
};

export type BatchResponseTrack = {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  releaseDate: string;
  totalPlays: number;
  durationMs: number;
  imageUrl: string;
  previewUrl: string;
};

export type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";

export const SERVER_IMPORT_OUTPUT_FORMAT: OutputFormat = "flac";
export const OUTPUT_FORMATS = new Set<OutputFormat>(["flac", "mp3", "aac", "ogg", "opus", "wav"]);

export function durationSecondsFromPayload(payload: SongPayload): number | null {
  const durationMs = toNumberValue(payload.durationMs);
  if (durationMs != null && durationMs > 0) {
    return Math.round(durationMs / 1000);
  }

  const duration = toNumberValue(payload.duration);
  if (duration != null && duration > 0) {
    return Math.round(duration > 1000 ? duration / 1000 : duration);
  }

  return null;
}

export function outputFormatFromPayload(value: unknown): OutputFormat {
  const format = toStringValue(value).toLowerCase() as OutputFormat;
  return OUTPUT_FORMATS.has(format) ? format : SERVER_IMPORT_OUTPUT_FORMAT;
}

export function assertServerImportOutputFormat(payload: Pick<SongPayload, "outputFormat">): void {
  const outputFormat = outputFormatFromPayload(payload.outputFormat);
  if (outputFormat !== SERVER_IMPORT_OUTPUT_FORMAT) {
    throw new ApiError(
      `${outputFormat.toUpperCase()} output is only available for browser/local saves. Server imports currently support FLAC/original audio.`,
      400,
    );
  }
}
