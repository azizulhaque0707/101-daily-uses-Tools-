import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { CategoryDefinition } from "@/lib/tools/types";
import { cn } from "@/lib/utils";

const accentStyles: Record<string, { box: string; ring: string }> = {
  brand: { box: "bg-brand-soft text-brand", ring: "group-hover:border-brand/50" },
  accent: { box: "bg-accent-soft text-accent", ring: "group-hover:border-accent/50" },
  violet: {
    box: "bg-violet-500/12 text-violet-600 dark:text-violet-300",
    ring: "group-hover:border-violet-400/50",
  },
  amber: {
    box: "bg-amber-500/12 text-amber-600 dark:text-amber-300",
    ring: "group-hover:border-amber-400/50",
  },
  emerald: {
    box: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300",
    ring: "group-hover:border-emerald-400/50",
  },
  rose: {
    box: "bg-rose-500/12 text-rose-600 dark:text-rose-300",
    ring: "group-hover:border-rose-400/50",
  },
};

export function CategoryCard({
  category,
  count,
  className,
}: {
  category: CategoryDefinition;
  count: number;
  className?: string;
}) {
  const accent = accentStyles[category.accent] ?? accentStyles.brand;

  return (
    <Link
      href={`/categories/${category.id}`}
      aria-label={`Explore ${category.name}`}
      className={cn(
        "group relative flex flex-col gap-3 overflow-hidden rounded-xl border border-line bg-surface p-5 shadow-soft transition-all duration-300",
        "hover:-translate-y-1 hover:shadow-lift",
        accent.ring,
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <span className={cn("flex size-11 items-center justify-center rounded-lg", accent.box)}>
          <category.icon className="size-5" aria-hidden />
        </span>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-ink-soft">
          {count} tools
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-base font-semibold tracking-tight text-ink">{category.name}</h3>
        <p className="text-sm leading-relaxed text-ink-soft line-clamp-2">{category.tagline}</p>
      </div>
      <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
        Explore
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" aria-hidden />
      </span>
    </Link>
  );
}
