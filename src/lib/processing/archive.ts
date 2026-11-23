import { zip } from "fflate";
import type { EngineContext, EngineResult, ToolEngine } from "@/lib/tools/types";

export async function zipArtifacts(
  files: { name: string; blob: Blob }[],
  level = 6,
): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    const path = file.name.replace(/^\/+/, "");
    entries[path] = new Uint8Array(await file.blob.arrayBuffer());
  }
  const buffer = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
  return new Blob([buffer.slice()], { type: "application/zip" });
}

export function textArtifact(
  name: string,
  content: string,
  mime = "text/plain;charset=utf-8",
) {
  return { name, blob: new Blob([content], { type: mime }), kind: "text" as const };
}

export function resultStats(entries: Record<string, string | number>) {
  return Object.entries(entries).map(([label, value]) => ({
    label,
    value: typeof value === "number" ? value.toLocaleString("en-US") : value,
  }));
}

export type { EngineContext, EngineResult, ToolEngine };
