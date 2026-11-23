import {
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { imageTools } from "./image";
import { pdfTools } from "./pdf";
import { documentTools } from "./document";
import { videoTools } from "./video";
import { audioTools } from "./audio";
import { utilityTools } from "./utility";
import type { CategoryDefinition, CategoryId, ToolDefinition } from "./types";

export const categories: CategoryDefinition[] = [
  {
    id: "image",
    name: "Image Tools",
    tagline: "Compress, resize, convert and retouch",
    description:
      "Resize, compress, convert and retouch images with GPU-accelerated canvas processing. Handles JPG, PNG, WebP and AVIF in batches.",
    icon: ImageIcon,
    accent: "brand",
  },
  {
    id: "pdf",
    name: "PDF Tools",
    tagline: "Merge, split, stamp and extract",
    description:
      "Merge, split, rotate, stamp and extract from PDF documents using a fully in-browser PDF engine — your files never leave the tab.",
    icon: FileText,
    accent: "rose",
  },
  {
    id: "document",
    name: "Document Tools",
    tagline: "Format text, JSON, CSV and Markdown",
    description:
      "Convert Markdown to HTML or Word, tidy JSON, pivot CSV, deduplicate lists and analyse text without uploading a thing.",
    icon: FileText,
    accent: "amber",
  },
  {
    id: "video",
    name: "Video Tools",
    tagline: "Trim, compress, resize and caption",
    description:
      "Trim, compress, rotate, caption and re-encode video with the browser's own media pipeline — no server render farm required.",
    icon: Film,
    accent: "violet",
  },
  {
    id: "audio",
    name: "Audio Tools",
    tagline: "Trim, normalise, mix and visualise",
    description:
      "Trim, normalise, mix, reverse and visualise audio using the Web Audio API and an offline rendering graph for sample-accurate output.",
    icon: Music,
    accent: "emerald",
  },
  {
    id: "utility",
    name: "Utility Tools",
    tagline: "Generate QR codes, hashes and more",
    description:
      "Everyday helpers: QR codes, barcodes, secure passwords, hashes, unit conversions and financial calculators.",
    icon: Wrench,
    accent: "accent",
  },
];

const categoryOrder: CategoryId[] = ["image", "pdf", "document", "video", "audio", "utility"];

export const tools: ToolDefinition[] = [
  ...imageTools,
  ...pdfTools,
  ...documentTools,
  ...videoTools,
  ...audioTools,
  ...utilityTools,
];

export const TOOL_COUNT = tools.length;
export const CATEGORY_COUNT = categories.length;

const bySlug = new Map<string, ToolDefinition>(tools.map((tool) => [tool.slug, tool]));

export function getTool(slug: string): ToolDefinition | undefined {
  return bySlug.get(slug);
}

export function getCategory(id: string): CategoryDefinition | undefined {
  return categories.find((category) => category.id === id);
}

export function toolsByCategory(id: CategoryId): ToolDefinition[] {
  return tools.filter((tool) => tool.category === id);
}

export function categoryCounts(): Record<CategoryId, number> {
  const counts = {} as Record<CategoryId, number>;
  for (const id of categoryOrder) counts[id] = 0;
  for (const tool of tools) counts[tool.category] += 1;
  return counts;
}

export function popularTools(limit = 12): ToolDefinition[] {
  return [...tools].sort((a, b) => b.popularity - a.popularity).slice(0, limit);
}

export function featuredTools(): ToolDefinition[] {
  return tools.filter((tool) => tool.featured);
}

export function relatedTools(tool: ToolDefinition, limit = 8): ToolDefinition[] {
  return tools
    .filter((candidate) => candidate.slug !== tool.slug)
    .map((candidate) => {
      const sharedKeywords = candidate.keywords.filter((keyword) =>
        tool.keywords.includes(keyword),
      ).length;
      const sameCategory = candidate.category === tool.category ? 1 : 0;
      return { candidate, score: sameCategory * 2 + sharedKeywords };
    })
    .sort((a, b) => b.score - a.score || b.candidate.popularity - a.candidate.popularity)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function searchTools(query: string): ToolDefinition[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tools;
  const terms = needle.split(/\s+/).filter(Boolean);
  return tools
    .map((tool) => {
      const haystack = [
        tool.name,
        tool.description,
        tool.slug.replace(/-/g, " "),
        tool.keywords.join(" "),
        getCategory(tool.category)?.name ?? "",
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (tool.name.toLowerCase().includes(term)) score += 6;
        if (tool.keywords.some((keyword) => keyword.includes(term))) score += 4;
        if (haystack.includes(term)) score += 2;
      }
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.tool.popularity - a.tool.popularity)
    .map(({ tool }) => tool);
}

export function toolHref(tool: Pick<ToolDefinition, "slug">): string {
  return `/tools/${tool.slug}`;
}

export function categoryHref(id: CategoryId | string): string {
  return `/categories/${id}`;
}

export function categoryIcon(id: CategoryId): LucideIcon {
  return (getCategory(id) ?? categories[0]).icon;
}

export { categoryOrder };
