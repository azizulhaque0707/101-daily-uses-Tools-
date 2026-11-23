/* eslint-disable */
/**
 * Proves the local FFmpeg.wasm build works before anything depends on it.
 *
 * Loads the core from /vendor/ffmpeg/, decodes a generated test video, encodes
 * a WebM, and reads the output back. Runs against the production server so the
 * exact same asset paths the app uses are exercised.
 *
 * Usage: node scripts/verify-ffmpeg.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

const PORT = 3452;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore" });
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  const text = m.text();
  if (/error|fail/i.test(text)) console.log("  [console]", text.slice(0, 200));
});

try {
  await page.goto(`${BASE}/tools/video-trimmer`, { waitUntil: "domcontentloaded", timeout: 45000 });

  const result = await page.evaluate(async () => {
    const logs = [];

    // 1. Can the worker be created and the core loaded from our own origin?
    const worker = new Worker("/vendor/ffmpeg/ffmpeg-bridge.js", { type: "classic" });

    const loaded = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("load timed out after 120s")), 120000);
      worker.onmessage = (event) => {
        if (event.data.type === "loaded") {
          clearTimeout(timeout);
          resolve(true);
        } else if (event.data.type === "error") {
          clearTimeout(timeout);
          reject(new Error(event.data.message));
        }
      };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({
        type: "load",
        corePath: "/vendor/ffmpeg/ffmpeg-core.js",
        wasmPath: "/vendor/ffmpeg/ffmpeg-core.wasm",
      });
    });

    const call = (message, transfer) =>
      new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMessage = (event) => {
          if (event.data.id !== id) return;
          worker.removeEventListener("message", onMessage);
          if (event.data.type === "error") reject(new Error(event.data.message));
          else resolve(event.data);
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({ ...message, id }, transfer || []);
      });

    // Generate a 2-second 320x240 test video inside the worker's FS using
    // FFmpeg's own lavfi source, so no input file is needed.

    // Build a test input with the lavfi test source.
    const generated = await call({
      type: "exec",
      args: [
        "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest",
        "input.mp4",
      ],
    });

    logs.push(`generated test video, code=${generated.code}`);

    const inputBytes = await call({ type: "readFile", path: "input.mp4" });
    const inputSize = inputBytes.data ? inputBytes.data.byteLength : 0;
    logs.push(`input.mp4 is ${inputSize} bytes`);

    // 3. Run a real transcode.
    const transcoded = await call({
      type: "exec",
      args: [
        "-i", "input.mp4",
        "-t", "1",
        "-vf", "scale=160:120:force_original_aspect_ratio=decrease",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "out.mp4",
      ],
    });
    logs.push(`transcode code=${transcoded.code}`);

    const outputBytes = await call({ type: "readFile", path: "out.mp4" });
    const outputSize = outputBytes.data ? outputBytes.data.byteLength : 0;
    logs.push(`out.mp4 is ${outputSize} bytes`);

    // 4. Check that MP4 and WebM encoders are present.
    const encoders = await call({
      type: "exec",
      args: ["-encoders"],
    });
    // Reading the log would need stderr capture; instead check the encoder runs.
    const webm = await call({
      type: "exec",
      args: [
        "-i", "input.mp4", "-t", "1",
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-row-mt", "1",
        "-c:a", "libopus",
        "out.webm",
      ],
    });
    const webmBytes = await call({ type: "readFile", path: "out.webm" });
    const webmSize = webmBytes.data ? webmBytes.data.byteLength : 0;
    logs.push(`webm code=${webm.code} size=${webmSize}`);

    // 5. MP3 encoder check.
    const mp3 = await call({
      type: "exec",
      args: ["-i", "input.mp4", "-t", "1", "-c:a", "libmp3lame", "-b:a", "128k", "out.mp3"],
    });
    const mp3Bytes = await call({ type: "readFile", path: "out.mp3" });
    const mp3Size = mp3Bytes.data ? mp3Bytes.data.byteLength : 0;
    logs.push(`mp3 code=${mp3.code} size=${mp3Size}`);

    worker.terminate();

    return {
      loaded,
      inputSize,
      outputSize,
      webmSize,
      webmCode: webm.code,
      mp3Size,
      mp3Code: mp3.code,
      transcodedCode: transcoded.code,
      logs,
    };
  });

  check("FFmpeg core loads from local /vendor/ffmpeg/", result.loaded);
  check("test video generated by FFmpeg itself", result.inputSize > 1000, `${result.inputSize} bytes`);
  check("H.264 transcode with aspect-preserving scale", result.transcodedCode === 0 && result.outputSize > 500, `${result.outputSize} bytes`);
  check("VP9/WebM encoding available", result.webmCode === 0 && result.webmSize > 500, `${result.webmSize} bytes`);
  check("MP3 encoding available", result.mp3Code === 0 && result.mp3Size > 500, `${result.mp3Size} bytes`);

  console.log("\n  worker log:");
  result.logs.forEach((line) => console.log(`    ${line}`));
} catch (error) {
  check("FFmpeg pipeline", false, String(error.message || error).slice(0, 300));
}

await browser.close();
server.kill("SIGKILL");

console.log(failures === 0 ? "\nlocal FFmpeg.wasm verified" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
