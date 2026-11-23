/**
 * Minimal but genuine DOCX writer.
 *
 * A .docx file is a ZIP of XML parts, so it can be produced with fflate and no
 * external service. Headings, paragraphs, list markers and inline emphasis are
 * emitted as real WordprocessingML, so Word, Pages and Google Docs open the
 * result as native, editable content.
 */

import { zip } from "fflate";
import type { DocBlock } from "./doc-blocks";
import { sanitize } from "./doc-blocks";

export type DocxOptions = {
  fontSize: number;
  fontFamily: string;
  title?: string;
};

const HEADING_LEVELS: Record<string, { style: string; sizeMultiplier: number }> = {
  h1: { style: "Heading1", sizeMultiplier: 1.85 },
  h2: { style: "Heading2", sizeMultiplier: 1.5 },
  h3: { style: "Heading3", sizeMultiplier: 1.22 },
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function halfPoints(size: number): number {
  return Math.round(size * 2);
}

function paragraphXml(
  text: string,
  options: { fontSize: number; fontFamily: string; bold?: boolean; italic?: boolean; heading?: string; listMarker?: string },
): string {
  const heading = options.heading ? HEADING_LEVELS[options.heading] : undefined;
  const size = halfPoints(options.fontSize * (heading?.sizeMultiplier ?? 1));
  const style = heading ? ` <w:pStyle w:val="${heading.style}"/>` : "";
  const bold = options.bold ? '<w:b/><w:bCs/>' : "";
  const italic = options.italic ? '<w:i/><w:iCs/>' : "";
  const marker = options.listMarker
    ? `<w:ind w:left="720" w:hanging="360"/>`
    : "";

  const runs = splitBold(text)
    .map(
      (part) =>
        `<w:r><w:rPr><w:rFonts w:ascii="${escapeXml(options.fontFamily)}" w:hAnsi="${escapeXml(options.fontFamily)}"/>${part.bold ? "<w:b/><w:bCs/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(part.text)}</w:t></w:r>`,
    )
    .join("");

  const markerRun = options.listMarker
    ? `<w:r><w:rPr><w:rFonts w:ascii="${escapeXml(options.fontFamily)}" w:hAnsi="${escapeXml(options.fontFamily)}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(options.listMarker)} </w:t></w:r>`
    : "";

  return `<w:p><w:pPr>${style}${bold}${italic}<w:spacing w:after="120" w:line="276" w:lineRule="auto"/>${marker}<w:jc w:val="left"/></w:pPr>${markerRun}${runs}</w:p>`;
}

type Run = { text: string; bold: boolean; italic: boolean };

/** Splits a string into runs, tracking **bold** and *italic* markers. */
function splitBold(text: string): Run[] {
  const runs: Run[] = [];
  let rest = text;
  const pattern = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)/;
  for (;;) {
    const match = pattern.exec(rest);
    if (!match) break;
    if (match.index > 0) runs.push({ text: rest.slice(0, match.index), bold: false, italic: false });
    if (match[2]) runs.push({ text: match[2], bold: true, italic: false });
    else if (match[4]) runs.push({ text: match[4], bold: false, italic: true });
    else if (match[6]) runs.push({ text: match[6], bold: false, italic: true });
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) runs.push({ text: rest, bold: false, italic: false });
  return runs.length ? runs : [{ text: "", bold: false, italic: false }];
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function stylesXml(fontFamily: string): string {
  const heading = (id: string, name: string, size: number, bold: boolean) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr>${bold ? "<w:b/><w:bCs/>" : ""}<w:rFonts w:ascii="${fontFamily}" w:hAnsi="${fontFamily}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${fontFamily}" w:hAnsi="${fontFamily}" w:eastAsia="${fontFamily}" w:cs="${fontFamily}"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${heading("Heading1", "heading 1", halfPoints(22 * 1.85), true)}
${heading("Heading2", "heading 2", halfPoints(22 * 1.5), true)}
${heading("Heading3", "heading 3", halfPoints(22 * 1.22), true)}
</w:styles>`;
}

function corePropsXml(title: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>BrowserForge (client-side)</dc:creator>
<cp:lastModifiedBy>BrowserForge (client-side)</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

const APP_PROPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>BrowserForge</Application>
</Properties>`;

/**
 * Packs structured blocks into a real .docx file.
 * Returns a Blob suitable for direct download.
 */
export async function blocksToDocx(
  blocks: DocBlock[],
  options: DocxOptions,
): Promise<Blob> {
  const body = blocks
    .map((block) => {
      const clean = sanitize(block.text);
      if (!clean) return "";
      switch (block.style) {
        case "h1":
        case "h2":
        case "h3":
          return clean.split("\n").map((line) => paragraphXml(line, { ...options, heading: block.style, bold: true })).join("");
        case "li":
        case "oli":
          return clean
            .split("\n")
            .map((line) => paragraphXml(line, { ...options, listMarker: block.style === "oli" ? "1." : "-" }))
            .join("");
        case "code":
          return clean
            .split("\n")
            .map((line) => paragraphXml(line, { ...options, fontFamily: "Courier New", fontSize: options.fontSize * 0.92 }))
            .join("");
        default:
          return clean.split("\n").map((line) => paragraphXml(line, options)).join("");
      }
    })
    .filter(Boolean)
    .join("");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;

  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": new TextEncoder().encode(CONTENT_TYPES),
    "_rels/.rels": new TextEncoder().encode(ROOT_RELS),
    "word/document.xml": new TextEncoder().encode(documentXml),
    "word/_rels/document.xml.rels": new TextEncoder().encode(DOCUMENT_RELS),
    "word/styles.xml": new TextEncoder().encode(stylesXml(options.fontFamily)),
    "docProps/core.xml": new TextEncoder().encode(corePropsXml(options.title ?? "Document")),
    "docProps/app.xml": new TextEncoder().encode(APP_PROPS_XML),
  };

  const buffer = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 6, mtime: new Date() }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });

  return new Blob([buffer.slice()], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
