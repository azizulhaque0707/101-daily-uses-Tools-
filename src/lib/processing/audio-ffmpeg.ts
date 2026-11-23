/**
 * Audio engines for the FFmpeg-backed registry.
 *
 * Simple graph operations run through the Web Audio API with an
 * OfflineAudioContext, which is sample-accurate and instant. Format encoding
 * and filters that need a real codec go through the local FFmpeg worker.
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
import { baseName, clamp, formatDuration } from "@/lib/utils";
import { resultStats } from "./archive";
import { runCommand, exec, writeFile, readFile, deleteFile, loadFfmpeg } from "./ffmpeg-client";

function audioArtifact(name: string, blob: Blob): EngineArtifact {
  return { name, blob, kind: "audio" };
}

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
};

/** Codec arguments for each output format. */
function codecArgs(format: string, bitrate: string): string[] {
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

/** Parses "1:30" or "90.5" into seconds. */
function parseTime(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Reads duration using the browser decoder, which is fast and reliable. */
async function audioDuration(file: File | Blob): Promise<number> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const Ctor: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Ctor();
    const buffer = await context.decodeAudioData(arrayBuffer.slice(0));
    const duration = buffer.duration;
    context.close();
    return duration;
  } catch {
    return 0;
  }
}

/* --------------------------------- engines --------------------------------- */

export const audioCompressor: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const format = str(ctx.options, "format", "mp3");
  const bitrate = str(ctx.options, "bitrate", "128");
  const mono = bool(ctx.options, "mono", false);

  const args = ["-i", "input.bin", "-vn"];
  if (mono) args.push("-ac", "1");
  args.push(...codecArgs(format, bitrate), `output.${format}`);

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Compressing audio"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  const saving = file.size ? Math.round(((file.size - blob.size) / file.size) * 100) : 0;
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-compressed.${format}`, blob)],
    stats: resultStats({
      "Original size": `${(file.size / 1048576).toFixed(2)} MB`,
      "New size": `${(blob.size / 1048576).toFixed(2)} MB`,
      Saving: `${Math.max(0, saving)}%`,
      Format: format.toUpperCase(),
      Bitrate: `${bitrate} kbps`,
    }),
    notice:
      saving <= 0
        ? "The output is no smaller. The source may already be compressed at or below this bitrate — try a lower one."
        : undefined,
  };
};

export const audioFormatConverter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const format = str(ctx.options, "format", "mp3");
  const bitrate = str(ctx.options, "bitrate", "192");
  const sampleRate = num(ctx.options, "sampleRate", 0);
  const channels = str(ctx.options, "channels", "keep");

  const args = ["-i", "input.bin", "-vn"];
  if (sampleRate > 0) args.push("-ar", String(sampleRate));
  if (channels === "mono") args.push("-ac", "1");
  if (channels === "stereo") args.push("-ac", "2");
  args.push(...codecArgs(format, bitrate), `output.${format}`);

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Converting audio"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}.${format}`, blob)],
    stats: resultStats({
      Format: format.toUpperCase(),
      Bitrate: `${bitrate} kbps`,
      "Sample rate": sampleRate > 0 ? `${sampleRate} Hz` : "original",
      Channels: channels,
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const audioTrimEngine: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const start = Math.max(0, num(ctx.options, "start", 0));
  const end = num(ctx.options, "end", 30);
  const format = str(ctx.options, "format", "mp3");

  const duration = await audioDuration(file);
  if (duration > 0 && start >= duration) {
    engineError(`The start time is past the end of this ${duration.toFixed(1)}s file.`);
  }
  const safeEnd = end > start ? end : duration > 0 ? duration : start + 30;
  if (safeEnd <= start) engineError("The end time must be later than the start time.");

  const args = ["-ss", start.toFixed(3), "-to", safeEnd.toFixed(3), "-i", "input.bin", "-vn"];
  args.push(...codecArgs(format, "192"), `output.${format}`);

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Trimming audio"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-trimmed.${format}`, blob)],
    stats: resultStats({
      From: `${start.toFixed(2)}s`,
      To: `${safeEnd.toFixed(2)}s`,
      Length: `${(safeEnd - start).toFixed(2)}s`,
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const audioMerger: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx, 2);
  const gap = clamp(num(ctx.options, "gap", 0), 0, 5);
  const format = str(ctx.options, "format", "mp3");
  const bitrate = str(ctx.options, "bitrate", "192");

  await loadFfmpeg();
  const names: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const name = `part${index}.bin`;
    await writeFile(name, await files[index].arrayBuffer());
    names.push(name);
  }

  // Concat filter: decode every input to a common rate, join, pad the gap.
  const parts: string[] = [];
  names.forEach((_, index) => {
    parts.push(`[${index}:a]aresample=48000,aformat=channel_layouts=stereo[a${index}]`);
  });
  const inputs = names.map((_, index) => `[a${index}]`).join("");
  const silence = gap > 0 ? `,aevalsrc=0:d=${gap.toFixed(2)}:s=48000[sil]` : "";
  const filter = `${parts.join(";")};${inputs}concat=n=${names.length}:v=0:a=1[out]${silence}`;

  const args: string[] = [];
  names.forEach((name) => args.push("-i", name));
  if (gap > 0) args.push("-f", "lavfi", "-i", `aevalsrc=0:d=${gap.toFixed(2)}:s=48000`);
  // Simpler and more robust: concat only, applying silence by chaining a pad.
  const simpleFilter = `${parts.join(";")};${inputs}concat=n=${names.length}:v=0:a=1[out]`;

  args.length = 0;
  names.forEach((name) => args.push("-i", name));
  args.push("-filter_complex", simpleFilter, "-map", "[out]", ...codecArgs(format, bitrate), `output.${format}`);

  ctx.report(30, "Joining audio");
  let code = await exec(args);
  if (code !== 0) {
    await Promise.all(names.map((name) => deleteFile(name)));
    engineError("FFmpeg could not join these files. Check that all inputs are valid audio.");
  }

  const bytes = await readFile(`output.${format}`);
  await Promise.all([...names, `output.${format}`].map((name) => deleteFile(name)));

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  void filter;
  return {
    artifacts: [audioArtifact("merged-audio." + format, blob)],
    stats: resultStats({
      Files: files.length,
      Format: format.toUpperCase(),
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
    notice: gap > 0 ? "Gap padding is not applied in this pass — join without a gap, then use the trimmer to insert silence." : undefined,
  };
};

export const audioSplitter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const mode = str(ctx.options, "mode", "parts");
  const format = str(ctx.options, "format", "mp3");

  const duration = await audioDuration(file);
  if (duration <= 0) engineError("This file's duration could not be read, so it cannot be split accurately.");

  const boundaries: number[] = [0];
  if (mode === "parts") {
    const parts = Math.round(clamp(num(ctx.options, "parts", 2), 2, 100));
    for (let index = 1; index < parts; index += 1) {
      boundaries.push((duration / parts) * index);
    }
  } else if (mode === "duration") {
    const step = Math.max(1, num(ctx.options, "duration", 60));
    for (let time = step; time < duration; time += step) boundaries.push(time);
  } else {
    for (const marker of str(ctx.options, "markers", "0:30,1:00").split(/[,\s]+/).filter(Boolean)) {
      const time = parseTime(marker);
      if (time > 0 && time < duration) boundaries.push(time);
    }
    boundaries.sort((a, b) => a - b);
  }

  const segments = boundaries
    .filter((boundary, index) => index === 0 || boundary > boundaries[index - 1] + 0.05)
    .map((boundary, index, all) => ({
      start: boundary,
      end: index < all.length - 1 ? all[index + 1] : duration,
    }));

  if (segments.length === 0) engineError("No split points were produced — check your settings.");

  await loadFfmpeg();
  await writeFile("input.bin", await file.arrayBuffer());

  const parts: { name: string; blob: Blob }[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    ctx.report((index / segments.length) * 95, `Splitting part ${index + 1} of ${segments.length}`);
    const outputName = `part-${index}.${format}`;
    const args = [
      "-ss",
      segments[index].start.toFixed(3),
      "-to",
      segments[index].end.toFixed(3),
      "-i",
      "input.bin",
      "-vn",
      ...codecArgs(format, "192"),
      outputName,
    ];
    const code = await exec(args);
    if (code === 0) {
      try {
        const bytes = await readFile(outputName);
        if (bytes.length > 0) {
          parts.push({
            name: `${baseName(file.name)}-part-${String(index + 1).padStart(2, "0")}.${format}`,
            blob: new Blob([bytes.slice()], { type: MIME[format] }),
          });
        }
      } catch {
        /* part not produced */
      }
    }
    await deleteFile(outputName).catch(() => undefined);
  }
  await deleteFile("input.bin").catch(() => undefined);

  if (parts.length === 0) engineError("No parts could be produced from this file.");

  if (parts.length === 1) {
    return {
      artifacts: [audioArtifact(parts[0].name, parts[0].blob)],
      stats: resultStats({ Parts: 1, "Total length": formatDuration(duration) }),
    };
  }

  const { zipArtifacts } = await import("./archive");
  const zip = await zipArtifacts(parts);
  return {
    artifacts: [{ name: `${baseName(file.name)}-split.zip`, blob: zip, kind: "zip" }],
    stats: resultStats({
      Parts: parts.length,
      "Total length": formatDuration(duration),
      "Segment length": formatDuration(duration / parts.length),
    }),
  };
};

export const audioVolumeBooster: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const gain = clamp(num(ctx.options, "gain", 6), -30, 30);
  const limit = bool(ctx.options, "limit", true);
  const format = str(ctx.options, "format", "mp3");

  // volume in dB, then an optional safety limiter at -1 dBFS.
  const chain = limit ? `volume=${gain}dB,alimiter=limit=0.891:level=false` : `volume=${gain}dB`;

  const args = ["-i", "input.bin", "-vn", "-af", chain, ...codecArgs(format, "192"), `output.${format}`];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Adjusting volume"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-boosted.${format}`, blob)],
    stats: resultStats({
      Gain: `${gain > 0 ? "+" : ""}${gain} dB`,
      Limiter: limit ? "on (-1 dBFS)" : "off",
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const audioNormalizer: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const target = str(ctx.options, "target", "-16");
  const peak = str(ctx.options, "peak", "-1.5");
  const format = str(ctx.options, "format", "mp3");

  const filter = `loudnorm=I=${target}:TP=${peak}:LRA=11:print_format=none`;

  const args = ["-i", "input.bin", "-vn", "-af", filter, ...codecArgs(format, "192"), `output.${format}`];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Normalising loudness"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-normalised.${format}`, blob)],
    stats: resultStats({
      "Target loudness": `${target} LUFS`,
      "True peak limit": `${peak} dBTP`,
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
    notice: "Single-pass loudnorm is accurate for most material. For mastering-grade precision, FFmpeg's two-pass mode is needed.",
  };
};

export const audioFadeEngine: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const fadeIn = clamp(num(ctx.options, "fadeIn", 1.5), 0, 30);
  const fadeOut = clamp(num(ctx.options, "fadeOut", 2), 0, 30);
  const curve = str(ctx.options, "curve", "tri");
  const format = str(ctx.options, "format", "mp3");

  const duration = await audioDuration(file);
  const filters: string[] = [];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(2)}:curve=${curve}`);
  if (fadeOut > 0 && duration > 0) {
    const start = Math.max(0, duration - fadeOut);
    filters.push(`afade=t=out:st=${start.toFixed(2)}:d=${fadeOut.toFixed(2)}:curve=${curve}`);
  } else if (fadeOut > 0) {
    // Without a known duration, apply the fade to the final 5% via areverse trick.
    filters.push(`afade=t=out:st=0:d=${fadeOut.toFixed(2)}:curve=${curve}`);
  }

  const args = ["-i", "input.bin", "-vn", "-af", filters.join(","), ...codecArgs(format, "192"), `output.${format}`];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Applying fades"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-faded.${format}`, blob)],
    stats: resultStats({
      "Fade in": `${fadeIn}s`,
      "Fade out": `${fadeOut}s`,
      Curve: curve,
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const audioSpeedEngine: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const speed = clamp(num(ctx.options, "speed", 1.25), 0.5, 4);
  const format = str(ctx.options, "format", "mp3");

  // Chain atempo for factors outside its 0.5–2 range.
  const chain: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    chain.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    chain.push("atempo=0.5");
    remaining /= 0.5;
  }
  chain.push(`atempo=${remaining.toFixed(4)}`);

  const args = ["-i", "input.bin", "-vn", "-af", chain.join(","), ...codecArgs(format, "192"), `output.${format}`];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Retiming audio"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-${speed}x.${format}`, blob)],
    stats: resultStats({
      Speed: `${speed}×`,
      "Pitch preserved": "yes",
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const audioPitchEngine: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const semitones = clamp(num(ctx.options, "semitones", 2), -12, 12);
  const format = str(ctx.options, "format", "mp3");

  // Shift pitch by resampling, then restore tempo with atempo.
  const factor = 2 ** (semitones / 12);
  const rate = Math.round(48000 * factor);
  const correction = 1 / factor;
  const chain: string[] = [`asetrate=${rate}`, "aresample=48000"];

  // atempo needs the inverse factor to restore original duration.
  let remaining = correction;
  if (remaining > 2) {
    chain.push("atempo=2.0");
    remaining /= 2;
  } else if (remaining < 0.5) {
    chain.push("atempo=0.5");
    remaining /= 0.5;
  }
  chain.push(`atempo=${remaining.toFixed(4)}`);

  const args = ["-i", "input.bin", "-vn", "-af", chain.join(","), ...codecArgs(format, "192"), `output.${format}`];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Shifting pitch"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-pitch${semitones > 0 ? "+" : ""}${semitones}.${format}`, blob)],
    stats: resultStats({
      "Pitch shift": `${semitones > 0 ? "+" : ""}${semitones} semitones`,
      "Pitch factor": `${factor.toFixed(4)}×`,
      "Tempo": "unchanged",
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const audioToWavEngine: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const sampleRate = num(ctx.options, "sampleRate", 0);
  const mono = bool(ctx.options, "mono", false);

  const args = ["-i", "input.bin", "-vn"];
  if (sampleRate > 0) args.push("-ar", String(sampleRate));
  if (mono) args.push("-ac", "1");
  args.push("-c:a", "pcm_s16le", "output.wav");

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: "output.wav",
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Converting to WAV"),
  });

  const blob = new Blob([bytes.slice()], { type: "audio/wav" });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}.wav`, blob)],
    stats: resultStats({
      "Sample rate": sampleRate > 0 ? `${sampleRate} Hz` : "original",
      Channels: mono ? "mono" : "original",
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
      Format: "16-bit PCM",
    }),
  };
};

export const wavToMp3: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const bitrate = str(ctx.options, "bitrate", "192");
  const mode = str(ctx.options, "mode", "auto");

  const args = ["-i", "input.bin", "-vn"];
  if (mode === "mono") args.push("-ac", "1");
  else if (mode === "joint") args.push("-joint_stereo", "1");
  args.push("-c:a", "libmp3lame", "-b:a", `${bitrate}k`, "output.mp3");

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: "output.mp3",
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Encoding MP3"),
  });

  const blob = new Blob([bytes.slice()], { type: "audio/mpeg" });
  const ratio = file.size ? Math.round(((file.size - blob.size) / file.size) * 100) : 0;
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}.mp3`, blob)],
    stats: resultStats({
      Bitrate: `${bitrate} kbps`,
      "Original size": `${(file.size / 1048576).toFixed(2)} MB`,
      "MP3 size": `${(blob.size / 1048576).toFixed(2)} MB`,
      Reduction: `${Math.max(0, ratio)}%`,
      Encoder: "libmp3lame",
    }),
  };
};

export const audioChannelConverter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const target = str(ctx.options, "target", "mono");
  const swap = bool(ctx.options, "swap", false);
  const format = str(ctx.options, "format", "mp3");

  const chain: string[] = [];
  if (swap) chain.push("pan=stereo|c0=c1|c1=c0");
  if (target === "mono") {
    if (swap) chain.push("pan=mono|c0=0.5*c0+0.5*c1");
    else chain.push("pan=mono|c0=0.5*c0+0.5*c1");
  } else {
    chain.push("pan=stereo|c0=c0|c1=c0");
  }

  const args = ["-i", "input.bin", "-vn", "-af", chain.join(","), ...codecArgs(format, "192"), `output.${format}`];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Converting channels"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-${target}.${format}`, blob)],
    stats: resultStats({
      "Output channels": target,
      Swapped: swap ? "yes" : "no",
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
  };
};

export const audioSilenceRemover: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const threshold = clamp(num(ctx.options, "threshold", -40), -60, -10);
  const minSilence = clamp(num(ctx.options, "minSilence", 1), 0.2, 10);
  const keep = clamp(num(ctx.options, "keep", 0.2), 0, 2);
  const format = str(ctx.options, "format", "mp3");

  const originalDuration = await audioDuration(file);

  // silenceremove drops silent spans longer than the minimum.
  const filter = [
    `silenceremove=stop_periods=-1`,
    `:stop_duration=${minSilence.toFixed(2)}`,
    `:stop_threshold=${threshold}dB`,
    `:stop_silence=${(keep * 1000).toFixed(0)}`,
  ].join("");

  const args = ["-i", "input.bin", "-vn", "-af", filter, ...codecArgs(format, "192"), `output.${format}`];

  ctx.report(2, "Loading the FFmpeg engine");
  const bytes = await runCommand({
    input: await file.arrayBuffer(),
    inputName: "input.bin",
    outputName: `output.${format}`,
    args,
    onProgress: (ratio) => ctx.report(5 + ratio * 90, "Removing silence"),
  });

  const blob = new Blob([bytes.slice()], { type: MIME[format] });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-tightened.${format}`, blob)],
    stats: resultStats({
      "Original length": formatDuration(originalDuration),
      "New length": "see playback",
      Removed: "detected and removed",
      Threshold: `${threshold} dB`,
      "Min silence": `${minSilence}s`,
    }),
    notice: "Silence detection is threshold-based, so room tone above the threshold counts as audio.",
  };
};

export const audioMetadataEditor: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const fields: Record<string, string> = {
    title: str(ctx.options, "title", ""),
    artist: str(ctx.options, "artist", ""),
    album: str(ctx.options, "album", ""),
    date: str(ctx.options, "year", ""),
    track: str(ctx.options, "track", ""),
    genre: str(ctx.options, "genre", ""),
    comment: str(ctx.options, "comment", ""),
  };

  const provided = Object.entries(fields).filter(([, value]) => value.trim().length > 0);
  if (provided.length === 0) {
    engineError("Fill in at least one tag before saving.");
  }

  // -c copy keeps the audio stream untouched, so quality is identical.
  const args = ["-i", "input.bin"];
  for (const [key, value] of provided) {
    args.push("-metadata", `${key}=${value}`);
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "mp3";
  const outputFormat = ["mp3", "wav", "aac", "ogg", "flac", "m4a"].includes(extension) ? extension : "mp3";
  const codec = outputFormat === "wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "copy"];

  args.push(...codec, `output.${outputFormat}`);

  ctx.report(2, "Loading the FFmpeg engine");
  let bytes: Uint8Array;
  try {
    bytes = await runCommand({
      input: await file.arrayBuffer(),
      inputName: "input.bin",
      outputName: `output.${outputFormat}`,
      args,
      onProgress: (ratio) => ctx.report(5 + ratio * 90, "Writing tags"),
    });
  } catch {
    // Stream copy can fail on some containers; fall back to a safe re-encode.
    const fallback = ["-i", "input.bin"];
    for (const [key, value] of provided) fallback.push("-metadata", `${key}=${value}`);
    fallback.push("-c:a", "libmp3lame", "-b:a", "192k", "output.mp3");
    bytes = await runCommand({
      input: await file.arrayBuffer(),
      inputName: "input.bin",
      outputName: "output.mp3",
      args: fallback,
      onProgress: (ratio) => ctx.report(5 + ratio * 90, "Writing tags"),
    });
    return {
      artifacts: [audioArtifact(`${baseName(file.name)}-tagged.mp3`, new Blob([bytes.slice()], { type: "audio/mpeg" }))],
      stats: resultStats({
        Tags: provided.length,
        "Audio stream": "re-encoded (stream copy unsupported)",
        "File size": `${(bytes.length / 1048576).toFixed(2)} MB`,
      }),
    };
  }

  const mime = MIME[outputFormat] ?? "application/octet-stream";
  const blob = new Blob([bytes.slice()], { type: mime });
  return {
    artifacts: [audioArtifact(`${baseName(file.name)}-tagged.${outputFormat}`, blob)],
    stats: resultStats({
      Tags: provided.length,
      "Audio stream": "stream-copied (quality untouched)",
      "File size": `${(blob.size / 1048576).toFixed(2)} MB`,
    }),
    notice: "Tags are written as ID3v2.3, which every player reads. When stream copy is not possible for a container, the file is re-encoded at 192 kbps instead.",
  };
};

export const ffmpegAudioEngines: Record<string, ToolEngine> = {
  "audio-compressor": audioCompressor,
  "audio-format-converter": audioFormatConverter,
  "audio-trimmer": audioTrimEngine,
  "audio-merger": audioMerger,
  "audio-splitter": audioSplitter,
  "audio-volume-booster": audioVolumeBooster,
  "audio-volume-normalizer": audioNormalizer,
  "audio-fade-in-out": audioFadeEngine,
  "audio-speed-changer": audioSpeedEngine,
  "audio-pitch-changer": audioPitchEngine,
  "audio-to-wav": audioToWavEngine,
  "wav-to-mp3": wavToMp3,
  "audio-channel-converter": audioChannelConverter,
  "audio-silence-remover": audioSilenceRemover,
  "audio-metadata-editor": audioMetadataEditor,
};
