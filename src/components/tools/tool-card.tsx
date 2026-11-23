import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import type { ToolDefinition } from "@/lib/tools/types";
import { getCategory } from "@/lib/tools/registry";
import { cn } from "@/lib/utils";

const accentStyles: Record<string, string> = {
  brand: "bg-brand-soft text-brand",
  accent: "bg-accent-soft text-accent",
  violet: "bg-violet-500/12 text-violet-600 dark:text-violet-300",
  amber: "bg-amber-500/12 text-amber-600 dark:text-amber-300",
  emerald: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300",
  rose: "bg-rose-500/12 text-rose-600 dark:text-rose-300",
};

export function ToolCard({
  tool,
  className,
  compact = false,
}: {
  tool: ToolDefinition;
  className?: string;
  compact?: boolean;
}) {
  const category = getCategory(tool.category);
  const accent = accentStyles[category?.accent ?? "brand"] ?? accentStyles.brand;

  return (
    <article
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface p-5 shadow-soft",
        "transition-all duration-300 hover:-translate-y-1 hover:border-brand/40 hover:shadow-lift",
        "focus-within:border-brand/60",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-24 h-40 bg-gradient-to-b from-brand/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="relative flex items-start justify-between gap-3">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", accent)}>
          <tool.icon className="size-5" aria-hidden />
        </span>
        <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-muted">
          {category?.name.replace(" Tools", "")}
        </span>
      </div>

      <div className="relative mt-4 flex flex-1 flex-col gap-2">
        <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink">
          <Link href={`/tools/${tool.slug}`} className="rounded transition-colors hover:text-brand">
            {tool.name}
          </Link>
        </h3>
        <p
          className={cn(
            "text-sm leading-relaxed text-ink-soft",
            compact ? "line-clamp-1" : "line-clamp-2",
          )}
        >
          {tool.description}
        </p>
      </div>

      <div className="relative mt-4 flex items-center justify-between gap-2 border-t border-line/70 pt-3.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
          <ShieldCheck className="size-3.5 text-success" />
          Local only
        </span>
        <Link
          href={`/tools/${tool.slug}`}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-brand transition-all group-hover:gap-2.5 group-hover:bg-brand-soft"
        >
          Try now
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </article>
  );
}

export function ToolCardRow({ tool }: { tool: ToolDefinition }) {
  return (
    <Link
      href={`/tools/${tool.slug}`}
      className="group flex items-center gap-3 rounded-lg border border-line bg-surface p-3 transition-all hover:border-brand/40 hover:shadow-card"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-soft transition-colors group-hover:bg-brand-soft group-hover:text-brand">
        <tool.icon className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-ink">{tool.name}</span>
        <span className="truncate text-xs text-ink-muted">{tool.outputHint}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
    </Link>
  );
}
