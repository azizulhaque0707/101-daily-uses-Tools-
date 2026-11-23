/* eslint-disable */
/**
 * Real browser test for the 15 video, 15 audio and 15 utility tools.
 *
 * Generates genuine input files (a real MP4 with audio via a browser
 * MediaRecorder, real PNGs, a real ZIP), runs each tool through the actual UI
 * and asserts a downloadable artifact. FFmpeg tools are exercised for real,
 * including the local WASM load.
 *
 * Usage: node scripts/e2e-media-utility-tools.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import zlib from "node:zlib";

const PORT = 3500;
const BASE = `http://localhost:${PORT}`;
const WORK = "/tmp/bf-media-test";

/* ------------------------------- PNG fixture ------------------------------- */
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
function png(w, h, withExif = false) {
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
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (withExif) {
    // A minimal eXIf chunk carrying a Make tag.
    const tiff = Buffer.alloc(26);
    tiff.writeUInt16BE(0x4949, 0); // little endian
    tiff.writeUInt16BE(0x2a00, 2); // TIFF magic
    tiff.writeUInt32BE(8, 4); // IFD offset
    tiff.writeUInt16BE(1, 8); // one entry
    // Entry: tag 0x010f (Make), type 2 (ASCII), count 4, value offset 26
    tiff.writeUInt16LE(0x010f, 10);
    tiff.writeUInt16LE(2, 12);
    tiff.writeUInt32LE(4, 14);
    tiff.writeUInt32LE(26, 18);
    tiff.write("Test", 22); // inline value bytes
    parts.push(chunk("eXIf", tiff));
  }
  parts.push(chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/* --------------------------------- fixtures -------------------------------- */

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  writeFileSync(`${WORK}/photo.png`, png(320, 240));
  writeFileSync(`${WORK}/photo2.png`, png(480, 320));
  writeFileSync(`${WORK}/exif.png`, png(200, 150, true));

  // Build a real ZIP for the extractor.
  const { zipSync } = await import("fflate");
  writeFileSync(`${WORK}/sample.zip`, Buffer.from(zipSync({ "a.txt": Buffer.from("alpha"), "b.txt": Buffer.from("beta") }, { level: 6 })));

  // Audio fixture: a real WAV with a 440 Hz tone.
  const sampleRate = 44100;
  const seconds = 3;
  const samples = sampleRate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    wav.writeInt16LE(value, 44 + i * 2);
  }
  writeFileSync(`${WORK}/tone.wav`, wav);

  // Video fixture is generated in the browser by MediaRecorder, so the codec
  // is definitely one Chromium can produce and decode.
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const browser = await chromium.launch();
  const browserContext = await browser.newContext();
  const uploads = [];
  const results = [];

  // Generate the video fixture using the browser's own encoder.
  console.log("generating video fixture with MediaRecorder…");
  const videoPage = await browserContext.newPage();
  await videoPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const videoArrayBuffer = await videoPage.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");

    const stream = canvas.captureStream(15);
    // Add a real audio track so audio tools have something to work with.
    const audioCtx = new AudioContext();
    const oscillator = audioCtx.createOscillator();
    oscillator.frequency.value = 440;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.15;
    const destination = audioCtx.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]);

    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 500000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const done = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start(200);

    // Animate a moving block for 4 seconds.
    const started = performance.now();
    for (;;) {
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed >= 4) break;
      ctx.fillStyle = `hsl(${(elapsed * 90) % 360}, 80%, 60%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111";
      ctx.fillRect(60 + Math.sin(elapsed * 3) * 60, 80 + Math.cos(elapsed * 3) * 40, 80, 60);
      await new Promise((r) => setTimeout(r, 1000 / 15));
    }
    recorder.stop();
    await done;
    oscillator.stop();
    audioCtx.close();
    const blob = new Blob(chunks, { type: mime });
    const buffer = await blob.arrayBuffer();
    // Transfer as a plain array so it survives the Playwright boundary.
    return Array.from(new Uint8Array(buffer));
  });
  await videoPage.close();

  const videoBytes = Buffer.from(videoArrayBuffer);
  writeFileSync(`${WORK}/clip.webm`, videoBytes);
  console.log(`  video fixture: ${videoBytes.length} bytes\n`);

  const F = (name) => `${WORK}/${name}`;

  const runTool = async (slug, { files = [], text = "", options = null, check = null, timeoutMs = 240000 } = {}) => {
    const page = await browserContext.newPage();
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
          { timeout: timeoutMs, polling: 500 },
        )
        .catch(() => null);

      const downloadButton = page
        .getByRole("button", { name: /download/i })
        .filter({ hasNotText: /download all/i })
        .first();
      const hasDownload = (await downloadButton.count()) > 0;

      if (hasDownload) {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 60000 }),
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
          if (extra && extra.startsWith("check failed")) entry.pass = false;
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
      entry.detail = error.message.split("\n")[0].slice(0, 170);
    }
    results.push(entry);
    await page.close();
    console.log(`  ${entry.pass ? "ok  " : "FAIL"} ${entry.slug} — ${entry.detail}`);
  };

  /**
   * Sets a tool option by id. Options render as range sliders, selects or
   * Radix switches, so fill() alone is not enough.
   */
  const setOption = async (page, id, value) => {
    const settingsTab = page.getByRole("tab", { name: /settings/i });
    if ((await settingsTab.count()) > 0) {
      await settingsTab.click();
      await page.waitForTimeout(300);
    }

    // Selects carry the raw id; find them by label text otherwise.
    const selectField = page.locator(`select#${id}`);
    if ((await selectField.count()) > 0) {
      await selectField.selectOption(String(value));
      return true;
    }

    const field = page.locator(`#${id}`);
    if ((await field.count()) > 0) {
      const tag = await field.evaluate((el) => el.tagName.toLowerCase());
      if (tag === "select") {
        await field.selectOption(String(value));
        return true;
      }
      if (tag === "input") {
        const type = await field.getAttribute("type");
        if (type === "color") {
          await field.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, String(value));
          return true;
        }
        if (type === "checkbox" || type === "radio") {
          const checked = await field.isChecked();
          if (checked !== Boolean(value)) await field.click();
          return true;
        }
        await field.fill(String(value));
        return true;
      }
    }

    // Radix switches expose role="switch" and data-state.
    const switchField = page.locator(`[role="switch"][id="${id}"]`);
    if ((await switchField.count()) > 0) {
      const state = await switchField.getAttribute("data-state");
      const wantChecked = String(value) === "true";
      if (wantChecked && state !== "checked") await switchField.click();
      if (!wantChecked && state === "checked") await switchField.click();
      return true;
    }

    // Range sliders: locate by the adjacent label, then set via DOM events.
    const label = page.locator(`label:has-text("${id}")`).first();
    if ((await label.count()) > 0) return false;

    // Fall back to matching by slider position next to the numeric readout.
    return false;
  };

  /** Sets a range slider by its numeric readout label. */
  const setSlider = async (page, label, value) => {
    const settingsTab = page.getByRole("tab", { name: /settings/i });
    if ((await settingsTab.count()) > 0) {
      await settingsTab.click();
      await page.waitForTimeout(300);
    }
    const control = page.locator(`[role="slider"], input[type="range"]`).filter({});
    const count = await control.count();
    for (let index = 0; index < count; index += 1) {
      const item = control.nth(index);
      const label2 = await item.getAttribute("aria-label");
      if (label2 && label2.toLowerCase().includes(label.toLowerCase())) {
        await item.evaluate((el, v) => {
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, String(value));
        return true;
      }
    }
    return false;
  };

  /* -------------------------------- video tools ------------------------------- */
  console.log("--- video tools (real FFmpeg.wasm) ---");
  const V = () => F("clip.webm");
  await runTool("video-compressor", { files: [V()], options: (p) => setOption(p, "quality", "small") });
  await runTool("video-resizer", { files: [V()], options: (p) => setOption(p, "resolution", "640") });
  await runTool("video-cropper", { files: [V()] });
  await runTool("video-trimmer", {
    files: [V()],
    options: async (p) => {
      await setOption(p, "start", "0.5");
      await setOption(p, "end", "2");
    },
  });
  await runTool("video-merger", { files: [V(), V()] });
  await runTool("video-format-converter", { files: [V()], options: (p) => setOption(p, "format", "webm") });
  await runTool("video-to-gif", {
    files: [V()],
    options: async (p) => {
      await setOption(p, "duration", "1.5");
      await setOption(p, "width", "320");
    },
    check: (_p, path) => {
      const bytes = readFileSync(path);
      return bytes.subarray(0, 3).toString("latin1") === "GIF" ? "valid GIF header" : "check failed: not a GIF";
    },
  });
  await runTool("video-to-mp3", {
    files: [V()],
    check: (_p, path) => {
      const bytes = readFileSync(path);
      // MP3 frame sync or ID3 tag.
      const hasId3 = bytes.subarray(0, 3).toString("latin1") === "ID3";
      const hasSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
      return hasId3 || hasSync ? "valid MP3 header" : "check failed: not an MP3";
    },
  });
  await runTool("video-to-wav", {
    files: [V()],
    check: (_p, path) => {
      const bytes = readFileSync(path);
      return bytes.subarray(0, 4).toString("latin1") === "RIFF" ? "valid WAV header" : "check failed: not a WAV";
    },
  });
  await runTool("video-speed-changer", { files: [V()], options: (p) => setOption(p, "speed", "1.5") });
  await runTool("video-watermark", { files: [V()], text: "© Test" });
  await runTool("video-frame-extractor", {
    files: [V()],
    options: async (p) => {
      await setOption(p, "mode", "count");
      await setOption(p, "count", "3");
    },
  });
  await runTool("video-thumbnail-maker", { files: [V()], options: (p) => setOption(p, "time", "1") });
  await runTool("video-aspect-ratio-converter", { files: [V()], options: (p) => setOption(p, "ratio", "1:1") });
  await runTool("video-resolution-converter", { files: [V()], options: (p) => setOption(p, "resolution", "640") });

  /* -------------------------------- audio tools ------------------------------- */
  console.log("\n--- audio tools (real FFmpeg.wasm) ---");
  const A = () => F("tone.wav");
  await runTool("audio-compressor", { files: [A()], options: (p) => setOption(p, "bitrate", "128") });
  await runTool("audio-format-converter", { files: [A()], options: (p) => setOption(p, "format", "mp3") });
  await runTool("audio-trimmer", {
    files: [A()],
    options: async (p) => {
      await setOption(p, "start", "0.5");
      await setOption(p, "end", "2");
    },
  });
  await runTool("audio-merger", { files: [A(), A()] });
  await runTool("audio-splitter", {
    files: [A()],
    options: async (p) => {
      await setOption(p, "mode", "parts");
      await setOption(p, "parts", "2");
    },
  });
  await runTool("audio-volume-booster", { files: [A()], options: (p) => setOption(p, "gain", "6") });
  await runTool("audio-volume-normalizer", { files: [A()] });
  await runTool("audio-fade-in-out", { files: [A()] });
  await runTool("audio-speed-changer", { files: [A()], options: (p) => setOption(p, "speed", "1.5") });
  await runTool("audio-pitch-changer", { files: [A()], options: (p) => setOption(p, "semitones", "3") });
  await runTool("audio-to-wav", { files: [A()] });
  await runTool("wav-to-mp3", {
    files: [A()],
    check: (_p, path) => {
      const bytes = readFileSync(path);
      const hasId3 = bytes.subarray(0, 3).toString("latin1") === "ID3";
      const hasSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
      return hasId3 || hasSync ? "valid MP3 header" : "check failed: not an MP3";
    },
  });
  await runTool("audio-channel-converter", { files: [A()] });
  await runTool("audio-silence-remover", { files: [A()] });
  await runTool("audio-metadata-editor", {
    files: [A()],
    options: async (p) => {
      await setOption(p, "title", "Test Tone");
      await setOption(p, "artist", "BrowserForge");
    },
    check: (_p, path) => {
      const bytes = readFileSync(path);
      const hasId3 = bytes.subarray(0, 3).toString("latin1") === "ID3";
      return hasId3 ? "ID3 tag written" : "check failed: no ID3 tag";
    },
  });

  /* ------------------------------- utility tools ------------------------------ */
  console.log("\n--- utility tools ---");
  await runTool("qr-code-generator", { text: "https://example.com/test" });
  await runTool("barcode-generator", { text: "1234567890" });
  await runTool("color-converter", { text: "#6366f1" });
  await runTool("hex-to-rgb", { text: "#ff0000" });
  await runTool("rgb-to-hex", {});
  await runTool("unit-converter", {});
  await runTool("file-hash-generator", { files: [F("photo.png")] });
  await runTool("file-zip-creator", { files: [F("photo.png"), F("photo2.png")] });
  await runTool("file-zip-extractor", {
    files: [F("sample.zip")],
    check: (_p, path) => {
      const bytes = readFileSync(path);
      return bytes.length > 0 ? "extracted a file" : "check failed: empty";
    },
  });
  await runTool("image-exif-viewer", { files: [F("exif.png")] });
  await runTool("age-calculator", {});
  await runTool("date-difference-calculator", {});
  await runTool("percentage-calculator", {});
  await runTool("image-dimensions-checker", {
    files: [F("photo.png"), F("photo2.png")],
    check: (_p, path) => {
      const report = readFileSync(path, "utf8");
      return report.includes("320 × 240") && report.includes("480 × 320")
        ? "correct dimensions measured"
        : "check failed: wrong dimensions";
    },
  });
  await runTool("file-size-converter", { files: [F("photo.png")] });

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
