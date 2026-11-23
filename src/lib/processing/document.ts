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
import { resultStats, textArtifact } from "./archive";
import {
  htmlToBlocks,
  markdownToBlocks,
  plainTextToBlocks,
  rtfToBlocks,
  renderBlocksToPdf,
  pageDimensions,
  sanitize,
  type DocBlock,
} from "./doc-blocks";
import { blocksToDocx } from "./docx-writer";
import { extractLines, linesToParagraphs } from "./pdf-render";

function pdfArtifact(name: string, blob: Blob): EngineArtifact {
  return { name, blob, kind: "pdf" };
}

async function blocksFromMarkdown(markdown: string): Promise<DocBlock[]> {
  return markdownToBlocks(markdown);
}

/* ------------------------------- DOCX reading ------------------------------- */

type MammothResult = { value: string; messages: { message: string; type: string }[] };

async function docxToHtmlString(file: File): Promise<MammothResult> {
  const { default: mammoth } = await import("mammoth/mammoth.browser");
  const arrayBuffer = await file.arrayBuffer();
  return mammoth.convertToHtml({ arrayBuffer });
}

/* --------------------------- shared text extraction -------------------------- */

async function readTextFile(file: File): Promise<string> {
  return file.text();
}

function stripHtml(html: string): string {
  if (typeof window === "undefined") return html.replace(/<[^>]+>/g, " ");
  const parsed = new DOMParser().parseFromString(
    html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ""),
    "text/html",
  );
  return (parsed.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function stripRtf(rtf: string): string {
  return rtf
    .replace(/\\'[0-9a-f]{2}/gi, " ")
    .replace(/\\par\b/g, "\n")
    .replace(/\\line\b/g, "\n")
    .replace(/\\tab\b/g, " ")
    .replace(/\\[a-z]+-?\d*\s?/gi, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------------------------- engines --------------------------------- */

/** DOCX → PDF: convert to HTML, then to structured blocks, then render. */
export const docxToPdf: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const size = str(ctx.options, "size", "a4");
  const baseFontSize = clamp(num(ctx.options, "fontSize", 11), 7, 24);
  const margin = clamp(num(ctx.options, "margin", 46), 16, 90);
  const family = str(ctx.options, "font", "Helvetica");
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Converting ${file.name}`);
    const html = await docxToHtmlString(file);
    const blocks = htmlToBlocks(html.value);
    if (blocks.length === 0) {
      engineError(`${file.name} contains no readable text.`);
    }
    const { bytes, pages } = await renderBlocksToPdf(blocks, {
      size,
      baseFontSize,
      margin,
      family,
      title: baseName(file.name),
    });
    artifacts.push(pdfArtifact(`${baseName(file.name)}.pdf`, new Blob([bytes as unknown as BlobPart], { type: "application/pdf" })));
    void pages;
  }

  return {
    artifacts,
    stats: resultStats({
      Files: artifacts.length,
      Blocks: artifacts.length,
      "Page size": size.toUpperCase(),
    }),
    notice: "Headings, lists, tables, bold and italic carry over. Images, columns, headers, footers and footnotes do not.",
  };
};

export const txtToPdf: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const size = str(ctx.options, "size", "a4");
  const baseFontSize = clamp(num(ctx.options, "fontSize", 11), 7, 24);
  const margin = clamp(num(ctx.options, "margin", 46), 16, 90);
  const lineHeight = clamp(num(ctx.options, "lineHeight", 1.5), 1, 2.4);
  const mono = bool(ctx.options, "mono", false);
  const artifacts: EngineArtifact[] = [];
  let totalPages = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Converting ${file.name}`);
    const text = await readTextFile(file);
    if (!text.trim()) engineError(`${file.name} is empty.`);
    const blocks = plainTextToBlocks(text);
    const { bytes, pages } = await renderBlocksToPdf(blocks, {
      size,
      baseFontSize,
      margin,
      family: mono ? "Courier" : "Helvetica",
      lineHeight,
      title: baseName(file.name),
    });
    totalPages += pages;
    artifacts.push(pdfArtifact(`${baseName(file.name)}.pdf`, new Blob([bytes as unknown as BlobPart], { type: "application/pdf" })));
  }

  return {
    artifacts,
    stats: resultStats({ Files: artifacts.length, Pages: totalPages, "Page size": size.toUpperCase() }),
  };
};

export const htmlToPdf: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const size = str(ctx.options, "size", "a4");
  const baseFontSize = clamp(num(ctx.options, "fontSize", 11), 7, 24);
  const margin = clamp(num(ctx.options, "margin", 46), 16, 90);
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Converting ${file.name}`);
    const html = await readTextFile(file);
    const cleaned = bool(ctx.options, "stripTags", true)
      ? html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
      : html;
    const blocks = htmlToBlocks(cleaned);
    if (blocks.length === 0) engineError(`${file.name} contains no readable text.`);
    const { bytes } = await renderBlocksToPdf(blocks, {
      size,
      baseFontSize,
      margin,
      title: baseName(file.name),
    });
    artifacts.push(pdfArtifact(`${baseName(file.name)}.pdf`, new Blob([bytes as unknown as BlobPart], { type: "application/pdf" })));
  }

  return {
    artifacts,
    stats: resultStats({ Files: artifacts.length, "Page size": size.toUpperCase() }),
    notice: "CSS layout is simplified into structured blocks, because a full layout engine cannot run in the browser.",
  };
};

export const markdownToPdf: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const size = str(ctx.options, "size", "a4");
  const baseFontSize = clamp(num(ctx.options, "fontSize", 11), 7, 24);
  const margin = clamp(num(ctx.options, "margin", 46), 16, 90);
  const family = str(ctx.options, "font", "Helvetica");
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Converting ${file.name}`);
    const markdown = await readTextFile(file);
    if (!markdown.trim()) engineError(`${file.name} is empty.`);
    const blocks = await blocksFromMarkdown(markdown);
    const { bytes, pages } = await renderBlocksToPdf(blocks, {
      size,
      baseFontSize,
      margin,
      family,
      title: baseName(file.name),
    });
    artifacts.push(pdfArtifact(`${baseName(file.name)}.pdf`, new Blob([bytes as unknown as BlobPart], { type: "application/pdf" })));
    void pages;
  }

  return { artifacts, stats: resultStats({ Files: artifacts.length }) };
};

export const rtfToPdf: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const size = str(ctx.options, "size", "a4");
  const baseFontSize = clamp(num(ctx.options, "fontSize", 11), 7, 24);
  const margin = clamp(num(ctx.options, "margin", 46), 16, 90);
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Converting ${file.name}`);
    const rtf = await readTextFile(file);
    if (!rtf.trim() || !rtf.includes("\\rtf")) {
      engineError(`${file.name} does not look like an RTF document.`);
    }
    const blocks = rtfToBlocks(rtf);
    if (blocks.length === 0) engineError(`${file.name} contains no readable text.`);
    const { bytes } = await renderBlocksToPdf(blocks, { size, baseFontSize, margin, title: baseName(file.name) });
    artifacts.push(pdfArtifact(`${baseName(file.name)}.pdf`, new Blob([bytes as unknown as BlobPart], { type: "application/pdf" })));
  }

  return {
    artifacts,
    stats: resultStats({ Files: artifacts.length }),
    notice: "Parses the common RTF subset: paragraphs, headings, bold and italic. Embedded images and tables are ignored.",
  };
};

/* ----------------------------- PDF → DOCX / TXT ----------------------------- */

/** Converts extracted PDF lines into blocks, flagging large text as headings. */
function paragraphsToBlocks(
  paragraphs: { text: string; size: number }[],
  detectHeadings: boolean,
  baseSize: number,
): DocBlock[] {
  const median = (() => {
    const sizes = paragraphs.map((paragraph) => paragraph.size).sort((a, b) => a - b);
    return sizes.length ? sizes[Math.floor(sizes.length / 2)] : baseSize;
  })();

  return paragraphs.map((paragraph) => {
    if (!detectHeadings) return { text: paragraph.text, style: "p" as const };
    if (paragraph.size > median * 1.55) return { text: paragraph.text, style: "h1" as const };
    if (paragraph.size > median * 1.25) return { text: paragraph.text, style: "h2" as const };
    if (paragraph.size > median * 1.1) return { text: paragraph.text, style: "h3" as const };
    return { text: paragraph.text, style: "p" as const };
  });
}

export const pdfToDocx: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const fontSize = clamp(num(ctx.options, "fontSize", 11), 8, 18);
  const detectHeadings = bool(ctx.options, "detectHeadings", true);
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Extracting ${file.name}`);
    const buffer = await file.arrayBuffer();
    const lines = await extractLines(buffer);
    if (lines.length === 0) {
      engineError(
        `${file.name} has no text layer, so there is nothing to convert. Scanned PDFs need OCR, which this offline build does not include.`,
      );
    }
    const paragraphs = linesToParagraphs(lines);
    const blocks = paragraphsToBlocks(paragraphs, detectHeadings, fontSize);
    const blob = await blocksToDocx(blocks, { fontSize, fontFamily: "Calibri", title: baseName(file.name) });
    artifacts.push({ name: `${baseName(file.name)}.docx`, blob, kind: "other" });
  }

  return {
    artifacts,
    stats: resultStats({
      Files: artifacts.length,
      Paragraphs: artifacts.length,
    }),
    notice: "Text, paragraph and heading structure carry over. Layout, images and columns do not.",
  };
};

export const pdfToTxt: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const pageBreaks = bool(ctx.options, "pageBreaks", true);
  const layout = str(ctx.options, "layout", "reading");
  const artifacts: EngineArtifact[] = [];
  let totalWords = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Reading ${file.name}`);
    const buffer = await file.arrayBuffer();
    const lines = await extractLines(buffer);
    if (lines.length === 0) {
      engineError(
        `${file.name} has no text layer. Scanned PDFs need OCR, which this offline build does not include.`,
      );
    }

    let text: string;
    if (layout === "lines") {
      const grouped = new Map<number, Map<number, string[]>>();
      for (const line of lines) {
        const byPage = grouped.get(line.page) ?? new Map<number, string[]>();
        const bucket = byPage.get(Math.round(line.y)) ?? [];
        bucket.push(line.text);
        byPage.set(Math.round(line.y), bucket);
        grouped.set(line.page, byPage);
      }
      const parts: string[] = [];
      for (const [page, byY] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
        const pageLines = [...byY.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, parts_]) => parts_.join(" ").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        parts.push(pageLines.join("\n"));
        if (pageBreaks) parts.push("--- page break ---");
      }
      text = parts.join("\n\n").trim();
    } else {
      const paragraphs = linesToParagraphs(lines);
      const byPage = new Map<number, string[]>();
      for (const paragraph of paragraphs) {
        void paragraph;
      }
      // Reading flow: paragraphs in reading order, page breaks optional.
      const parts: string[] = [];
      let currentPage = 1;
      let buffer_: string[] = [];
      for (const line of lines) {
        if (line.page !== currentPage) {
          if (buffer_.length) parts.push(buffer_.join(" "));
          buffer_ = [];
          if (pageBreaks) parts.push("--- page break ---");
          currentPage = line.page;
        }
        buffer_.push(line.text);
      }
      if (buffer_.length) parts.push(buffer_.join(" "));
      text = parts
        .join("\n\n")
        .replace(/\s+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .trim();
      void byPage;
    }

    totalWords += text ? text.split(/\s+/).filter(Boolean).length : 0;
    artifacts.push(textArtifact(`${baseName(file.name)}.txt`, text));
  }

  return {
    artifacts,
    stats: resultStats({ Files: artifacts.length, Words: totalWords }),
    preview: { type: "text", data: artifacts[0] ? await blobText(artifacts[0].blob) : "" },
  };
};

async function blobText(blob: Blob): Promise<string> {
  const text = await blob.text();
  return text.slice(0, 6000);
}

export const pdfToHtml: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const detectHeadings = bool(ctx.options, "detectHeadings", true);
  const darkMode = bool(ctx.options, "darkMode", true);

  const lines = await extractLines(await file.arrayBuffer());
  if (lines.length === 0) {
    engineError(`${file.name} has no text layer, so there is no content to convert.`);
  }
  const paragraphs = linesToParagraphs(lines);
  const blocks = paragraphsToBlocks(paragraphs, detectHeadings, 11);
  const median = (() => {
    const sizes = paragraphs.map((paragraph) => paragraph.size).sort((a, b) => a - b);
    return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11;
  })();

  const body = blocks
    .map((block) => {
      const text = block.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      switch (block.style) {
        case "h1":
          return `<h1>${text}</h1>`;
        case "h2":
          return `<h2>${text}</h2>`;
        case "h3":
          return `<h3>${text}</h3>`;
        case "li":
          return `<li>${text}</li>`;
        case "code":
          return `<pre><code>${text}</code></pre>`;
        default:
          return `<p>${text}</p>`;
      }
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${sanitize(baseName(file.name))}</title>
<style>
  :root { color-scheme: light${darkMode ? " dark" : ""}; }
  body { max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; font: 16px/1.65 system-ui, sans-serif; color: #1f2430; background: #fff; }
  pre { background: #f4f5f8; padding: 1rem; border-radius: .5rem; overflow: auto; font-family: ui-monospace, monospace; font-size: .92em; }
${darkMode ? "  @media (prefers-color-scheme: dark) { body { color: #e6e8ee; background: #14161d; } pre { background: #22252e; } }" : ""}
</style>
</head>
<body>
${body}
</body>
</html>
`;

  return {
    artifacts: [
      { name: `${baseName(file.name)}.html`, blob: new Blob([html], { type: "text/html;charset=utf-8" }), kind: "text" },
    ],
    preview: { type: "text", data: html.slice(0, 8000) },
    stats: resultStats({
      Paragraphs: paragraphs.length,
      "Median font size": `${median.toFixed(1)}pt`,
      Headings: blocks.filter((block) => block.style.startsWith("h")).length,
    }),
    notice: "Text and heading structure carry over. Images, vector graphics and multi-column layout are not reproduced.",
  };
};

/* ------------------------------ DOCX / HTML ⇄ ------------------------------- */

export const docxToHtml: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const fullDocument = bool(ctx.options, "fullDocument", true);
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Converting ${file.name}`);
    const result = await docxToHtmlString(file);
    const output = fullDocument
      ? `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<title>${sanitize(baseName(file.name))}</title>\n</head>\n<body>\n${result.value}\n</body>\n</html>\n`
      : result.value;
    artifacts.push({
      name: `${baseName(file.name)}.html`,
      blob: new Blob([output], { type: "text/html;charset=utf-8" }),
      kind: "text",
    });
  }

  return {
    artifacts,
    stats: resultStats({ Files: artifacts.length }),
    notice: "Text, headings, lists and tables convert well. Embedded images are dropped.",
  };
};

export const htmlToDocx: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const fontSize = clamp(num(ctx.options, "fontSize", 11), 8, 18);
  const fontFamily = str(ctx.options, "fontFamily", "Calibri");
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 100, `Converting ${file.name}`);
    const html = await readTextFile(file);
    const blocks = htmlToBlocks(html);
    if (blocks.length === 0) engineError(`${file.name} contains no readable text.`);
    const blob = await blocksToDocx(blocks, { fontSize, fontFamily, title: baseName(file.name) });
    artifacts.push({ name: `${baseName(file.name)}.docx`, blob, kind: "other" });
  }

  return {
    artifacts,
    stats: resultStats({ Files: artifacts.length, Font: fontFamily }),
    notice: "Writes a genuine OOXML .docx, so headings, paragraphs and lists open as real Word content. CSS styling does not carry over.",
  };
};

/* --------------------------------- counters --------------------------------- */

async function gatherText(ctx: { files: File[]; text: string }): Promise<string> {
  if (ctx.files.length > 0) {
    const file = ctx.files[0];
    if (/\.docx$/i.test(file.name)) {
      const html = await docxToHtmlString(file);
      return stripHtml(html.value);
    }
    if (/\.html?$/i.test(file.name) || file.type === "text/html") {
      return stripHtml(await readTextFile(file));
    }
    if (/\.rtf$/i.test(file.name) || /rtf/i.test(file.type)) {
      return stripRtf(await readTextFile(file));
    }
    return readTextFile(file);
  }
  return ctx.text;
}

export const documentWordCounter: ToolEngine = async (ctx) => {
  const text = (await gatherText({ files: ctx.files, text: ctx.text })).trim();
  if (!text) engineError("Paste some text or add a file first.");

  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?…]+(?:\s|$)/).filter((part) => part.trim().length > 0);
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim().length > 0);
  const readingSpeed = Math.max(60, num(ctx.options, "readingSpeed", 225));
  const minutes = words.length / readingSpeed;

  const report = `Word count report
=================

Words               ${words.length}
Characters          ${text.length}
Characters (no ws)  ${text.replace(/\s/g, "").length}
Sentences           ${sentences.length}
Paragraphs          ${paragraphs.length}
Unique words        ${new Set(words.map((word) => word.toLowerCase())).size}
Average word length ${words.length ? (words.join("").length / words.length).toFixed(2) : "0"}
Average sentence    ${sentences.length ? (words.length / sentences.length).toFixed(1) : 0} words
Reading time        ${minutes < 1 ? `${Math.max(1, Math.round(minutes * 60))} seconds` : `${minutes.toFixed(1)} minutes`}
Speaking time       ${(words.length / 130).toFixed(1)} minutes at 130 wpm
Longest word        ${words.reduce((longest, word) => (word.length > longest.length ? word : longest), "")}
`;

  return {
    artifacts: [textArtifact("word-count.txt", report)],
    preview: {
      type: "stats",
      data: [
        { label: "Words", value: words.length.toLocaleString("en-US") },
        { label: "Characters", value: text.length.toLocaleString("en-US") },
        { label: "Characters (no spaces)", value: text.replace(/\s/g, "").length.toLocaleString("en-US") },
        { label: "Sentences", value: sentences.length.toLocaleString("en-US") },
        { label: "Paragraphs", value: paragraphs.length.toLocaleString("en-US") },
        { label: "Unique words", value: new Set(words.map((w) => w.toLowerCase())).size.toLocaleString("en-US") },
        { label: "Reading time", value: minutes < 1 ? `${Math.max(1, Math.round(minutes * 60))} s` : `${minutes.toFixed(1)} min` },
      ],
    },
    stats: resultStats({ Words: words.length, Characters: text.length, Sentences: sentences.length }),
  };
};

export const documentCharacterCounter: ToolEngine = async (ctx) => {
  const text = await gatherText({ files: ctx.files, text: ctx.text });
  if (!text) engineError("Paste some text or add a file first.");
  const includeSpaces = bool(ctx.options, "countSpaces", false);

  const characters = text.length;
  const withoutSpaces = text.replace(/\s/g, "").length;
  const primary = includeSpaces ? characters : withoutSpaces;
  const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const lines = text ? text.split(/\n/).length : 0;

  const report = `Character count report
======================

Characters (with spaces)     ${characters}
Characters (without spaces)  ${withoutSpaces}
Words                        ${words}
Lines                        ${lines}
Paragraphs                   ${text.split(/\n\s*\n/).filter((p) => p.trim()).length}

Common limits
SMS (GSM, single)            ${characters}/160
Tweet                        ${withoutSpaces}/280
Meta description             ${characters}/160
Title tag                    ${characters}/60
`;

  return {
    artifacts: [textArtifact("character-count.txt", report)],
    preview: {
      type: "stats",
      data: [
        { label: "Characters (with spaces)", value: characters.toLocaleString("en-US") },
        { label: "Characters (no spaces)", value: withoutSpaces.toLocaleString("en-US") },
        { label: "Selected count", value: primary.toLocaleString("en-US") },
        { label: "Words", value: words.toLocaleString("en-US") },
        { label: "Lines", value: lines.toLocaleString("en-US") },
        { label: "SMS 160", value: `${Math.min(characters, 160)}/160` },
        { label: "Tweet 280", value: `${Math.min(withoutSpaces, 280)}/280` },
      ],
    },
    stats: resultStats({ Characters: characters, "No spaces": withoutSpaces, Words: words }),
  };
};

export const documentPageCounter: ToolEngine = async (ctx) => {
  const size = str(ctx.options, "pageSize", "a4");
  const fontSize = clamp(num(ctx.options, "fontSize", 11), 8, 16);
  const margin = clamp(num(ctx.options, "margin", 46), 12, 90);
  const files = ctx.files;
  const text = ctx.text.trim();

  if (files.length === 0 && !text) engineError("Add files or paste some text to count.");

  const lines: string[] = ["Page count report", "================", ""];
  let totalFiles = 0;
  let totalPages = 0;

  const [pageWidth, pageHeight] = pageDimensions(size);
  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;
  const lineHeight = fontSize * 1.5;
  const charsPerLine = Math.max(10, Math.floor(usableWidth / (fontSize * 0.5)));
  const linesPerPage = Math.max(1, Math.floor(usableHeight / lineHeight));

  const estimatePages = (content: string): number => {
    const physicalLines = content.split(/\n/).reduce((total, paragraph) => {
      const wrapped = Math.max(1, Math.ceil(paragraph.length / charsPerLine));
      return total + wrapped;
    }, 0);
    return Math.max(1, Math.ceil(physicalLines / linesPerPage));
  };

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / Math.max(1, files.length)) * 90, `Counting ${file.name}`);
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      const { openPdf } = await import("./pdf-render");
      const doc = await openPdf(await file.arrayBuffer());
      lines.push(`${file.name}: ${doc.numPages} pages (read directly from the document)`);
      totalPages += doc.numPages;
      await doc.cleanup?.();
    } else {
      const content = await gatherText({ files: [file], text: "" });
      const pages = estimatePages(content);
      const words = content.trim() ? content.trim().split(/\s+/).length : 0;
      lines.push(`${file.name}: ~${pages} pages (${words.toLocaleString("en-US")} words, estimated at ${fontSize}pt)`);
      totalPages += pages;
    }
    totalFiles += 1;
  }

  if (text) {
    const pages = estimatePages(text);
    lines.push(`Pasted text: ~${pages} pages (${text.split(/\s+/).filter(Boolean).length.toLocaleString("en-US")} words, estimated at ${fontSize}pt)`);
    totalPages += pages;
  }

  lines.push("", `Total: ${totalPages} page${totalPages === 1 ? "" : "s"} across ${totalFiles} file${totalFiles === 1 ? "" : "s"}`);
  lines.push("", `Layout used for estimates: ${size.toUpperCase()}, ${fontSize}pt, ${margin}pt margins`);
  lines.push("Text estimates are calculated from the real layout parameters but remain close approximations.");

  const report = lines.join("\n");
  return {
    artifacts: [textArtifact("page-count.txt", report)],
    preview: { type: "text", data: report },
    stats: resultStats({ Files: totalFiles, Pages: totalPages }),
  };
};

export const textCaseConverter: ToolEngine = async (ctx) => {
  const text = await gatherText({ files: ctx.files, text: ctx.text });
  if (!text) engineError("Paste some text or add a file first.");
  const mode = str(ctx.options, "mode", "title");

  const toWords = (value: string) =>
    value.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_\-.]+/).filter(Boolean);
  const toCamel = (value: string, pascal = false) =>
    toWords(value)
      .map((word, index) => {
        const lower = word.toLowerCase();
        return index === 0 && !pascal ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("");

  let output = text;
  switch (mode) {
    case "upper":
      output = text.toUpperCase();
      break;
    case "lower":
      output = text.toLowerCase();
      break;
    case "title":
      output = text.toLowerCase().replace(/\b([a-z])/g, (match) => match.toUpperCase());
      break;
    case "sentence":
      output = text.toLowerCase().replace(/(^\s*\w|[.!?]\s*\w)/g, (match) => match.toUpperCase());
      break;
    case "camel":
      output = toCamel(text);
      break;
    case "pascal":
      output = toCamel(text, true);
      break;
    case "snake":
      output = toWords(text).map((word) => word.toLowerCase()).join("_");
      break;
    case "kebab":
      output = toWords(text).map((word) => word.toLowerCase()).join("-");
      break;
    case "alternating":
      output = text
        .split("")
        .map((char, index) => (index % 2 === 0 ? char.toLowerCase() : char.toUpperCase()))
        .join("");
      break;
    default:
      output = text;
  }

  return {
    artifacts: [textArtifact("converted-text.txt", output)],
    preview: { type: "text", data: output.slice(0, 8000) },
    stats: resultStats({ Mode: mode, Characters: output.length, Words: output.trim() ? output.trim().split(/\s+/).length : 0 }),
  };
};

export const documentEngines: Record<string, ToolEngine> = {
  "docx-to-pdf": docxToPdf,
  "txt-to-pdf": txtToPdf,
  "html-to-pdf": htmlToPdf,
  "markdown-to-pdf": markdownToPdf,
  "rtf-to-pdf": rtfToPdf,
  "pdf-to-docx": pdfToDocx,
  "pdf-to-txt": pdfToTxt,
  "pdf-to-html": pdfToHtml,
  "docx-to-html": docxToHtml,
  "html-to-docx": htmlToDocx,
  "document-word-counter": documentWordCounter,
  "document-character-counter": documentCharacterCounter,
  "document-page-counter": documentPageCounter,
  "text-case-converter": textCaseConverter,
};
