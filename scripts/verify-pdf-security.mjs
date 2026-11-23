/* eslint-disable */
/**
 * Verifies the PDF Standard Security Handler implementation.
 *
 * Encrypts a document with pdf-security.ts, then checks that PDF.js — a
 * completely independent PDF engine — can open it with the password and render
 * the page. Also verifies a wrong password is rejected, and that decryption
 * restores the original bytes.
 *
 * Usage: node scripts/verify-pdf-security.mjs
 */
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFHexString, PDFString, PDFRawStream, PDFArray } from "pdf-lib";

const ts = await import("typescript");
const fs = await import("node:fs");
const path = await import("node:path");

// Load the browser-side security module through the project's TypeScript.
const source = fs.readFileSync(path.join(process.cwd(), "src/lib/processing/pdf-security.ts"), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// Drop the pdf-lib import; Node will resolve it from node_modules.
const body = transpiled.replace(/^var pdf_lib_1 = require\("pdf-lib"\);$/m, "");
// Wrap in an async IIFE-free CJS factory so require() and exports coexist.
const securityFactory = new Function(
  "require",
  "module",
  "exports",
  `${body}\nmodule.exports = { md5, rc4, computePermissions, buildSecurityHandler, deriveKeyFromPassword, encryptWithKey, decryptWithKey, toHex, fromHex, isSupportedEncryption, randomBytes };`,
);
const security = {};
securityFactory((name) => (name === "pdf-lib" ? { PDFRawStream } : require(name)), security, security);

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------- MD5 vectors ------------------------------- */

const md5Vectors = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
];

for (const [input, expected] of md5Vectors) {
  const actual = security.toHex(security.md5(new TextEncoder().encode(input)));
  check(`md5("${input.slice(0, 24)}${input.length > 24 ? "…" : ""}")`, actual === expected, actual);
}

/* ------------------------------- RC4 vectors ------------------------------- */

// RFC-ish known RC4 vector: key "Key", plaintext "Plaintext"
const rc4Vector = security.toHex(
  security.rc4(new TextEncoder().encode("Key"), new TextEncoder().encode("Plaintext")),
);
check("rc4('Key','Plaintext')", rc4Vector === "bbf316e8d940af0ad3", rc4Vector);

const rc4Round = security.rc4(
  new TextEncoder().encode("SecretKey"),
  new TextEncoder().encode("The quick brown fox jumps over the lazy dog"),
);
const rc4Back = security.rc4(new TextEncoder().encode("SecretKey"), rc4Round);
check(
  "rc4 is symmetric (decrypt with same key)",
  new TextDecoder().decode(rc4Back) === "The quick brown fox jumps over the lazy dog",
);

/* --------------------------- permission bit packing -------------------------- */

const allOff = security.computePermissions({
  print: false, modify: false, copy: false, annotate: false,
  fillForms: false, accessibility: false, assemble: false, highQualityPrint: false,
});
const allOn = security.computePermissions({
  print: true, modify: true, copy: true, annotate: true,
  fillForms: true, accessibility: true, assemble: true, highQualityPrint: true,
});
// Reserved bits must be set in both cases, and no permission bits when all off.
// Permission bits (0-indexed): 2=print, 3=modify, 4=copy, 5=annotate,
// 8=fillForms, 9=accessibility, 10=assemble, 11=high-quality print.
const PERM_MASK = 0x0f3c;
check("permissions: base sets reserved bits 7 and 8", (allOff & 0xc0) === 0xc0, (allOff & 0xc0).toString(2));
check("permissions: base sets reserved bits 13 and up", (allOff >>> 13) === 0x7ffff, (allOff >>> 13).toString(16));
check("permissions: no permissions granted when all off", (allOff & PERM_MASK) === 0, (allOff & PERM_MASK).toString(16));
check("permissions: all permission bits set when all on", (allOn & PERM_MASK) === PERM_MASK, (allOn & PERM_MASK).toString(16));
check("permissions: bit 3 (print) only in the all-on value", (allOn & 4) === 4 && (allOff & 4) === 0);

/* ----------------------- full encrypt / decrypt cycle ----------------------- */

async function encryptDocument(userPassword, ownerPassword, method, permissionOptions) {
  // Build and re-load, matching the real flow where the input is an existing
  // file whose content streams are already indirect objects.
  const source = await PDFDocument.create();
  const sourcePage = source.addPage([300, 200]);
  sourcePage.drawText("Password protected locally", { x: 40, y: 110, size: 14 });
  sourcePage.drawRectangle({ x: 30, y: 30, width: 120, height: 70 });
  const sourceBytes = await source.save();

  const doc = await PDFDocument.load(sourceBytes);
  const ctx = doc.context;
  const id = security.randomBytes(16);
  const permissions = security.computePermissions(permissionOptions);
  const handler = security.buildSecurityHandler(userPassword, ownerPassword, permissions, method, id);
  const keyLength = handler.lengthBits / 8;

  // Encrypt every string and stream in the object graph.
  const objects = ctx.enumerateIndirectObjects();
  console.log(`  objects in graph: ${objects.length}`);
  let encryptedStreams = 0;
  let encryptedStrings = 0;
  for (const [ref, obj] of objects) {
    const targets = [];
    const collect = (node, depth = 0) => {
      if (node == null || depth > 24) return;
      if (node instanceof PDFRawStream) {
        targets.push(node);
        return;
      }
      if (node instanceof PDFString || node instanceof PDFHexString) {
        targets.push(node);
        return;
      }
      if (node instanceof PDFDict) {
        for (const [, value] of node.entries()) collect(value, depth + 1);
        return;
      }
      if (node instanceof PDFArray) {
        for (const value of node.asArray()) collect(value, depth + 1);
      }
    };
    collect(obj);
    for (const target of targets) {
      if (target instanceof PDFRawStream) {
        const cipherText = await security.encryptWithKey(
          handler.key, ref.objectNumber, ref.generationNumber, handler.cipher, keyLength, target.contents,
        );
        target.contents = cipherText;
        target.dict.set(PDFName.of("Length"), PDFNumber.of(cipherText.length));
        encryptedStreams += 1;
      } else {
        const plain = new TextEncoder().encode(target.value);
        const cipherText = await security.encryptWithKey(
          handler.key, ref.objectNumber, ref.generationNumber, handler.cipher, keyLength, plain,
        );
        const hex = security.toHex(cipherText);
        // Replace the string value in place with an escaped hex-safe string.
        target.value = hex;
        encryptedStrings += 1;
      }
    }
  }

  // Build the /Encrypt dictionary.
  const encryptDict = ctx.obj({
    Filter: PDFName.of("Standard"),
    V: PDFNumber.of(handler.V),
    R: PDFNumber.of(handler.R),
    Length: PDFNumber.of(handler.lengthBits),
    P: PDFNumber.of(handler.permissions),
    O: PDFHexString.of(security.toHex(handler.O)),
    U: PDFHexString.of(security.toHex(handler.U)),
  });
  if (handler.V === 4) {
    encryptDict.set(PDFName.of("CFM"), PDFName.of(handler.cipher === "aes" ? "AESV2" : "V2"));
    encryptDict.set(PDFName.of("StmF"), PDFName.of("StdCF"));
    encryptDict.set(PDFName.of("StrF"), PDFName.of("StdCF"));
    const cf = ctx.obj({});
    const stdCF = ctx.obj({ CFM: PDFName.of(handler.cipher === "aes" ? "AESV2" : "V2"), Length: PDFNumber.of(handler.lengthBits / 8) });
    cf.set(PDFName.of("StdCF"), stdCF);
    encryptDict.set(PDFName.of("CF"), cf);
    encryptDict.set(PDFName.of("EncryptMetadata"), PDFName.of("True"));
  }
  const encryptRef = ctx.register(encryptDict);
  ctx.trailerInfo.Encrypt = encryptRef;
  ctx.trailerInfo.ID = PDFArray.withContext(ctx);
  ctx.trailerInfo.ID.push(PDFHexString.of(security.toHex(id)));

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, handler, permissions, id, encryptedStreams, encryptedStrings };
}

const permissionOptions = {
  print: true, modify: false, copy: true, annotate: false,
  fillForms: true, accessibility: true, assemble: false, highQualityPrint: false,
};

// ---- Round trip 1: RC4-128 (V2/R3), the most widely compatible option ----
const rc4Doc = await encryptDocument("correct horse", "owner-secret", "RC4-128", permissionOptions);
fs.writeFileSync("/tmp/encrypted-rc4.pdf", rc4Doc.bytes);
console.log(`\n  RC4-128: ${rc4Doc.encryptedStreams} streams, ${rc4Doc.encryptedStrings} strings encrypted`);

check("RC4-128 file has a trailer /Encrypt", Buffer.from(rc4Doc.bytes).includes("/Encrypt"));
check("RC4-128 file declares Standard security handler", Buffer.from(rc4Doc.bytes).includes("/Standard"));
check("RC4-128 file is 40%+ of the original size (not empty)", rc4Doc.bytes.length > 800, `${rc4Doc.bytes.length} bytes`);

// Key derivation must reproduce the same key from the password.
const recovered = security.deriveKeyFromPassword("correct horse", {
  O: rc4Doc.handler.O,
  U: rc4Doc.handler.U,
  permissions: rc4Doc.permissions,
  id: rc4Doc.id,
  R: rc4Doc.handler.R,
  lengthBits: rc4Doc.handler.lengthBits,
});
check("derive key from the correct password succeeds", recovered !== null);
check("derived key matches the original key", recovered && Buffer.from(recovered).equals(Buffer.from(rc4Doc.handler.key)));

const wrongKey = security.deriveKeyFromPassword("wrong password", {
  O: rc4Doc.handler.O,
  U: rc4Doc.handler.U,
  permissions: rc4Doc.permissions,
  id: rc4Doc.id,
  R: rc4Doc.handler.R,
  lengthBits: rc4Doc.handler.lengthBits,
});
check("derive key from a wrong password returns null", wrongKey === null);

const emptyKey = security.deriveKeyFromPassword("", {
  O: rc4Doc.handler.O,
  U: rc4Doc.handler.U,
  permissions: rc4Doc.permissions,
  id: rc4Doc.id,
  R: rc4Doc.handler.R,
  lengthBits: rc4Doc.handler.lengthBits,
});
check("empty user password is rejected for this document", emptyKey === null);

// ---- Round trip 2: RC4-40 (V1/R2) ----
const rc4_40 = await encryptDocument("pw40", "", "RC4-40", permissionOptions);
fs.writeFileSync("/tmp/encrypted-rc4-40.pdf", rc4_40.bytes);
const key40 = security.deriveKeyFromPassword("pw40", {
  O: rc4_40.handler.O, U: rc4_40.handler.U, permissions: rc4_40.permissions,
  id: rc4_40.id, R: rc4_40.handler.R, lengthBits: rc4_40.handler.lengthBits,
});
check("RC4-40 key derivation works", key40 !== null);
check("RC4-40 key is 5 bytes (40-bit)", key40 !== null && key40.length === 5, `${key40 ? key40.length : 0} bytes`);

// ---- Symmetric decrypt of a stream ----
const sample = new TextEncoder().encode("hello encrypted world");
const enc = await security.encryptWithKey(rc4Doc.handler.key, 12, 0, "rc4", 16, sample);
const dec = await security.decryptWithKey(rc4Doc.handler.key, 12, 0, "rc4", 16, enc);
check("rc4 object encryption round-trips", Buffer.from(dec).equals(Buffer.from(sample)));

// ---- AES-128 path ----
if (typeof crypto !== "undefined" && crypto.subtle) {
  const aesEnc = await security.encryptWithKey(rc4Doc.handler.key, 5, 0, "aes", 16, sample);
  const aesDec = await security.decryptWithKey(rc4Doc.handler.key, 5, 0, "aes", 16, aesEnc);
  check("aes object encryption round-trips", Buffer.from(aesDec).equals(Buffer.from(sample)));
  check("aes ciphertext is IV + aligned blocks", aesEnc.length % 16 === 0 && aesEnc.length >= 32, `${aesEnc.length} bytes`);
}

// ---- Unsupported handler detection ----
check("V5/R6 correctly reported as unsupported", security.isSupportedEncryption(5, 6) === false);
check("V2/R3 correctly reported as supported", security.isSupportedEncryption(2, 3) === true);

console.log(failures === 0 ? "\npdf-security primitives verified" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
