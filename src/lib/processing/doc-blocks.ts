import { PDFDocument, StandardFonts, degrees, rgb, PDFFont } from "pdf-lib";

export type DocBlock = {
  text: string;
  style: "h1" | "h2" | "h3" | "li" | "oli" | "p" | "code";
};

/** Metrics for the page being laid out. */
export type Layout = {
  width: number;
  height: number;
  margin: number;
};

const PAGE_SIZES: Record<string, [number, number]> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
};

export function pageDimensions(size: string, landscape = false): [number, number] {
  const [short, long] = PAGE_SIZES[size] ?? PAGE_SIZES.a4;
  return landscape ? [long, short] : [short, long];
}

/** Encodes a string as WinAnsi-safe, since PDF standard fonts cannot hold arbitrary Unicode. */
export function sanitize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/\u2022/g, "-")
    .replace(/\u200B/g, "")
    // Drop anything outside the WinAnsi range instead of corrupting the output.
    .replace(/[^\u0009\u000A\u0020-\u007E\u00A1-\u00FF]/g, "");
}

type FontSet = { regular: PDFFont; bold: PDFFont; mono: PDFFont };

async function embedFonts(doc: PDFDocument, family: string): Promise<FontSet> {
  const regular =
    family === "Times"
      ? await doc.embedFont(StandardFonts.TimesRoman)
      : family === "Courier"
        ? await doc.embedFont(StandardFonts.Courier)
        : await doc.embedFont(StandardFonts.Helvetica);
  const bold =
    family === "Times"
      ? await doc.embedFont(StandardFonts.TimesRomanBold)
      : family === "Courier"
        ? await doc.embedFont(StandardFonts.CourierBold)
        : await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  return { regular, bold, mono };
}

/**
 * Renders structured blocks into a paginated PDF.
 *
 * Handles wrapping, page breaks, heading sizing, list bullets and code blocks.
 * Everything is drawn with pdf-lib standard fonts, so no font file is fetched.
 */
export async function renderBlocksToPdf(
  blocks: DocBlock[],
  options: {
    size: string;
    baseFontSize: number;
    margin: number;
    family?: string;
    lineHeight?: number;
    title?: string;
  },
): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = await PDFDocument.create();
  doc.setProducer("BrowserForge (client-side)");
  if (options.title) doc.setTitle(options.title);

  const fonts = await embedFonts(doc, options.family ?? "Helvetica");
  const [width, height] = pageDimensions(options.size);
  const margin = options.margin;
  const base = options.baseFontSize;

  let page = doc.addPage([width, height]);
  let cursor = height - margin;

  const newPage = () => {
    page = doc.addPage([width, height]);
    cursor = height - margin;
  };

  for (const block of blocks) {
    const clean = sanitize(block.text);
    if (!clean) continue;

    let font = fonts.regular;
    let fontSize = base;
    let lineGap = base * (options.lineHeight ?? 1.5);
    let indent = 0;

    switch (block.style) {
      case "h1":
        font = fonts.bold;
        fontSize = base * 1.85;
        lineGap = fontSize * 1.25;
        break;
      case "h2":
        font = fonts.bold;
        fontSize = base * 1.5;
        lineGap = fontSize * 1.3;
        break;
      case "h3":
        font = fonts.bold;
        fontSize = base * 1.22;
        lineGap = fontSize * 1.35;
        break;
      case "li":
      case "oli":
        indent = base * 1.6;
        lineGap = base * 1.45;
        break;
      case "code":
        font = fonts.mono;
        fontSize = base * 0.92;
        lineGap = fontSize * 1.35;
        break;
      default:
        break;
    }

    const usable = width - margin * 2 - indent;
    const wrapped = wrap(clean, font, fontSize, usable);
    const spaceAbove = block.style.startsWith("h") ? fontSize * 0.7 : fontSize * 0.35;
    const spaceBelow = block.style.startsWith("h") ? fontSize * 0.5 : fontSize * 0.25;

    if (cursor - spaceAbove - lineGap < margin) newPage();
    cursor -= spaceAbove;

    wrapped.forEach((line, index) => {
      if (cursor - lineGap < margin) newPage();
      page.drawText(line, {
        x: margin + indent,
        y: cursor - fontSize,
        size: fontSize,
        font,
        color: rgb(0.12, 0.13, 0.16),
      });
      // Bullet for list items on the first wrapped line only.
      if (block.style === "li" && index === 0) {
        page.drawText("-", { x: margin, y: cursor - fontSize, size: fontSize, font: fonts.regular, color: rgb(0.4, 0.42, 0.47) });
      }
      cursor -= lineGap;
    });

    cursor -= spaceBelow;
  }

  const bytes = await doc.save();
  return { bytes, pages: doc.getPageCount() };
}

/** Greedy word wrap measured against the real font metrics. */
export function wrap(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // A single word longer than the column is hard-broken so it never overflows.
    if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
      let piece = "";
      for (const char of word) {
        if (font.widthOfTextAtSize(piece + char, fontSize) > maxWidth) {
          if (piece) lines.push(piece);
          piece = char;
        } else {
          piece += char;
        }
      }
      current = piece;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/* --------------------------------- parsers --------------------------------- */

/** Markdown → structured blocks. Supports headings, lists, quotes, code and rules. */
export function markdownToBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let codeBuffer: string[] = [];

  const flushCode = () => {
    if (codeBuffer.length) {
      blocks.push({ text: codeBuffer.join("\n"), style: "code" });
      codeBuffer = [];
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(raw);
      continue;
    }
    if (!line.trim()) continue;

    const inline = (value: string) => value.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/~~([^~]+)~~/g, "$1");

    if (/^#\s/.test(line)) blocks.push({ text: inline(line.slice(2)), style: "h1" });
    else if (/^##\s/.test(line)) blocks.push({ text: inline(line.slice(3)), style: "h2" });
    else if (/^#{3,6}\s/.test(line)) blocks.push({ text: inline(line.replace(/^#{3,6}\s/, "")), style: "h3" });
    else if (/^\s*[-*+]\s+/.test(line)) blocks.push({ text: inline(line.replace(/^\s*[-*+]\s+/, "")), style: "li" });
    else if (/^\s*\d+[.)]\s+/.test(line)) blocks.push({ text: inline(line.replace(/^\s*\d+[.)]\s+/, "")), style: "oli" });
    else if (/^>\s?/.test(line)) blocks.push({ text: inline(line.replace(/^>\s?/, "")), style: "p" });
    else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) blocks.push({ text: "", style: "p" });
    else blocks.push({ text: inline(line.trim()), style: "p" });
  }
  flushCode();
  return blocks.filter((block) => block.text.trim().length > 0);
}

/** HTML → structured blocks, using the browser's DOM parser. */
export function htmlToBlocks(html: string): DocBlock[] {
  if (typeof window === "undefined") {
    return [{ text: html.replace(/<[^>]+>/g, " "), style: "p" }];
  }
  const cleaned = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "");
  const parsed = new DOMParser().parseFromString(cleaned, "text/html");
  const blocks: DocBlock[] = [];

  const walk = (node: Node, listDepth = 0) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) blocks.push({ text, style: "p" });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as HTMLElement;
      const tag = element.tagName.toLowerCase();
      if (["script", "style", "noscript", "head", "meta", "link", "title"].includes(tag)) continue;

      if (tag === "h1") { pushText(blocks, element, "h1"); continue; }
      if (tag === "h2") { pushText(blocks, element, "h2"); continue; }
      if (["h3", "h4", "h5", "h6"].includes(tag)) { pushText(blocks, element, "h3"); continue; }
      if (tag === "li") {
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) blocks.push({ text, style: listDepth > 0 ? "li" : "li" });
        continue;
      }
      if (tag === "pre" || tag === "code") {
        const text = (element.textContent ?? "").trim();
        if (text) blocks.push({ text, style: "code" });
        continue;
      }
      if (tag === "br") continue;
      if (tag === "table") {
        emitTable(blocks, element);
        continue;
      }
      if (["ul", "ol"].includes(tag)) {
        walk(element, listDepth + 1);
        continue;
      }
      walk(element, listDepth);
    }
  };

  walk(parsed.body);
  return blocks.filter((block) => block.text.trim().length > 0);
}

function pushText(blocks: DocBlock[], element: HTMLElement, style: DocBlock["style"]) {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) blocks.push({ text, style });
}

/** Renders an HTML table as a text grid, which the PDF layout can place cleanly. */
function emitTable(blocks: DocBlock[], table: HTMLElement) {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return;
  const matrix = rows.map((row) =>
    Array.from(row.querySelectorAll("th,td")).map((cell) =>
      (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
    ),
  );
  const columns = Math.max(...matrix.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...matrix.map((row) => row[index]?.length ?? 0)),
  );
  const lines = matrix.map((row) =>
    row.map((cell, index) => cell.padEnd(widths[index], " ")).join(" | "),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  blocks.push({ text: [lines[0], separator, ...lines.slice(1)].join("\n"), style: "code" });
}

/** RTF → structured blocks, parsing the widely used subset. */
export function rtfToBlocks(rtf: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let text = rtf;

  // Strip the header and colour/font tables, which are not prose.
  text = text.replace(/\\'[0-9a-f]{2}/gi, "?");
  text = text.replace(/\\[a-z]+-?\d*\s?/gi, (match) => {
    if (/^\\par/i.test(match)) return "\n";
    if (/^\\line/i.test(match)) return "\n";
    if (/^\\tab/i.test(match)) return " ";
    if (/^\\[{}]/.test(match)) return "";
    return " ";
  });
  text = text.replace(/[{}]/g, "");

  const paragraphs = text
    .split(/\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.length < 60) blocks.push({ text: paragraph, style: "h2" });
    else blocks.push({ text: paragraph, style: "p" });
  }
  return blocks;
}

/** Plain text → blocks, preserving blank-line paragraph breaks. */
export function plainTextToBlocks(text: string): DocBlock[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .map((paragraph) => ({ text: paragraph, style: "p" as const }));
}

export { degrees, PAGE_SIZES };
