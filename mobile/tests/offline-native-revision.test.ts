import { describe, expect, test } from "bun:test";
import { NativeDownloadRevisionGate, nativeTransferIdentity } from "../src/lib/offline-native-revision";

describe("native download revision gate", () => {
  test("drops stale revisions and cancelled transfers", () => {
    const gate = new NativeDownloadRevisionGate();
    expect(nativeTransferIdentity("a", "t1")).toBe("a\u0000t1");
    expect(gate.shouldApply("song", "tok", 1)).toBe(true);
    expect(gate.knownRevision("song", "tok")).toBe(-1);
    gate.record("song", "tok", 3);
    expect(gate.knownRevision("song", "tok")).toBe(3);
    expect(gate.shouldApply("song", "tok", 2)).toBe(false);
    expect(gate.shouldApply("song", "tok", 3)).toBe(true);
    gate.cancel("song", "tok");
    expect(gate.shouldApply("song", "tok", 4)).toBe(false);
    gate.clearCancel("song", "tok");
    expect(gate.shouldApply("song", "tok", 4)).toBe(true);
  });
});
