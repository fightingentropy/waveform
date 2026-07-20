import { describe, expect, test } from "bun:test";
import { resolveDeezerDecryptionId, looksLikeAudio } from "../src/lib/deezer-decrypt";

describe("deezer decrypt helpers", () => {
  test("resolve id from cdn url", () => {
    const url = "https://cdnt-stream.dzcdn.net/media/1/9/7/5/4/884037/abc.flac?x=1";
    expect(resolveDeezerDecryptionId(url, 0)).toBe(884037);
  });
  test("looksLikeAudio fLaC", () => {
    expect(looksLikeAudio(Buffer.from("fLaCxxxx"))).toBe(true);
    expect(looksLikeAudio(Buffer.from("garbage!"))).toBe(false);
  });
});
