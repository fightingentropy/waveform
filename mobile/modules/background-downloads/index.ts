import {
  EventEmitter,
  type EventSubscription,
  requireOptionalNativeModule,
} from "expo-modules-core";
import { Platform } from "react-native";

export type NativeBackgroundDownloadStatus =
  | "queued"
  | "downloading"
  | "ready"
  | "error";

export type NativeBackgroundDownloadJob = {
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

export type NativeBackgroundDownloadState = {
  key: string;
  transferToken: string;
  accountScope: string;
  songId: string;
  scopes: string[];
  songJSON: string;
  status: NativeBackgroundDownloadStatus;
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

export type NativeBackgroundDownloadRef = {
  key: string;
  transferToken: string;
};

export type NativeBackgroundDownloadAcknowledgement =
  NativeBackgroundDownloadRef & {
    revision: number;
  };

type NativeBackgroundDownloadsModule = {
  enqueue(jobs: NativeBackgroundDownloadJob[]): Promise<void>;
  cancel(jobs: NativeBackgroundDownloadRef[]): Promise<void>;
  cancelAccount(accountScope: string): Promise<void>;
  cancelAll(): Promise<void>;
  snapshot(accountScope?: string | null): Promise<NativeBackgroundDownloadState[]>;
  acknowledge(
    jobs: NativeBackgroundDownloadAcknowledgement[],
  ): Promise<void>;
  setActiveAccount(accountScope: string): Promise<void>;
};

let cachedModule: NativeBackgroundDownloadsModule | null | undefined;
let cachedEmitter: any = null;

function nativeModule(): NativeBackgroundDownloadsModule | null {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  if (cachedModule === undefined) {
    cachedModule =
      requireOptionalNativeModule<NativeBackgroundDownloadsModule>(
        "BackgroundDownloads",
      );
  }
  return cachedModule;
}

export function supportsNativeBackgroundDownloads(): boolean {
  return nativeModule() !== null;
}

export async function enqueueNativeBackgroundDownloads(
  jobs: NativeBackgroundDownloadJob[],
): Promise<void> {
  if (jobs.length === 0) return;
  await nativeModule()?.enqueue(jobs);
}

export async function cancelNativeBackgroundDownloads(
  jobs: NativeBackgroundDownloadRef[],
): Promise<void> {
  if (jobs.length === 0) return;
  await nativeModule()?.cancel(jobs);
}

export async function cancelNativeBackgroundDownloadAccount(
  accountScope: string,
): Promise<void> {
  await nativeModule()?.cancelAccount(accountScope);
}

export async function cancelAllNativeBackgroundDownloads(): Promise<void> {
  await nativeModule()?.cancelAll();
}

export async function getNativeBackgroundDownloadSnapshot(
  accountScope?: string,
): Promise<NativeBackgroundDownloadState[]> {
  return (await nativeModule()?.snapshot(accountScope ?? null)) ?? [];
}

export async function acknowledgeNativeBackgroundDownloads(
  jobs: NativeBackgroundDownloadAcknowledgement[],
): Promise<void> {
  if (jobs.length === 0) return;
  await nativeModule()?.acknowledge(jobs);
}

export async function setNativeBackgroundDownloadAccount(
  accountScope: string,
): Promise<void> {
  await nativeModule()?.setActiveAccount(accountScope);
}

export function addNativeBackgroundDownloadListener(
  listener: (event: NativeBackgroundDownloadState) => void,
): EventSubscription | null {
  const module = nativeModule();
  if (!module) return null;
  if (!cachedEmitter) {
    cachedEmitter = new EventEmitter(module as any);
  }
  return cachedEmitter.addListener(
    "stateChanged",
    listener as (event: Record<string, unknown>) => void,
  );
}
