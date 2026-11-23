import {
  bool,
  engineError,
  num,
  requireFile,
  requireFiles,
  str,
  type EngineArtifact,
  type EngineContext,
  type EngineResult,
  type ToolEngine,
} from "@/lib/tools/types";
import { baseName, clamp, extensionOf } from "@/lib/utils";
import {
  createCanvas,
  drawToCanvas,
  encodeCanvas,
  extensionFor,
  hexToRgb,
  loadImage,
  resolveImageType,
} from "./canvas";
import { resultStats, textArtifact } from "./archive";
import {
  heicToJpg,
  imageConverter,
  imageTextOverlay,
  imageWatermarker,
  jpgToPng,
  jpgToWebp,
  loadAnyImage,
  pngToJpg,
  pngToWebp,
  webpToJpg,
} from "./image-convert";

function imageArtifact(name: string, blob: Blob): EngineArtifact {
  return { name, blob, kind: "image" };
}

async function emitImage(
  canvas: HTMLCanvasElement,
  file: File,
  type: string,
  quality: number,
  suffix: string,
): Promise<EngineResult> {
  const blob = await encodeCanvas(canvas, type, quality);
  const ext = extensionFor(type);
  const name = `${baseName(file.name)}${suffix}.${ext}`;
  return {
    artifacts: [imageArtifact(name, blob)],
    stats: resultStats({
      "Original size": `${(file.size / 1024).toFixed(1)} KB`,
      "New size": `${(blob.size / 1024).toFixed(1)} KB`,
      Dimensions: `${canvas.width} × ${canvas.height} px`,
      Format: type.replace("image/", "").toUpperCase(),
    }),
  };
}

/* ------------------------------ shared filters ----------------------------- */

function applyFilter(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  filter: string,
): void {
  if (!filter) return;
  const snapshot = createCanvas(canvas.width, canvas.height);
  snapshot.ctx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.filter = filter;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(snapshot.canvas, 0, 0);
  ctx.restore();
}

function pixelLoop(
  canvas: HTMLCanvasElement,
  transform: (r: number, g: number, b: number, a: number) => [number, number, number, number],
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) engineError("Canvas is unavailable.");
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height);
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = transform(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
    pixels[i] = clamp(r, 0, 255);
    pixels[i + 1] = clamp(g, 0, 255);
    pixels[i + 2] = clamp(b, 0, 255);
    pixels[i + 3] = clamp(a, 0, 255);
  }
  ctx.putImageData(data, 0, 0);
}

function convolve(canvas: HTMLCanvasElement, kernel: number[], divisor = 1) {
  const ctx = canvas.getContext("2d");
  if (!ctx) engineError("Canvas is unavailable.");
  const { width, height } = canvas;
  const source = ctx.getImageData(0, 0, width, height);
  const output = ctx.createImageData(width, height);
  const side = Math.round(Math.sqrt(kernel.length));
  const half = Math.floor(side / 2);
  const src = source.data;
  const dst = output.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let ky = 0; ky < side; ky += 1) {
        for (let kx = 0; kx < side; kx += 1) {
          const sampleY = clamp(y + ky - half, 0, height - 1);
          const sampleX = clamp(x + kx - half, 0, width - 1);
          const offset = (sampleY * width + sampleX) * 4;
          const weight = kernel[ky * side + kx];
          r += src[offset] * weight;
          g += src[offset + 1] * weight;
          b += src[offset + 2] * weight;
        }
      }
      const target = (y * width + x) * 4;
      dst[target] = clamp(r / divisor, 0, 255);
      dst[target + 1] = clamp(g / divisor, 0, 255);
      dst[target + 2] = clamp(b / divisor, 0, 255);
      dst[target + 3] = src[target + 3];
    }
  }
  ctx.putImageData(output, 0, 0);
}

function scaleForMax(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  let w = width;
  let h = height;
  if (maxWidth > 0 && w > maxWidth) {
    h = Math.round((h * maxWidth) / w);
    w = maxWidth;
  }
  if (maxHeight > 0 && h > maxHeight) {
    w = Math.round((w * maxHeight) / h);
    h = maxHeight;
  }
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/* --------------------------------- engines --------------------------------- */

export const imageCompressor: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const quality = clamp(num(ctx.options, "quality", 75), 5, 100) / 100;
  const requested = str(ctx.options, "format", "auto");
  const maxWidth = num(ctx.options, "maxWidth", 0);
  const maxHeight = num(ctx.options, "maxHeight", 0);
  const artifacts: EngineArtifact[] = [];
  let inputBytes = 0;
  let outputBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Compressing ${file.name}`);
    const source = await loadAnyImage(file);
    const type = resolveImageType(file, requested) === "image/png" && quality < 1
      ? resolveImageType(file, requested)
      : resolveImageType(file, requested);
    const target = scaleForMax(source.width, source.height, maxWidth, maxHeight);
    const { canvas, ctx: c2d } = createCanvas(target.width, target.height);
    if (type === "image/jpeg") {
      c2d.fillStyle = "#ffffff";
      c2d.fillRect(0, 0, canvas.width, canvas.height);
    }
    c2d.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await encodeCanvas(canvas, type, quality);
    inputBytes += file.size;
    outputBytes += blob.size;
    artifacts.push(
      imageArtifact(`${baseName(file.name)}-compressed.${extensionFor(type)}`, blob),
    );
  }

  return {
    artifacts,
    stats: resultStats({
      Files: artifacts.length,
      "Original size": `${(inputBytes / 1024 / 1024).toFixed(2)} MB`,
      "New size": `${(outputBytes / 1024 / 1024).toFixed(2)} MB`,
      Saving: `${inputBytes ? Math.max(0, Math.round(((inputBytes - outputBytes) / inputBytes) * 100)) : 0}%`,
    }),
  };
};

export const imageResizer: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const width = num(ctx.options, "width", 1280);
  const height = num(ctx.options, "height", 720);
  const fit = str(ctx.options, "fit", "cover");
  const format = str(ctx.options, "format", "auto");
  const quality = clamp(num(ctx.options, "quality", 92), 10, 100) / 100;
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Resizing ${file.name}`);
    const source = await loadAnyImage(file);
    const type = resolveImageType(file, format);
    const { canvas, ctx: c2d } = createCanvas(width, height);
    const scaleX = canvas.width / source.width;
    const scaleY = canvas.height / source.height;
    const scale = fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    const drawWidth = fit === "stretch" ? canvas.width : source.width * scale;
    const drawHeight = fit === "stretch" ? canvas.height : source.height * scale;
    if (type === "image/jpeg") {
      c2d.fillStyle = "#ffffff";
      c2d.fillRect(0, 0, canvas.width, canvas.height);
    }
    c2d.imageSmoothingQuality = "high";
    c2d.drawImage(
      source,
      (canvas.width - drawWidth) / 2,
      (canvas.height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    const blob = await encodeCanvas(canvas, type, quality);
    artifacts.push(
      imageArtifact(`${baseName(file.name)}-${canvas.width}x${canvas.height}.${extensionFor(type)}`, blob),
    );
  }

  return { artifacts, stats: resultStats({ Resized: artifacts.length, "Target size": `${width} × ${height} px` }) };
};

export const imageCropper: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const source = await loadAnyImage(file);
  const x = clamp(num(ctx.options, "x", 10), 0, 99) / 100;
  const y = clamp(num(ctx.options, "y", 10), 0, 99) / 100;
  const w = clamp(num(ctx.options, "w", 80), 1, 100) / 100;
  const h = clamp(num(ctx.options, "h", 80), 1, 100) / 100;
  const type = resolveImageType(file, str(ctx.options, "format", "auto"));

  const sx = Math.round(source.width * x);
  const sy = Math.round(source.height * y);
  const sw = Math.max(1, Math.round(source.width * w));
  const sh = Math.max(1, Math.round(source.height * h));
  const { canvas, ctx: c2d } = createCanvas(sw, sh);
  if (type === "image/jpeg") {
    c2d.fillStyle = "#ffffff";
    c2d.fillRect(0, 0, sw, sh);
  }
  c2d.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return emitImage(canvas, file, type, 0.95, "-cropped");
};

export const imageRotator: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const angle = num(ctx.options, "angle", 90);
  const background = str(ctx.options, "background", "#ffffff");
  const type = str(ctx.options, "format", "image/png");
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Rotating ${file.name}`);
    const source = await loadAnyImage(file);
    const radians = (angle * Math.PI) / 180;
    const sin = Math.abs(Math.sin(radians));
    const cos = Math.abs(Math.cos(radians));
    const width = Math.round(source.width * cos + source.height * sin);
    const height = Math.round(source.width * sin + source.height * cos);
    const { canvas, ctx: c2d } = createCanvas(width, height);
    const { r, g, b } = hexToRgb(background);
    c2d.fillStyle = `rgb(${r},${g},${b})`;
    c2d.fillRect(0, 0, width, height);
    c2d.translate(width / 2, height / 2);
    c2d.rotate(radians);
    c2d.drawImage(source, -source.width / 2, -source.height / 2);
    const blob = await encodeCanvas(canvas, type, 0.95);
    artifacts.push(imageArtifact(`${baseName(file.name)}-rotated.${extensionFor(type)}`, blob));
  }
  return { artifacts };
};

export const imageFlipper: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const horizontal = bool(ctx.options, "horizontal", true);
  const vertical = bool(ctx.options, "vertical", false);
  if (!horizontal && !vertical) engineError("Enable at least one flip axis.");
  const type = str(ctx.options, "format", "auto");
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Flipping ${file.name}`);
    const source = await loadAnyImage(file);
    const outputType = resolveImageType(file, type);
    const { canvas, ctx: c2d } = createCanvas(source.width, source.height);
    c2d.translate(horizontal ? canvas.width : 0, vertical ? canvas.height : 0);
    c2d.scale(horizontal ? -1 : 1, vertical ? -1 : 1);
    c2d.drawImage(source, 0, 0);
    const blob = await encodeCanvas(canvas, outputType, 0.95);
    artifacts.push(imageArtifact(`${baseName(file.name)}-flipped.${extensionFor(outputType)}`, blob));
  }
  return { artifacts };
};




export const imageBlur: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const radius = clamp(num(ctx.options, "radius", 10), 0, 60);
  const regionOnly = bool(ctx.options, "regionOnly", false);
  const type = str(ctx.options, "format", "image/png");
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Blurring ${file.name}`);
    const source = await loadAnyImage(file);
    const { canvas, ctx: c2d } = drawToCanvas(source);

    if (radius > 0) {
      if (!regionOnly) {
        applyFilter(c2d, canvas, `blur(${radius}px)`);
      } else {
        const rx = Math.round((clamp(num(ctx.options, "x", 25), 0, 99) / 100) * canvas.width);
        const ry = Math.round((clamp(num(ctx.options, "y", 25), 0, 99) / 100) * canvas.height);
        const rw = Math.max(4, Math.round((clamp(num(ctx.options, "w", 50), 1, 100) / 100) * canvas.width));
        const rh = Math.max(4, Math.round((clamp(num(ctx.options, "h", 50), 1, 100) / 100) * canvas.height));

        // Blur the region by drawing a downscaled copy back at full size.
        const steps = Math.max(1, Math.ceil(radius / 3));
        let working = createCanvas(canvas.width, canvas.height);
        working.ctx.drawImage(canvas, 0, 0);
        for (let step = 0; step < steps; step += 1) {
          const next = createCanvas(canvas.width, canvas.height);
          next.ctx.filter = "blur(2px)";
          next.ctx.drawImage(working.canvas, 0, 0);
          working = next;
        }
        c2d.save();
        c2d.beginPath();
        c2d.rect(rx, ry, rw, rh);
        c2d.clip();
        c2d.drawImage(working.canvas, 0, 0);
        c2d.restore();
      }
    }

    const blob = await encodeCanvas(canvas, type, 0.94);
    artifacts.push(imageArtifact(`${baseName(file.name)}-blurred.${extensionFor(type)}`, blob));
  }
  return { artifacts };
};

export const imageSharpen: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const amount = clamp(num(ctx.options, "amount", 100), 0, 300) / 100;
  const type = str(ctx.options, "format", "image/png");
  const artifacts: EngineArtifact[] = [];
  const center = 1 + 4 * amount;
  const kernel = [0, -amount, 0, -amount, center, -amount, 0, -amount, 0];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Sharpening ${file.name}`);
    const source = await loadAnyImage(file);
    const { canvas } = drawToCanvas(source);
    if (amount > 0) convolve(canvas, kernel);
    const blob = await encodeCanvas(canvas, type, 0.95);
    artifacts.push(imageArtifact(`${baseName(file.name)}-sharpened.${extensionFor(type)}`, blob));
  }
  return { artifacts };
};

export const imageAdjust: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const brightness = clamp(num(ctx.options, "brightness", 100), 0, 200);
  const contrast = clamp(num(ctx.options, "contrast", 100), 0, 200);
  const saturation = clamp(num(ctx.options, "saturation", 100), 0, 200);
  const type = str(ctx.options, "format", "image/jpeg");
  const artifacts: EngineArtifact[] = [];
  const filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Adjusting ${file.name}`);
    const source = await loadAnyImage(file);
    const { canvas, ctx: c2d } = drawToCanvas(source);
    applyFilter(c2d, canvas, filter);
    const blob = await encodeCanvas(canvas, type, 0.94);
    artifacts.push(imageArtifact(`${baseName(file.name)}-adjusted.${extensionFor(type)}`, blob));
  }
  return { artifacts };
};



export const imagePixelate: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const block = Math.max(2, Math.round(num(ctx.options, "block", 16)));
  const regionOnly = bool(ctx.options, "regionOnly", false);
  const type = str(ctx.options, "format", "image/png");
  const source = await loadAnyImage(file);

  const width = Math.max(1, Math.round(source.width / block));
  const height = Math.max(1, Math.round(source.height / block));
  const small = createCanvas(width, height);
  small.ctx.imageSmoothingEnabled = true;
  small.ctx.drawImage(source, 0, 0, width, height);
  const { canvas, ctx: c2d } = drawToCanvas(source);
  c2d.imageSmoothingEnabled = false;

  if (regionOnly) {
    const rx = Math.round((clamp(num(ctx.options, "x", 25), 0, 99) / 100) * canvas.width);
    const ry = Math.round((clamp(num(ctx.options, "y", 25), 0, 99) / 100) * canvas.height);
    const rw = Math.max(block, Math.round((clamp(num(ctx.options, "w", 50), 1, 100) / 100) * canvas.width));
    const rh = Math.max(block, Math.round((clamp(num(ctx.options, "h", 50), 1, 100) / 100) * canvas.height));
    c2d.drawImage(small.canvas, 0, 0, width, height, rx, ry, rw, rh);
  } else {
    c2d.drawImage(small.canvas, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
  }

  return emitImage(canvas, file, type, 0.95, "-pixelated");
};




export const imageToBase64: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const mode = str(ctx.options, "mode", "datauri");
  const format = str(ctx.options, "format", "auto");
  const source = await loadAnyImage(file);
  const type = resolveImageType(file, format);
  const { canvas } = drawToCanvas(source);
  const blob = await encodeCanvas(canvas, type, 0.92);
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  const output = mode === "raw" ? base64 : `data:${type};base64,${base64}`;
  return {
    artifacts: [textArtifact(`${baseName(file.name)}-base64.txt`, output)],
    preview: { type: "text", data: output.slice(0, 4000) },
    stats: resultStats({
      "Original size": `${(file.size / 1024).toFixed(1)} KB`,
      "Base64 length": output.length.toLocaleString("en-US"),
      Format: type,
    }),
  };
};

export const base64ToImage: ToolEngine = async (ctx) => {
  const raw = (ctx.text || "").trim();
  if (!raw) engineError("Paste a Base64 string or data URI first.");
  const cleaned = raw.replace(/^data:([^;]+);base64,/, (match) => match);
  const isDataUri = raw.startsWith("data:");
  const mimeMatch = /^data:([^;]+);/.exec(raw);
  const mime = isDataUri && mimeMatch ? mimeMatch[1] : "image/png";
  const body = isDataUri ? raw.slice(raw.indexOf(",") + 1) : raw.replace(/\s+/g, "");
  const binary = atob(body.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const name = `${str(ctx.options, "filename", "decoded-image") || "decoded-image"}.${extensionFor(mime)}`;
  return {
    artifacts: [imageArtifact(name, blob)],
    stats: resultStats({
      Format: mime,
      "Decoded size": `${(blob.size / 1024).toFixed(1)} KB`,
    }),
    notice: cleaned.length > 0 ? undefined : undefined,
  };
};


export const imageEngines: Record<string, ToolEngine> = {
  "image-compressor": imageCompressor,
  "image-resizer": imageResizer,
  "image-cropper": imageCropper,
  "image-rotator": imageRotator,
  "image-flipper": imageFlipper,
  "image-converter": imageConverter,
  "jpg-to-png": jpgToPng,
  "png-to-jpg": pngToJpg,
  "webp-to-jpg": webpToJpg,
  "jpg-to-webp": jpgToWebp,
  "png-to-webp": pngToWebp,
  "heic-to-jpg": heicToJpg,
  "image-to-base64": imageToBase64,
  "base64-to-image": base64ToImage,
  "image-text-overlay": imageTextOverlay,
  "image-watermarker": imageWatermarker,
  "image-blur": imageBlur,
  "image-pixelate": imagePixelate,
  "image-sharpen": imageSharpen,
  "image-brightness-contrast": imageAdjust,
};

export { extensionOf };
