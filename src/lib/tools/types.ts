import type { LucideIcon } from "lucide-react";

export type CategoryId = "image" | "pdf" | "document" | "video" | "audio" | "utility";

export type ToolOptionValue = string | number | boolean;

export type ToolOption =
  | {
      id: string;
      label: string;
      type: "number";
      min: number;
      max: number;
      step?: number;
      default: number;
      unit?: string;
      help?: string;
    }
  | {
      id: string;
      label: string;
      type: "select";
      choices: { value: string; label: string }[];
      default: string;
      help?: string;
    }
  | {
      id: string;
      label: string;
      type: "toggle";
      default: boolean;
      help?: string;
    }
  | {
      id: string;
      label: string;
      type: "text";
      default: string;
      placeholder?: string;
      help?: string;
    }
  | {
      id: string;
      label: string;
      type: "color";
      default: string;
      help?: string;
    };

export interface ToolFileInput {
  accept: string;
  multiple: boolean;
  label: string;
  hint?: string;
}

export interface ToolTextInput {
  label: string;
  placeholder: string;
  default?: string;
  rows?: number;
}

export interface ToolDefinition {
  slug: string;
  name: string;
  description: string;
  category: CategoryId;
  icon: LucideIcon;
  keywords: string[];
  /** Identifier resolved against the lazy engine registry. */
  engine: string;
  fileInput?: ToolFileInput;
  textInput?: ToolTextInput;
  options: ToolOption[];
  outputHint: string;
  steps: string[];
  popularity: number;
  featured?: boolean;
  /** Honest note about a browser-side constraint for this tool. */
  limitation?: string;
}

export interface CategoryDefinition {
  id: CategoryId;
  name: string;
  tagline: string;
  description: string;
  icon: LucideIcon;
  accent: "brand" | "accent" | "violet" | "amber" | "emerald" | "rose";
}

/* ------------------------------ engine contract ----------------------------- */

export type ArtifactKind = "image" | "pdf" | "text" | "audio" | "video" | "zip" | "other";

export interface EngineArtifact {
  name: string;
  blob: Blob;
  kind: ArtifactKind;
  note?: string;
}

export interface EngineStat {
  label: string;
  value: string;
}

export type EnginePreview =
  | { type: "text"; data: string }
  | { type: "html"; data: string; escaped?: boolean }
  | { type: "json"; data: string }
  | { type: "stats"; data: EngineStat[] };

export interface EngineResult {
  artifacts: EngineArtifact[];
  preview?: EnginePreview;
  stats?: EngineStat[];
  notice?: string;
}

export interface EngineContext {
  files: File[];
  text: string;
  options: Record<string, ToolOptionValue>;
  report: (progress: number, label?: string) => void;
}

export type ToolEngine = (ctx: EngineContext) => Promise<EngineResult>;

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function engineError(message: string): never {
  throw new ToolError(message);
}

export function requireFile(ctx: EngineContext): File {
  const file = ctx.files[0];
  if (!file) engineError("Please select a file first.");
  return file;
}

export function requireFiles(ctx: EngineContext, min = 1): File[] {
  if (ctx.files.length < min) {
    engineError(
      min === 1
        ? "Please select a file first."
        : `This tool needs at least ${min} files.`,
    );
  }
  return ctx.files;
}

export function num(
  options: Record<string, ToolOptionValue>,
  id: string,
  fallback: number,
): number {
  const value = options[id];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

export function str(
  options: Record<string, ToolOptionValue>,
  id: string,
  fallback = "",
): string {
  const value = options[id];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

export function bool(
  options: Record<string, ToolOptionValue>,
  id: string,
  fallback = false,
): boolean {
  const value = options[id];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
