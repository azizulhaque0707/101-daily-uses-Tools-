/**
 * PDF.js page rendering and inspection helpers.
 *
 * Every operation runs on the user's device. The worker script is served from
 * /public so no bundling step is needed and the browser executes it directly.
 */

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfjsDocument = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

export async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
      module.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
      return module;
    });
  }
  return pdfjsPromise;
}

export async function openPdf(data: ArrayBuffer, password?: string): Promise<PdfjsDocument> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(data), password }).promise;
}

export type PageThumb = {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
};

/**
 * Renders page thumbnails lazily, one page at a time, so a 500 page document
 * does not allocate hundreds of canvases up front.
 */
export async function renderThumbnails(
  data: ArrayBuffer,
  options: {
    maxPages?: number;
    maxWidth?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<PageThumb[]> {
  const maxPages = options.maxPages ?? 200;
  const maxWidth = options.maxWidth ?? 220;
  const doc = await openPdf(data);
  const total = Math.min(doc.numPages, maxPages);
  const thumbs: PageThumb[] = [];

  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1, maxWidth / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    }
    thumbs.push({
      pageNumber,
      dataUrl: canvas.toDataURL("image/jpeg", 0.7),
      width: base.width,
      height: base.height,
    });
    options.onProgress?.(pageNumber, total);
    page.cleanup();
  }

  await doc.cleanup?.();
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return thumbs;
}

export type PageInfo = {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  wordCount: number;
  charCount: number;
  textPreview: string;
};

export async function inspectPages(data: ArrayBuffer, maxPages = 500): Promise<PageInfo[]> {
  const doc = await openPdf(data);
  const total = Math.min(doc.numPages, maxPages);
  const pages: PageInfo[] = [];
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const text = (content.items as { str?: string }[])
      .map((item) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
      wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
      charCount: text.length,
      textPreview: text.slice(0, 240),
    });
    page.cleanup();
  }
  await doc.cleanup?.();
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return pages;
}

export type TextLine = { text: string; y: number; size: number; page: number };

/** Extracts positioned text lines with font size, used for heading detection. */
export async function extractLines(data: ArrayBuffer): Promise<TextLine[]> {
  const doc = await openPdf(data);
  const lines: TextLine[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      if (!item.str || !item.str.trim()) continue;
      const transform = item.transform;
      const height = transform ? Math.abs(transform[3]) : 11;
      lines.push({ text: item.str, y: transform ? transform[5] : 0, size: height, page: pageNumber });
    }
    page.cleanup();
  }
  await doc.cleanup?.();
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return lines;
}

/** Groups extracted lines into paragraphs based on vertical gaps. */
export function linesToParagraphs(lines: TextLine[]): { text: string; size: number }[] {
  const sorted = [...lines].sort((a, b) => a.page - b.page || b.y - a.y);
  const paragraphs: { text: string; size: number }[] = [];
  let current: { parts: string[]; size: number; y: number; page: number } | null = null;

  for (const line of sorted) {
    if (!current) {
      current = { parts: [line.text], size: line.size, y: line.y, page: line.page };
      continue;
    }
    // Same page and a gap smaller than ~1.6 line heights continues a paragraph.
    const gap = current.y - line.y;
    const sameBlock = line.page === current.page && gap < line.size * 1.6 && gap > -line.size;
    if (sameBlock) {
      current.parts.push(line.text);
      current.y = line.y;
      current.size = Math.max(current.size, line.size);
    } else {
      paragraphs.push({ text: current.parts.join(" ").replace(/\s+/g, " ").trim(), size: current.size });
      current = { parts: [line.text], size: line.size, y: line.y, page: line.page };
    }
  }
  if (current) {
    paragraphs.push({ text: current.parts.join(" ").replace(/\s+/g, " ").trim(), size: current.size });
  }
  return paragraphs.filter((paragraph) => paragraph.text.length > 0);
}
