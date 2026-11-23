/**
 * FFmpeg.wasm client.
 *
 * A single Web Worker owns the FFmpeg core. It is created lazily the first time
 * a video or audio tool runs, and can be terminated to reclaim the ~90 MB of
 * WASM heap. The core script and WASM binary come from /vendor/ffmpeg/ inside
 * this app, so nothing is ever fetched from a CDN or external service.
 */

export type FfmpegProgress = { ratio: number; time: number };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, Pending>();
let loadingPromise: Promise<void> | null = null;

let progressHandler: ((progress: FfmpegProgress) => void) | null = null;
let logHandler: ((message: string) => void) | null = null;

const CORE_PATH = "/vendor/ffmpeg/ffmpeg-core.js";
const WASM_PATH = "/vendor/ffmpeg/ffmpeg-core.wasm";
const WORKER_PATH = "/vendor/ffmpeg/ffmpeg-bridge.js";

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(WORKER_PATH, { type: "classic" });
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as {
      type: string;
      id?: number;
      code?: number;
      data?: ArrayBuffer;
      entries?: string[];
      message?: string;
      path?: string;
    };
    const entry = data.id != null ? pending.get(data.id) : undefined;

    switch (data.type) {
      case "loaded":
      case "done":
        if (entry) {
          pending.delete(data.id as number);
          entry.resolve(data.data ?? data.code ?? 0);
        }
        break;
      case "data":
        if (entry) {
          pending.delete(data.id as number);
          entry.resolve(data.data);
        }
        break;
      case "entries":
        if (entry) {
          pending.delete(data.id as number);
          entry.resolve(data.entries ?? []);
        }
        break;
      case "error":
        if (entry) {
          pending.delete(data.id as number);
          entry.reject(new Error(data.message ?? "FFmpeg failed"));
        }
        break;
      default:
        break;
    }
  };
  worker.onerror = (event) => {
    const error = new Error(`FFmpeg worker failed: ${event.message}`);
    pending.forEach((entry) => entry.reject(error));
    pending.clear();
  };
  return worker;
}

function call<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = (sequence += 1);
  const active = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    active.postMessage({ ...message, id }, transfer);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("FFmpeg operation timed out."));
      }
    }, 15 * 60 * 1000);
  });
}

/** Loads the FFmpeg core once. Safe to call repeatedly. */
export function loadFfmpeg(onProgress?: (progress: FfmpegProgress) => void, onLog?: (message: string) => void): Promise<void> {
  progressHandler = onProgress ?? null;
  logHandler = onLog ?? null;
  if (loadingPromise) return loadingPromise;
  loadingPromise = call({ type: "load", corePath: CORE_PATH, wasmPath: WASM_PATH })
    .then(() => undefined)
    .catch((error) => {
      loadingPromise = null;
      throw error;
    });
  return loadingPromise;
}

export function isFfmpegLoaded(): boolean {
  return loadingPromise !== null && worker !== null;
}

/** Releases the worker and its WASM heap. */
export function terminateFfmpeg(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  loadingPromise = null;
  pending.forEach((entry) => entry.reject(new Error("FFmpeg was terminated.")));
  pending.clear();
}

export async function writeFile(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  await call({ type: "writeFile", path, data: bytes }, [bytes.buffer]);
}

export function readFile(path: string): Promise<Uint8Array> {
  return call<ArrayBuffer>({ type: "readFile", path }).then((buffer) => new Uint8Array(buffer));
}

export async function deleteFile(path: string): Promise<void> {
  await call({ type: "deleteFile", path });
}

export async function exec(args: string[]): Promise<number> {
  if (logHandler) logHandler(`ffmpeg ${args.join(" ")}`);
  return call<number>({ type: "exec", args });
}


export function onFfmpegProgress(handler: (progress: FfmpegProgress) => void): void {
  progressHandler = handler;
}

/* --------------------------------- commands -------------------------------- */

/**
 * Runs a command and returns the produced file.
 * Input is written, the command runs, then the output is read and cleaned up.
 */
export async function runCommand(options: {
  input: ArrayBuffer | Uint8Array;
  inputName: string;
  outputName: string;
  args: string[];
  onProgress?: (ratio: number) => void;
}): Promise<Uint8Array> {
  await loadFfmpeg(options.onProgress ? (progress) => options.onProgress?.(progress.ratio) : undefined);
  await writeFile(options.inputName, options.input);
  try {
    const code = await exec(options.args);
    if (code !== 0) {
      throw new Error(`FFmpeg exited with code ${code}. The input may use a codec this browser build cannot handle.`);
    }
    return await readFile(options.outputName);
  } finally {
    await deleteFile(options.inputName).catch(() => undefined);
    await deleteFile(options.outputName).catch(() => undefined);
  }
}

/* ------------------------- argument building helpers ------------------------ */

const PRESETS: Record<string, { crf: string; preset: string; audioBitrate: string }> = {
  "high": { crf: "18", preset: "slow", audioBitrate: "192k" },
  "balanced": { crf: "23", preset: "medium", audioBitrate: "160k" },
  "small": { crf: "28", preset: "fast", audioBitrate: "128k" },
  "tiny": { crf: "32", preset: "veryfast", audioBitrate: "96k" },
};

export function qualityPreset(name: string) {
  return PRESETS[name] ?? PRESETS.balanced;
}

/** Ensures width and height are even, which H.264 and VP9 require. */
export function evenDimension(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/** Scales to fit inside a box, preserving aspect ratio and never stretching. */
export function scaleArgs(width: number, height: number): string[] {
  const w = evenDimension(width);
  const h = evenDimension(height);
  // -1 lets FFmpeg derive the other axis, which preserves the ratio exactly.
  return ["-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease`];
}

/** Crops to a region then scales to target, so the result is never distorted. */
export function cropScaleArgs(
  sourceWidth: number,
  sourceHeight: number,
  crop: { x: number; y: number; w: number; h: number },
  targetWidth: number,
  targetHeight: number,
): string[] {
  const cw = Math.max(2, evenDimension(crop.w * sourceWidth));
  const ch = Math.max(2, evenDimension(crop.h * sourceHeight));
  const cx = Math.max(0, Math.round(crop.x * sourceWidth));
  const cy = Math.max(0, Math.round(crop.y * sourceHeight));
  const chain = [
    `crop=${cw}:${ch}:${cx}:${cy}`,
    `scale=${evenDimension(targetWidth)}:${evenDimension(targetHeight)}:force_original_aspect_ratio=decrease`,
  ];
  return ["-vf", chain.join(",")];
}

export type Container = "mp4" | "webm" | "gif" | "mp3" | "wav" | "aac" | "ogg";

/** Video codec arguments per container, with a WebM fallback for Chromium. */
export function videoCodecArgs(container: Container): string[] {
  switch (container) {
    case "webm":
      return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-c:a", "libopus"];
    case "gif":
      return ["-loop", "0"];
    default:
      // libx264 with yuv420p is the most widely playable combination.
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k"];
  }
}

export function extensionFor(container: Container): string {
  return container;
}

export function mimeFor(container: Container): string {
  switch (container) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "gif":
      return "image/gif";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "aac":
      return "audio/aac";
    case "ogg":
      return "audio/ogg";
  }
}
