import { describe, expect, test } from "bun:test";
import { sniffUploadFile, sniffUploadMediaBytes } from "../src/lib/upload-media-sniff";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("upload media signature validation", () => {
  test.each([
    [new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image", ".jpg"],
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image", ".png"],
    [bytes("GIF89a"), "image", ".gif"],
    [bytes("RIFF0000WEBP"), "image", ".webp"],
    [bytes("fLaC"), "audio", ".flac"],
    [bytes("RIFF0000WAVE"), "audio", ".wav"],
    [bytes("FORM0000AIFF"), "audio", ".aiff"],
    [bytes("OggS0000OpusHead"), "audio", ".opus"],
    [bytes("0000ftypM4A "), "audio", ".m4a"],
    [bytes("ID3"), "audio", ".mp3"],
    [new Uint8Array([0xff, 0xf1, 0x50, 0x80]), "audio", ".aac"],
    [new Uint8Array([0xff, 0xfb, 0x90, 0x64]), "audio", ".mp3"],
  ] as const)("recognizes %# from bytes", (input, kind, extension) => {
    expect(sniffUploadMediaBytes(input)).toMatchObject({ kind, extension });
  });

  test("rejects executable text even when a client labels it as media", async () => {
    const fakeImage = new File(["<script>alert(1)</script>"], "cover.jpg", { type: "image/jpeg" });
    const fakeAudio = new File(["not audio"], "song.mp3", { type: "audio/mpeg" });

    expect(await sniffUploadFile(fakeImage, "image")).toBeNull();
    expect(await sniffUploadFile(fakeAudio, "audio")).toBeNull();
  });

  test("rejects a valid signature when the endpoint expects the other media kind", async () => {
    const image = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "song.mp3", { type: "audio/mpeg" });
    expect(await sniffUploadFile(image, "audio")).toBeNull();
  });
});
