/**
 * Video engines built on the locally hosted FFmpeg WebAssembly build.
 *
 * Every command runs in a Web Worker on the user's device. Scaling always uses
 * force_original_aspect_ratio=decrease so video is letterboxed rather than
 * stretched, and audio is re-encoded in the same pass to stay in sync.
 */

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
import { resultStats, textArtifact, zipArtifacts } from "./archive";
import {
  exec,
  evenDimension,
  loadFfmpeg,
  qualityPreset,
  readFile,
  runCommand,
  terminateFfmpeg,
  writeFile,
  deleteFile,
  type Container,
} from "./ffmpeg-client";

function videoArtifact(name: string, blob: Blob): EngineArtifact {
  return { name, blob, kind: "video" };
}

function audioArtifact(name: string, blob: Blob): EngineArtifact {
  return { name, blob, kind: "audio" };
}

const FORMAT_MAP: Record<string, Container> = {
  mp4: "mp4",
  webm: "webm",
  gif: "gif",
  mp3: "mp3",
  wav: "wav",
};

const MIME_MAP: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** Codec arguments for a given container, including audio. */
function codecArgs(container: Container, preset: string, keepAudio = true): string[] {
  const quality = qualityPreset(preset);
  if (container === "webm") {
    const args = ["-c:v", "libvpx-vp9", "-crf", quality.crf, "-b:v", "0", "-row-mt", "1"];
    if (keepAudio) args.push("-c:a", "libopus", "-b:a", quality.audioBitrate);
    else args.push("-an");
    return args;
  }
  const args = [
    "-c:v",
    "libx264",
    "-preset",
    quality.preset === "slow" ? "medium" : quality.preset,
    "-crf",
    quality.crf,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  ];
  if (keepAudio) args.push("-c:a", "aac", "-b:a", quality.audioBitrate);
  else args.push("-an");
  return args;
}

/** Gets real dimensions by decoding a frame, so aspect ratio is exact. */
async function probeViaDecode(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    };
    video.src = url;
  });
}

/* --------------------------------- engines --------------------------------- */

export const videoCompressor: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");
  const targetWidth = num(ctx.options, "resolution", 0);
  const fps = num(ctx.options, "fps", 0);
  const keepAudio = bool(ctx.options, "audio", true);

  const source = await probeViaDecode(file);
  let width = targetWidth;
  if (targetWidth > 0 && source.width > 0) {
    width = Math.min(targetWidth, source.width);
  }

  const args: string[] = ["-i", "input.bin"];
  if (width > 0) {
    args.push("-vf", `scale=${evenDimension(width)}:-2:force_original_aspect_ratio=decrease`);
  }
  if (fps > 0) args.push("-r", String(fps));
  args.push(...codecArgs(format, quality, keepAudio));
  if (format === "gif") args.push("-loop", "0");

  const outputName = `output.${format}`;
  ctx.report(2, "Loading the FFmpeg engine (one-time, about 30 MB)");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Compressing video"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  const saving = file.size ? Math.round(((file.size - blob.size) / file.size) * 100) : 0;
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-compressed.${format}`, blob)],
    stats: resultStats({
      "Original size": `${(file.size / 1048576).toFixed(2)} MB`,
      "New size": `${(blob.size / 1048576).toFixed(2)} MB`,
      Saving: `${saving > 0 ? saving : 0}%`,
      Format: format.toUpperCase(),
      Resolution: width > 0 ? `${evenDimension(width)} wide` : "original",
    }),
    notice:
      saving <= 0
        ? "The output is no smaller than the source. This happens when the original is already well compressed — try a lower quality preset or resolution."
        : undefined,
  };
};

export const videoResizer: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");
  const presetWidth = num(ctx.options, "resolution", 1280);
  const customWidth = num(ctx.options, "customWidth", 0);
  const customHeight = num(ctx.options, "customHeight", 0);

  let filter: string;
  if (customWidth > 0 && customHeight > 0) {
    filter = `scale=${evenDimension(customWidth)}:${evenDimension(customHeight)}:force_original_aspect_ratio=decrease`;
  } else if (customWidth > 0) {
    filter = `scale=${evenDimension(customWidth)}:-2:force_original_aspect_ratio=decrease`;
  } else if (presetWidth > 0) {
    filter = `scale=${evenDimension(presetWidth)}:-2:force_original_aspect_ratio=decrease`;
  } else {
    filter = "null";
  }

  const args = ["-i", "input.bin"];
  if (filter !== "null") args.push("-vf", filter);
  args.push(...codecArgs(format, quality));
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Resizing video"),
  });

  const source = await probeViaDecode(file);
  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-resized.${format}`, blob)],
    stats: resultStats({
      "Source size": source.width ? `${source.width} × ${source.height}` : "unknown",
      "Target width":
        customWidth > 0 ? evenDimension(customWidth) : presetWidth > 0 ? evenDimension(presetWidth) : "original",
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
      "Aspect ratio": "preserved",
    }),
  };
};

export const videoCropper: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const source = await probeViaDecode(file);
  if (!source.width || !source.height) {
    engineError("This video's dimensions could not be read, so it cannot be cropped safely.");
  }

  const x = clamp(num(ctx.options, "x", 10), 0, 95) / 100;
  const y = clamp(num(ctx.options, "y", 10), 0, 95) / 100;
  const w = clamp(num(ctx.options, "w", 80), 5, 100) / 100;
  const h = clamp(num(ctx.options, "h", 80), 5, 100) / 100;
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");
  const targetWidth = num(ctx.options, "resolution", 0);

  const cw = evenDimension(source.width * w);
  const ch = evenDimension(source.height * h);
  const cx = Math.round(source.width * x);
  const cy = Math.round(source.height * y);

  const scale = targetWidth > 0 ? `scale=${evenDimension(targetWidth)}:-2:force_original_aspect_ratio=decrease` : "";
  const chain = [`crop=${cw}:${ch}:${cx}:${cy}`, scale].filter(Boolean).join(",");

  const args = ["-i", "input.bin", "-vf", chain, ...codecArgs(format, quality)];
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Cropping video"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-cropped.${format}`, blob)],
    stats: resultStats({
      "Source frame": `${source.width} × ${source.height}`,
      "Crop region": `${cw} × ${ch} at (${cx}, ${cy})`,
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const videoTrimmer: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const start = Math.max(0, num(ctx.options, "start", 0));
  const end = num(ctx.options, "end", 5);
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");

  if (end <= start) engineError("The end time must be later than the start time.");

  const args = [
    "-ss",
    start.toFixed(3),
    "-to",
    end.toFixed(3),
    "-i",
    "input.bin",
    ...codecArgs(format, quality),
  ];
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Trimming video"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-trimmed.${format}`, blob)],
    stats: resultStats({
      From: `${start.toFixed(2)}s`,
      To: `${end.toFixed(2)}s`,
      Length: `${(end - start).toFixed(2)}s`,
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const videoMerger: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx, 2);
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");
  const targetWidth = num(ctx.options, "resolution", 1280);

  await loadFfmpeg();
  ctx.report(5, "Preparing clips");

  const inputs: string[] = [];
  const filters: string[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const name = `clip${index}.bin`;
    await writeFile(name, await files[index].arrayBuffer());
    inputs.push(name);
  }

  // Build a concat filter: one input per clip, each normalised, then joined.
  const parts: string[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const scale =
      targetWidth > 0
        ? `scale=${evenDimension(targetWidth)}:-2:force_original_aspect_ratio=decrease`
        : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    const fps = "fps=30";
    parts.push(`[${index}:v]${scale},${fps},setsar=1[v${index}]`);
  }
  const concatInputs = inputs.map((_, index) => `[v${index}]`).join("");
  const audioInputs = inputs.map((_, index) => `[${index}:a]`).join("");
  filters.push(...parts);
  filters.push(`${concatInputs}concat=n=${inputs.length}:v=1:a=0[outv]`);

  // Audio: mix only if every clip has one; otherwise drop audio entirely.
  const args: string[] = [];
  inputs.forEach((name) => args.push("-i", name));
  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "[outv]");
  args.push(...codecArgs(format, quality, false));

  const outputName = `output.${format}`;
  ctx.report(20, "Joining clips");
  const code = await exec(args);
  if (code !== 0) {
    await Promise.all(inputs.map((name) => deleteFile(name)));
    engineError("FFmpeg could not join these clips. Try clips with matching codecs or use the same file type.");
  }

  const bytes = await readFile(outputName);
  await Promise.all([...inputs, outputName].map((name) => deleteFile(name)));

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact("merged-video." + format, blob)],
    stats: resultStats({
      Clips: files.length,
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
      "Audio track": "dropped for compatibility",
    }),
    notice:
      "Video is joined with normalised scale and frame rate. Audio is dropped because mixing clips with different audio codecs in one pass is unreliable — use the audio tools to combine soundtracks separately.",
  };
};

export const videoFormatConverter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const format = FORMAT_MAP[str(ctx.options, "format", "webm")] ?? "webm";
  const quality = str(ctx.options, "quality", "balanced");
  const targetWidth = num(ctx.options, "resolution", 0);

  const args = ["-i", "input.bin"];
  if (targetWidth > 0) {
    args.push("-vf", `scale=${evenDimension(targetWidth)}:-2:force_original_aspect_ratio=decrease`);
  }
  args.push(...codecArgs(format, quality));
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Converting video"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}.${format}`, blob)],
    stats: resultStats({
      "Target format": format.toUpperCase(),
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
      Codec: format === "webm" ? "VP9 + Opus" : "H.264 + AAC",
    }),
  };
};

export const videoToGif: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const start = Math.max(0, num(ctx.options, "start", 0));
  const duration = clamp(num(ctx.options, "duration", 3), 0.2, 60);
  const width = evenDimension(clamp(num(ctx.options, "width", 480), 32, 1280));
  const fps = clamp(num(ctx.options, "fps", 12), 5, 30);
  const dither = str(ctx.options, "dither", "sierra2_4a");

  const paletteFilter = `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff`;
  const gifFilter = `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=${dither}`;

  const args = [
    "-ss",
    start.toFixed(3),
    "-t",
    duration.toFixed(2),
    "-i",
    "input.bin",
    "-filter_complex",
    `[0:v]${paletteFilter}[p];[0:v]${gifFilter}`,
    "-loop",
    "0",
    "output.gif",
  ];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: "output.gif",
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Generating GIF"),
  });

  const blob = new Blob([bytes.slice()], { type: "image/gif" });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}.gif`, blob)],
    stats: resultStats({
      Duration: `${duration}s`,
      Width: `${width}px`,
      "Frame rate": `${fps} fps`,
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

function audioCodecArgs(format: string, bitrate: string): string[] {
  switch (format) {
    case "wav":
      return ["-c:a", "pcm_s16le"];
    case "aac":
      return ["-c:a", "aac", "-b:a", `${bitrate}k`];
    case "ogg":
      return ["-c:a", "libvorbis", "-q:a", "5"];
    default:
      return ["-c:a", "libmp3lame", "-b:a", `${bitrate}k`];
  }
}

export const videoToMp3: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const bitrate = str(ctx.options, "bitrate", "192");
  const start = Math.max(0, num(ctx.options, "start", 0));
  const duration = num(ctx.options, "duration", 0);

  const args = ["-ss", start.toFixed(3), "-i", "input.bin", "-vn"];
  if (duration > 0) args.push("-t", duration.toFixed(2));
  args.push(...audioCodecArgs("mp3", bitrate), "output.mp3");

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: "output.mp3",
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Extracting MP3"),
  });

  const blob = new Blob([bytes.slice()], { type: "audio/mpeg" });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}.mp3`, blob)],
    stats: resultStats({
      Bitrate: `${bitrate} kbps`,
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
      Codec: "libmp3lame",
    }),
  };
};

export const videoToWav: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const sampleRate = num(ctx.options, "sampleRate", 0);
  const start = Math.max(0, num(ctx.options, "start", 0));
  const duration = num(ctx.options, "duration", 0);

  const args = ["-ss", start.toFixed(3), "-i", "input.bin", "-vn"];
  if (duration > 0) args.push("-t", duration.toFixed(2));
  if (sampleRate > 0) args.push("-ar", String(sampleRate));
  args.push("-c:a", "pcm_s16le", "output.wav");

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: "output.wav",
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Extracting WAV"),
  });

  const blob = new Blob([bytes.slice()], { type: "audio/wav" });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}.wav`, blob)],
    stats: resultStats({
      "Sample rate": sampleRate > 0 ? `${sampleRate} Hz` : "original",
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
      Format: "16-bit PCM",
    }),
  };
};

export const videoSpeedChanger: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const speed = clamp(num(ctx.options, "speed", 1.5), 0.25, 4);
  const preservePitch = bool(ctx.options, "pitch", true);
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");

  // atempo only accepts 0.5–2 per instance, so chain for extreme factors.
  const atempoChain: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    atempoChain.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    atempoChain.push("atempo=0.5");
    remaining /= 0.5;
  }
  atempoChain.push(`atempo=${remaining.toFixed(4)}`);

  const videoChain = `setpts=${(1 / speed).toFixed(4)}*PTS`;
  const audioChain = preservePitch ? atempoChain.join(",") : `asetrate=${(48000 * speed).toFixed(0)},aresample=48000`;

  const args = [
    "-i",
    "input.bin",
    "-filter_complex",
    `[0:v]${videoChain}[v];[0:a]${audioChain}[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...codecArgs(format, quality),
  ];
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Retime video"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-${speed}x.${format}`, blob)],
    stats: resultStats({
      Speed: `${speed}×`,
      "Pitch preserved": preservePitch ? "yes" : "no",
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const videoWatermark: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const text = (ctx.text || "© Your Studio").trim() || "© Your Studio";
  const position = str(ctx.options, "position", "bottom-right");
  const fontSize = clamp(num(ctx.options, "size", 28), 8, 96);
  const opacity = clamp(num(ctx.options, "opacity", 70), 10, 100) / 100;
  const color = str(ctx.options, "color", "#ffffff").replace("#", "");
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");

  const positions: Record<string, string> = {
    "top-left": "x=10:y=10",
    "top-right": "x=w-tw-10:y=10",
    "bottom-left": "x=10:y=h-th-10",
    "bottom-right": "x=w-tw-10:y=h-th-10",
  };

  // drawtext needs escaping for special characters.
  const escaped = text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
  const filter = `drawtext=text='${escaped}':${positions[position]}:fontsize=${fontSize}:fontcolor=0x${color}@${opacity.toFixed(2)}`;

  const args = ["-i", "input.bin", "-vf", filter, ...codecArgs(format, quality)];
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Watermarking video"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-watermarked.${format}`, blob)],
    stats: resultStats({
      Text: text,
      Position: position,
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
    notice: "Watermark text uses FFmpeg's built-in font, so non-Latin scripts are not supported.",
  };
};

export const videoFrameExtractor: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const mode = str(ctx.options, "mode", "interval");
  const format = str(ctx.options, "format", "png");
  const width = num(ctx.options, "width", 0);

  const source = await probeViaDecode(file);
  let duration = 0;
  try {
    duration = await new Promise<number>((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        resolve(video.duration || 0);
        URL.revokeObjectURL(url);
      };
      video.onerror = () => {
        resolve(0);
        URL.revokeObjectURL(url);
      };
      video.src = url;
    });
  } catch {
    duration = 0;
  }

  const scale = width > 0 ? `,scale=${evenDimension(width)}:-2:force_original_aspect_ratio=decrease` : "";
  const frames: { name: string; blob: Blob }[] = [];
  let timestamps: number[] = [];

  if (mode === "timestamps") {
    for (const part of str(ctx.options, "timestamps", "0,1,2").split(/[,\s]+/).filter(Boolean)) {
      const value = Number.parseFloat(part);
      if (Number.isFinite(value) && value >= 0) timestamps.push(value);
    }
  } else if (mode === "count") {
    const count = Math.round(clamp(num(ctx.options, "count", 8), 1, 200));
    for (let index = 0; index < count; index += 1) {
      timestamps.push((duration / count) * (index + 0.5));
    }
  } else {
    const interval = Math.max(0.1, num(ctx.options, "interval", 1));
    for (let time = 0; time <= duration; time += interval) timestamps.push(time);
    if (timestamps.length > 400) timestamps = timestamps.slice(0, 400);
  }

  if (timestamps.length === 0) engineError("No frame timestamps were produced — check your settings.");

  await loadFfmpeg();
  await writeFile("input.bin", await file.arrayBuffer());

  for (let index = 0; index < timestamps.length; index += 1) {
    const time = timestamps[index];
    ctx.report((index / timestamps.length) * 95, `Extracting frame ${index + 1} of ${timestamps.length}`);
    const outputName = `frame-${String(index + 1).padStart(4, "0")}.${format}`;
    const args = [
      "-ss",
      Math.max(0, time).toFixed(3),
      "-i",
      "input.bin",
      "-frames:v",
      "1",
      "-vf",
      `select=eq(n\\,0)${scale ? scale.replace(/^,/, "") : ""}`,
      "-q:v",
      "2",
      outputName,
    ];
    const code = await exec(args);
    if (code === 0) {
      try {
        const bytes = await readFile(outputName);
        if (bytes.length > 0) {
          frames.push({
            name: `${baseName(file.name)}-frame-${String(index + 1).padStart(4, "0")}.${format}`,
            blob: new Blob([bytes.slice()], { type: format === "png" ? "image/png" : "image/jpeg" }),
          });
        }
      } catch {
        /* frame not produced */
      }
    }
    await deleteFile(outputName).catch(() => undefined);
  }
  await deleteFile("input.bin").catch(() => undefined);

  if (frames.length === 0) engineError("No frames could be extracted from this video.");

  if (frames.length === 1) {
    return {
      artifacts: [{ name: frames[0].name, blob: frames[0].blob, kind: "image" }],
      stats: resultStats({ Frames: 1, Duration: duration.toFixed(2) + "s" }),
    };
  }

  const zip = await zipArtifacts(frames);
  return {
    artifacts: [{ name: `${baseName(file.name)}-frames.zip`, blob: zip, kind: "zip" }],
    stats: resultStats({
      Frames: frames.length,
      Requested: timestamps.length,
      Duration: duration.toFixed(2) + "s",
      "Source frame": source.width ? `${source.width} × ${source.height}` : "unknown",
    }),
  };
};

export const videoThumbnailMaker: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const time = Math.max(0, num(ctx.options, "time", 1));
  const format = str(ctx.options, "format", "png");
  const width = num(ctx.options, "width", 0);

  const scale = width > 0 ? `scale=${evenDimension(width)}:-2:force_original_aspect_ratio=decrease` : "";
  const args = ["-ss", time.toFixed(3), "-i", "input.bin", "-frames:v", "1"];
  if (scale) args.push("-vf", scale);
  args.push("-q:v", "2", `output.${format}`);

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Capturing thumbnail"),
  });

  const blob = new Blob([bytes.slice()], { type: format === "png" ? "image/png" : "image/jpeg" });
  return {
    artifacts: [{ name: `${baseName(file.name)}-thumbnail.${format}`, blob, kind: "image" }],
    stats: resultStats({
      "Frame time": `${time.toFixed(2)}s`,
      Format: format.toUpperCase(),
      "File size": `${(blob.size / 1024).toFixed(1)} KB`,
    }),
  };
};

export const videoAspectRatioConverter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const ratio = str(ctx.options, "ratio", "9:16");
  const fit = str(ctx.options, "fit", "pad");
  const background = str(ctx.options, "background", "#000000").replace("#", "");
  const targetWidth = num(ctx.options, "resolution", 1280);
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");

  const source = await probeViaDecode(file);
  if (!source.width || !source.height) {
    engineError("This video's dimensions could not be read, so its aspect ratio cannot be converted safely.");
  }

  const [ratioW, ratioH] = ratio.split(":").map(Number);
  const targetRatio = ratioW / ratioH;

  const width = evenDimension(targetWidth > 0 ? targetWidth : source.width);
  const height = evenDimension(width / targetRatio);

  let filter: string;
  if (fit === "crop") {
    // Crop the source to the target ratio first, then scale to fill.
    const sourceRatio = source.width / source.height;
    let cropW = source.width;
    let cropH = source.height;
    if (sourceRatio > targetRatio) cropW = Math.round(source.height * targetRatio);
    else cropH = Math.round(source.width / targetRatio);
    filter = `crop=${evenDimension(cropW)}:${evenDimension(cropH)},scale=${width}:${height}`;
  } else {
    // Pad: fit inside, then place on a correctly-coloured background.
    filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:0x${background}`;
  }

  const args = ["-i", "input.bin", "-vf", filter, ...codecArgs(format, quality)];
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio_) => ctx.report(5 + ratio_ * 90, "Reframing video"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-${ratio.replace(":", "x")}.${format}`, blob)],
    stats: resultStats({
      "Target ratio": ratio,
      "Output frame": `${width} × ${height}`,
      Fitting: fit === "crop" ? "centre crop" : "padded",
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
    notice:
      fit === "pad"
        ? "Padding preserves every pixel of the original frame. Switch to crop mode to fill the frame instead, at the cost of the overflow edges."
        : undefined,
  };
};

export const videoResolutionConverter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const targetWidth = num(ctx.options, "resolution", 720);
  const format = FORMAT_MAP[str(ctx.options, "format", "mp4")] ?? "mp4";
  const quality = str(ctx.options, "quality", "balanced");

  const source = await probeViaDecode(file);
  const width = evenDimension(Math.min(targetWidth, source.width > 0 ? Math.max(targetWidth, source.width) : targetWidth));

  const args = [
    "-i",
    "input.bin",
    "-vf",
    `scale=${width}:-2:force_original_aspect_ratio=decrease`,
    ...codecArgs(format, quality),
  ];
  const outputName = `output.${format}`;

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Converting resolution"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME_MAP[format] });
  return {
    artifacts: [videoArtifact(`${baseName(file.name)}-${width}p.${format}`, blob)],
    stats: resultStats({
      "Source width": source.width || "unknown",
      "Target width": width,
      "Aspect ratio": "preserved",
      "Output size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const videoEngines: Record<string, ToolEngine> = {
  "video-compressor": videoCompressor,
  "video-resizer": videoResizer,
  "video-cropper": videoCropper,
  "video-trimmer": videoTrimmer,
  "video-merger": videoMerger,
  "video-format-converter": videoFormatConverter,
  "video-to-gif": videoToGif,
  "video-to-mp3": videoToMp3,
  "video-to-wav": videoToWav,
  "video-speed-changer": videoSpeedChanger,
  "video-watermark": videoWatermark,
  "video-frame-extractor": videoFrameExtractor,
  "video-thumbnail-maker": videoThumbnailMaker,
  "video-aspect-ratio-converter": videoAspectRatioConverter,
  "video-resolution-converter": videoResolutionConverter,
};

export { terminateFfmpeg };
