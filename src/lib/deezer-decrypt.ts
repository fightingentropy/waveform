// Deezer BF-CBC stripe decrypt — matches SpotiFLAC-Next / spotiflac-cli.
// Only needed on the Mac mini (Node/Bun); Worker always materializes Deezer there.

import { createHash, createDecipheriv } from "node:crypto";

const SECRET = Buffer.from("g4el58wc0zvf9na1", "utf8");
const CBC_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const CHUNK = 2048;

export function resolveDeezerDecryptionId(streamUrl: string, fallback = 0): number {
  let path = streamUrl;
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  const segs = path.split("/");
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const n = Number(segs[i]);
    if (Number.isFinite(n) && n > 0 && String(Math.trunc(n)) === segs[i]) {
      return Math.trunc(n);
    }
  }
  return fallback > 0 ? fallback : 0;
}

function decryptKey(trackId: number): Buffer {
  const md5hex = createHash("md5").update(String(trackId), "utf8").digest("hex");
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    key[i] = md5hex.charCodeAt(i) ^ md5hex.charCodeAt(i + 16) ^ SECRET[i]!;
  }
  return key;
}

/** Decrypts in place (mutates `data`). Every 3rd 2048-byte chunk is BF-CBC. */
export function decryptDeezerChunks(data: Buffer, trackId: number): void {
  const key = decryptKey(trackId);
  const nChunks = Math.floor(data.byteLength / CHUNK);
  for (let i = 0; i < nChunks; i += 1) {
    if (i % 3 !== 0) continue;
    const slice = data.subarray(i * CHUNK, (i + 1) * CHUNK);
    // OpenSSL 3 may require legacy provider for Blowfish; Bun typically still supports bf-cbc.
    const decipher = createDecipheriv("bf-cbc", key, CBC_IV);
    decipher.setAutoPadding(false);
    const out = Buffer.concat([decipher.update(slice), decipher.final()]);
    out.copy(slice);
  }
}

export function looksLikeAudio(bytes: Buffer): boolean {
  if (bytes.byteLength < 4) return false;
  if (bytes.subarray(0, 4).toString("ascii") === "fLaC") return true;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return true;
  if (bytes.byteLength >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return true;
  return false;
}

export function maybeDecryptDeezerBuffer(
  data: Buffer,
  streamUrl: string,
  fallbackId = 0,
): Buffer {
  const id = resolveDeezerDecryptionId(streamUrl, fallbackId);
  if (!id) return data;
  const copy = Buffer.from(data);
  try {
    decryptDeezerChunks(copy, id);
  } catch {
    return data;
  }
  return looksLikeAudio(copy) ? copy : data;
}
