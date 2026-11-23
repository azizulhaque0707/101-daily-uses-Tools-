import type { CategoryId, ToolOption, ToolOptionValue, ToolTextInput, ToolFileInput } from "@/lib/tools/types";

/**
 * Serializable description of a tool for the client-side runtime. The tool
 * registry stores Lucide icon *components*, which cannot cross the server →
 * client boundary, so the page renders icons itself and hands only plain data
 * to the runtime.
 */
export type ToolRuntimeConfig = {
  slug: string;
  name: string;
  category: CategoryId;
  fileInput?: ToolFileInput;
  textInput?: ToolTextInput;
  options: ToolOption[];
  limitation?: string;
};

export type { ToolOption, ToolOptionValue };
