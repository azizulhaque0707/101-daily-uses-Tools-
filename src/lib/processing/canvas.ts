import { ToolError } from "@/lib/tools/types";

export type DrawableSource = CanvasImageSource & { width: number; height: number };

export async function loadImage(file: File | Blob): Promise<DrawableSource> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    } catch {
      /* fall through to the HTMLImageElement path */
    }
  }
  return new Promise<DrawableSource>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ToolError("That file could not be decoded as an image."));
    };
    image.src = url;
  });
}

export function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new ToolError("Canvas is unavailable in this browser.");
  return { canvas, ctx };
}

export function drawToCanvas(
  source: DrawableSource,
  width?: number,
  height?: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const { canvas, ctx } = createCanvas(width ?? source.width, height ?? source.height);
  ctx.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality = 0.92,
): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  );
  if (!blob) throw new ToolError("This browser cannot encode that image format.");
  return blob;
}

export function resolveImageType(file: File, requested: string): string {
  if (requested && requested !== "auto") return requested;
  const type = file.type;
  if (type && type !== "image/gif" && type.startsWith("image/") && type !== "image/jpg") {
    return type;
  }
  return "image/png";
}

export function extensionFor(type: string): string {
  switch (type) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
      return "png";
    case "image/avif":
      return "avif";
    case "application/pdf":
      return "pdf";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "video/webm":
      return "webm";
    case "video/mp4":
      return "mp4";
    case "text/html":
      return "html";
    case "text/csv":
      return "csv";
    case "application/json":
      return "json";
    default:
      return "txt";
  }
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => char + char)
          .join("")
      : clean;
  const value = Number.parseInt(full || "000000", 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

export function svgToBlob(svg: string): Blob {
  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

export async function svgToPngBlob(svg: string, width: number, height: number): Promise<Blob> {
  const blob = svgToBlob(svg);
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new ToolError("Could not rasterise the SVG."));
      element.src = url;
    });
    const { canvas, ctx } = createCanvas(width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return await encodeCanvas(canvas, "image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
