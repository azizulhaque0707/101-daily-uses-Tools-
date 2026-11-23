import type {
  CategoryId,
  EngineContext,
  EngineResult,
  ToolEngine,
} from "@/lib/tools/types";
import { ToolError } from "@/lib/tools/types";

type EngineMap = Record<string, ToolEngine>;

const categoryModules: Record<CategoryId, () => Promise<EngineMap>> = {
  image: () => import("./image").then((module) => module.imageEngines),
  pdf: () => import("./pdf").then((module) => module.pdfEngines),
  document: () => import("./document").then((module) => module.documentEngines),
  video: () => import("./video").then((module) => module.videoEngines),
  audio: () => import("./audio-ffmpeg").then((module) => module.ffmpegAudioEngines),
  utility: () => import("./utility").then((module) => module.utilityEngines),
};

const engineCache = new Map<CategoryId, EngineMap>();

export type { EngineResult, EngineContext };

export async function loadEngines(category: CategoryId): Promise<EngineMap> {
  const cached = engineCache.get(category);
  if (cached) return cached;
  const engines = await categoryModules[category]();
  engineCache.set(category, engines);
  return engines;
}

export type EngineKey = {
  slug: string;
  name: string;
  category: CategoryId;
  engine?: string;
};

export async function resolveEngine(tool: EngineKey): Promise<ToolEngine> {
  const engines = await loadEngines(tool.category);
  const engine = engines[tool.engine ?? tool.slug] ?? engines[tool.slug];
  if (!engine) {
    throw new ToolError(
      `The engine for “${tool.name}” is not available in this browser.`,
    );
  }
  return engine;
}

/** Runs a tool completely inside the browser. No network access is involved. */
export async function runTool(tool: EngineKey, ctx: EngineContext): Promise<EngineResult> {
  const engine = await resolveEngine(tool);
  try {
    const result = await engine(ctx);
    if (!result.artifacts || result.artifacts.length === 0) {
      throw new ToolError("The tool finished but produced no output. Check your settings.");
    }
    return result;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const message = error instanceof Error ? error.message : "Unknown processing error";
    throw new ToolError(message);
  }
}
