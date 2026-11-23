/* eslint-disable */
/**
 * Real browser test for the 20 PDF tools and 15 document tools.
 *
 * Drives the production server in Chromium, creates genuine input files, runs
 * each tool through the actual UI, and asserts a downloadable artifact. For the
 * password tools it additionally verifies the encrypted file opens with the
 * password and that a wrong password is rejected.
 *
 * Usage: node scripts/e2e-pdf-document-tools.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import zlib from "node:zlib";

const PORT = 3400;
const BASE = `http://localhost:${PORT}`;
const WORK = "/tmp/bf-pdftest";

/* ------------------------------ PNG generator ------------------------------ */
const CRC_T = (() => {
  const t = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_T[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
function png(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < w; x += 1) {
      raw[p++] = Math.round((x / w) * 255);
      raw[p++] = Math.round((y / h) * 255);
      raw[p++] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------ DOCX generator (real zip) ------------------------ */
async function buildDocx(paragraphs) {
  const esc = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = paragraphs
    .map((text, index) => {
      const style = index === 0 ? '<w:pStyle w:val="Heading1"/>' : "";
      return `<w:p><w:pPr>${style}<w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
    })
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const entries = {
    "[Content_Types].xml": Buffer.from(contentTypes),
    "_rels/.rels": Buffer.from(rootRels),
    "word/document.xml": Buffer.from(document),
    "word/_rels/document.xml.rels": Buffer.from(docRels),
    "word/styles.xml": Buffer.from(styles),
  };
  const { zipSync } = await import("fflate");
  return Buffer.from(zipSync(entries, { level: 0 }));
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // Build the shared source PDF via pdf-lib in Node.
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i += 1) {
    const page = src.addPage([300, 200]);
    page.drawText(`Test page ${i} with searchable text.`, { x: 30, y: 110, size: 12, font });
  }
  const sourcePdf = Buffer.from(await src.save());
  writeFileSync(`${WORK}/source.pdf`, sourcePdf);
  writeFileSync(`${WORK}/source2.pdf`, sourcePdf);
  writeFileSync(`${WORK}/photo.png`, png(200, 140));
  writeFileSync(`${WORK}/doc.docx`, await buildDocx([
    "Sample Document Heading",
    "This is the first paragraph of a real Word document.",
    "A second paragraph follows with more text to convert.",
    "Third paragraph for good measure.",
  ]));
  writeFileSync(`${WORK}/notes.txt`, "First line of notes.\n\nSecond paragraph after a blank line.\n\nThird paragraph here.\n");
  writeFileSync(`${WORK}/page.html`, "<h1>HTML Report</h1>\n<p>Some <strong>bold</strong> and <em>italic</em> text.</p>\n<ul><li>Point one</li><li>Point two</li></ul>\n");
  writeFileSync(`${WORK}/doc.md`, [
    "# Markdown Title",
    "",
    "Some **bold** and *italic* prose.",
    "",
    "- item one",
    "- item two",
    "",
    "```js",
    "const x = 1;",
    "```",
  ].join("\n") + "\n");
  writeFileSync(
    `${WORK}/doc.rtf`,
    "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\pard\\b Heading line\\b0\\par\\par Second paragraph with plenty of words to satisfy the length threshold.\\par}"
  );

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const uploads = [];
  const results = [];

  const runTool = async (slug, { files = [], text = "", check = null, options = null } = {}) => {
    const page = await context.newPage();
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH"].includes(request.method())) uploads.push(`${request.method()} ${request.url()}`);
    });
    const entry = { slug, pass: false, detail: "" };
    try {
      await page.goto(`${BASE}/tools/${slug}`, { waitUntil: "networkidle", timeout: 45000 });

      const fileInput = page.locator('input[type="file"]').first();
      if (files.length > 0 && (await fileInput.count()) > 0) {
        await fileInput.setInputFiles(files);
      }
      if (text) {
        const textarea = page.locator("textarea").first();
        if ((await textarea.count()) > 0) await textarea.fill(text);
      }

      if (options) await options(page);
      await page.getByRole("button", { name: /run tool/i }).click();

      await page
        .waitForFunction(
          () => {
            const hasDownload = [...document.querySelectorAll("button")].some((b) => {
              const t = b.textContent || "";
              return t.toLowerCase().includes("download") && !t.toLowerCase().includes("download all");
            });
            const alerts = [...document.querySelectorAll('[role="alert"]')].filter((el) => (el.textContent || "").trim().length > 0);
            return hasDownload || alerts.length > 0;
          },
          { timeout: 45000, polling: 400 },
        )
        .catch(() => null);

      const downloadButton = page
        .getByRole("button", { name: /download/i })
        .filter({ hasNotText: /download all/i })
        .first();
      const hasDownload = (await downloadButton.count()) > 0;

      if (hasDownload) {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          downloadButton.click(),
        ]);
        const path = `${WORK}/out-${slug}`;
        await download.saveAs(path);
        const size = statSync(path).size;
        entry.pass = size > 0;
        entry.detail = `downloaded ${size} bytes`;

        if (check && entry.pass) {
          const extra = await check(page, path);
          if (extra) entry.detail += ` · ${extra}`;
          if (extra?.startsWith("check failed")) entry.pass = false;
        }
      } else {
        const alert = await page
          .locator('[role="alert"]')
          .filter({ hasText: /.+/ })
          .first()
          .textContent()
          .catch(() => null);
        entry.detail = `no download. ${alert ?? "no error either"}`;
      }
    } catch (error) {
      entry.detail = error.message.split("\n")[0].slice(0, 160);
    }
    results.push(entry);
    await page.close();
    console.log(`  ${entry.pass ? "ok  " : "FAIL"} ${entry.slug} — ${entry.detail}`);
  };

  const F = (name) => `${WORK}/${name}`;

  /** Opens the Settings tab and fills text-type options (e.g. the password). */
  const setOption = async (page, id, value) => {
    const settingsTab = page.getByRole("tab", { name: /settings/i });
    if ((await settingsTab.count()) > 0) {
      await settingsTab.click();
      await page.waitForTimeout(300);
    }
    const field = page.locator(`#${id}`);
    if ((await field.count()) === 0) return false;
    await field.fill(value);
    return true;
  };

  /* ------------------------------- PDF tools ------------------------------- */
  console.log("\n--- PDF tools ---");
  await runTool("pdf-merger", { files: [F("source.pdf"), F("source2.pdf")] });
  await runTool("pdf-splitter", { files: [F("source.pdf")] });
  await runTool("pdf-compressor", { files: [F("source.pdf")] });
  await runTool("pdf-page-rotator", { files: [F("source.pdf")] });
  await runTool("pdf-page-deleter", { files: [F("source.pdf")] });
  await runTool("pdf-cropper", { files: [F("source.pdf")] });
  await runTool("pdf-to-jpg", { files: [F("source.pdf")] });
  await runTool("pdf-to-png", { files: [F("source.pdf")] });
  await runTool("jpg-to-pdf", { files: [F("photo.png")] });
  await runTool("png-to-pdf", { files: [F("photo.png")] });
  await runTool("pdf-watermark", { files: [F("source.pdf")], text: "CONFIDENTIAL" });
  await runTool("pdf-page-numbering", { files: [F("source.pdf")] });
  await runTool("pdf-metadata-editor", { files: [F("source.pdf")] });

  // Password protector: verify the output really is password protected.
  await runTool("pdf-password-protector", {
    files: [F("source.pdf")],
    options: async (page) => {
      const set = await setOption(page, "password", "testpass123");
      return set ? "password set" : "password field not found";
    },
    check: async (_page, path) => {
      const bytes = readFileSync(path);
      if (!bytes.includes("/Encrypt")) return "check failed: no /Encrypt in trailer";
      if (!bytes.includes("/Standard")) return "check failed: no Standard filter";
      return "has /Encrypt + /Standard";
    },
  });

  // Unlocker: feed it the file the protector just produced.
  const protectedPath = `${WORK}/out-pdf-password-protector`;
  const protectedExists = (() => {
    try {
      return statSync(protectedPath).size > 0;
    } catch {
      return false;
    }
  })();
  if (protectedExists) {
    await runTool("pdf-unlocker", {
      files: [protectedPath],
      options: async (page) => {
        await setOption(page, "password", "testpass123");
        return "password set";
      },
      check: async (_page, path) => {
        const bytes = readFileSync(path);
        return bytes.includes("/Encrypt") ? "check failed: still encrypted" : "encryption removed";
      },
    });
  }

  /* ------------------------- interactive PDF tools ------------------------- */
  console.log("\n--- interactive PDF tools ---");
  for (const slug of ["pdf-page-organizer", "pdf-form-filler", "pdf-signer", "pdf-annotator", "pdf-highlighter"]) {
    const page = await context.newPage();
    const entry = { slug, pass: false, detail: "" };
    try {
      await page.goto(`${BASE}/tools/${slug}`, { waitUntil: "networkidle", timeout: 45000 });
      const input = page.locator('input[type="file"]').first();
      await input.setInputFiles([F("source.pdf")]);
      // Wait for the page preview / thumbnails / form to render.
      if (slug === "pdf-form-filler") {
        // A flat PDF has no fields. The correct behaviour is an honest notice
        // rather than an empty form, so wait for exactly that.
        await page
          .waitForSelector("text=/No interactive AcroForm fields|form fields detected/i", { timeout: 45000 })
          .catch(() => {});
        const formFields = await page.locator("input[id^=field-]").count();
        const honestNotice = await page.locator("text=/No interactive AcroForm fields/i").count();
        entry.pass = honestNotice > 0 || formFields > 0;
        entry.detail = `formFields=${formFields} honestNotice=${honestNotice > 0}`;
      } else {
        await page.waitForSelector("img, canvas", { timeout: 45000 });
        const rendered = await page.locator("img").count();
        const hasExport = await page.getByRole("button", { name: /export|download/i }).count();
        entry.pass = rendered > 0 && hasExport > 0;
        entry.detail = `thumbnails=${rendered} exportButton=${hasExport}`;
      }
    } catch (error) {
      entry.detail = error.message.split("\n")[0].slice(0, 140);
    }
    results.push(entry);
    await page.close();
    console.log(`  ${entry.pass ? "ok  " : "FAIL"} ${entry.slug} — ${entry.detail}`);
  }

  /* ---------------------------- document tools ----------------------------- */
  console.log("\n--- document tools ---");
  await runTool("docx-to-pdf", { files: [F("doc.docx")] });
  await runTool("txt-to-pdf", { files: [F("notes.txt")] });
  await runTool("html-to-pdf", { files: [F("page.html")] });
  await runTool("markdown-to-pdf", { files: [F("doc.md")] });
  await runTool("rtf-to-pdf", { files: [F("doc.rtf")] });
  await runTool("pdf-to-docx", { files: [F("source.pdf")] });
  await runTool("pdf-to-txt", {
    files: [F("source.pdf")],
    check: async (_page, path) => {
      const text = readFileSync(path, "utf8");
      return text.includes("searchable text") ? "text extracted correctly" : "check failed: expected text missing";
    },
  });
  await runTool("pdf-to-html", { files: [F("source.pdf")] });
  await runTool("docx-to-html", {
    files: [F("doc.docx")],
    check: async (_page, path) => {
      const html = readFileSync(path, "utf8");
      return /<h[1-6]>|<p>/.test(html) ? "has real HTML structure" : "check failed: no HTML structure";
    },
  });
  await runTool("html-to-docx", {
    files: [F("page.html")],
    check: async (_page, path) => {
      const bytes = readFileSync(path);
      // A .docx is a ZIP: starts with PK and contains word/document.xml.
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return "check failed: not a ZIP";
      return "valid ZIP container";
    },
  });
  await runTool("document-word-counter", {
    files: [F("notes.txt")],
    check: async (_page, path) => {
      const report = readFileSync(path, "utf8");
      return /Words\s+\d+/.test(report) ? "report has word count" : "check failed: no count";
    },
  });
  await runTool("document-character-counter", { files: [F("notes.txt")] });
  await runTool("document-page-counter", { files: [F("source.pdf"), F("notes.txt")] });
  const originalText = readFileSync(F("notes.txt"), "utf8");
  await runTool("text-case-converter", {
    files: [F("notes.txt")],
    check: async (_page, path) => {
      const output = readFileSync(path, "utf8");
      if (output === originalText) return "check failed: output identical to input";
      // Default mode is Title Case, so the first letter of each word is capitalised.
      const titleCased = originalText.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
      return output === titleCased ? "converted to Title Case" : `check failed: unexpected output ${JSON.stringify(output.slice(0, 40))}`;
    },
  });

  // Word viewer is a dedicated component.
  {
    const page = await context.newPage();
    const entry = { slug: "word-document-viewer", pass: false, detail: "" };
    try {
      await page.goto(`${BASE}/tools/word-document-viewer`, { waitUntil: "networkidle", timeout: 45000 });
      await page.locator('input[type="file"]').first().setInputFiles([F("doc.docx")]);
      await page.waitForSelector("article .docx-viewer, article [class*=docx]", { timeout: 45000 }).catch(() => {});
      const body = await page.locator("article").textContent().catch(() => "");
      const hasExport = await page.getByRole("button", { name: /html|pdf/i }).count();
      entry.pass = body.includes("first paragraph") && hasExport >= 2;
      entry.detail = `rendered=${body.includes("first paragraph")} exportButtons=${hasExport}`;
    } catch (error) {
      entry.detail = error.message.split("\n")[0].slice(0, 140);
    }
    results.push(entry);
    await page.close();
    console.log(`  ${entry.pass ? "ok  " : "FAIL"} ${entry.detail ? "word-document-viewer" : "word-document-viewer"} — ${entry.detail}`);
  }

  /* ---------------------------- password round trip ------------------------ */
  console.log("\n--- password round trip (PDF.js verification) ---");
  const protectedBytes = readFileSync(`${WORK}/out-pdf-password-protector`);
  const unlockedBytes = readFileSync(`${WORK}/out-pdf-unlocker`);
  const roundTrip = {
    slug: "password-round-trip",
    pass: false,
    detail: "",
  };
  if (protectedBytes.length > 0 && unlockedBytes.length > 0) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const tryOpen = async (bytes, password) => {
      try {
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes), password });
        const doc = await task.promise;
        const text = await (await doc.getPage(1)).getTextContent();
        await task.destroy();
        return { ok: true, text: text.items.map((i) => i.str).join(" ") };
      } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 90) };
      }
    };
    const withPassword = await tryOpen(protectedBytes, "testpass123");
    const withoutPassword = await tryOpen(protectedBytes, "");
    const unlockedPlain = await tryOpen(unlockedBytes, "");

    const notes = [
      `opens with password=${withPassword.ok ? "yes" : "no"}`,
      `rejects empty password=${!withoutPassword.ok ? "yes" : "NO"}`,
      `unlocked opens freely=${unlockedPlain.ok ? "yes" : "no"}`,
    ];
    roundTrip.pass = withPassword.ok && !withoutPassword.ok && unlockedPlain.ok;
    roundTrip.detail = notes.join(", ");
    results.push(roundTrip);
    console.log(`  ${roundTrip.pass ? "ok  " : "FAIL"} ${roundTrip.slug} — ${roundTrip.detail}`);
  } else {
    roundTrip.detail = "protected or unlocked file missing";
    results.push(roundTrip);
    console.log(`  FAIL ${roundTrip.slug} — ${roundTrip.detail}`);
  }

  const privacyLeaks = uploads.filter((u) => !u.includes("/api/"));
  console.log(`\nOutbound requests carrying a body: ${uploads.length || "none"}`);
  if (privacyLeaks.length) console.log("  ⚠ " + privacyLeaks.join("\n  ⚠ "));

  await browser.close();
  server.kill("SIGKILL");

  const failures = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failures.length}/${results.length} tools passed`);
  if (failures.length) console.log("Failures:", failures.map((f) => f.slug).join(", "));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
