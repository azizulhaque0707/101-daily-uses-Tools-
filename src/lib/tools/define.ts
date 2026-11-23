import type { ToolDefinition } from "./types";

/**
 * Small authoring helper: every tool defaults to a dedicated engine keyed by
 * its own slug, and can be overridden when several tools share one engine.
 */
export function def(
  tool: Omit<ToolDefinition, "engine"> & { engine?: string },
): ToolDefinition {
  return { ...tool, engine: tool.engine ?? tool.slug };
}
