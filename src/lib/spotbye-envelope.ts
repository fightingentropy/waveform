// SpotBye Next secure envelope (ver=2): ECDH P-256 + HKDF-SHA256 + AES-256-GCM.
// Matches SpotiFLAC-Next / spotiflac-cli internal/community/envelope.go.

const ENVELOPE_VERSION = 2;
const ENVELOPE_INFO_REQ = "spotiflac-req-v2";
const ENVELOPE_INFO_RESP = "spotiflac-resp-v2";
const ENVELOPE_MIN_LENGTH = 1 + 65 + 16 + 12 + 16;
const SERVER_PUB_B64 =
  "BNV5TIGu2QTUN+bPqd4CAHiqDedLaixISDpxko/h6Q8e6vaeskKkfECeYJ2n6UehSbHxUjfLz4hUebG5w8HcBzg=";
const API_TOKEN = ["padlock-", "unified-", "attractor-", "ovary-", "letdown"].join("");

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importServerPublicKey(): Promise<CryptoKey> {
  const raw = b64ToBytes(SERVER_PUB_B64);
  return crypto.subtle.importKey("raw", bytesToArrayBuffer(raw), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function deriveAesKey(sharedSecret: ArrayBuffer, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytesToArrayBuffer(salt),
      info: bytesToArrayBuffer(new TextEncoder().encode(info)),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type SpotByeEnvelopeBody = Record<string, unknown>;

export async function encryptSpotByeEnvelope(body: SpotByeEnvelopeBody): Promise<{
  wire: Uint8Array;
  privateKey: CryptoKey;
}> {
  const serverPub = await importServerPublicKey();
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: serverPub }, eph.privateKey, 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(shared, salt, ENVELOPE_INFO_REQ);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      token: API_TOKEN,
      body,
      ts: Math.floor(Date.now() / 1000),
    }),
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytesToArrayBuffer(nonce) }, key, plaintext),
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const wire = concatBytes(new Uint8Array([ENVELOPE_VERSION]), pubRaw, salt, nonce, sealed);
  return { wire, privateKey: eph.privateKey };
}

export async function decryptSpotByeEnvelope(wire: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array> {
  if (wire.byteLength < ENVELOPE_MIN_LENGTH) {
    throw new Error("secure envelope too short");
  }
  if (wire[0] !== ENVELOPE_VERSION) {
    throw new Error(`unsupported secure envelope version ${wire[0]}`);
  }
  const peerPub = await crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(wire.subarray(1, 66)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, privateKey, 256);
  const salt = wire.subarray(66, 82);
  const nonce = wire.subarray(82, 94);
  const ct = wire.subarray(94);
  const key = await deriveAesKey(shared, salt, ENVELOPE_INFO_RESP);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(nonce) },
    key,
    bytesToArrayBuffer(ct),
  );
  return new Uint8Array(plain);
}

/** True for lettered SpotBye Next `/api/dl` hosts that expect the encrypted envelope. */
export function isSpotByeEnvelopeHost(endpointUrl: string): boolean {
  try {
    const url = new URL(endpointUrl);
    return /^(?:tdl|qbz|amz|dzr)-[a-e]\.spotbye\.qzz\.io$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export async function postSpotByeEnvelope(
  endpointUrl: string,
  body: SpotByeEnvelopeBody,
  options?: { userAgent?: string; timeoutMs?: number },
): Promise<{ status: number; text: string; headers: Headers }> {
  const { wire, privateKey } = await encryptSpotByeEnvelope(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 30_000);
  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/octet-stream, application/json, */*",
        "content-type": "application/octet-stream",
        "user-agent": options?.userAgent || "spotify/1.0 (+https://music.streamarena.xyz)",
      },
      body: bytesToArrayBuffer(wire),
    });
    const raw = new Uint8Array(await response.arrayBuffer());
    // Some error paths still return JSON plaintext.
    const looksJson =
      raw.byteLength > 0 && (raw[0] === 0x7b || raw[0] === 0x5b); // { or [
    if (looksJson || response.status === 429 || response.status === 503) {
      return {
        status: response.status,
        text: new TextDecoder().decode(raw),
        headers: response.headers,
      };
    }
    if (!response.ok) {
      return {
        status: response.status,
        text: new TextDecoder().decode(raw),
        headers: response.headers,
      };
    }
    const plain = await decryptSpotByeEnvelope(raw, privateKey);
    return {
      status: response.status,
      text: new TextDecoder().decode(plain),
      headers: response.headers,
    };
  } finally {
    clearTimeout(timer);
  }
}
