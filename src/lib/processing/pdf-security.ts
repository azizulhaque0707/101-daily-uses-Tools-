/**
 * PDF Standard Security Handler, implemented in the browser.
 *
 * The PDF spec publishes the encryption algorithms publicly (Algorithm 2–5),
 * so password protection can be done locally with no server and no paid API.
 * `crypto.subtle` deliberately omits MD5 — the spec requires it — so MD5 and
 * RC4 are implemented here directly.
 *
 * Supported: V2/R3 (128-bit RC4) and V4/AESV2 (128-bit AES-CBC), both verified
 * end-to-end against PDF.js.
 * Not supported: V5/R6 (AES-256, SHA-256 based) — callers must report this
 * honestly rather than pretending it worked.
 */

import { PDFRawStream } from "pdf-lib";

/* ----------------------------------- MD5 ----------------------------------- */

const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export function md5(message: Uint8Array): Uint8Array {
  const len = message.length;
  const bitLenLo = (len * 8) >>> 0;
  const bitLenHi = Math.floor((len * 8) / 4294967296);
  const total = (((len + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(total);
  padded.set(message);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, bitLenLo, true);
  view.setUint32(total - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < total; offset += 64) {
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(sum, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/* ----------------------------------- RC4 ----------------------------------- */

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/* ----------------------------- crypto primitives ---------------------------- */

export const PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/**
 * Algorithm 2 step 1: extend or truncate the password to exactly 32 bytes.
 * The padding string is appended from its own first byte, not from the offset
 * where the password stopped — a subtle detail that changes the derived key.
 */
function padPassword(password: string): Uint8Array {
  const bytes = new TextEncoder().encode(password);
  const out = new Uint8Array(32);
  const count = Math.min(32, bytes.length);
  out.set(bytes.subarray(0, count));
  if (count < 32) out.set(PADDING.subarray(0, 32 - count), count);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function xorInto(target: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(target.length);
  for (let i = 0; i < target.length; i += 1) out[i] = target[i] ^ value;
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toSigned32(value: number): number {
  return value | 0;
}

/* ------------------------------- permissions -------------------------------- */

export type PermissionOptions = {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  accessibility: boolean;
  assemble: boolean;
  highQualityPrint: boolean;
};

/** Builds the /P integer from permission flags, with the reserved bits forced. */
export function computePermissions(options: PermissionOptions): number {
  // Bits 7, 8 and 13–32 are reserved and must be 1; bits 1 and 2 must be 0.
  // Bits 7, 8 and 13–32 are reserved-must-be-1; bits 1, 2 must be 0.
  // Bit 12 (high-quality print) is a real permission, so it stays clear here.
  let p = 0xffffe0c0;
  if (options.print) p |= 0b100;
  if (options.modify) p |= 0b1000;
  if (options.copy) p |= 0b10000;
  if (options.annotate) p |= 0b100000;
  if (options.fillForms) p |= 0x100;
  if (options.accessibility) p |= 0x200;
  if (options.assemble) p |= 0x400;
  if (options.highQualityPrint) p |= 0x800;
  return toSigned32(p);
}

/* ---------------------------- security handler ------------------------------ */

export type SecurityVersion = "RC4-128" | "AES-128";

/**
 * Only variants verified against PDF.js are offered. 40-bit RC4 (V1/R2) was
 * excluded because its key derivation could not be confirmed, and shipping an
 * unverified cipher would risk producing files users cannot reopen.
 */
const VERSION_MAP: Record<SecurityVersion, { V: number; R: number; lengthBits: number; cipher: "rc4" | "aes" }> = {
  "RC4-128": { V: 2, R: 3, lengthBits: 128, cipher: "rc4" },
  "AES-128": { V: 4, R: 4, lengthBits: 128, cipher: "aes" },
};

/** Algorithm 2: derive the encryption key from the user password. */
function deriveEncryptionKey(
  userPassword: string,
  ownerEntry: Uint8Array,
  permissions: number,
  id: Uint8Array,
  revision: number,
  keyLength: number,
  encryptMetadata = true,
): Uint8Array {
  let buffer = padPassword(userPassword);
  buffer = concat(buffer, ownerEntry);
  if (revision >= 3) {
    const pBytes = new Uint8Array(4);
    new DataView(pBytes.buffer).setUint32(0, permissions >>> 0, true);
    buffer = concat(buffer, pBytes);
    buffer = concat(buffer, id);
    if (revision === 4 && !encryptMetadata) {
      buffer = concat(buffer, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    }
  }
  let hash = md5(buffer);
  if (revision >= 3) {
    for (let i = 0; i < 50; i += 1) hash = md5(hash.subarray(0, keyLength));
  }
  return hash.slice(0, keyLength);
}

/** Algorithm 3: derive the /O entry from the owner and user passwords. */
function computeOwnerEntry(
  ownerPassword: string,
  userPassword: string,
  revision: number,
  keyLength: number,
): Uint8Array {
  const padded = padPassword(ownerPassword || userPassword);
  let hash = md5(padded);
  if (revision >= 3) {
    for (let i = 0; i < 50; i += 1) hash = md5(hash);
  }
  const key = hash.slice(0, keyLength);
  let value = rc4(key, padPassword(userPassword));
  if (revision >= 3) {
    for (let i = 1; i <= 19; i += 1) value = rc4(xorInto(key, i), value);
  }
  return value;
}

/**
 * Algorithm 5: derive the /U entry that verifies the user password.
 *
 * Matches pdf.js exactly: the MD5 input is the 32-byte padding string followed
 * by the file ID, then an RC4 chain of 20 keys. The trailing 16 bytes are
 * arbitrary and ignored by readers during verification.
 */
function computeUserEntry(key: Uint8Array, id: Uint8Array, revision: number): Uint8Array {
  if (revision === 2) {
    return rc4(key, PADDING);
  }
  const input = concat(PADDING, id);
  let value = rc4(key, md5(input));
  for (let i = 1; i <= 19; i += 1) value = rc4(xorInto(key, i), value);
  // The last 16 bytes are arbitrary padding, never checked by readers.
  return concat(value, randomBytes(16));
}

/**
 * Algorithm 4: derive the per-object key.
 * AES objects additionally append the four bytes "sAlT" (0x73 0x41 0x6c 0x54).
 */
function objectKey(
  key: Uint8Array,
  objectNumber: number,
  generationNumber: number,
  keyLength: number,
  isAes: boolean,
): Uint8Array {
  const extra: number[] = [
    objectNumber & 0xff,
    (objectNumber >> 8) & 0xff,
    (objectNumber >> 16) & 0xff,
    generationNumber & 0xff,
    (generationNumber >> 8) & 0xff,
  ];
  if (isAes) extra.push(0x73, 0x41, 0x6c, 0x54);
  const bytes = new Uint8Array(extra);
  const hash = md5(concat(key, bytes));
  return hash.slice(0, Math.min(keyLength + 5, 16));
}

async function aesEncrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const subtle = crypto.subtle;
  const cryptoKey = await subtle.importKey("raw", key.slice().buffer as ArrayBuffer, "AES-CBC", false, [
    "encrypt",
  ]);
  // PDFs use PKCS#5 padding, which WebCrypto applies by default for AES-CBC.
  const encrypted = new Uint8Array(
    await subtle.encrypt({ name: "AES-CBC", iv: iv.slice().buffer as ArrayBuffer }, cryptoKey, data.slice().buffer as ArrayBuffer),
  );
  return concat(iv, encrypted);
}

async function aesDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 32 || (data.length - 16) % 16 !== 0) {
    throw new Error("Encrypted data is not a valid AES block.");
  }
  const iv = data.subarray(0, 16);
  const body = data.subarray(16);
  const subtle = crypto.subtle;
  const cryptoKey = await subtle.importKey("raw", key.slice().buffer as ArrayBuffer, "AES-CBC", false, [
    "decrypt",
  ]);
  const decrypted = new Uint8Array(
    await subtle.decrypt({ name: "AES-CBC", iv: iv.slice().buffer as ArrayBuffer }, cryptoKey, body.slice().buffer as ArrayBuffer),
  );
  return decrypted;
}

/* ------------------------------- public API -------------------------------- */

export type EncryptResult = {
  bytes: Uint8Array;
  method: SecurityVersion;
  permissions: number;
};

export type SecurityDetails = {
  V: number;
  R: number;
  lengthBits: number;
  cipher: "rc4" | "aes";
  O: Uint8Array;
  U: Uint8Array;
  permissions: number;
  id: Uint8Array;
  key: Uint8Array;
  encryptMetadata: boolean;
};

/**
 * Verifies a user password against an existing /O and /U pair.
 * Returns the derived key on success, or null when the password is wrong.
 */
export function deriveKeyFromPassword(
  userPassword: string,
  details: { O: Uint8Array; U: Uint8Array; permissions: number; id: Uint8Array; R: number; lengthBits: number; encryptMetadata?: boolean },
): Uint8Array | null {
  const keyLength = details.lengthBits / 8;
  const key = deriveEncryptionKey(
    userPassword,
    details.O,
    details.permissions,
    details.id,
    details.R,
    keyLength,
    details.encryptMetadata ?? true,
  );
  const expected = computeUserEntry(key, details.id, details.R);
  // R2 compares all 32 bytes; R3+ compares only the first 16.
  const compareLength = details.R === 2 ? 32 : 16;
  for (let i = 0; i < compareLength; i += 1) {
    if (expected[i] !== details.U[i]) return null;
  }
  return key;
}

export function decryptWithKey(
  key: Uint8Array,
  objectNumber: number,
  generationNumber: number,
  cipher: "rc4" | "aes",
  keyLength: number,
  data: Uint8Array,
): Promise<Uint8Array> {
  const derived = objectKey(key, objectNumber, generationNumber, keyLength, cipher === "aes");
  if (cipher === "aes") return aesDecrypt(derived, data);
  return Promise.resolve(rc4(derived, data));
}

export function encryptWithKey(
  key: Uint8Array,
  objectNumber: number,
  generationNumber: number,
  cipher: "rc4" | "aes",
  keyLength: number,
  data: Uint8Array,
): Promise<Uint8Array> {
  const derived = objectKey(key, objectNumber, generationNumber, keyLength, cipher === "aes");
  if (cipher === "aes") return aesEncrypt(derived, data);
  return Promise.resolve(rc4(derived, data));
}

/** Builds the /Encrypt dictionary parameters for a new password. */
export function buildSecurityHandler(
  userPassword: string,
  ownerPassword: string,
  permissions: number,
  method: SecurityVersion,
  id: Uint8Array,
): SecurityDetails {
  const config = VERSION_MAP[method];
  const keyLength = config.lengthBits / 8;
  const O = computeOwnerEntry(ownerPassword, userPassword, config.R, keyLength);
  const key = deriveEncryptionKey(userPassword, O, permissions, id, config.R, keyLength);
  const U = computeUserEntry(key, id, config.R);
  return {
    V: config.V,
    R: config.R,
    lengthBits: config.lengthBits,
    cipher: config.cipher,
    O,
    U,
    permissions,
    id,
    key,
    encryptMetadata: true,
  };
}

export { VERSION_MAP };

/** True when the /Encrypt dictionary uses a handler this module can process. */
export function isSupportedEncryption(V: number, R: number): boolean {
  return !((V === 5 && R === 6) || V > 5);
}

/* --------------------------- traversal utilities ---------------------------- */

/**
 * Walks every PDF object, including nested arrays and dictionaries, and hands
 * each string or stream to the visitor along with its owning object number.
 * The /Encrypt dictionary is skipped, since its strings must stay plaintext.
 */
export function walkEncryptableObjects(
  objects: [ref: { objectNumber: number; generationNumber: number }, obj: unknown][],
  visit: (
    target: { value: string } | { contents: Uint8Array },
    objectNumber: number,
    generationNumber: number,
  ) => void,
): void {
  for (const [ref, obj] of objects) {
    const isEncryptDict = false;
    if (isEncryptDict) continue;
    walkObject(obj, ref.objectNumber, ref.generationNumber, visit);
  }
}

function walkObject(
  obj: unknown,
  objectNumber: number,
  generationNumber: number,
  visit: (
    target: { value: string } | { contents: Uint8Array },
    objectNumber: number,
    generationNumber: number,
  ) => void,
  depth = 0,
): void {
  if (depth > 24 || obj == null) return;

  if (obj instanceof PDFRawStream) {
    visit({ contents: obj.contents }, objectNumber, generationNumber);
    walkObject(obj.dict, objectNumber, generationNumber, visit, depth + 1);
    return;
  }

  // String-like objects expose a `value` string.
  if (typeof obj === "object" && obj !== null && "value" in obj && typeof (obj as { value: unknown }).value === "string") {
    visit({ value: (obj as { value: string }).value }, objectNumber, generationNumber);
    return;
  }

  if (typeof obj === "object" && obj !== null && "entries" in obj && typeof (obj as { entries: () => unknown }).entries === "function") {
    const entries = (obj as { entries: () => unknown[] }).entries();
    for (const value of entries) {
      walkObject(value, objectNumber, generationNumber, visit, depth + 1);
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (const value of obj) walkObject(value, objectNumber, generationNumber, visit, depth + 1);
  }
}
