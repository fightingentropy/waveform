import { describe, expect, test } from "bun:test";
import { tintFromArtworkUri, toBackgroundTint } from "../src/lib/artwork-tint";

describe("artwork tint", () => {
  test("is stable for one cover and varies across covers", () => {
    const first = tintFromArtworkUri("https://example.com/cover-a.jpg");
    expect(tintFromArtworkUri("https://example.com/cover-a.jpg")).toBe(first);
    expect(tintFromArtworkUri("https://example.com/cover-b.jpg")).not.toBe(first);
    expect(first).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("darkens bright colors while leaving dark colors unchanged", () => {
    expect(toBackgroundTint("#ffffff")).toBe("#555555");
    expect(toBackgroundTint("#102030")).toBe("#102030");
  });
});
