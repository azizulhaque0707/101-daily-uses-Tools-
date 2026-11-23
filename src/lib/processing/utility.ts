/**
 * Utility engines for the 15-tool registry.
 *
 * Everything uses browser-native APIs: Web Crypto for hashing, fflate for ZIP,
 * the Canvas API for image inspection, and a hand-written JPEG APP1 parser for
 * EXIF. No external service is contacted.
 */

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
import { baseName, clamp, formatBytes, safeFileName } from "@/lib/utils";
import { resultStats, textArtifact, zipArtifacts } from "./archive";
import { createCanvas, encodeCanvas, loadImage, svgToPngBlob } from "./canvas";

/* ------------------------------- QR / barcode ------------------------------- */

export const qrCodeGenerator: ToolEngine = async (ctx) => {
  const content = (ctx.text || "").trim();
  if (!content) engineError("Enter the text or URL to encode.");
  if (content.length > 2900) engineError("QR codes hold at most about 2,900 characters.");

  const size = Math.round(clamp(num(ctx.options, "size", 512), 128, 2048));
  const margin = Math.round(clamp(num(ctx.options, "margin", 2), 0, 8));
  const dark = str(ctx.options, "dark", "#000000");
  const light = str(ctx.options, "light", "#ffffff");
  const ecLevel = str(ctx.options, "ecLevel", "M").toLowerCase();

  const QRCode = (await import("qrcode")).default;
  const options = {
    errorCorrectionLevel: ecLevel as "low" | "medium" | "quartile" | "high",
    margin,
    width: size,
    color: { dark, light },
  };

  const dataUrl = await QRCode.toDataURL(content, options);
  const image = await loadImage(await (await fetch(dataUrl)).blob());
  const { canvas, ctx: c2d } = createCanvas(size, size);
  c2d.imageSmoothingEnabled = false;
  c2d.drawImage(image, 0, 0, size, size);
  const png = await encodeCanvas(canvas, "image/png");
  const svg = await QRCode.toString(content, { ...options, type: "svg", width: size });

  return {
    artifacts: [
      { name: "qr-code.png", blob: png, kind: "image" },
      { name: "qr-code.svg", blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), kind: "image" },
    ],
    stats: resultStats({
      "Content length": content.length,
      Size: `${size} × ${size} px`,
      "Error correction": ecLevel.toUpperCase(),
    }),
  };
};

export const barcodeGenerator: ToolEngine = async (ctx) => {
  const value = (ctx.text || "").trim();
  if (!value) engineError("Enter the barcode value.");
  const format = str(ctx.options, "format", "CODE128");
  const width = clamp(num(ctx.options, "width", 2), 1, 6);
  const height = Math.round(clamp(num(ctx.options, "height", 90), 20, 400));
  const showText = bool(ctx.options, "showText", true);
  const background = str(ctx.options, "background", "#ffffff");
  const lineColor = str(ctx.options, "lineColor", "#000000");

  const JsBarcode = (await import("jsbarcode")).default;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  try {
    JsBarcode(svg, value, { format, width, height, displayValue: showText, background, lineColor, margin: 8 });
  } catch (error) {
    engineError(
      `${format} rejected the value "${value}". ${error instanceof Error ? error.message : "Check the required digits."}`,
    );
  }
  const svgText = new XMLSerializer().serializeToString(svg);
  const widthMatch = /width="(\d+)"/.exec(svgText);
  const rasterWidth = widthMatch ? Number(widthMatch[1]) : 400;
  const png = await svgToPngBlob(svgText, rasterWidth, height + 40);

  return {
    artifacts: [
      { name: `barcode-${safeFileName(value)}.png`, blob: png, kind: "image" },
      { name: `barcode-${safeFileName(value)}.svg`, blob: new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }), kind: "image" },
    ],
    stats: resultStats({ Type: format, Value: value, Width: `${rasterWidth} px` }),
  };
};

/* ------------------------------- colour tools ------------------------------- */

export function parseColor(input: string): { r: number; g: number; b: number } | null {
  const value = input.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return null;
}

function toHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function toCmyk(r: number, g: number, b: number) {
  const normalized = [r / 255, g / 255, b / 255];
  const max = Math.max(...normalized);
  const k = 1 - max;
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: Math.round(((1 - normalized[0] - k) / (1 - k)) * 100),
    m: Math.round(((1 - normalized[1] - k) / (1 - k)) * 100),
    y: Math.round(((1 - normalized[2] - k) / (1 - k)) * 100),
    k: Math.round(k * 100),
  };
}

function luminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = ln - c / 2;
  const to255 = (value: number) => Math.round(clamp((value + m) * 255, 0, 255));
  return `#${[to255(r1), to255(g1), to255(b1)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function colourReport(rgb: { r: number; g: number; b: number }, input: string, shades: string[]) {
  const { h, s, l } = toHsl(rgb.r, rgb.g, rgb.b);
  const cmyk = toCmyk(rgb.r, rgb.g, rgb.b);
  const hex = `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const white = 1.05 / (luminance(rgb.r, rgb.g, rgb.b) + 0.05);
  const black = (luminance(rgb.r, rgb.g, rgb.b) + 0.05) / 0.05;

  const lines = [
    "Colour report",
    "=============",
    "",
    `Input:              ${input}`,
    `HEX:                ${hex}`,
    `RGB:                rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    `HSL:                hsl(${h}, ${s}%, ${l}%)`,
    `CMYK:               cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`,
    `Relative luminance: ${luminance(rgb.r, rgb.g, rgb.b).toFixed(4)}`,
    `Contrast on white:  ${white.toFixed(2)}:1 ${white >= 4.5 ? "(AA pass)" : "(AA fail)"}`,
    `Contrast on black:  ${black.toFixed(2)}:1 ${black >= 4.5 ? "(AA pass)" : "(AA fail)"}`,
    "",
    `Shade scale (${shades.length} steps)`,
    ...shades.map((value, index) => `${String(index).padStart(2)}  ${value}`),
    "",
    "CSS custom properties",
    ":root {",
    ...shades.map((value, index) => `  --color-${String(index + 1).padStart(2, "0")}: ${value};`),
    "}",
  ];
  return lines.join("\n");
}

export const colorConverter: ToolEngine = async (ctx) => {
  const input = (ctx.text || "").trim();
  if (!input) engineError("Enter a colour such as #6366f1 or rgb(99,102,241).");
  const rgb = parseColor(input);
  if (!rgb) engineError(`"${input}" is not a valid colour. Try #6366f1 or rgb(99,102,241).`);

  const shadeCount = Math.round(clamp(num(ctx.options, "shades", 9), 0, 12));
  const format = str(ctx.options, "format", "hex");
  const { h, s } = toHsl(rgb.r, rgb.g, rgb.b);

  const shades: string[] = [];
  for (let index = 0; index < shadeCount; index += 1) {
    const lightness = Math.round((index / Math.max(1, shadeCount - 1)) * 100);
    const hex = hslToHex(h, s, lightness);
    if (format === "hex") shades.push(hex);
    else {
      const parsed = parseColor(hex)!;
      if (format === "rgb") shades.push(`rgb(${parsed.r}, ${parsed.g}, ${parsed.b})`);
      else {
        const hsl = toHsl(parsed.r, parsed.g, parsed.b);
        shades.push(`hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`);
      }
    }
  }

  const report = colourReport(rgb, input, shades);

  const swatchCell = 64;
  const { canvas, ctx: c2d } = createCanvas(Math.max(1, shades.length) * swatchCell, swatchCell);
  if (shades.length === 0) {
    c2d.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
    c2d.fillRect(0, 0, swatchCell, swatchCell);
  } else {
    shades.forEach((value, index) => {
      const parsed = parseColor(value.includes("rgb") ? value : value)!;
      c2d.fillStyle = `rgb(${parsed.r},${parsed.g},${parsed.b})`;
      c2d.fillRect(index * swatchCell, 0, swatchCell, swatchCell);
    });
  }
  const swatch = await encodeCanvas(canvas, "image/png");

  return {
    artifacts: [
      textArtifact("color-report.txt", report),
      textArtifact("color-variables.css", report.slice(report.indexOf("CSS custom properties")), "text/css;charset=utf-8"),
      { name: "color-scale.png", blob: swatch, kind: "image" },
    ],
    preview: { type: "text", data: report },
    stats: resultStats({
      HEX: `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
      RGB: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      HSL: `hsl(${h}, ${s}%, ${toHsl(rgb.r, rgb.g, rgb.b).l}%)`,
      Shades: shades.length,
    }),
  };
};

export const hexToRgb: ToolEngine = async (ctx) => {
  const input = (ctx.text || "").trim();
  if (!input) engineError("Enter a HEX colour code such as #6366f1.");
  const rgb = parseColor(input);
  if (!rgb) engineError(`"${input}" is not a valid HEX code. Use 3 or 6 hex digits, optionally with #.`);

  const { h, s, l } = toHsl(rgb.r, rgb.g, rgb.b);
  const lines = [
    "HEX to RGB conversion",
    "=====================",
    "",
    `Input:   ${input}`,
    `HEX:     #${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
    `RGB:     rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    `Red:     ${rgb.r}`,
    `Green:   ${rgb.g}`,
    `Blue:    ${rgb.b}`,
  ];
  if (bool(ctx.options, "includeHsl", true)) {
    lines.push("", `HSL:     hsl(${h}, ${s}%, ${l}%)`, `Hue: ${h}°  Saturation: ${s}%  Lightness: ${l}%`);
  }
  const report = lines.join("\n");
  return {
    artifacts: [textArtifact("hex-to-rgb.txt", report)],
    preview: { type: "text", data: report },
    stats: resultStats({ HEX: input, R: rgb.r, G: rgb.g, B: rgb.b, HSL: `hsl(${h}, ${s}%, ${l}%)` }),
  };
};

export const rgbToHex: ToolEngine = async (ctx) => {
  const r = Math.round(clamp(num(ctx.options, "r", 99), 0, 255));
  const g = Math.round(clamp(num(ctx.options, "g", 102), 0, 255));
  const b = Math.round(clamp(num(ctx.options, "b", 241), 0, 255));
  const uppercase = bool(ctx.options, "uppercase", true);

  let hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  if (uppercase) hex = hex.toUpperCase();

  const { h, s, l } = toHsl(r, g, b);
  const report = [
    "RGB to HEX conversion",
    "=====================",
    "",
    `Red:     ${r}`,
    `Green:   ${g}`,
    `Blue:    ${b}`,
    `HEX:     ${hex}`,
    `HSL:     hsl(${h}, ${s}%, ${l}%)`,
  ].join("\n");

  return {
    artifacts: [textArtifact("rgb-to-hex.txt", report)],
    preview: { type: "text", data: report },
    stats: resultStats({ RGB: `rgb(${r}, ${g}, ${b})`, HEX: hex }),
  };
};

/* ------------------------------ unit conversion ----------------------------- */

const UNIT_TABLE: Record<string, Record<string, number>> = {
  length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 },
  mass: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, oz: 0.0283495, lb: 0.453592, st: 6.35029 },
  area: { mm2: 1e-6, cm2: 1e-4, m2: 1, ha: 10000, km2: 1e6, in2: 0.00064516, ft2: 0.092903, ac: 4046.86 },
  volume: { ml: 0.001, l: 1, m3: 1000, tsp: 0.00492892, tbsp: 0.0147868, cup: 0.236588, in3: 0.0163871, gal: 3.78541 },
  speed: { "m/s": 1, "km/h": 0.277778, mph: 0.44704, kn: 0.514444, "ft/s": 0.3048 },
  data: { b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1048576, gib: 1073741824 },
  time: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, wk: 604800, mo: 2629800, yr: 31557600 },
};

function convertTemperature(value: number, from: string, to: string): number {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  let celsius = value;
  if (f === "f" || f === "fahrenheit") celsius = (value - 32) / 1.8;
  if (f === "k" || f === "kelvin") celsius = value - 273.15;
  if (t === "f" || t === "fahrenheit") return celsius * 1.8 + 32;
  if (t === "k" || t === "kelvin") return celsius + 273.15;
  return celsius;
}

export const unitConverter: ToolEngine = async (ctx) => {
  const category = str(ctx.options, "category", "length");
  const value = num(ctx.options, "value", 1);
  const from = str(ctx.options, "from", "km").trim().toLowerCase();
  const to = str(ctx.options, "to", "mi").trim().toLowerCase();

  if (Number.isNaN(value)) engineError("Enter a numeric value to convert.");

  let result: number;
  if (category === "temperature") {
    result = convertTemperature(value, from, to);
  } else {
    const table = UNIT_TABLE[category];
    if (!table) engineError("That category is not supported yet.");
    if (!(from in table)) engineError(`Unknown unit "${from}". Try one of: ${Object.keys(table).join(", ")}`);
    if (!(to in table)) engineError(`Unknown unit "${to}". Try one of: ${Object.keys(table).join(", ")}`);
    result = (value * table[from]) / table[to];
  }

  const precision = Math.abs(result) >= 1000 ? 4 : Math.abs(result) >= 1 ? 6 : 10;
  const formatted = Number(result.toFixed(precision)).toLocaleString("en-US", { maximumFractionDigits: precision });

  const report = [
    "Unit conversion",
    "===============",
    "",
    `Category:  ${category}`,
    `Input:     ${value} ${from}`,
    `Result:    ${formatted} ${to}`,
    "",
    `Working:   ${value} ${from} → ${formatted} ${to}`,
  ].join("\n");

  return {
    artifacts: [textArtifact("conversion.txt", report)],
    preview: { type: "text", data: `${value} ${from} = ${formatted} ${to}` },
    stats: resultStats({ Category: category, Input: `${value} ${from}`, Result: `${formatted} ${to}` }),
  };
};

/* --------------------------------- hashing --------------------------------- */

async function digest(algorithm: string, data: ArrayBuffer): Promise<string> {
  const buffer = await crypto.subtle.digest(algorithm, data);
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const fileHashGenerator: ToolEngine = async (ctx) => {
  const algorithm = str(ctx.options, "algorithm", "SHA-256");
  const uppercase = bool(ctx.options, "uppercase", false);
  const all = bool(ctx.options, "allAlgorithms", true);
  const algorithms = all ? ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] : [algorithm];

  const source = ctx.files[0];
  let data: ArrayBuffer;
  if (source) {
    ctx.report(30, `Hashing ${source.name}`);
    data = await source.arrayBuffer();
  } else {
    if (!ctx.text.trim()) engineError("Enter text to hash, or add a file.");
    data = new TextEncoder().encode(ctx.text).buffer as ArrayBuffer;
  }

  const entries: { label: string; value: string }[] = [];
  for (let index = 0; index < algorithms.length; index += 1) {
    ctx.report(30 + (index / algorithms.length) * 65, `Computing ${algorithms[index]}`);
    entries.push({ label: algorithms[index], value: await digest(algorithms[index], data) });
  }

  const formatted = entries.map((entry) => ({
    ...entry,
    value: uppercase ? entry.value.toUpperCase() : entry.value,
  }));
  const report = [
    "Hash report",
    "===========",
    "",
    source
      ? `File:     ${source.name}\nSize:     ${source.size} bytes`
      : `Input:    ${ctx.text.length} characters`,
    "",
    ...formatted.map((entry) => `${entry.label.padEnd(10)}${entry.value}`),
  ].join("\n");

  return {
    artifacts: [textArtifact(`${baseName(source?.name ?? "text")}-hashes.txt`, report)],
    preview: { type: "stats", data: formatted },
    stats: resultStats({ Source: source ? source.name : "text", Algorithms: formatted.length }),
  };
};

/* ----------------------------------- ZIP ----------------------------------- */

export const fileZipCreator: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const level = Number(str(ctx.options, "level", "6"));
  const name = safeFileName(str(ctx.options, "name", "archive")) || "archive";

  ctx.report(10, `Archiving ${files.length} files`);
  const entries = files.map((file) => ({ name: file.name, blob: file }));
  const zip = await zipArtifacts(entries, level);
  ctx.report(95, "Archive complete");

  const totalInput = files.reduce((total, file) => total + file.size, 0);
  return {
    artifacts: [{ name: `${name}.zip`, blob: zip, kind: "zip" }],
    stats: resultStats({
      Files: files.length,
      "Original size": formatBytes(totalInput),
      "Archive size": formatBytes(zip.size),
      Compression: `${totalInput ? Math.max(0, Math.round(((totalInput - zip.size) / totalInput) * 100)) : 0}%`,
    }),
  };
};

export const fileZipExtractor: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const flatten = bool(ctx.options, "flatten", false);

  const { unzip } = await import("fflate");
  const buffer = new Uint8Array(await file.arrayBuffer());

  let entries: Record<string, Uint8Array>;
  try {
    entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      unzip(buffer, (error, data) => (error ? reject(error) : resolve(data)));
    });
  } catch (error) {
    engineError(
      `This ZIP could not be read. ${error instanceof Error ? error.message : "Unsupported archive."} Encrypted and spanned ZIPs are not supported.`,
    );
  }

  const files = Object.entries(entries).filter(([name, data]) => {
    // Skip directory markers and hidden entries.
    if (name.endsWith("/")) return false;
    if (data.length === 0) return false;
    return true;
  });

  if (files.length === 0) engineError("This archive contains no files.");

  const artifacts: EngineArtifact[] = files.map(([name, data]) => {
    const shortName = flatten ? name.split("/").pop() ?? name : name;
    const blob = new Blob([data.slice()], { type: "application/octet-stream" });
    return { name: shortName, blob, kind: "other" as const };
  });

  const listing = [
    "ZIP contents",
    "============",
    "",
    `Archive:  ${file.name}`,
    `Files:    ${files.length}`,
    "",
    ...files.map(([name, data]) => `${formatBytes(data.length).padStart(10)}  ${name}`),
  ].join("\n");

  return {
    artifacts: [...artifacts, textArtifact("zip-contents.txt", listing)],
    preview: { type: "text", data: listing },
    stats: resultStats({
      Files: files.length,
      "Uncompressed size": formatBytes(files.reduce((total, [, data]) => total + data.length, 0)),
      "Archive size": formatBytes(file.size),
    }),
    notice: "Files are listed individually — use the download button beside each one, or download them all as a ZIP.",
  };
};

/* ----------------------------------- EXIF ---------------------------------- */

/**
 * Minimal JPEG APP1 EXIF parser.
 *
 * TIFF structure is well documented, so tags can be read without a library.
 * Only the commonly useful tags are decoded; unknown tags are skipped.
 */
const EXIF_TAGS: Record<number, string> = {
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x0131: "Software",
  0x0132: "DateTime",
  0x013b: "Artist",
  0x8298: "Copyright",
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8822: "ExposureProgram",
  0x8827: "ISO",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9201: "ShutterSpeedValue",
  0x9202: "ApertureValue",
  0x9204: "ExposureBias",
  0x9207: "MeteringMode",
  0x9209: "Flash",
  0x920a: "FocalLength",
  0x9286: "UserComment",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
  0xa405: "FocalLengthIn35mm",
  0xa432: "LensSpecification",
  0xa433: "LensMake",
  0xa434: "LensModel",
  0xa435: "LensSerialNumber",
  0x0001: "GPSLatitudeRef",
  0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef",
  0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef",
  0x0006: "GPSAltitude",
  0x0007: "GPSTimeStamp",
  0x0012: "GPSMapDatum",
};

function readExif(bytes: Uint8Array): { tag: string; value: string }[] {
  // Find the APP1 marker containing Exif.
  let offset = 2;
  let exifStart = -1;
  while (offset < bytes.length - 4) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker === 0xe1) {
      // Check for the "Exif\0\0" header.
      const header = String.fromCharCode(...bytes.subarray(offset + 4, offset + 10));
      if (header === "Exif\0\0") {
        exifStart = offset + 10;
        break;
      }
    }
    offset += 2 + length;
  }
  if (exifStart === -1) return [];

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tiffStart = exifStart;
  const endian = view.getUint16(tiffStart);
  const little = endian === 0x4949;
  if (!little && endian !== 0x4d4d) return [];

  const readU16 = (position: number) => view.getUint16(position, little);
  const readU32 = (position: number) => view.getUint32(position, little);

  const ifdOffset = readU32(tiffStart + 4);
  const results: { tag: string; value: string }[] = [];

  const readIfd = (directoryOffset: number, tagMap: Record<number, string>, prefix = "") => {
    if (directoryOffset <= 0 || tiffStart + directoryOffset + 2 > bytes.length) return;
    const count = readU16(tiffStart + directoryOffset);
    const entrySize = 12;
    for (let index = 0; index < count; index += 1) {
      const entry = tiffStart + directoryOffset + 2 + index * entrySize;
      if (entry + 12 > bytes.length) break;
      const tag = readU16(entry);
      const type = readU16(entry + 2);
      const valueCount = readU32(entry + 4);
      const tagName = tagMap[tag];
      if (!tagName) continue;

      const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const unitSize = typeSizes[type] ?? 1;
      const totalSize = unitSize * valueCount;
      const valueOffset = totalSize > 4 ? tiffStart + readU32(entry + 8) : entry + 8;

      try {
        let value = "";
        if (type === 2) {
          // ASCII string, null terminated.
          let end = valueOffset;
          while (end < bytes.length && bytes[end] !== 0 && end - valueOffset < 128) end += 1;
          value = String.fromCharCode(...bytes.subarray(valueOffset, end)).trim();
        } else if (type === 3) {
          value = String(view.getUint16(valueOffset, little));
        } else if (type === 4) {
          value = String(view.getUint32(valueOffset, little));
        } else if (type === 5 || type === 10) {
          const numerator = readU32(valueOffset);
          const denominator = readU32(valueOffset + 4) || 1;
          value = `${numerator}/${denominator}`;
          if (denominator !== 0) {
            const numeric = numerator / denominator;
            if (Number.isFinite(numeric)) value = `${numeric.toFixed(4)} (${numerator}/${denominator})`;
          }
        } else if (type === 1) {
          value = Array.from(bytes.subarray(valueOffset, valueOffset + Math.min(valueCount, 16))).join(" ");
        }
        if (value) results.push({ tag: `${prefix}${tagName}`, value });
      } catch {
        /* skip malformed entries */
      }
    }
  };

  readIfd(ifdOffset, EXIF_TAGS);

  // The EXIF sub-IFD holds camera settings.
  const exifPointerOffset = Object.keys(EXIF_TAGS).length;
  void exifPointerOffset;
  // Locate tag 0x8769 (Exif IFD pointer) in IFD0.
  const count = readU16(tiffStart + ifdOffset);
  for (let index = 0; index < count; index += 1) {
    const entry = tiffStart + ifdOffset + 2 + index * 12;
    if (entry + 12 > bytes.length) break;
    if (readU16(entry) === 0x8769) {
      const subOffset = readU32(entry + 8);
      readIfd(subOffset, EXIF_TAGS);
      break;
    }
  }
  // GPS IFD pointer is tag 0x8825.
  for (let index = 0; index < count; index += 1) {
    const entry = tiffStart + ifdOffset + 2 + index * 12;
    if (entry + 12 > bytes.length) break;
    if (readU16(entry) === 0x8825) {
      const gpsOffset = readU32(entry + 8);
      readIfd(gpsOffset, EXIF_TAGS, "GPS.");
      break;
    }
  }

  return results;
}

export const imageExifViewer: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const includeMaker = bool(ctx.options, "includeMaker", true);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isTiff = (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);

  let tags: { tag: string; value: string }[] = [];
  if (isJpeg) tags = readExif(bytes);
  else if (isTiff) tags = readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, ...Array(6).fill(0), ...bytes]));

  const image = await loadImage(file).catch(() => null);
  const dimensions = image ? `${image.width} × ${image.height}` : "unknown";

  const filtered = includeMaker ? tags : tags.filter((entry) => !/maker|serial/i.test(entry.tag));
  const report = [
    "EXIF report",
    "===========",
    "",
    `File:        ${file.name}`,
    `Size:        ${formatBytes(file.size)}`,
    `Format:      ${file.type || (isTiff ? "image/tiff" : "image/jpeg")}`,
    `Dimensions:  ${dimensions}`,
    `EXIF tags:   ${filtered.length}`,
    "",
    ...(filtered.length === 0
      ? [
          "No EXIF metadata was found.",
          "",
          "JPEG and TIFF files normally carry EXIF. PNG and WebP usually have none, and",
          "photos uploaded to social media are often stripped of it entirely.",
        ]
      : filtered.map((entry) => `${(entry.tag + ":").padEnd(26)}${entry.value}`)),
  ].join("\n");

  return {
    artifacts: [textArtifact(`${baseName(file.name)}-exif.txt`, report)],
    preview: { type: "text", data: report },
    stats: resultStats({
      Tags: filtered.length,
      Dimensions: dimensions,
      "File size": formatBytes(file.size),
    }),
  };
};

/* --------------------------------- calculators ------------------------------ */

function parseDate(value: string, label: string): Date {
  const trimmed = value.trim();
  if (!trimmed) engineError(`Enter a date for ${label}.`);
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    engineError(`"${value}" is not a valid date. Use the YYYY-MM-DD format.`);
  }
  return date;
}

export const ageCalculator: ToolEngine = async (ctx) => {
  const birth = parseDate(str(ctx.options, "birth", ""), "the date of birth");
  const asOfInput = str(ctx.options, "asOf", "").trim();
  const asOf = asOfInput ? parseDate(asOfInput, "the comparison date") : new Date();
  if (birth > asOf) engineError("The date of birth must be before the comparison date.");

  let years = asOf.getFullYear() - birth.getFullYear();
  let months = asOf.getMonth() - birth.getMonth();
  let days = asOf.getDate() - birth.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(asOf.getFullYear(), asOf.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const totalDays = Math.floor((asOf.getTime() - birth.getTime()) / 86400000);
  const nextBirthday = new Date(asOf.getFullYear(), birth.getMonth(), birth.getDate());
  if (nextBirthday < asOf) nextBirthday.setFullYear(asOf.getFullYear() + 1);
  const daysToBirthday = Math.ceil((nextBirthday.getTime() - asOf.getTime()) / 86400000);

  const report = [
    "Age report",
    "==========",
    "",
    `Date of birth:   ${birth.toISOString().slice(0, 10)}`,
    `Age at:          ${asOf.toISOString().slice(0, 10)}`,
    "",
    `Age:             ${years} years, ${months} months, ${days} days`,
    `Total months:    ${years * 12 + months}`,
    `Total weeks:     ${Math.floor(totalDays / 7)}`,
    `Total days:      ${totalDays}`,
    `Total hours:     ${totalDays * 24}`,
    `Total minutes:   ${totalDays * 24 * 60}`,
    "",
    `Next birthday:   ${nextBirthday.toISOString().slice(0, 10)} (in ${daysToBirthday} days)`,
    `Day of week born: ${birth.toLocaleDateString("en-US", { weekday: "long" })}`,
  ].join("\n");

  return {
    artifacts: [textArtifact("age-report.txt", report)],
    preview: { type: "text", data: `${years} years, ${months} months, ${days} days` },
    stats: resultStats({
      Age: `${years}y ${months}m ${days}d`,
      "Total days": totalDays.toLocaleString("en-US"),
      "Next birthday": `${daysToBirthday} days`,
    }),
  };
};

export const dateDifferenceCalculator: ToolEngine = async (ctx) => {
  const start = parseDate(str(ctx.options, "start", ""), "the start date");
  const end = parseDate(str(ctx.options, "end", ""), "the end date");
  if (start > end) engineError("The start date must be before the end date.");
  const includeWeekends = bool(ctx.options, "includeWeekends", true);

  let years = end.getFullYear() - start.getFullYear();
  let months = end.getMonth() - start.getMonth();
  let days = end.getDate() - start.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(end.getFullYear(), end.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const totalDays = Math.round((end.getTime() - start.getTime()) / 86400000);
  let weekdays = 0;
  let weekendDays = 0;
  for (let day = 0; day < totalDays; day += 1) {
    const current = new Date(start.getTime() + day * 86400000);
    const dow = current.getDay();
    if (dow === 0 || dow === 6) weekendDays += 1;
    else weekdays += 1;
  }

  const report = [
    "Date difference report",
    "=====================",
    "",
    `Start date:      ${start.toISOString().slice(0, 10)}`,
    `End date:        ${end.toISOString().slice(0, 10)}`,
    "",
    `Difference:      ${years} years, ${months} months, ${days} days`,
    `Total months:    ${years * 12 + months}`,
    `Total weeks:     ${(totalDays / 7).toFixed(1)}`,
    `Total days:      ${totalDays}`,
    ...(includeWeekends
      ? [`Weekdays:        ${weekdays}`, `Weekend days:    ${weekendDays}`]
      : []),
    `Total hours:     ${totalDays * 24}`,
    `Total minutes:   ${totalDays * 24 * 60}`,
    `Total seconds:   ${totalDays * 24 * 60 * 60}`,
  ].join("\n");

  return {
    artifacts: [textArtifact("date-difference.txt", report)],
    preview: { type: "text", data: `${years}y ${months}m ${days}d (${totalDays} days)` },
    stats: resultStats({
      Difference: `${years}y ${months}m ${days}d`,
      "Total days": totalDays.toLocaleString("en-US"),
      Weekdays: weekdays.toLocaleString("en-US"),
    }),
  };
};

export const percentageCalculator: ToolEngine = async (ctx) => {
  const mode = str(ctx.options, "mode", "of");
  const x = num(ctx.options, "x", 25);
  const y = num(ctx.options, "y", 200);
  if (!Number.isFinite(x) || !Number.isFinite(y)) engineError("Enter numeric values for X and Y.");

  let result = 0;
  let working = "";
  if (mode === "of") {
    if (y === 0) engineError("Y cannot be zero for this calculation.");
    result = (x / 100) * y;
    working = `${x}% of ${y} = ${x}/100 × ${y} = ${result}`;
  } else if (mode === "isWhat") {
    if (y === 0) engineError("Y cannot be zero for this calculation.");
    result = (x / y) * 100;
    working = `${x} is ${((x / y) * 100).toFixed(4)}% of ${y}`;
  } else {
    if (x === 0) engineError("X cannot be zero for a percentage change.");
    result = ((y - x) / Math.abs(x)) * 100;
    working = `Change from ${x} to ${y} = ${(((y - x) / Math.abs(x)) * 100).toFixed(4)}%`;
  }

  const report = [
    "Percentage calculation",
    "======================",
    "",
    working,
    "",
    `Inputs:    X = ${x}, Y = ${y}`,
    `Mode:      ${mode}`,
    `Result:    ${Number(result.toFixed(6))}`,
  ].join("\n");

  return {
    artifacts: [textArtifact("percentage-result.txt", report)],
    preview: { type: "text", data: working },
    stats: resultStats({ Result: Number(result.toFixed(6)).toLocaleString("en-US"), Mode: mode }),
  };
};

/* ------------------------------ image measuring ----------------------------- */

export const imageDimensionsChecker: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const targetWidth = Math.round(clamp(num(ctx.options, "targetWidth", 0), 0, 16000));

  const rows: {
    name: string;
    width: number;
    height: number;
    megapixels: number;
    ratio: string;
    size: string;
  }[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 95, `Measuring ${file.name}`);
    const image = await loadImage(file).catch(() => null);
    if (!image) {
      rows.push({ name: `${file.name} (unreadable)`, width: 0, height: 0, megapixels: 0, ratio: "—", size: formatBytes(file.size) });
      continue;
    }
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const divisor = gcd(image.width, image.height) || 1;
    rows.push({
      name: file.name,
      width: image.width,
      height: image.height,
      megapixels: Number(((image.width * image.height) / 1_000_000).toFixed(2)),
      ratio: `${image.width / divisor}:${image.height / divisor}`,
      size: formatBytes(file.size),
    });
  }

  const lines = [
    "Image dimensions report",
    "=======================",
    "",
    `Images measured: ${rows.length}`,
    ...(targetWidth > 0 ? [`Compared against: ${targetWidth}px width`] : []),
    "",
    "File".padEnd(34) + "Dimensions".padEnd(16) + "Megapixels".padEnd(13) + "Ratio".padEnd(12) + "Size".padEnd(10) + "vs target",
    "-".repeat(100),
    ...rows.map((row) => {
      const dimensions = row.width ? `${row.width} × ${row.height}` : "unreadable";
      const comparison =
        targetWidth > 0 && row.width > 0
          ? row.width > targetWidth
            ? `${row.width - targetWidth}px larger`
            : row.width < targetWidth
              ? `${targetWidth - row.width}px smaller`
              : "exact match"
          : "";
      return (
        row.name.slice(0, 33).padEnd(34) +
        dimensions.padEnd(16) +
        (row.megapixels ? row.megapixels.toFixed(2) : "—").padEnd(13) +
        row.ratio.padEnd(12) +
        row.size.padEnd(10) +
        comparison
      );
    }),
  ];
  const report = lines.join("\n");

  return {
    artifacts: [textArtifact("image-dimensions.txt", report)],
    preview: { type: "text", data: report },
    stats: resultStats({
      Images: rows.length,
      "Total megapixels": rows.reduce((total, row) => total + row.megapixels, 0).toFixed(2),
    }),
  };
};

export const fileSizeConverter: ToolEngine = async (ctx) => {
  const unit = str(ctx.options, "unit", "B");
  let value = num(ctx.options, "value", 1048576);
  let label = "entered manually";

  if (ctx.files[0]) {
    value = ctx.files[0].size;
    label = `from ${ctx.files[0].name}`;
  }

  if (!Number.isFinite(value) || value < 0) engineError("Enter a non-negative size.");

  const decimalFactors: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9 };
  const binaryFactors: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  const factor = decimalFactors[unit] ?? binaryFactors[unit] ?? 1;
  const bytes = value * factor;

  const format = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const report = [
    "File size conversion",
    "====================",
    "",
    `Input:      ${format(value)} ${unit} ${label}`,
    "",
    `Bytes:      ${format(bytes)}`,
    `Kilobytes:  ${format(bytes / 1e3)} KB`,
    `Megabytes:  ${format(bytes / 1e6)} MB`,
    `Gigabytes:  ${format(bytes / 1e9)} GB`,
    "",
    `Kibibytes:  ${format(bytes / 1024)} KiB`,
    `Mebibytes:  ${format(bytes / 1024 ** 2)} MiB`,
    `Gibibytes:  ${format(bytes / 1024 ** 3)} GiB`,
    "",
    `Human readable: ${formatBytes(bytes)}`,
    "",
    "Decimal units (KB, MB) use powers of 1000; binary units (KiB, MiB) use",
    "powers of 1024. Drive makers use decimal, operating systems often binary —",
    "which is why a \"500 GB\" drive shows as about 465 GiB.",
  ].join("\n");

  return {
    artifacts: [textArtifact("file-size.txt", report)],
    preview: { type: "text", data: `${format(value)} ${unit} = ${formatBytes(bytes)}` },
    stats: resultStats({
      Bytes: format(bytes),
      "Human readable": formatBytes(bytes),
      "Megabytes": format(bytes / 1e6),
      "Mebibytes": format(bytes / 1024 ** 2),
    }),
  };
};

export const utilityEngines: Record<string, ToolEngine> = {
  "qr-code-generator": qrCodeGenerator,
  "barcode-generator": barcodeGenerator,
  "color-converter": colorConverter,
  "hex-to-rgb": hexToRgb,
  "rgb-to-hex": rgbToHex,
  "unit-converter": unitConverter,
  "file-hash-generator": fileHashGenerator,
  "file-zip-creator": fileZipCreator,
  "file-zip-extractor": fileZipExtractor,
  "image-exif-viewer": imageExifViewer,
  "age-calculator": ageCalculator,
  "date-difference-calculator": dateDifferenceCalculator,
  "percentage-calculator": percentageCalculator,
  "image-dimensions-checker": imageDimensionsChecker,
  "file-size-converter": fileSizeConverter,
};
