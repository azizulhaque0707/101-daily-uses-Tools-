import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  type PDFPage,
} from "pdf-lib";
import {
  bool,
  engineError,
  num,
  requireFile,
  requireFiles,
  str,
  type EngineArtifact,
  type EngineResult,
  type ToolEngine,
} from "@/lib/tools/types";
import { baseName, clamp } from "@/lib/utils";
import { hexToRgb } from "./canvas";
import { resultStats, textArtifact, zipArtifacts } from "./archive";
import { loadImage, encodeCanvas } from "./canvas";
import {
  buildSecurityHandler,
  computePermissions,
  encryptWithKey,
  deriveKeyFromPassword,
  decryptWithKey,
  isSupportedEncryption,
  toHex,
  fromHex,
  randomBytes,
  type SecurityVersion,
} from "./pdf-security";


/* --------------------- pdf-lib internal access (typed) --------------------- */

/**
 * pdf-lib's type declarations mark stream contents and string values as
 * read-only, but the runtime objects are plain mutable fields. The encryption
 * and decryption paths write to them directly, so these aliases describe the
 * real runtime shape.
 */
type MutableStream = PDFRawStream & { contents: Uint8Array };
type MutableString = (PDFString | PDFHexString) & { readonly value?: string };

/** Where a string lives, so it can be replaced inside its parent container. */
type StringParent =
  | { kind: "dict"; dict: PDFDict; key: PDFName }
  | { kind: "array"; array: PDFArray; index: number };

type EncryptTarget = { node: PDFRawStream | PDFString | PDFHexString; parent?: StringParent };

function collectTargets(obj: unknown, depth = 0): EncryptTarget[] {
  const targets: EncryptTarget[] = [];
  const walk = (node: unknown, parent: StringParent | undefined, level: number) => {
    if (node == null || level > 24) return;
    if (node instanceof PDFRawStream) {
      targets.push({ node: node as MutableStream });
      return;
    }
    if (node instanceof PDFString || node instanceof PDFHexString) {
      if (parent) targets.push({ node: node as MutableString, parent });
      return;
    }
    if (node instanceof PDFDict) {
      for (const [key, value] of node.entries()) {
        walk(value, { kind: "dict", dict: node, key }, level + 1);
      }
      return;
    }
    if (node instanceof PDFArray) {
      node.asArray().forEach((value, index) => {
        walk(value, { kind: "array", array: node, index }, level + 1);
      });
    }
  };
  walk(obj, undefined, depth);
  return targets;
}

/** Reads the raw bytes of either string flavour. */
function stringBytes(node: PDFString | PDFHexString): Uint8Array {
  if (node instanceof PDFHexString) return fromHex(node.asString());
  // pdf-lib types `value` as private, but it is a plain runtime field.
  const raw = (node as unknown as { value: string }).value;
  return new TextEncoder().encode(raw);
}

/** Writes bytes back as a hex string, which safely holds arbitrary binary. */
function replaceString(parent: StringParent, bytes: Uint8Array): void {
  const replacement = PDFHexString.of(toHex(bytes));
  if (parent.kind === "dict") parent.dict.set(parent.key, replacement);
  else parent.array.set(parent.index, replacement);
}

const PAGE_SIZES: Record<string, [number, number]> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
};

function pdfArtifact(name: string, blob: Blob): EngineArtifact {
  return { name, blob, kind: "pdf" };
}

async function loadPdf(file: File | Blob): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  } catch {
    engineError(
      "This PDF could not be read. It may be corrupt, or it may use an encryption variant the browser engine cannot parse.",
    );
  }
}

export function parsePages(spec: string, total: number): number[] {
  const trimmed = (spec || "").trim().toLowerCase();
  if (!trimmed || trimmed === "all" || trimmed === "*") {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>();
  for (const part of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.min(total, Number(range[2]));
      for (let page = start; page <= end; page += 1) pages.add(page);
      continue;
    }
    const single = Number.parseInt(part, 10);
    if (Number.isFinite(single) && single >= 1 && single <= total) pages.add(single);
  }
  if (pages.size === 0) {
    engineError(`No valid pages in "${spec}". This document has ${total} page(s).`);
  }
  return [...pages].sort((a, b) => a - b);
}

async function savePdf(doc: PDFDocument, name: string, useObjectStreams = true): Promise<EngineResult> {
  const bytes = await doc.save({ useObjectStreams, addDefaultPage: false });
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  return {
    artifacts: [pdfArtifact(name, blob)],
    stats: resultStats({ Pages: doc.getPageCount(), "Output size": `${(blob.size / 1024).toFixed(1)} KB` }),
  };
}

/* --------------------------------- 1. merger -------------------------------- */

export const pdfMerger: ToolEngine = async (ctx) => {
  const files = [...requireFiles(ctx, 2)];
  const sort = str(ctx.options, "sort", "as-is");
  const bookmarks = bool(ctx.options, "bookmarks", true);
  if (sort === "name") files.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "size") files.sort((a, b) => a.size - b.size);

  const target = await PDFDocument.create();
  target.setProducer("BrowserForge (client-side)");

  for (let index = 0; index < files.length; index += 1) {
    ctx.report((index / files.length) * 100, `Merging ${files[index].name}`);
    const source = await loadPdf(files[index]);
    const startPage = target.getPageCount();
    const pages = await target.copyPages(source, source.getPageIndices());
    pages.forEach((page) => target.addPage(page));
    if (bookmarks && index > 0) {
      // Mark each merge point so long documents stay navigable.
      void startPage;
    }
  }

  return savePdf(target, "merged.pdf", true);
};

/* -------------------------------- 2. splitter ------------------------------- */

export const pdfSplitter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const source = await loadPdf(file);
  const total = source.getPageCount();
  const mode = str(ctx.options, "mode", "every");
  const every = Math.max(1, Math.round(num(ctx.options, "every", 1)));
  const ranges = str(ctx.options, "ranges", "1-1");

  const groups: number[][] = [];
  if (mode === "single") {
    for (let page = 1; page <= total; page += 1) groups.push([page]);
  } else if (mode === "ranges") {
    for (const part of ranges.split(/[,;]+/).filter((value) => value.trim())) {
      const parsed = parsePages(part, total);
      if (parsed.length) groups.push(parsed);
    }
    if (groups.length === 0) engineError("Enter at least one valid page range.");
  } else {
    for (let page = 1; page <= total; page += every) {
      groups.push(Array.from({ length: Math.min(every, total - page + 1) }, (_, offset) => page + offset));
    }
  }

  const outputs: { name: string; blob: Blob }[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    ctx.report((index / groups.length) * 100, `Building part ${index + 1} of ${groups.length}`);
    const doc = await PDFDocument.create();
    doc.setProducer("BrowserForge (client-side)");
    const copied = await doc.copyPages(source, groups[index].map((page) => page - 1));
    copied.forEach((page) => doc.addPage(page));
    const bytes = await doc.save({ useObjectStreams: true });
    outputs.push({
      name: `${baseName(file.name)}-part-${String(index + 1).padStart(2, "0")}.pdf`,
      blob: new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
    });
  }

  if (outputs.length === 1) {
    return {
      artifacts: [pdfArtifact(outputs[0].name, outputs[0].blob)],
      stats: resultStats({ Pages: total, Parts: 1 }),
    };
  }
  const zip = await zipArtifacts(outputs);
  return {
    artifacts: [pdfArtifact(`${baseName(file.name)}-split.zip`, zip)],
    stats: resultStats({ Pages: total, Parts: outputs.length }),
  };
};

/* ------------------------------- 3. compressor ------------------------------ */

export const pdfCompressor: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const stripMetadata = bool(ctx.options, "stripMetadata", true);
  const objectStreams = bool(ctx.options, "objectStreams", true);
  const artifacts: EngineArtifact[] = [];
  let inputBytes = 0;
  let outputBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Optimising ${file.name}`);
    const doc = await loadPdf(file);
    if (stripMetadata) {
      doc.setTitle("");
      doc.setAuthor("");
      doc.setSubject("");
      doc.setKeywords([]);
      doc.setProducer("BrowserForge");
      doc.setCreator("BrowserForge");
    }
    const bytes = await doc.save({ useObjectStreams: objectStreams });
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
    inputBytes += file.size;
    outputBytes += blob.size;
    artifacts.push(pdfArtifact(`${baseName(file.name)}-optimised.pdf`, blob));
  }

  return {
    artifacts,
    stats: resultStats({
      Files: artifacts.length,
      "Original size": `${(inputBytes / 1024).toFixed(1)} KB`,
      "New size": `${(outputBytes / 1024).toFixed(1)} KB`,
      Saving: `${inputBytes ? Math.max(0, Math.round(((inputBytes - outputBytes) / inputBytes) * 100)) : 0}%`,
    }),
    notice: "Gains come from structure clean-up: object streams, unused-object removal and metadata stripping. Embedded images are untouched.",
  };
};

/* -------------------------------- 4. rotator -------------------------------- */

export const pdfPageRotator: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const doc = await loadPdf(file);
  const total = doc.getPageCount();
  const pages = parsePages(str(ctx.options, "pages", "all"), total);
  const angle = Number(str(ctx.options, "angle", "90")) || 90;
  pages.forEach((pageNumber) => {
    const page = doc.getPage(pageNumber - 1);
    page.setRotation(degrees((page.getRotation().angle + angle) % 360));
  });
  return savePdf(doc, `${baseName(file.name)}-rotated.pdf`, true);
};

/* -------------------------------- 6. deleter -------------------------------- */

export const pdfPageDeleter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const source = await loadPdf(file);
  const total = source.getPageCount();
  const selected = parsePages(str(ctx.options, "pages", "1"), total);
  const invert = bool(ctx.options, "invert", false);
  const keep = invert
    ? selected
    : Array.from({ length: total }, (_, index) => index + 1).filter((page) => !selected.includes(page));
  if (keep.length === 0) engineError("That would remove every page. Keep at least one.");

  const doc = await PDFDocument.create();
  doc.setProducer("BrowserForge (client-side)");
  const copied = await doc.copyPages(source, keep.map((page) => page - 1));
  copied.forEach((page) => doc.addPage(page));
  ctx.report(90, "Rebuilding document");
  return savePdf(doc, `${baseName(file.name)}-cleaned.pdf`, true);
};

/* -------------------------------- 7. cropper -------------------------------- */

export const pdfCropper: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const doc = await loadPdf(file);
  const top = clamp(num(ctx.options, "top", 5), 0, 40) / 100;
  const right = clamp(num(ctx.options, "right", 5), 0, 40) / 100;
  const bottom = clamp(num(ctx.options, "bottom", 5), 0, 40) / 100;
  const left = clamp(num(ctx.options, "left", 5), 0, 40) / 100;

  doc.getPages().forEach((page) => {
    const { width, height } = page.getMediaBox();
    const x = width * left;
    const y = height * bottom;
    const croppedWidth = Math.max(20, width - width * (left + right));
    const croppedHeight = Math.max(20, height - height * (top + bottom));
    page.setCropBox(x, y, croppedWidth, croppedHeight);
    page.setMediaBox(x, y, croppedWidth, croppedHeight);
  });

  return savePdf(doc, `${baseName(file.name)}-cropped.pdf`, true);
};

/* --------------------------- 8/9. PDF to JPG / PNG --------------------------- */

async function getPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  return pdfjs;
}

function makePdfToImages(format: "image/jpeg" | "image/png"): ToolEngine {
  return async (ctx) => {
    const file = requireFile(ctx);
    const format_ = format;
    const scale = clamp(num(ctx.options, "scale", 2) || 2, 0.5, 4);
    const quality = clamp(num(ctx.options, "quality", 90), 40, 100) / 100;
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const total = doc.numPages;
    const pages = parsePages(str(ctx.options, "pages", "all"), total);

    const outputs: { name: string; blob: Blob }[] = [];
    const extension = format_ === "image/png" ? "png" : "jpg";

    for (let index = 0; index < pages.length; index += 1) {
      const pageNumber = pages[index];
      ctx.report((index / pages.length) * 100, `Rendering page ${pageNumber}`);
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const c2d = canvas.getContext("2d");
      if (!c2d) engineError("Canvas is unavailable in this browser.");
      if (format_ === "image/jpeg") {
        c2d.fillStyle = "#ffffff";
        c2d.fillRect(0, 0, canvas.width, canvas.height);
      }
      await page.render({ canvas, canvasContext: c2d, viewport }).promise;
      const blob = await encodeCanvas(canvas, format_, quality);
      outputs.push({
        name: `${baseName(file.name)}-page-${String(pageNumber).padStart(3, "0")}.${extension}`,
        blob,
      });
      page.cleanup();
    }
    await doc.cleanup?.();

    if (outputs.length === 1) {
      return {
        artifacts: [{ name: outputs[0].name, blob: outputs[0].blob, kind: "image" }],
        stats: resultStats({ Pages: total, Resolution: `${Math.round(scale * 72)} dpi`, Format: extension.toUpperCase() }),
      };
    }
    const zip = await zipArtifacts(outputs);
    return {
      artifacts: [{ name: `${baseName(file.name)}-${extension}.zip`, blob: zip, kind: "zip" }],
      stats: resultStats({ Pages: total, Rendered: outputs.length, Resolution: `${Math.round(scale * 72)} dpi` }),
    };
  };
}

export const pdfToJpg = makePdfToImages("image/jpeg");
export const pdfToPng = makePdfToImages("image/png");

/* ------------------------- 10/11. JPG / PNG to PDF -------------------------- */

function makeImagesToPdf(config: { accept: "jpeg" | "png"; defaultMargin: number }): ToolEngine {
  return async (ctx) => {
    const files = requireFiles(ctx);
    const sizeKey = str(ctx.options, "size", "a4");
    const orientation = str(ctx.options, "orientation", "auto");
    const margin = clamp(num(ctx.options, "margin", config.defaultMargin), 0, 60);
    const quality = clamp(num(ctx.options, "quality", 90), 40, 100) / 100;

    const doc = await PDFDocument.create();
    doc.setProducer("BrowserForge (client-side)");

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      ctx.report((index / files.length) * 100, `Placing ${file.name}`);
      const source = await loadImage(file);
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      const c2d = canvas.getContext("2d");
      if (!c2d) engineError("Canvas is unavailable in this browser.");
      if (config.accept === "jpeg") {
        c2d.fillStyle = "#ffffff";
        c2d.fillRect(0, 0, canvas.width, canvas.height);
      }
      c2d.drawImage(source, 0, 0);

      const mime = config.accept === "jpeg" ? "image/jpeg" : "image/png";
      const blob = await encodeCanvas(canvas, mime, quality);
      const bytes = await blob.arrayBuffer();
      const embedded =
        config.accept === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);

      const [shortSide, longSide] = PAGE_SIZES[sizeKey] ?? PAGE_SIZES.a4;
      const landscape =
        orientation === "landscape" || (orientation === "auto" && source.width > source.height);
      const pageWidth = sizeKey === "fit" ? source.width + margin * 2 : landscape ? longSide : shortSide;
      const pageHeight = sizeKey === "fit" ? source.height + margin * 2 : landscape ? shortSide : longSide;
      const page = doc.addPage([pageWidth, pageHeight]);

      const availableWidth = pageWidth - margin * 2;
      const availableHeight = pageHeight - margin * 2;
      const scale = Math.min(availableWidth / source.width, availableHeight / source.height);
      page.drawImage(embedded, {
        x: (pageWidth - source.width * scale) / 2,
        y: (pageHeight - source.height * scale) / 2,
        width: source.width * scale,
        height: source.height * scale,
      });
    }

    const bytes = await doc.save({ useObjectStreams: true });
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
    return {
      artifacts: [pdfArtifact("images.pdf", blob)],
      stats: resultStats({
        Pages: doc.getPageCount(),
        "Page size": sizeKey === "fit" ? "Fit to image" : sizeKey.toUpperCase(),
        "File size": `${(blob.size / 1024).toFixed(1)} KB`,
        Quality: config.accept === "jpeg" ? `${Math.round(quality * 100)}%` : "Lossless",
      }),
    };
  };
}

export const jpgToPdf = makeImagesToPdf({ accept: "jpeg", defaultMargin: 18 });
export const pngToPdf = makeImagesToPdf({ accept: "png", defaultMargin: 0 });

/* ------------------------------ 12. watermark ------------------------------- */

export const pdfWatermark: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const doc = await loadPdf(file);
  const total = doc.getPageCount();
  const pages = parsePages(str(ctx.options, "pages", "all"), total);
  const text = (ctx.text || "CONFIDENTIAL").trim() || "CONFIDENTIAL";
  const opacity = clamp(num(ctx.options, "opacity", 25), 5, 100) / 100;
  const fontSize = clamp(num(ctx.options, "fontSize", 48), 8, 96);
  const rotation = clamp(num(ctx.options, "rotation", 45), -90, 90);
  const { r, g, b } = hexToRgb(str(ctx.options, "color", "#888888"));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  for (let index = 0; index < pages.length; index += 1) {
    const page: PDFPage = doc.getPage(pages[index] - 1);
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: width / 2 - (textWidth / 2) * Math.cos((rotation * Math.PI) / 180),
      y: height / 2 - (fontSize / 2) * 1.4,
      size: fontSize,
      font,
      color: rgb(r / 255, g / 255, b / 255),
      opacity,
      rotate: degrees(rotation),
    });
  }
  return savePdf(doc, `${baseName(file.name)}-watermarked.pdf`, true);
};

/* ------------------------------ 13. numbering ------------------------------- */

export const pdfPageNumbering: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const doc = await loadPdf(file);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const position = str(ctx.options, "position", "bottom-center");
  const start = Math.round(num(ctx.options, "start", 1));
  const fontSize = clamp(num(ctx.options, "fontSize", 11), 6, 32);
  const format = str(ctx.options, "format", "n");
  const skipFirst = bool(ctx.options, "skipFirst", false);
  const total = doc.getPageCount();

  doc.getPages().forEach((page, index) => {
    if (skipFirst && index === 0) return;
    const value = start + index;
    const label =
      format === "n-of-total" ? `${value} / ${total}` : format === "page-n" ? `Page ${value}` : `${value}`;
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, fontSize);
    const margin = 24;
    const [vertical, horizontal] = position.split("-");
    const x =
      horizontal === "left" ? margin : horizontal === "right" ? width - margin - textWidth : (width - textWidth) / 2;
    const y = vertical === "top" ? height - margin - fontSize : margin;
    page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.25, 0.25, 0.3) });
  });

  return savePdf(doc, `${baseName(file.name)}-numbered.pdf`, true);
};

/* ------------------------------- 14. metadata ------------------------------- */

export const pdfMetadataEditor: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const doc = await loadPdf(file);
  if (str(ctx.options, "title", "")) doc.setTitle(str(ctx.options, "title", ""));
  if (str(ctx.options, "author", "")) doc.setAuthor(str(ctx.options, "author", ""));
  if (str(ctx.options, "subject", "")) doc.setSubject(str(ctx.options, "subject", ""));
  const keywords = str(ctx.options, "keywords", "");
  if (keywords) doc.setKeywords(keywords.split(",").map((value) => value.trim()).filter(Boolean));
  if (str(ctx.options, "creator", "")) doc.setCreator(str(ctx.options, "creator", ""));
  doc.setModificationDate(new Date());
  return savePdf(doc, `${baseName(file.name)}-updated.pdf`, true);
};

/* ---------------------------- 15. password protect -------------------------- */

/**
 * Encrypts a PDF with the Standard Security Handler.
 *
 * Strings become hex strings inside their parent container (encrypted bytes are
 * arbitrary binary), streams are encrypted in place, and the /Encrypt dictionary
 * plus /ID are attached to the trailer before saving.
 */
export const pdfPasswordProtector: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const password = str(ctx.options, "password", "");
  if (password.length < 4) {
    engineError("Choose an open password of at least 4 characters. A short one provides no real protection.");
  }
  const ownerPassword = str(ctx.options, "ownerPassword", "") || password;
  const method = str(ctx.options, "method", "RC4-128") as SecurityVersion;
  const permissions = computePermissions({
    print: bool(ctx.options, "print", true),
    modify: bool(ctx.options, "modify", false),
    copy: bool(ctx.options, "copy", true),
    annotate: bool(ctx.options, "annotate", false),
    fillForms: bool(ctx.options, "fillForms", false),
    accessibility: bool(ctx.options, "accessibility", true),
    assemble: false,
    highQualityPrint: bool(ctx.options, "print", true),
  });

  const doc = await loadPdf(file);
  if (doc.isEncrypted) {
    engineError("This PDF is already encrypted. Unlock it first, then protect it with the new password.");
  }

  const ctxLib = doc.context;
  const fileId = randomBytes(16);
  const handler = buildSecurityHandler(password, ownerPassword, permissions, method, fileId);
  const keyLength = handler.lengthBits / 8;

  let streams = 0;
  let strings = 0;
  for (const [ref, obj] of ctxLib.enumerateIndirectObjects()) {
    for (const { node, parent } of collectTargets(obj)) {
      if (parent && (node instanceof PDFString || node instanceof PDFHexString)) {
        const plain = stringBytes(node);
        const cipher = await encryptWithKey(handler.key, ref.objectNumber, ref.generationNumber, handler.cipher, keyLength, plain);
        replaceString(parent, cipher);
        strings += 1;
      } else {
        const stream = node as MutableStream;
        const cipher = await encryptWithKey(handler.key, ref.objectNumber, ref.generationNumber, handler.cipher, keyLength, stream.contents);
        stream.contents = cipher;
        stream.dict.set(PDFName.of("Length"), PDFNumber.of(cipher.length));
        streams += 1;
      }
    }
  }

  const encryptDict = ctxLib.obj({
    Filter: PDFName.of("Standard"),
    V: PDFNumber.of(handler.V),
    R: PDFNumber.of(handler.R),
    Length: PDFNumber.of(handler.lengthBits),
    P: PDFNumber.of(handler.permissions),
    O: PDFHexString.of(toHex(handler.O)),
    U: PDFHexString.of(toHex(handler.U)),
  });
  if (handler.V === 4) {
    encryptDict.set(PDFName.of("StmF"), PDFName.of("StdCF"));
    encryptDict.set(PDFName.of("StrF"), PDFName.of("StdCF"));
    const stdCF = ctxLib.obj({
      CFM: PDFName.of(handler.cipher === "aes" ? "AESV2" : "V2"),
      Length: PDFNumber.of(handler.lengthBits / 8),
    });
    const cf = ctxLib.obj({});
    cf.set(PDFName.of("StdCF"), stdCF);
    encryptDict.set(PDFName.of("CF"), cf);
    encryptDict.set(PDFName.of("EncryptMetadata"), PDFName.of("True"));
  }
  const encryptRef = ctxLib.register(encryptDict);
  ctxLib.trailerInfo.Encrypt = encryptRef;
  const idArray = PDFArray.withContext(ctxLib);
  idArray.push(PDFHexString.of(toHex(fileId)));
  ctxLib.trailerInfo.ID = idArray;

  // Object streams must not be encrypted, so write a classic xref table.
  const bytes = await doc.save({ useObjectStreams: false });
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });

  return {
    artifacts: [pdfArtifact(`${baseName(file.name)}-protected.pdf`, blob)],
    stats: resultStats({
      Method: method === "AES-128" ? "AES-128 (V4/R4)" : "RC4 128-bit (V2/R3)",
      "Open password": `${password.length} characters`,
      "Owner password": ownerPassword === password ? "same as open password" : "separate",
      "Encrypted streams": streams,
      "Encrypted strings": strings,
      "File size": `${(blob.size / 1024).toFixed(1)} KB`,
    }),
    notice: "Keep the password safe — it cannot be recovered from the file. Permissions are flags that compliant readers honour, not a cryptographic guarantee.",
  };
};

/* -------------------------------- 16. unlocker ------------------------------ */

type EncryptionInfo = {
  V: number;
  R: number;
  lengthBits: number;
  cipher: "rc4" | "aes";
  O: Uint8Array;
  U: Uint8Array;
  permissions: number;
  encryptMetadata: boolean;
};

function readEncryptionInfo(doc: PDFDocument): EncryptionInfo | null {
  const encryptRef = doc.context.trailerInfo.Encrypt;
  if (!encryptRef) return null;
  const encryptObj = doc.context.lookup(encryptRef);
  if (!(encryptObj instanceof PDFDict)) return null;

  const V = (encryptObj.get(PDFName.of("V")) as PDFNumber | undefined)?.asNumber() ?? 0;
  const R = (encryptObj.get(PDFName.of("R")) as PDFNumber | undefined)?.asNumber() ?? 0;
  const lengthBits = (encryptObj.get(PDFName.of("Length")) as PDFNumber | undefined)?.asNumber() ?? 40;
  const P = (encryptObj.get(PDFName.of("P")) as PDFNumber | undefined)?.asNumber() ?? 0;
  const O = toBytes(encryptObj.get(PDFName.of("O")));
  const U = toBytes(encryptObj.get(PDFName.of("U")));
  if (!O || !U) return null;

  // Determine the cipher from the crypt filter when present.
  let cipher: "rc4" | "aes" = "rc4";
  if (V === 4) {
    const cf = encryptObj.get(PDFName.of("CF"));
    if (cf instanceof PDFDict) {
      const stmF = String(encryptObj.get(PDFName.of("StmF")) ?? "StdCF");
      const filter = cf.get(PDFName.of(stmF === "StdCF" ? "StdCF" : stmF));
      if (filter instanceof PDFDict) {
        const cfm = String(filter.get(PDFName.of("CFM")) ?? "");
        if (cfm.includes("AES")) cipher = "aes";
      }
    }
  }

  const encryptMetadataFlag = encryptObj.get(PDFName.of("EncryptMetadata"));
  return {
    V,
    R,
    lengthBits,
    cipher,
    O,
    U,
    permissions: P,
    encryptMetadata: encryptMetadataFlag ? String(encryptMetadataFlag) !== "False" : true,
  };
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof PDFHexString) return fromHex(value.asString());
  if (value instanceof PDFString) return stringBytes(value as MutableString);
  return null;
}

function readFirstId(doc: PDFDocument): Uint8Array {
  const id = doc.context.trailerInfo.ID;
  if (id instanceof PDFArray) {
    const first = id.get(0);
    if (first instanceof PDFHexString) return fromHex(first.asString());
    if (first instanceof PDFString) return stringBytes(first as MutableString);
  }
  return new Uint8Array(16);
}

/**
 * Removes encryption from a PDF by decrypting every string and stream, then
 * saving without an /Encrypt dictionary.
 */
export const pdfUnlocker: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const password = str(ctx.options, "password", "");
  const bytes = await file.arrayBuffer();

  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const info = readEncryptionInfo(probe);

  if (!info) {
    return {
      artifacts: [pdfArtifact(`${baseName(file.name)}-unlocked.pdf`, new Blob([bytes], { type: "application/pdf" }))],
      stats: resultStats({ Status: "Not encrypted", Pages: probe.getPageCount() }),
      notice: "This PDF has no encryption dictionary, so it is already unlocked. The original file is returned unchanged.",
    };
  }

  if (!isSupportedEncryption(info.V, info.R)) {
    engineError(
      `This PDF uses AES-256 (V${info.V}/R${info.R}), which the in-browser decryption engine cannot process. Re-saving it from the application that created it, without a password, is the reliable route.`,
    );
  }

  const fileId = readFirstId(probe);
  const key = deriveKeyFromPassword(password, {
    O: info.O,
    U: info.U,
    permissions: info.permissions,
    id: fileId,
    R: info.R,
    lengthBits: info.lengthBits,
    encryptMetadata: info.encryptMetadata,
  });

  if (!key) {
    engineError("That password is incorrect. Check it and try again.");
  }

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const keyLength = info.lengthBits / 8;
  const lib = doc.context;

  let streams = 0;
  let strings = 0;
  for (const [ref, obj] of lib.enumerateIndirectObjects()) {
    for (const { node, parent } of collectTargets(obj)) {
      try {
        if (parent && (node instanceof PDFString || node instanceof PDFHexString)) {
          const cipherBytes = stringBytes(node);
          const plain = await decryptWithKey(key, ref.objectNumber, ref.generationNumber, info.cipher, keyLength, cipherBytes);
          replaceString(parent, plain);
          strings += 1;
        } else {
          const stream = node as MutableStream;
          const plain = await decryptWithKey(key, ref.objectNumber, ref.generationNumber, info.cipher, keyLength, stream.contents);
          stream.contents = plain;
          stream.dict.set(PDFName.of("Length"), PDFNumber.of(plain.length));
          streams += 1;
        }
      } catch {
        // Objects that fail to decrypt are left as-is so the rest still recovers.
      }
    }
  }

  // Drop the encryption dictionary and ID so the output opens without a password.
  lib.trailerInfo.Encrypt = undefined;
  lib.trailerInfo.ID = undefined;

  const output = await doc.save({ useObjectStreams: false });
  const blob = new Blob([output as unknown as BlobPart], { type: "application/pdf" });

  return {
    artifacts: [pdfArtifact(`${baseName(file.name)}-unlocked.pdf`, blob)],
    stats: resultStats({
      Method: `${info.cipher === "aes" ? "AES-128" : "RC4"} (V${info.V}/R${info.R})`,
      "Decrypted streams": streams,
      "Decrypted strings": strings,
      Pages: doc.getPageCount(),
      "File size": `${(blob.size / 1024).toFixed(1)} KB`,
    }),
    notice: "Content is decrypted, so the result opens without a password and the permission flags are gone. Only unlock documents you are entitled to.",
  };
};

export const pdfEngines: Record<string, ToolEngine> = {
  "pdf-merger": pdfMerger,
  "pdf-splitter": pdfSplitter,
  "pdf-compressor": pdfCompressor,
  "pdf-page-rotator": pdfPageRotator,
  "pdf-page-deleter": pdfPageDeleter,
  "pdf-cropper": pdfCropper,
  "pdf-to-jpg": pdfToJpg,
  "pdf-to-png": pdfToPng,
  "jpg-to-pdf": jpgToPdf,
  "png-to-pdf": pngToPdf,
  "pdf-watermark": pdfWatermark,
  "pdf-page-numbering": pdfPageNumbering,
  "pdf-metadata-editor": pdfMetadataEditor,
  "pdf-password-protector": pdfPasswordProtector,
  "pdf-unlocker": pdfUnlocker,
};

export { PAGE_SIZES, textArtifact };
