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
import { createCanvas, encodeCanvas, extensionFor, hexToRgb, loadImage } from "./canvas";
import { resultStats } from "./archive";

function imageArtifact(name: string, blob: Blob): EngineArtifact {
  return { name, blob, kind: "image" };
}

const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/* ------------------------- HEIC decoding (WASM, local) ----------------------- */

async function decodeHeic(file: File): Promise<Blob> {
  // Safari decodes HEIC natively, so try that first before loading the WASM decoder.
  try {
    const bitmap = await createImageBitmap(file);
    return await new Promise<Blob>((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas unavailable"));
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Encode failed"))), "image/png");
    });
  } catch {
    /* fall through to the WASM decoder */
  }

  try {
    const heic2any = (await import("heic2any")).default;
    const converted = await heic2any({ blob: file, toType: "image/png" });
    return Array.isArray(converted) ? converted[0] : converted;
  } catch {
    engineError(
      `${file.name} could not be decoded. HEIC support needs Safari's native decoder or the bundled WebAssembly decoder, and this browser provided neither.`,
    );
  }
}

export async function loadAnyImage(file: File) {
  const isHeic =
    /heic|heif/i.test(file.type) || /\.heic$|\.heif$/i.test(file.name) || !file.type;
  if (isHeic) {
    const decoded = await decodeHeic(file);
    return loadImage(decoded);
  }
  try {
    return await loadImage(file);
  } catch (error) {
    // Some browsers report an empty MIME type for HEIC; retry through the decoder.
    if (!file.type) {
      const decoded = await decodeHeic(file);
      return loadImage(decoded);
    }
    engineError(
      error instanceof Error
        ? error.message
        : `${file.name} is not a decodable image in this browser.`,
    );
  }
}

/* ----------------------------- generic converter ----------------------------- */

function makeFormatConverter(config: {
  target: string;
  qualityDefault: number;
  label: string;
  suffix: string;
  losslessOption?: boolean;
}): ToolEngine {
  return async (ctx) => {
    const files = requireFiles(ctx);
    const quality = clamp(num(ctx.options, "quality", config.qualityDefault), 10, 100) / 100;
    const lossless = config.losslessOption ? bool(ctx.options, "lossless", false) : false;
    const artifacts: EngineArtifact[] = [];
    let inputBytes = 0;
    let outputBytes = 0;
    const type = config.target;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      ctx.report((index / files.length) * 100, `Converting ${file.name}`);
      const source = await loadAnyImage(file);
      const { canvas, ctx: c2d } = createCanvas(source.width, source.height);
      if (type === "image/jpeg") {
        const background = str(ctx.options, "background", "#ffffff");
        const { r, g, b } = hexToRgb(background);
        c2d.fillStyle = `rgb(${r},${g},${b})`;
        c2d.fillRect(0, 0, canvas.width, canvas.height);
      }
      c2d.imageSmoothingEnabled = false;
      c2d.drawImage(source, 0, 0);

      const encoderQuality = lossless || type === "image/png" ? 1 : quality;
      const blob = await encodeCanvas(canvas, type, encoderQuality);
      inputBytes += file.size;
      outputBytes += blob.size;
      artifacts.push(
        imageArtifact(`${baseName(file.name)}${config.suffix}.${extensionFor(type)}`, blob),
      );
    }

    return {
      artifacts,
      stats: resultStats({
        Files: artifacts.length,
        "Input size": `${(inputBytes / 1024 / 1024).toFixed(2)} MB`,
        "Output size": `${(outputBytes / 1024 / 1024).toFixed(2)} MB`,
        Change: `${inputBytes ? Math.round(((outputBytes - inputBytes) / inputBytes) * 100) : 0}%`,
        Format: config.label,
      }),
    };
  };
}

export const jpgToPng = makeFormatConverter({
  target: "image/png",
  qualityDefault: 100,
  label: "PNG (lossless)",
  suffix: "",
});

export const pngToJpg = makeFormatConverter({
  target: "image/jpeg",
  qualityDefault: 92,
  label: "JPEG",
  suffix: "",
});

export const webpToJpg = makeFormatConverter({
  target: "image/jpeg",
  qualityDefault: 92,
  label: "JPEG",
  suffix: "",
});

export const jpgToWebp = makeFormatConverter({
  target: "image/webp",
  qualityDefault: 82,
  label: "WebP",
  suffix: "",
});

export const pngToWebp = makeFormatConverter({
  target: "image/webp",
  qualityDefault: 88,
  label: "WebP (alpha kept)",
  suffix: "",
  losslessOption: true,
});

export const imageConverter = makeFormatConverter({
  target: "image/webp",
  qualityDefault: 90,
  label: "WebP",
  suffix: "",
});

/* --------------------------------- HEIC tool -------------------------------- */

export const heicToJpg: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const type = str(ctx.options, "format", "image/jpeg");
  const quality = clamp(num(ctx.options, "quality", 92), 40, 100) / 100;
  const maxWidth = num(ctx.options, "maxWidth", 0);
  const artifacts: EngineArtifact[] = [];
  let inputBytes = 0;
  let outputBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Decoding ${file.name}`);
    const source = await loadAnyImage(file);
    const scale = maxWidth > 0 ? Math.min(1, maxWidth / source.width) : 1;
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const { canvas, ctx: c2d } = createCanvas(width, height);
    if (type === "image/jpeg") {
      c2d.fillStyle = "#ffffff";
      c2d.fillRect(0, 0, width, height);
    }
    c2d.imageSmoothingQuality = "high";
    c2d.drawImage(source, 0, 0, width, height);
    const blob = await encodeCanvas(canvas, type, quality);
    inputBytes += file.size;
    outputBytes += blob.size;
    artifacts.push(imageArtifact(`${baseName(file.name)}.${extensionFor(type)}`, blob));
  }

  return {
    artifacts,
    stats: resultStats({
      Photos: artifacts.length,
      "Input size": `${(inputBytes / 1024 / 1024).toFixed(2)} MB`,
      "Output size": `${(outputBytes / 1024 / 1024).toFixed(2)} MB`,
      Format: type === "image/png" ? "PNG" : type === "image/webp" ? "WebP" : "JPEG",
    }),
  };
};

/* ------------------------------- text overlay -------------------------------- */

type OverlayConfig = {
  defaultSize: number;
  defaultWeight: string;
  defaultOpacity: number;
  shadow: boolean;
  outline: boolean;
};

function makeTextOverlay(config: OverlayConfig): ToolEngine {
  return async (ctx) => {
    const files = requireFiles(ctx);
    const text = (ctx.text || "").trim();
    if (!text) engineError("Type the text you want to place on the image.");
    const position = str(ctx.options, "position", "bottom-center");
    const sizePercent = clamp(num(ctx.options, "size", config.defaultSize), 1, 40) / 100;
    const weight = str(ctx.options, "weight", config.defaultWeight);
    const color = str(ctx.options, "color", "#ffffff");
    const opacity = clamp(num(ctx.options, "opacity", config.defaultOpacity), 5, 100) / 100;
    const format = str(ctx.options, "format", "image/jpeg");
    const quality = 0.94;
    const artifacts: EngineArtifact[] = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      ctx.report((index / files.length) * 100, `Labelling ${file.name}`);
      const source = await loadAnyImage(file);
      const { canvas, ctx: c2d } = createCanvas(source.width, source.height);
      if (format === "image/jpeg") {
        c2d.fillStyle = "#ffffff";
        c2d.fillRect(0, 0, canvas.width, canvas.height);
      }
      c2d.drawImage(source, 0, 0);

      const fontSize = Math.max(10, Math.round(canvas.width * sizePercent));
      c2d.save();
      c2d.font = `${weight} ${fontSize}px ${FONT_STACK}`;
      c2d.textBaseline = "middle";
      c2d.textAlign = "center";
      c2d.globalAlpha = opacity;

      const lines = text.split(/\n/).slice(0, 6);
      const lineHeight = fontSize * 1.25;
      const blockHeight = lineHeight * lines.length;
      const [vertical, horizontal] = position.split("-");
      const padding = Math.round(canvas.width * (num(ctx.options, "padding", 4) / 100));
      const x =
        horizontal === "left"
          ? padding + (canvas.width * 0.2) / 2
          : horizontal === "right"
            ? canvas.width - padding - (canvas.width * 0.2) / 2
            : canvas.width / 2;
      const startY =
        vertical === "top"
          ? padding + blockHeight / 2
          : vertical === "bottom"
            ? canvas.height - padding - blockHeight / 2
            : canvas.height / 2;

      lines.forEach((line, lineIndex) => {
        const y = startY - blockHeight / 2 + lineHeight * (lineIndex + 0.5);
        if (config.outline && bool(ctx.options, "outline", true)) {
          c2d.lineWidth = Math.max(2, fontSize * 0.11);
          c2d.strokeStyle = "rgba(0,0,0,0.78)";
          c2d.lineJoin = "round";
          c2d.strokeText(line, x, y);
        }
        if (config.shadow && bool(ctx.options, "shadow", true)) {
          c2d.shadowColor = "rgba(0,0,0,0.5)";
          c2d.shadowBlur = fontSize * 0.18;
          c2d.shadowOffsetY = 1;
        }
        c2d.fillStyle = color;
        c2d.fillText(line, x, y);
      });
      c2d.restore();

      const blob = await encodeCanvas(canvas, format, quality);
      artifacts.push(
        imageArtifact(`${baseName(file.name)}-labelled.${extensionFor(format)}`, blob),
      );
    }

    return {
      artifacts,
      stats: resultStats({
        Images: artifacts.length,
        Text: text,
        "Font size": `${Math.round(sizePercent * 100)}% of width`,
      }),
    };
  };
}

export const imageTextOverlay = makeTextOverlay({
  defaultSize: 9,
  defaultWeight: "700",
  defaultOpacity: 100,
  shadow: false,
  outline: true,
});

export const imageWatermarker = makeTextOverlay({
  defaultSize: 7,
  defaultWeight: "600",
  defaultOpacity: 55,
  shadow: true,
  outline: false,
});

export const formatConverterEngines: Record<string, ToolEngine> = {
  "jpg-to-png": jpgToPng,
  "png-to-jpg": pngToJpg,
  "webp-to-jpg": webpToJpg,
  "jpg-to-webp": jpgToWebp,
  "png-to-webp": pngToWebp,
  "heic-to-jpg": heicToJpg,
  "image-converter": imageConverter,
  "image-text-overlay": imageTextOverlay,
  "image-watermarker": imageWatermarker,
};

export { requireFile };
