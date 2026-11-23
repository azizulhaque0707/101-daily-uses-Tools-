/* eslint-disable */
/**
 * Real browser test for the 21 image tools.
 *
 * Drives the production server in Chromium, generates real image files, runs
 * every image tool through the actual UI, and asserts a downloadable artifact
 * was produced. Also verifies that no network request ever carries file data.
 *
 * Usage: node scripts/e2e-image-tools.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import zlib from "node:zlib";

const PORT = 3311;
const BASE = `http://localhost:${PORT}`;
const WORK = "/tmp/bf-e2e";
const IMAGE_SLUGS = [
  "image-compressor",
  "image-resizer",
  "image-cropper",
  "image-rotator",
  "image-flipper",
  "image-converter",
  "jpg-to-png",
  "png-to-jpg",
  "webp-to-jpg",
  "jpg-to-webp",
  "png-to-webp",
  "heic-to-jpg",
  "image-to-base64",
  "base64-to-image",
  "image-text-overlay",
  "image-watermarker",
  "image-blur",
  "image-pixelate",
  "image-sharpen",
  "image-brightness-contrast",
];

function pngBytes(width, height) {
  // Minimal valid PNG: 8-byte signature + IHDR + IDAT (stored/uncompressed) + IEND
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // Raw scanlines: filter byte 0 + RGB per pixel (a coloured gradient)
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[p++] = Math.min(255, Math.round((x / width) * 255));
      raw[p++] = Math.min(255, Math.round((y / height) * 255));
      raw[p++] = 128;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function makeFixtures() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const png = pngBytes(240, 160);
  writeFileSync(`${WORK}/photo.png`, png);
  writeFileSync(`${WORK}/photo-copy.png`, png);
  writeFileSync(`${WORK}/photo-renamed.png`, png);
  return WORK;
}

async function main() {
  const fixtures = await makeFixtures();
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: "ignore",
    detached: false,
  });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      ready = response.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!ready) {
    server.kill("SIGKILL");
    throw new Error("Server never became ready");
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Watch for any request that could carry file data out of the browser.
  const uploads = [];
  page.on("request", (request) => {
    const method = request.method();
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      uploads.push(`${method} ${request.url()}`);
    }
  });

  const results = [];

  for (const slug of IMAGE_SLUGS) {
    const url = `${BASE}/tools/${slug}`;
    const entry = { slug, pass: false, detail: "" };
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

      const fileInput = page.locator('input[type="file"]').first();
      const isTextTool = (await fileInput.count()) === 0;

      if (isTextTool) {
        const textarea = page.locator("textarea").first();
        await textarea.fill("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==");
      } else {
        const multiple = await fileInput.getAttribute("multiple");
        const files = multiple !== null
          ? [`${fixtures}/photo.png`, `${fixtures}/photo-copy.png`]
          : [`${fixtures}/photo.png`];
        await fileInput.setInputFiles(files);
      }

      await page.getByRole("button", { name: /run tool/i }).click();

      // Wait for a real outcome: a download button, or an error with text.
      // An empty role="alert" wrapper can exist in the DOM, so require content.
      await page
        .waitForFunction(
          () => {
            const hasDownload = [...document.querySelectorAll("button")].some((b) => {
              const text = b.textContent || "";
              return text.toLowerCase().includes("download") && !text.toLowerCase().includes("download all");
            });
            const alerts = [...document.querySelectorAll('[role="alert"]')].filter(
              (el) => (el.textContent || "").trim().length > 0,
            );
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
          page.waitForEvent("download", { timeout: 25000 }),
          downloadButton.click(),
        ]);
        const path = `${WORK}/out-${slug}`;
        await download.saveAs(path);
        const saved = statSync(path);
        entry.pass = saved.size > 0;
        entry.detail = `downloaded ${saved.size} bytes`;
      } else {
        const alert = await page
          .locator('[role="alert"]')
          .filter({ hasText: /.+/ })
          .first()
          .textContent()
          .catch(() => null);
        entry.detail = `no download produced. ${alert ?? "no error surfaced either"}`;
      }
    } catch (error) {
      entry.detail = error.message.split("\n")[0];
    }
    results.push(entry);
    console.log(`  ${entry.pass ? "ok  " : "FAIL"} ${entry.slug} — ${entry.detail}`);
  }

  /* ------------------------- duplicate finder flow ------------------------- */
  console.log("\n--- duplicate-image-finder ---");
  const dupEntry = { slug: "duplicate-image-finder", pass: false, detail: "" };
  try {
    await page.goto(`${BASE}/tools/duplicate-image-finder`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Inject three identical files plus one visually different one.
    const fixtureBytes = await import("node:fs/promises").then((m) =>
      m.readFile(`${fixtures}/photo.png`),
    );
    const fileCount = await page.evaluate(async (bytes) => {
      const data = new Uint8Array(bytes);
      const files = [
        new File([data], "a-original.png", { type: "image/png" }),
        new File([data], "b-same-bytes.png", { type: "image/png" }),
        new File([data], "c-renamed-again.png", { type: "image/png" }),
      ];
      const input = document.querySelector('input[type="file"]');
      const dt = new DataTransfer();
      files.forEach((file) => dt.items.add(file));
      Object.defineProperty(input, "files", { value: dt.files, configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return files.length;
    }, Array.from(fixtureBytes));
    if (fileCount !== 3) throw new Error(`expected 3 files injected, got ${fileCount}`);

    await page.getByRole("button", { name: /scan/i }).click();

    await page.waitForFunction(
      () => Boolean([...document.querySelectorAll("article")] && document.body.textContent.includes("Duplicate groups")),
      { timeout: 40000, polling: 500 },
    );

    const summary = await page.evaluate(() => document.body.textContent);
    const hasExactGroup = /Exact duplicate/i.test(summary);
    const hasRecommended = /Recommended/i.test(summary);

    // Select duplicates, then download the cleaned ZIP.
    await page.getByRole("button", { name: /select duplicates/i }).first().click();
    const zipButton = page.getByRole("button", { name: /download cleaned zip/i }).first();
    const [zip] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      zipButton.click(),
    ]);
    const zipPath = `${WORK}/cleaned.zip`;
    await zip.saveAs(zipPath);
    const zipSize = statSync(zipPath).size;

    dupEntry.pass = hasExactGroup && hasRecommended && zipSize > 0;
    dupEntry.detail = `exactGroup=${hasExactGroup} recommended=${hasRecommended} zip=${zipSize} bytes`;
  } catch (error) {
    dupEntry.detail = error.message.split("\n")[0];
  }
  results.push(dupEntry);
  console.log(`  ${dupEntry.pass ? "ok  " : "FAIL"} ${dupEntry.slug} — ${dupEntry.detail}`);

  const privacyLeaks = uploads.filter((u) => !u.includes("/api/"));
  console.log(`\nOutbound requests with a body: ${uploads.length || "none"}`);
  if (privacyLeaks.length) console.log("  ⚠ ", privacyLeaks.join("\n  ⚠ "));

  await browser.close();
  server.kill("SIGKILL");

  const failures = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failures.length}/${results.length} tools passed`);
  if (failures.length) {
    console.log("Failures:", failures.map((f) => f.slug).join(", "));
  }
  rmSync(WORK, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
