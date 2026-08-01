export type UploadMediaKind = "audio" | "image";

export type SniffedUploadMedia = {
  kind: UploadMediaKind;
  extension: string;
  contentType: string;
};

const MAX_SNIFF_BYTES = 4 * 1024;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

/**
 * Identifies the small, explicitly supported set of upload formats from file
 * signatures. Names and client-provided MIME types are intentionally ignored.
 */
export function sniffUploadMediaBytes(bytes: Uint8Array): SniffedUploadMedia | null {
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") {
    return { kind: "audio", extension: ".flac", contentType: "audio/flac" };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return { kind: "audio", extension: ".wav", contentType: "audio/wav" };
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "FORM" &&
    (ascii(bytes, 8, 4) === "AIFF" || ascii(bytes, 8, 4) === "AIFC")
  ) {
    return { kind: "audio", extension: ".aiff", contentType: "audio/aiff" };
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") {
    const header = ascii(bytes, 0, Math.min(bytes.length, 128));
    return header.includes("OpusHead")
      ? { kind: "audio", extension: ".opus", contentType: "audio/opus" }
      : { kind: "audio", extension: ".ogg", contentType: "audio/ogg" };
  }
  if (bytes.length >= 8 && ascii(bytes, 4, 4) === "ftyp") {
    return { kind: "audio", extension: ".m4a", contentType: "audio/mp4" };
  }
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") {
    return { kind: "audio", extension: ".mp3", contentType: "audio/mpeg" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) {
    return { kind: "audio", extension: ".aac", contentType: "audio/aac" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0) {
    return { kind: "audio", extension: ".mp3", contentType: "audio/mpeg" };
  }

  if (bytes.length >= 3 && hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: "image", extension: ".jpg", contentType: "image/jpeg" };
  }
  if (bytes.length >= 8 && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", extension: ".png", contentType: "image/png" };
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { kind: "image", extension: ".gif", contentType: "image/gif" };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { kind: "image", extension: ".webp", contentType: "image/webp" };
  }

  return null;
}

export async function sniffUploadFile(file: Blob, expectedKind: UploadMediaKind): Promise<SniffedUploadMedia | null> {
  if (file.size <= 0) return null;
  const bytes = new Uint8Array(await file.slice(0, MAX_SNIFF_BYTES).arrayBuffer());
  const sniffed = sniffUploadMediaBytes(bytes);
  return sniffed?.kind === expectedKind ? sniffed : null;
}
