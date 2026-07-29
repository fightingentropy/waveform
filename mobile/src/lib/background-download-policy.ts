import {
  PLAYBACK_CACHE_SCOPE,
  type DownloadScope,
  type DownloadStatus,
  type OfflineDownloadRecord,
} from "@/lib/offline-download-queue";
import type { PlayerSong } from "@/types/player";

export type BackgroundDownloadTransportState = {
  key: string;
  transferToken: string;
  accountScope: string;
  songId: string;
  scopes: string[];
  songJSON: string;
  status: DownloadStatus;
  progress: number;
  bytesWritten: number;
  bytesExpected: number;
  audioPath?: string;
  coverPath?: string;
  lyricsPath?: string;
  error?: string;
  revision: number;
  updatedAt: number;
};

export type BackgroundDownloadTransportJob = {
  key: string;
  transferToken: string;
  accountScope: string;
  songId: string;
  scopes: string[];
  songJSON: string;
  audioURL: string;
  coverURL?: string;
  lyricsURL?: string;
  refreshURL: string;
  audioPath: string;
  coverPath?: string;
  lyricsPath?: string;
  priority: number;
};

let transferSequence = 0;

export function createDownloadTransferToken(
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  transferSequence = (transferSequence + 1) % Number.MAX_SAFE_INTEGER;
  return [
    now().toString(36),
    transferSequence.toString(36),
    Math.floor(random() * 0x1_0000_0000)
      .toString(36)
      .padStart(7, "0"),
  ].join("-");
}

export function safeDownloadName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export function downloadExtension(
  url: string,
  fallback: string,
): string {
  const path = url.split(/[?#]/)[0] ?? "";
  const match = path.match(/\.([a-zA-Z0-9]{1,5})$/);
  return match ? `.${match[1].toLowerCase()}` : fallback;
}

export function backgroundDownloadPaths(song: PlayerSong): {
  audioPath: string;
  coverPath?: string;
  lyricsPath?: string;
} {
  const directory = `offline-media/${safeDownloadName(song.id)}`;
  return {
    audioPath: `${directory}/audio${downloadExtension(song.audioUrl, ".audio")}`,
    coverPath: song.imageUrl
      ? `${directory}/cover${downloadExtension(song.imageUrl, ".jpg")}`
      : undefined,
    lyricsPath: song.lyricsUrl ? `${directory}/lyrics.lrc` : undefined,
  };
}

export function backgroundDownloadPriority(
  scopes: readonly DownloadScope[],
): number {
  if (scopes.includes(PLAYBACK_CACHE_SCOPE)) return 1;
  if (scopes.some((scope) => scope.startsWith("song:"))) return 0.8;
  return 0.25;
}

export function createBackgroundDownloadTransportJob(
  record: OfflineDownloadRecord,
  key: string,
  toAbsoluteURL: (url: string) => string,
): BackgroundDownloadTransportJob | null {
  if (!record.transferToken || !record.song.audioUrl) return null;
  const paths = backgroundDownloadPaths(record.song);
  return {
    key,
    transferToken: record.transferToken,
    accountScope: record.accountScope,
    songId: record.songId,
    scopes: record.scopes,
    songJSON: JSON.stringify(record.song),
    audioURL: toAbsoluteURL(record.song.audioUrl),
    coverURL: record.song.imageUrl
      ? toAbsoluteURL(record.song.imageUrl)
      : undefined,
    lyricsURL: record.song.lyricsUrl
      ? toAbsoluteURL(record.song.lyricsUrl)
      : undefined,
    refreshURL: toAbsoluteURL(
      `/api/songs/${encodeURIComponent(record.songId)}`,
    ),
    ...paths,
    priority: backgroundDownloadPriority(record.scopes),
  };
}

export function applyBackgroundDownloadTransportState(
  record: OfflineDownloadRecord,
  state: BackgroundDownloadTransportState,
): OfflineDownloadRecord | null {
  if (
    record.accountScope !== state.accountScope ||
    record.songId !== state.songId ||
    record.transferToken !== state.transferToken
  ) {
    return null;
  }

  let song = record.song;
  try {
    const refreshed = JSON.parse(state.songJSON) as PlayerSong;
    if (refreshed?.id === record.songId && refreshed.audioUrl) {
      song = refreshed;
    }
  } catch {}

  return {
    ...record,
    song,
    status: state.status,
    audioPath: state.status === "ready" ? state.audioPath : undefined,
    coverPath: state.status === "ready" ? state.coverPath : undefined,
    lyricsPath: state.status === "ready" ? state.lyricsPath : undefined,
    error: state.status === "error" ? state.error ?? "Download failed" : undefined,
    resumeData: undefined,
    updatedAt: state.updatedAt,
  };
}

export function restoreRecordFromBackgroundDownloadState(
  state: BackgroundDownloadTransportState,
): OfflineDownloadRecord | null {
  let song: PlayerSong;
  try {
    song = JSON.parse(state.songJSON) as PlayerSong;
  } catch {
    return null;
  }
  const scopes = state.scopes.filter(
    (scope): scope is DownloadScope =>
      scope === "home" ||
      scope === "liked" ||
      scope === PLAYBACK_CACHE_SCOPE ||
      scope.startsWith("playlist:") ||
      scope.startsWith("song:"),
  );
  if (
    !song?.id ||
    song.id !== state.songId ||
    !song.audioUrl ||
    scopes.length === 0
  ) {
    return null;
  }

  return {
    songId: state.songId,
    accountScope: state.accountScope,
    scopes,
    status: state.status,
    song,
    audioPath: state.status === "ready" ? state.audioPath : undefined,
    coverPath: state.status === "ready" ? state.coverPath : undefined,
    lyricsPath: state.status === "ready" ? state.lyricsPath : undefined,
    error: state.status === "error" ? state.error ?? "Download failed" : undefined,
    transferToken: state.transferToken,
    updatedAt: state.updatedAt,
  };
}

export function isTerminalBackgroundDownloadState(
  state: BackgroundDownloadTransportState,
): boolean {
  return state.status === "ready" || state.status === "error";
}
