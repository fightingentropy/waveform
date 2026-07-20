import { describe, expect, test } from "bun:test";
import { encryptSpotByeEnvelope, decryptSpotByeEnvelope, isSpotByeEnvelopeHost } from "../src/lib/spotbye-envelope";

describe("spotbye envelope", () => {
  test("host detection", () => {
    expect(isSpotByeEnvelopeHost("https://tdl-a.spotbye.qzz.io/api/dl")).toBe(true);
    expect(isSpotByeEnvelopeHost("https://qbz-foss.spotbye.qzz.io/api/dl")).toBe(false);
    expect(isSpotByeEnvelopeHost("https://amz-x.spotbye.qzz.io/api/dl")).toBe(false);
  });
  test("encrypt produces ver=2 wire", async () => {
    const { wire } = await encryptSpotByeEnvelope({ id: "1", quality: "16" });
    expect(wire[0]).toBe(2);
    expect(wire.byteLength).toBeGreaterThan(110);
  });
});
