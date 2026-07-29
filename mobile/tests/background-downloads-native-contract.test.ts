import { describe, expect, test } from "bun:test";

const coordinator = await Bun.file(
  new URL(
    "../modules/background-downloads/ios/BackgroundDownloadCoordinator.swift",
    import.meta.url,
  ),
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

  test("migrates transfer generations into the existing SQLite table", () => {
    expect(database).toContain(
      "ALTER TABLE downloads ADD COLUMN transferToken TEXT",
    );
    expect(database).toContain(
      "audioPath, coverPath, lyricsPath, transferToken, updatedAt",
    );
  });
});
