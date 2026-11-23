/** Shape returned by the hashing worker in /workers/duplicate-hash.js. */
export type HashResponse = {
  id: number;
  sha256: string;
  ahash: string;
  dhash: string;
  phash: string;
};

export type ScannedImage = {
  id: number;
  file: File;
  name: string;
  path: string;
  size: number;
  type: string;
  width: number;
  height: number;
  lastModified: number;
  sha256: string;
  ahash: string;
  dhash: string;
  phash: string;
  thumbnail: string;
};

export type DuplicateGroup = {
  id: string;
  kind: "exact" | "similar";
  similarity: number;
  images: ScannedImage[];
  recommendedId: number | null;
};

export type ScanProgress = {
  stage: "idle" | "hashing" | "comparing" | "done" | "cancelled" | "error";
  processed: number;
  total: number;
  currentFile: string;
  groupsFound: number;
  duplicatesFound: number;
  message?: string;
};

export const IMAGE_EXTENSIONS = [
  "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "heif", "tif", "tiff", "svg", "ico",
];

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(extension);
}

function hashFor(image: ScannedImage, method: string): string {
  if (method === "dhash") return image.dhash;
  if (method === "ahash") return image.ahash;
  return image.phash;
}

export type KeepStrategy = "resolution" | "size" | "newest" | "oldest" | "format";

const FORMAT_PRIORITY = ["image/png", "image/webp", "image/jpeg", "image/jpg"];

function keepScore(image: ScannedImage, strategy: KeepStrategy): number {
  switch (strategy) {
    case "size":
      return image.size;
    case "newest":
      return image.lastModified;
    case "oldest":
      return -image.lastModified;
    case "format":
      return -Math.max(0, FORMAT_PRIORITY.indexOf(image.type));
    default:
      return image.width * image.height;
  }
}

export function recommendKeep(image: ScannedImage, strategy: KeepStrategy): number {
  return keepScore(image, strategy);
}

export function applyRecommendations(
  groups: DuplicateGroup[],
  strategy: KeepStrategy,
): DuplicateGroup[] {
  return groups.map((group) => {
    let best = group.images[0];
    for (const image of group.images) {
      if (keepScore(image, strategy) > keepScore(best, strategy)) best = image;
    }
    return { ...group, recommendedId: best.id };
  });
}

/* ---------------------------- grouping (in a worker) ---------------------------- */

/**
 * Groups returned before the "keep" recommendation is applied. The worker only
 * ever sees hashes and ids, so no image data crosses the boundary.
 */
export type RawGroup = {
  id: string;
  kind: "exact" | "similar";
  similarity: number;
  indices: number[];
};

let groupWorker: Worker | null = null;
let groupSequence = 0;

function groupingWorker(): Worker {
  if (!groupWorker || groupWorkerTerminated) {
    groupWorker = new Worker("/workers/duplicate-hash.js", { type: "classic" });
    groupWorkerTerminated = false;
  }
  return groupWorker;
}

let groupWorkerTerminated = false;

export function releaseGroupingWorker(): void {
  if (groupWorker) {
    groupWorker.terminate();
    groupWorker = null;
    groupWorkerTerminated = true;
  }
}

/**
 * Runs duplicate grouping in the hashing worker.
 *
 * The perceptual comparison is quadratic in the worst case, so a 5,000 image
 * folder can take seconds. Doing that inside React's render cycle froze the
 * whole page; off the main thread the interface stays responsive throughout.
 */
export function groupImages(
  images: ScannedImage[],
  threshold: number,
  method: string,
): Promise<DuplicateGroup[]> {
  if (images.length < 2) return Promise.resolve([]);

  const entries = images.map((image) => ({
    id: image.id,
    sha256: image.sha256,
    ahash: image.ahash,
    dhash: image.dhash,
    phash: image.phash,
  }));

  return new Promise<DuplicateGroup[]>((resolve, reject) => {
    const worker = groupingWorker();
    const requestId = (groupSequence += 1);
    const timeout = setTimeout(() => {
      worker.removeEventListener("message", router);
      reject(new Error("Grouping timed out."));
    }, 300_000);

    const router = (event: MessageEvent<{ id: number; groups?: RawGroup[]; error?: string }>) => {
      if (event.data.id !== requestId) return;
      clearTimeout(timeout);
      worker.removeEventListener("message", router);
      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }
      const raw = event.data.groups ?? [];
      const byId = new Map(images.map((image) => [image.id, image]));
      resolve(
        raw.map((group) => ({
          id: group.id,
          kind: group.kind,
          similarity: group.similarity,
          images: group.indices
            .map((id) => byId.get(id))
            .filter((image): image is ScannedImage => Boolean(image)),
          recommendedId: null,
        })),
      );
    };

    worker.addEventListener("message", router);
    worker.postMessage({ type: "group", id: requestId, entries, threshold, method });
  });
}

/* ------------------------------ scanning engine ----------------------------- */

function createHashWorker(): Worker {
  // Plain JS asset served from /public so every browser can execute it without
  // a bundling step. Each worker is independent, so the pool scales cleanly.
  return new Worker("/workers/duplicate-hash.js", { type: "classic" });
}

async function decodeBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    } catch {
      /* fall through to the HTMLImageElement path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error(`${file.name} cannot be decoded as an image in this browser.`));
      image.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

function guessType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };
  return map[extension] ?? "application/octet-stream";
}

export type ScanHandle = {
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  promise: Promise<{ images: ScannedImage[]; skipped: string[]; cancelled: boolean }>;
};

/**
 * Scans a list of files using a pool of Web Workers. Files are handled one
 * batch at a time and each decoded bitmap is released immediately, so memory
 * stays flat even for folders containing thousands of images.
 */
export function scanFiles(
  files: File[],
  callbacks: {
    onProgress: (progress: ScanProgress) => void;
    thumbnailSize?: number;
    batchSize?: number;
    concurrency?: number;
  },
): ScanHandle {
  const state = { cancelled: false, paused: false };
  const concurrency = Math.max(1, Math.min(callbacks.concurrency ?? 3, 6));
  const batchSize = callbacks.batchSize ?? 10;
  const thumbnailSize = callbacks.thumbnailSize ?? 220;

  const workers: Worker[] = Array.from({ length: concurrency }, () => createHashWorker());

  /**
   * Rejections for in-flight hashes. Without this, terminating the worker pool
   * on cancel left these promises unsettled forever, so `handle.promise` never
   * settled and the UI stayed stuck on "Scanning…".
   */
  const abortListeners = new Set<() => void>();

  const hashOne = (requestId: number, payload: { buffer: ArrayBuffer; pixels: ArrayBuffer }) =>
    new Promise<HashResponse>((resolve, reject) => {
      const worker = workers[requestId % workers.length];
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.removeEventListener("message", router);
        abortListeners.delete(abort);
        reject(new Error("Hashing timed out."));
      }, 120_000);
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener("message", router);
        reject(new DOMException("Scan cancelled", "AbortError"));
      };
      abortListeners.add(abort);
      const router = (event: MessageEvent<HashResponse & { error?: string }>) => {
        if (event.data.id !== requestId) return;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener("message", router);
        abortListeners.delete(abort);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.addEventListener("message", router);
      worker.postMessage(
        { id: requestId, buffer: payload.buffer, pixels: payload.pixels, width: 32, height: 32 },
        [payload.buffer, payload.pixels],
      );
    });

  const promise = (async (): Promise<{
    images: ScannedImage[];
    skipped: string[];
    cancelled: boolean;
  }> => {
    const images: ScannedImage[] = [];
    const skipped: string[] = [];
    let processed = 0;
    let requestId = 0;

    for (let offset = 0; offset < files.length; offset += batchSize) {
      if (state.cancelled) break;
      // Pause parks the loop between batches rather than mid-file.
      while (state.paused && !state.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (state.cancelled) break;

      const batch = files.slice(offset, offset + batchSize);
      const settled = await Promise.all(
        batch.map(async (file) => {
          const id = requestId;
          requestId += 1;
          try {
            const buffer = await file.arrayBuffer();
            if (state.cancelled) throw new DOMException("Scan cancelled", "AbortError");

            const bitmap = await decodeBitmap(file);
            const width = bitmap.width;
            const height = bitmap.height;

            const hashCanvas = document.createElement("canvas");
            hashCanvas.width = 32;
            hashCanvas.height = 32;
            const hashCtx = hashCanvas.getContext("2d", { willReadFrequently: true });
            if (!hashCtx) throw new Error("Canvas is unavailable.");
            hashCtx.drawImage(bitmap, 0, 0, 32, 32);
            const pixels = hashCtx.getImageData(0, 0, 32, 32).data.buffer.slice(0);

            const scale = Math.min(1, thumbnailSize / Math.max(width, height));
            const thumbCanvas = document.createElement("canvas");
            thumbCanvas.width = Math.max(1, Math.round(width * scale));
            thumbCanvas.height = Math.max(1, Math.round(height * scale));
            const thumbCtx = thumbCanvas.getContext("2d");
            if (!thumbCtx) throw new Error("Canvas is unavailable.");
            thumbCtx.imageSmoothingQuality = "medium";
            thumbCtx.drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
            const thumbnail = thumbCanvas.toDataURL("image/jpeg", 0.7);

            // Release the decoded bitmap before hashing keeps memory flat.
            if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

            const hashed = await hashOne(id, { buffer, pixels });

            const image: ScannedImage = {
              id,
              file,
              name: file.name,
              path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
              size: file.size,
              type: file.type || guessType(file.name),
              width,
              height,
              lastModified: file.lastModified,
              sha256: hashed.sha256,
              ahash: hashed.ahash,
              dhash: hashed.dhash,
              phash: hashed.phash,
              thumbnail,
            };
            return { ok: true as const, image };
          } catch (error) {
            return {
              ok: false as const,
              name: file.name,
              cancelled: error instanceof DOMException && error.name === "AbortError",
              reason: error instanceof Error ? error.message : "unreadable file",
            };
          }
        }),
      );

      let aborted = false;
      for (const result of settled) {
        if (result.ok) {
          images.push(result.image);
        } else if (result.cancelled) {
          aborted = true;
        } else {
          skipped.push(`${result.name} — ${result.reason}`);
        }
      }
      if (aborted || state.cancelled) break;

      processed += batch.length;
      callbacks.onProgress({
        stage: "hashing",
        processed: Math.min(processed, files.length),
        total: files.length,
        currentFile: batch[batch.length - 1]?.name ?? "",
        groupsFound: 0,
        duplicatesFound: 0,
        message: `Hashing ${Math.min(processed, files.length)} of ${files.length} images in the background`,
      });
    }

    // Tear the pool down and release anything still in flight.
    abortListeners.forEach((abort) => abort());
    abortListeners.clear();
    workers.forEach((worker) => worker.terminate());

    return { images, skipped, cancelled: state.cancelled };
  })();

  return {
    cancel: () => {
      state.cancelled = true;
      abortListeners.forEach((abort) => abort());
      abortListeners.clear();
      workers.forEach((worker) => worker.terminate());
    },
    pause: () => {
      state.paused = true;
    },
    resume: () => {
      state.paused = false;
    },
    promise,
  };
}

/* ------------------------- deletion & clean export -------------------------- */

export async function deleteWithDirectoryHandle(
  directory: FileSystemDirectoryHandle,
  paths: string[],
): Promise<{ deleted: string[]; failed: { path: string; reason: string }[] }> {
  const deleted: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
      failed.push({ path, reason: "Invalid path" });
      continue;
    }
    try {
      let handle: FileSystemDirectoryHandle = directory;
      for (const part of parts) handle = await handle.getDirectoryHandle(part);
      await handle.removeEntry(fileName, { recursive: false });
      deleted.push(path);
    } catch (error) {
      failed.push({ path, reason: error instanceof Error ? error.message : "Could not delete" });
    }
  }
  return { deleted, failed };
}

export async function buildCleanedZip(
  keep: { name: string; blob: Blob }[],
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const { zip } = await import("fflate");
  const entries: Record<string, Uint8Array> = {};
  for (let index = 0; index < keep.length; index += 1) {
    entries[keep[index].name] = new Uint8Array(await keep[index].blob.arrayBuffer());
    onProgress?.(((index + 1) / keep.length) * 100);
  }
  const buffer = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 0 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
  return new Blob([buffer.slice()], { type: "application/zip" });
}
