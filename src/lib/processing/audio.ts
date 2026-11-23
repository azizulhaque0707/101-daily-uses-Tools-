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
import { createCanvas, encodeCanvas, hexToRgb } from "./canvas";

let sharedContext: AudioContext | null = null;

function audioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedContext = new Ctor();
  }
  return sharedContext;
}

async function releaseContext() {
  if (sharedContext && sharedContext.state !== "closed") {
    try {
      await sharedContext.close();
    } catch {
      /* ignore */
    }
  }
  sharedContext = null;
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const context = audioContext();
  const buffer = await context.decodeAudioData(await file.arrayBuffer());
  return buffer;
}

/* --------------------------------- WAV file -------------------------------- */

export function encodeWav(buffer: AudioBuffer, targetRate?: number): Blob {
  const sampleRate = targetRate ?? buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const length = Math.min(buffer.length, Math.ceil(buffer.duration * sampleRate));
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    channelData.push(buffer.getChannelData(channel));
  }

  let offset = 44;
  const ratio = buffer.sampleRate / sampleRate;
  for (let index = 0; index < length; index += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sourceIndex = Math.min(buffer.length - 1, Math.round(index * ratio));
      const sample = clamp(channelData[channel][sourceIndex] ?? 0, -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

async function encodeCompressed(buffer: AudioBuffer, bitrate: number, report: (p: number) => void): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") engineError("This browser cannot record compressed audio.");
  const context = audioContext();
  try {
    await context.resume();
  } catch {
    /* ignore */
  }
  const destination = context.createMediaStreamDestination();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(destination);

  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];
  const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) engineError("No supported compressed audio encoder is available — choose WAV instead.");

  const recorder = new MediaRecorder(destination.stream, {
    mimeType,
    audioBitsPerSecond: bitrate * 1000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start(500);
  source.start();

  const total = buffer.duration * 1000;
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started;
      report(Math.min(99, (elapsed / total) * 100));
      if (elapsed >= total + 150) resolve();
      else window.setTimeout(tick, 200);
    };
    window.setTimeout(tick, 200);
  });
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: mimeType ?? "audio/webm" });
}

/* ------------------------------- render helper ------------------------------ */

type Layer = {
  buffer: AudioBuffer;
  offset: number;
  start?: number;
  duration?: number;
  gain: number;
  playbackRate?: number;
  fades?: { in: number; out: number; curve: string };
};

async function renderLayers(
  layers: Layer[],
  totalDuration: number,
  sampleRate: number,
  channels: number,
): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(totalDuration * sampleRate));
  const OfflineCtor: typeof OfflineAudioContext =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const offline = new OfflineCtor(channels, length, sampleRate);

  for (const layer of layers) {
    const source = offline.createBufferSource();
    source.buffer = layer.buffer;
    if (layer.playbackRate && layer.playbackRate !== 1) source.playbackRate.value = layer.playbackRate;
    const gainNode = offline.createGain();
    gainNode.gain.value = layer.gain;
    if (layer.fades && (layer.fades.in > 0 || layer.fades.out > 0)) {
      const duration = layer.duration ?? layer.buffer.duration / (layer.playbackRate ?? 1);
      const now = layer.offset;
      if (layer.fades.in > 0) {
        if (layer.fades.curve === "exponential") {
          gainNode.gain.setValueAtTime(0.0001, now);
          gainNode.gain.exponentialRampToValueAtTime(Math.max(layer.gain, 0.0001), now + layer.fades.in);
        } else {
          gainNode.gain.setValueAtTime(0.0001, now);
          gainNode.gain.linearRampToValueAtTime(layer.gain, now + layer.fades.in);
        }
      }
      if (layer.fades.out > 0) {
        const start = now + Math.max(0.01, duration - layer.fades.out);
        if (layer.fades.curve === "exponential") {
          gainNode.gain.setValueAtTime(Math.max(layer.gain, 0.0001), start);
          gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        } else {
          gainNode.gain.setValueAtTime(layer.gain, start);
          gainNode.gain.linearRampToValueAtTime(0.0001, now + duration);
        }
      }
    }
    source.connect(gainNode).connect(offline.destination);
    source.start(layer.offset, layer.start ?? 0, layer.duration);
  }

  return offline.startRendering();
}

function cloneBuffer(buffer: AudioBuffer): AudioBuffer {
  const context = audioContext();
  const clone = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    clone.getChannelData(channel).set(buffer.getChannelData(channel));
  }
  return clone;
}

function reverseBuffer(buffer: AudioBuffer): AudioBuffer {
  const reversed = cloneBuffer(buffer);
  for (let channel = 0; channel < reversed.numberOfChannels; channel += 1) {
    const data = reversed.getChannelData(channel);
    data.reverse();
  }
  return reversed;
}

function mixdownToMono(buffer: AudioBuffer): AudioBuffer {
  const context = audioContext();
  const mono = context.createBuffer(1, buffer.length, buffer.sampleRate);
  const output = mono.getChannelData(0);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < output.length; i += 1) output[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

function monoToStereo(buffer: AudioBuffer): AudioBuffer {
  const context = audioContext();
  const stereo = context.createBuffer(2, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    stereo.getChannelData(channel).set(buffer.getChannelData(0));
  }
  return stereo;
}

function swapChannels(buffer: AudioBuffer): AudioBuffer {
  const context = audioContext();
  const swapped = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const count = buffer.numberOfChannels;
  for (let channel = 0; channel < count; channel += 1) {
    swapped.getChannelData((channel + 1) % count).set(buffer.getChannelData(channel));
  }
  return swapped;
}

function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

function limitPeaks(buffer: AudioBuffer): AudioBuffer {
  const peak = peakOf(buffer);
  if (peak <= 1) return buffer;
  const limited = cloneBuffer(buffer);
  for (let channel = 0; channel < limited.numberOfChannels; channel += 1) {
    const data = limited.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) data[i] = clamp(data[i] / peak, -1, 1);
  }
  return limited;
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

async function outputArtifact(
  buffer: AudioBuffer,
  format: string,
  bitrate: number,
  name: string,
  report: (progress: number, label?: string) => void,
): Promise<EngineArtifact> {
  if (format === "webm") {
    report(5, "Encoding compressed audio (runs in real time)");
    const blob = await encodeCompressed(buffer, bitrate, (value) => report(5 + value * 0.9, "Encoding audio"));
    return { name: `${name}.webm`, blob, kind: "audio" };
  }
  const blob = encodeWav(buffer);
  return { name: `${name}.wav`, blob, kind: "audio" };
}

/**
 * Downsamples an AudioBuffer into normalised peak values for waveform drawing.
 */
export function computePeaks(buffer: AudioBuffer, buckets: number): number[] {
  const data = buffer.getChannelData(0);
  const size = Math.max(1, Math.floor(data.length / buckets));
  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    let sum = 0;
    const start = bucket * size;
    const end = Math.min(start + size, data.length);
    for (let i = start; i < end; i += 1) sum += data[i] * data[i];
    peaks.push(Math.min(1, Math.sqrt(sum / Math.max(1, end - start))));
  }
  return peaks;
}

/* --------------------------------- engines --------------------------------- */

export const audioTrimmer: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  ctx.report(10, "Decoding audio");
  const buffer = await decodeAudioFile(file);
  const start = clamp(num(ctx.options, "start", 0), 0, Math.max(0, buffer.duration - 0.05));
  const end = clamp(num(ctx.options, "end", 30), start + 0.05, buffer.duration);
  const format = str(ctx.options, "format", "wav");

  ctx.report(50, "Rendering trimmed audio");
  const rendered = await renderLayers(
    [{ buffer, offset: 0, start, duration: end - start, gain: 1 }],
    end - start,
    buffer.sampleRate,
    buffer.numberOfChannels,
  );
  const artifact = await outputArtifact(rendered, format, 160, `${baseName(file.name)}-trimmed`, ctx.report);
  return {
    artifacts: [artifact],
    stats: resultStats({
      "Original length": formatDuration(buffer.duration),
      "New length": formatDuration(rendered.duration),
      Channels: buffer.numberOfChannels,
      "Sample rate": `${(buffer.sampleRate / 1000).toFixed(1)} kHz`,
      Format: format.toUpperCase(),
    }),
  };
};

export const audioConverter: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const format = str(ctx.options, "format", "wav");
  const sampleRate = num(ctx.options, "sampleRate", 0);
  const channels = str(ctx.options, "channels", "keep");
  const artifacts: EngineArtifact[] = [];
  let inputBytes = 0;
  let outputBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 90, `Converting ${file.name}`);
    const buffer = await decodeAudioFile(file);
    const targetRate = sampleRate > 0 ? sampleRate : buffer.sampleRate;
    let working = buffer;
    if (channels === "mono" && buffer.numberOfChannels > 1) working = mixdownToMono(working);
    if (channels === "stereo" && buffer.numberOfChannels === 1) working = monoToStereo(working);
    const rendered = await renderLayers([{ buffer: working, offset: 0, gain: 1 }], working.duration, targetRate, working.numberOfChannels);
    const artifact = await outputArtifact(rendered, format, 160, `${baseName(file.name)}`, ctx.report);
    inputBytes += file.size;
    outputBytes += artifact.blob.size;
    artifacts.push(artifact);
  }

  return {
    artifacts,
    stats: resultStats({
      Files: artifacts.length,
      "Input size": `${(inputBytes / 1024 / 1024).toFixed(2)} MB`,
      "Output size": `${(outputBytes / 1024 / 1024).toFixed(2)} MB`,
      Format: format === "wav" ? "WAV 16-bit" : "WebM Opus",
    }),
    notice: format === "webm" ? "Compressed encoding runs in real time, so long files take as long as their runtime." : undefined,
  };
};

export const audioNormalizer: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const target = clamp(num(ctx.options, "target", -1), -12, 0);
  const format = str(ctx.options, "format", "wav");
  const artifacts: EngineArtifact[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 80, `Normalising ${file.name}`);
    const buffer = await decodeAudioFile(file);
    const peak = peakOf(buffer);
    if (peak === 0) engineError(`${file.name} is silent and cannot be normalised.`);
    const gain = Math.min(dbToGain(target) / peak, 8);
    const rendered = await renderLayers(
      [{ buffer, offset: 0, gain }],
      buffer.duration,
      buffer.sampleRate,
      buffer.numberOfChannels,
    );
    const limited = limitPeaks(rendered);
    artifacts.push(
      await outputArtifact(limited, format, 160, `${baseName(file.name)}-normalised`, ctx.report),
    );
  }
  return { artifacts, stats: resultStats({ Files: artifacts.length, "Target peak": `${target} dBFS` }) };
};

export const audioVolumeBooster: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const gainDb = clamp(num(ctx.options, "gain", 6), -24, 24);
  const limit = bool(ctx.options, "limit", true);
  const format = str(ctx.options, "format", "wav");
  const buffer = await decodeAudioFile(file);
  const rendered = await renderLayers(
    [{ buffer, offset: 0, gain: dbToGain(gainDb) }],
    buffer.duration,
    buffer.sampleRate,
    buffer.numberOfChannels,
  );
  const output = limit ? limitPeaks(rendered) : rendered;
  return {
    artifacts: [await outputArtifact(output, format, 160, `${baseName(file.name)}-boosted`, ctx.report)],
    stats: resultStats({
      Gain: `${gainDb > 0 ? "+" : ""}${gainDb} dB`,
      "Peak before": `${(20 * Math.log10(Math.max(peakOf(buffer), 1e-6))).toFixed(2)} dBFS`,
      "Peak after": `${(20 * Math.log10(Math.max(peakOf(output), 1e-6))).toFixed(2)} dBFS`,
    }),
  };
};

export const audioSpeedChanger: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const speed = clamp(num(ctx.options, "speed", 1.25), 0.5, 2);
  const format = str(ctx.options, "format", "wav");
  const buffer = await decodeAudioFile(file);
  const rendered = await renderLayers(
    [{ buffer, offset: 0, gain: 1, playbackRate: speed }],
    buffer.duration / speed,
    buffer.sampleRate,
    buffer.numberOfChannels,
  );
  return {
    artifacts: [await outputArtifact(rendered, format, 160, `${baseName(file.name)}-${speed}x`, ctx.report)],
    stats: resultStats({
      "Original length": formatDuration(buffer.duration),
      "New length": formatDuration(rendered.duration),
      Speed: `${speed}×`,
    }),
    notice: "Tempo and pitch change together, exactly like adjusting tape speed.",
  };
};

export const audioReverser: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const format = str(ctx.options, "format", "wav");
  const buffer = await decodeAudioFile(file);
  const reversed = reverseBuffer(buffer);
  const rendered = await renderLayers(
    [{ buffer: reversed, offset: 0, gain: 1 }],
    reversed.duration,
    reversed.sampleRate,
    reversed.numberOfChannels,
  );
  return {
    artifacts: [await outputArtifact(rendered, format, 160, `${baseName(file.name)}-reversed`, ctx.report)],
    stats: resultStats({ Length: formatDuration(rendered.duration) }),
  };
};

export const audioFadeMaker: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const fadeIn = clamp(num(ctx.options, "fadeIn", 1.5), 0, 15);
  const fadeOut = clamp(num(ctx.options, "fadeOut", 2), 0, 15);
  const curve = str(ctx.options, "curve", "linear");
  const format = str(ctx.options, "format", "wav");
  const buffer = await decodeAudioFile(file);
  const rendered = await renderLayers(
    [{ buffer, offset: 0, gain: 1, fades: { in: fadeIn, out: fadeOut, curve } }],
    buffer.duration,
    buffer.sampleRate,
    buffer.numberOfChannels,
  );
  return {
    artifacts: [await outputArtifact(rendered, format, 160, `${baseName(file.name)}-faded`, ctx.report)],
    stats: resultStats({ "Fade in": `${fadeIn}s`, "Fade out": `${fadeOut}s`, Curve: curve }),
  };
};

export const audioJoiner: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx, 2);
  const gap = clamp(num(ctx.options, "gap", 0), 0, 5);
  const crossfade = clamp(num(ctx.options, "crossfade", 0), 0, 5);
  const format = str(ctx.options, "format", "wav");
  const buffers: AudioBuffer[] = [];
  for (let index = 0; index < files.length; index += 1) {
    ctx.report((index / files.length) * 40, `Decoding ${files[index].name}`);
    buffers.push(await decodeAudioFile(files[index]));
  }

  const sampleRate = Math.max(...buffers.map((buffer) => buffer.sampleRate));
  const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
  const layers: Layer[] = [];
  let cursor = 0;
  buffers.forEach((buffer, index) => {
    const duration = buffer.duration;
    layers.push({
      buffer,
      offset: cursor,
      gain: 1,
      fades: crossfade > 0 ? { in: index === 0 ? 0 : crossfade, out: index === buffers.length - 1 ? 0 : crossfade, curve: "linear" } : undefined,
    });
    cursor += duration + (index < buffers.length - 1 ? Math.max(gap - crossfade * 2, 0) + crossfade * 2 : 0);
  });

  ctx.report(70, "Rendering joined audio");
  const rendered = await renderLayers(layers, cursor, sampleRate, channels);
  return {
    artifacts: [await outputArtifact(rendered, format, 160, "joined-audio", ctx.report)],
    stats: resultStats({
      Files: files.length,
      "Total length": formatDuration(rendered.duration),
      Gap: `${gap}s`,
      Crossfade: `${crossfade}s`,
    }),
  };
};

export const audioChannelConverter: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const target = str(ctx.options, "target", "mono");
  const swap = bool(ctx.options, "swap", false);
  const format = str(ctx.options, "format", "wav");
  let buffer = await decodeAudioFile(file);
  if (swap && buffer.numberOfChannels > 1) buffer = swapChannels(buffer);
  const working =
    target === "mono" ? mixdownToMono(buffer) : monoToStereo(buffer.numberOfChannels === 1 ? buffer : mixdownToMono(buffer));
  const rendered = await renderLayers(
    [{ buffer: working, offset: 0, gain: 1 }],
    working.duration,
    working.sampleRate,
    working.numberOfChannels,
  );
  return {
    artifacts: [await outputArtifact(rendered, format, 160, `${baseName(file.name)}-${target}`, ctx.report)],
    stats: resultStats({
      "Input channels": buffer.numberOfChannels,
      "Output channels": rendered.numberOfChannels,
      Swapped: swap ? "yes" : "no",
    }),
  };
};

export const audioSilenceRemover: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const thresholdDb = clamp(num(ctx.options, "threshold", -42), -60, -10);
  const minSilence = clamp(num(ctx.options, "minSilence", 1), 0.2, 10);
  const keep = clamp(num(ctx.options, "keep", 0.2), 0, 2);
  const format = str(ctx.options, "format", "wav");
  const buffer = await decodeAudioFile(file);

  ctx.report(30, "Scanning for silence");
  const data = buffer.getChannelData(0);
  const windowSize = Math.max(1, Math.floor(buffer.sampleRate * 0.01));
  const threshold = dbToGain(thresholdDb);
  const frames = Math.floor(data.length / windowSize);
  const loud: boolean[] = new Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let i = frame * windowSize; i < (frame + 1) * windowSize; i += 1) sum += data[i] * data[i];
    loud[frame] = Math.sqrt(sum / windowSize) > threshold;
  }

  const segments: { start: number; end: number }[] = [];
  const frameSeconds = windowSize / buffer.sampleRate;
  let index = 0;
  while (index < frames) {
    if (!loud[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < frames && loud[index]) index += 1;
    segments.push({ start: start * frameSeconds, end: index * frameSeconds });
  }
  if (segments.length === 0) engineError("No audio above the silence threshold was found.");

  const merged: { start: number; end: number }[] = [];
  const minSilenceSeconds = minSilence;
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && segment.start - last.end < minSilenceSeconds) {
      last.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }

  const layers: Layer[] = merged.map((segment) => ({
    buffer,
    offset: 0,
    start: Math.max(0, segment.start - keep / 2),
    duration: Math.max(0.05, segment.end - segment.start + keep),
    gain: 1,
  }));

  let total = 0;
  const offsets: number[] = [];
  for (const layer of layers) {
    offsets.push(total);
    total += (layer.duration ?? 0);
  }
  layers.forEach((layer, position) => {
    layer.offset = offsets[position];
  });

  ctx.report(60, "Rebuilding audio without silence");
  const rendered = await renderLayers(layers, total, buffer.sampleRate, buffer.numberOfChannels);
  return {
    artifacts: [await outputArtifact(rendered, format, 160, `${baseName(file.name)}-tightened`, ctx.report)],
    stats: resultStats({
      "Original length": formatDuration(buffer.duration),
      "New length": formatDuration(rendered.duration),
      Removed: formatDuration(Math.max(0, buffer.duration - rendered.duration)),
      Segments: layers.length,
    }),
  };
};

export const audioToWav: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx);
  const sampleRate = num(ctx.options, "sampleRate", 0);
  const mono = bool(ctx.options, "mono", false);
  const artifacts: EngineArtifact[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ctx.report((index / files.length) * 90, `Decoding ${file.name}`);
    let buffer = await decodeAudioFile(file);
    if (mono && buffer.numberOfChannels > 1) buffer = mixdownToMono(buffer);
    const rendered = await renderLayers(
      [{ buffer, offset: 0, gain: 1 }],
      buffer.duration,
      sampleRate > 0 ? sampleRate : buffer.sampleRate,
      buffer.numberOfChannels,
    );
    const blob = encodeWav(rendered, sampleRate > 0 ? sampleRate : rendered.sampleRate);
    artifacts.push({ name: `${baseName(file.name)}.wav`, blob, kind: "audio" });
  }
  return { artifacts, stats: resultStats({ Files: artifacts.length, Format: "WAV 16-bit PCM" }) };
};


export const audioWaveformGenerator: ToolEngine = async (ctx) => {
  const file = requireFile(ctx);
  const width = Math.round(clamp(num(ctx.options, "width", 1600), 400, 4000));
  const height = Math.round(clamp(num(ctx.options, "height", 320), 100, 1000));
  const color = str(ctx.options, "color", "#6366f1");
  const background = str(ctx.options, "background", "#ffffff");
  const mirror = bool(ctx.options, "mirror", true);
  const buffer = await decodeAudioFile(file);

  const peaks = computePeaks(buffer, Math.floor(width / 3));
  const { canvas, ctx: c2d } = createCanvas(width, height);
  const { r: br, g: bg, b: bb } = hexToRgb(background);
  c2d.fillStyle = `rgb(${br},${bg},${bb})`;
  c2d.fillRect(0, 0, width, height);
  const { r, g, b } = hexToRgb(color);
  c2d.fillStyle = `rgb(${r},${g},${b})`;
  const barWidth = width / peaks.length;
  const mid = height / 2;
  peaks.forEach((peak, index) => {
    const half = Math.max(1, peak * mid * 0.92);
    if (mirror) {
      c2d.fillRect(index * barWidth, mid - half, Math.max(0.8, barWidth - 0.8), half);
      c2d.fillRect(index * barWidth, mid, Math.max(0.8, barWidth - 0.8), half);
    } else {
      c2d.fillRect(index * barWidth, mid - half / 2, Math.max(0.8, barWidth - 0.8), half);
    }
  });
  c2d.fillStyle = `rgba(${br},${bg},${bb},0.9)`;
  c2d.fillRect(0, mid - 0.5, width, 1);

  const blob = await encodeCanvas(canvas, "image/png");
  await releaseContext();
  return {
    artifacts: [{ name: `${baseName(file.name)}-waveform.png`, blob, kind: "image" }],
    stats: resultStats({
      Duration: formatDuration(buffer.duration),
      Resolution: `${width} × ${height}`,
      "Sample rate": `${(buffer.sampleRate / 1000).toFixed(1)} kHz`,
    }),
  };
};

export const toneGenerator: ToolEngine = async (ctx) => {
  const waveform = str(ctx.options, "waveform", "sine");
  const frequency = clamp(num(ctx.options, "frequency", 440), 20, 20000);
  const duration = clamp(num(ctx.options, "duration", 5), 0.5, 60);
  const sweepTo = clamp(num(ctx.options, "sweepTo", 0), 0, 20000);
  const amplitude = clamp(num(ctx.options, "amplitude", 60), 1, 100) / 100;
  const sampleRate = num(ctx.options, "sampleRate", 44100);

  const context = audioContext();
  const buffer = context.createBuffer(1, Math.ceil(duration * sampleRate), sampleRate);
  const data = buffer.getChannelData(0);
  const twoPi = Math.PI * 2;
  let phase = 0;
  for (let index = 0; index < data.length; index += 1) {
    const time = index / sampleRate;
    const currentFrequency = sweepTo > 0 ? frequency + (sweepTo - frequency) * (time / duration) : frequency;
    phase += (twoPi * currentFrequency) / sampleRate;
    let value: number;
    if (waveform === "noise") value = Math.random() * 2 - 1;
    else if (waveform === "square") value = Math.sin(phase) >= 0 ? 1 : -1;
    else if (waveform === "sawtooth") value = ((phase / twoPi) % 1) * 2 - 1;
    else if (waveform === "triangle") value = Math.asin(Math.sin(phase)) * (2 / Math.PI);
    else value = Math.sin(phase);
    data[index] = value * amplitude;
  }

  const blob = encodeWav(buffer, sampleRate);
  await releaseContext();
  return {
    artifacts: [{ name: `tone-${waveform}-${Math.round(frequency)}hz.wav`, blob, kind: "audio" }],
    stats: resultStats({
      Waveform: waveform,
      Frequency: sweepTo > 0 ? `${frequency} → ${sweepTo} Hz` : `${frequency} Hz`,
      Duration: `${duration}s`,
      "Sample rate": `${(sampleRate / 1000).toFixed(1)} kHz`,
      "File size": `${(blob.size / 1024).toFixed(1)} KB`,
    }),
  };
};

export const audioMixer: ToolEngine = async (ctx) => {
  const files = requireFiles(ctx, 2);
  const gain = clamp(num(ctx.options, "gain", 100), 0, 200) / 100;
  const stagger = clamp(num(ctx.options, "stagger", 0), 0, 10);
  const format = str(ctx.options, "format", "wav");
  const buffers: AudioBuffer[] = [];
  for (let index = 0; index < files.length; index += 1) {
    ctx.report((index / files.length) * 40, `Decoding ${files[index].name}`);
    buffers.push(await decodeAudioFile(files[index]));
  }

  const sampleRate = Math.max(...buffers.map((buffer) => buffer.sampleRate));
  const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
  const layers: Layer[] = buffers.map((buffer, index) => ({
    buffer,
    offset: index * stagger,
    gain: gain / buffers.length,
  }));
  const total = Math.max(...buffers.map((buffer, index) => index * stagger + buffer.duration));

  ctx.report(70, "Rendering mix");
  const rendered = await renderLayers(layers, total, sampleRate, channels);
  const limited = limitPeaks(rendered);
  return {
    artifacts: [await outputArtifact(limited, format, 160, "mix", ctx.report)],
    stats: resultStats({
      Tracks: buffers.length,
      Length: formatDuration(limited.duration),
      "Master gain": `${Math.round(gain * 100)}%`,
      Stagger: `${stagger}s`,
    }),
  };
};

export const audioEngines: Record<string, ToolEngine> = {
  "audio-trimmer": audioTrimmer,
  "audio-converter": audioConverter,
  "audio-normalizer": audioNormalizer,
  "audio-volume-booster": audioVolumeBooster,
  "audio-speed-changer": audioSpeedChanger,
  "audio-reverser": audioReverser,
  "audio-fade-maker": audioFadeMaker,
  "audio-joiner": audioJoiner,
  "audio-channel-converter": audioChannelConverter,
  "audio-silence-remover": audioSilenceRemover,
  "audio-to-wav": audioToWav,
  "audio-waveform-generator": audioWaveformGenerator,
  "tone-generator": toneGenerator,
  "audio-mixer": audioMixer,
};

export { releaseContext, encodeCompressed, reverseBuffer };
