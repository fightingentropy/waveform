import { describe, expect, test } from "bun:test";

const coordinator = await Bun.file(
  new URL(
    "../modules/background-downloads/ios/BackgroundDownloadCoordinator.swift",
    import.meta.url,
  ),
).text();
const androidCoordinator = await Bun.file(
  new URL(
    "../modules/background-downloads/android/src/main/java/expo/modules/backgrounddownloads/BackgroundDownloadCoordinator.kt",
    import.meta.url,
  ),
).text();
const androidManifest = await Bun.file(
  new URL(
    "../modules/background-downloads/android/src/main/AndroidManifest.xml",
    import.meta.url,
  ),
).text();
const bridge = await Bun.file(
  new URL("../modules/background-downloads/index.ts", import.meta.url),
).text();
const database = await Bun.file(
  new URL("../src/lib/offline-db.ts", import.meta.url),
).text();

describe("native background download durability contract", () => {
  test("uses one relaunchable URLSession and completes UIKit only after reconciliation", () => {
    expect(coordinator).toContain(
      'return "\\(bundleIdentifier).background-downloads.v1"',
    );
    expect(coordinator).toContain(
      "configuration.sessionSendsLaunchEvents = true",
    );
    expect(coordinator).toContain(
      "guard backgroundEventsFinished, !reconcilingTasks else { return }",
    );
  });

  test("persists changed jobs through an append journal instead of full-ledger rewrites", () => {
    expect(coordinator).toContain("journal-v1.ndjson");
    expect(coordinator).toContain("private func appendLedgerLocked(");
    expect(coordinator).not.toContain("persistLedgerLocked");
    expect(coordinator).toContain("try handle.synchronize()");
    expect(coordinator).toContain("try compactLedgerIfNeededLocked()");
  });

  test("does not promote legacy response bodies and keeps URL refresh intent durable", () => {
    expect(coordinator).toContain(
      "job.audioPath != job.requestedAudioPath",
    );
    expect(coordinator).toContain("job.pendingStage = .refresh");
    expect(coordinator).toContain("if job.pendingStage == .refresh");
    expect(coordinator).toContain(
      "refreshedSongId == job.songId",
    );
  });

  test("reuses audio for sidecar repair and makes advertised sidecars required", () => {
    expect(coordinator).toContain("let existingAudioPath =");
    expect(coordinator).toContain("stage != .refresh");
    expect(coordinator).toContain(
      "stage == .audio ? 7 * 24 * 60 * 60 : 90",
    );
    expect(coordinator).toContain("If the catalog advertises a sidecar");
    expect(coordinator).not.toContain("Artwork and lyrics are best-effort sidecars");
  });

  test("normalizes restored media for file protection and backup exclusion", () => {
    expect(coordinator).toContain("func protectOfflineMediaStorage()");
    expect(coordinator).toContain("values.isExcludedFromBackup = true");
    expect(bridge).toContain("protectNativeOfflineMediaStorage");
  });

  test("migrates transfer generations into the existing SQLite table", () => {
    expect(database).toContain(
      "ALTER TABLE downloads ADD COLUMN transferToken TEXT",
    );
    expect(database).toContain(
      "audioPath, coverPath, lyricsPath, transferToken, updatedAt",
    );
  });
});

describe("android WorkManager background downloads", () => {
  test("queues unique work per key and writes a durable JSON ledger", () => {
    expect(androidCoordinator).toContain("enqueueUniqueWork");
    expect(androidCoordinator).toContain('UNIQUE_WORK_PREFIX = "bgdl:"');
    expect(androidCoordinator).toContain("ledger-v1.json");
    expect(androidCoordinator).toContain('relativePath.startsWith("offline-media/")');
  });

  test("keeps transfer tokens and revisions on the JS snapshot contract", () => {
    expect(androidCoordinator).toContain("job.transferToken != transferToken");
    expect(androidCoordinator).toContain("job.revision += 1");
    expect(androidCoordinator).toContain("FOREGROUND_SERVICE_TYPE_DATA_SYNC");
    expect(androidManifest).toContain("FOREGROUND_SERVICE_DATA_SYNC");
    expect(androidManifest).toContain('android:foregroundServiceType="dataSync"');
  });

  test("exposes the same native module on Android as on iOS", () => {
    expect(bridge).toContain(
      'if (Platform.OS !== "ios" && Platform.OS !== "android") return null;',
    );
    expect(bridge).toContain("requireOptionalNativeModule<NativeBackgroundDownloadsModule>");
    expect(bridge).toContain('"BackgroundDownloads"');
  });
});
