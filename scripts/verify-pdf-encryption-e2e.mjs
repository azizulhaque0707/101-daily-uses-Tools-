/* eslint-disable */
/**
 * End-to-end proof that the PDF encryption really works.
 *
 * Encrypts a document using pdf-security.ts, then asks PDF.js — a completely
 * independent PDF engine — to open it with the password and extract text.
 * This is the same library that powers Firefox's viewer, so success here means
 * real PDF readers will accept the file.
 *
 * Usage: node scripts/verify-pdf-encryption-e2e.mjs
 */
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFHexString, PDFString, PDFRawStream, PDFArray } from "pdf-lib";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ts = await import("typescript");
const source = fs.readFileSync(path.join(process.cwd(), "src/lib/processing/pdf-security.ts"), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const body = transpiled.replace(/^var pdf_lib_1 = require\("pdf-lib"\);$/m, "");
const security = {};
new Function("require", "module", "exports", `${body}\nmodule.exports = { md5, rc4, computePermissions, buildSecurityHandler, encryptWithKey, toHex };`)(
  (name) => (name === "pdf-lib" ? { PDFRawStream } : require(name)),
  security,
  security,
);

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function encryptDocument(userPassword, ownerPassword, method, permissionOptions, text) {
  const source = await PDFDocument.create();
  const page = source.addPage([400, 260]);
  page.drawText(text, { x: 40, y: 140, size: 16 });
  page.drawRectangle({ x: 30, y: 30, width: 140, height: 80 });
  const sourceBytes = await source.save();

  const doc = await PDFDocument.load(sourceBytes);
  const ctx = doc.context;
  const id = security.toHex(security.rc4(new Uint8Array(16), new TextEncoder().encode(path.basename(process.argv[1])))).slice(0, 0) || null;
  const fileId = crypto.getRandomValues(new Uint8Array(16));
  const permissions = security.computePermissions(permissionOptions);
  const handler = security.buildSecurityHandler(userPassword, ownerPassword, permissions, method, fileId);
  const keyLength = handler.lengthBits / 8;

  let streams = 0;
  let strings = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    // Strings must be swapped for a PDFHexString inside their parent, since
    // encrypted bytes are arbitrary binary and cannot live in a literal string.
    const replacements = [];
    const collect = (node, parent, depth = 0) => {
      if (node == null || depth > 24) return;
      if (node instanceof PDFRawStream) { replacements.push({ target: node }); return; }
      if (node instanceof PDFString || node instanceof PDFHexString) {
        if (parent) replacements.push({ target: node, parent });
        return;
      }
      if (node instanceof PDFDict) {
        for (const [key, value] of node.entries()) collect(value, { dict: node, key }, depth + 1);
        return;
      }
      if (node instanceof PDFArray) {
        node.asArray().forEach((value, index) => collect(value, { array: node, index }, depth + 1));
      }
    };
    collect(obj, null);

    for (const { target, parent } of replacements) {
      if (target instanceof PDFRawStream) {
        const cipher = await security.encryptWithKey(handler.key, ref.objectNumber, ref.generationNumber, handler.cipher, keyLength, target.contents);
        target.contents = cipher;
        target.dict.set(PDFName.of("Length"), PDFNumber.of(cipher.length));
        streams += 1;
      } else if (parent) {
        const plain = new TextEncoder().encode(target.value);
        const cipher = await security.encryptWithKey(handler.key, ref.objectNumber, ref.generationNumber, handler.cipher, keyLength, plain);
        const hexString = PDFHexString.of(security.toHex(cipher));
        if (parent.dict) parent.dict.set(parent.key, hexString);
        else if (parent.array) parent.array.set(parent.index, hexString);
        strings += 1;
      }
    }
  }

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
    encryptDict.set(PDFName.of("StmF"), PDFName.of("StdCF"));
    encryptDict.set(PDFName.of("StrF"), PDFName.of("StdCF"));
    const stdCF = ctx.obj({
      CFM: PDFName.of(handler.cipher === "aes" ? "AESV2" : "V2"),
      Length: PDFNumber.of(handler.lengthBits / 8),
    });
    const cf = ctx.obj({});
    cf.set(PDFName.of("StdCF"), stdCF);
    encryptDict.set(PDFName.of("CF"), cf);
    encryptDict.set(PDFName.of("EncryptMetadata"), PDFName.of("True"));
  }
  const encryptRef = ctx.register(encryptDict);
  ctx.trailerInfo.Encrypt = encryptRef;
  const idArray = PDFArray.withContext(ctx);
  idArray.push(PDFHexString.of(security.toHex(fileId)));
  ctx.trailerInfo.ID = idArray;

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, handler, permissions, fileId, streams, strings };
}

// Load pdf.js the way the browser app does.
async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

async function tryOpen(bytes, password) {
  const pdfjs = await loadPdfjs();
  let doc = null;
  let task = null;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      password,
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: path.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/") + path.sep,
    });
    doc = await task.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ").trim();
    const numPages = doc.numPages;
    return { ok: true, text, numPages, error: null };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200), text: "", numPages: 0 };
  } finally {
    try {
      if (task?.destroy) await task.destroy();
      else if (doc?.destroy) await doc.destroy();
    } catch {
      /* cleanup is best-effort */
    }
  }
}

const PERMISSIONS = {
  print: true, modify: false, copy: true, annotate: false,
  fillForms: true, accessibility: true, assemble: false, highQualityPrint: false,
};

console.log("\nRC4-128 (V2/R3) — the most widely compatible option");
const rc4 = await encryptDocument("correct horse", "owner-secret", "RC4-128", PERMISSIONS, "SECRET PAYLOAD RC4");
fs.writeFileSync("/tmp/enc-rc4.pdf", rc4.bytes);
console.log(`  encrypted: ${rc4.streams} streams, ${rc4.strings} strings, ${rc4.bytes.length} bytes`);

const opened = await tryOpen(rc4.bytes, "correct horse");
check("pdf.js opens it with the correct password", opened.ok, opened.ok ? `pages=${opened.numPages}` : opened.error);
check(
  "pdf.js extracts the original text after decrypting",
  opened.ok && opened.text.includes("SECRET PAYLOAD RC4"),
  JSON.stringify(opened.text),
);

const wrongPassword = await tryOpen(rc4.bytes, "not the password");
check("pdf.js rejects a wrong password", !wrongPassword.ok, wrongPassword.ok ? "opened!" : wrongPassword.error);

const noPassword = await tryOpen(rc4.bytes, "");
check("pdf.js rejects an empty password", !noPassword.ok, noPassword.ok ? "opened!" : noPassword.error);

console.log("\nAES-128 (V4/R4)");
const aes = await encryptDocument("aespass", "", "AES-128", PERMISSIONS, "SECRET PAYLOAD AES");
fs.writeFileSync("/tmp/enc-aes.pdf", aes.bytes);
const openedAes = await tryOpen(aes.bytes, "aespass");
check("pdf.js opens AES-128 with the correct password", openedAes.ok, openedAes.ok ? `pages=${openedAes.numPages}` : openedAes.error);
check(
  "pdf.js extracts AES-128 text",
  openedAes.ok && openedAes.text.includes("SECRET PAYLOAD AES"),
  JSON.stringify(openedAes.text),
);

console.log("\nControl: the same document without encryption");
const plain = await PDFDocument.create();
plain.addPage([400, 260]).drawText("SECRET PAYLOAD PLAIN", { x: 40, y: 140, size: 16 });
const plainBytes = await plain.save();
const openedPlain = await tryOpen(plainBytes, "");
check("control document opens and extracts text", openedPlain.ok && openedPlain.text.includes("SECRET PAYLOAD PLAIN"), JSON.stringify({ ok: openedPlain.ok, text: openedPlain.text, error: openedPlain.error }));

console.log(failures === 0 ? "\nPDF encryption verified end-to-end by an independent engine" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
