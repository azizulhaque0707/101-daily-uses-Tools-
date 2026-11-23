"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Filter, LayoutGrid, Rows3, SearchX } from "lucide-react";
import {
  categories,
  categoryCounts,
  searchTools,
  tools,
  TOOL_COUNT,
} from "@/lib/tools/registry";
import type { CategoryId } from "@/lib/tools/types";
import { SearchBar } from "@/components/tools/search-bar";
import { ToolCard } from "@/components/tools/tool-card";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/form-controls";
import { cn } from "@/lib/utils";

type Filter = CategoryId | "all";
type Density = "grid" | "list";

export function ToolsExplorer({
  initialQuery = "",
  lockedCategory,
  showCategoryFilter = true,
  className,
  limit,
}: {
  initialQuery?: string;
  lockedCategory?: CategoryId;
  showCategoryFilter?: boolean;
  className?: string;
  limit?: number;
}) {
  const [query, setQuery] = React.useState(initialQuery);
  const [selectedFilter, setSelectedFilter] = React.useState<Filter>("all");
  const [density, setDensity] = React.useState<Density>("grid");
  const [visible, setVisible] = React.useState(limit ?? 0);
  const counts = React.useMemo(() => categoryCounts(), []);

  // A locked category is derived, not stored: the parent decides the scope, so
  // there is no state to keep in sync and no effect to run when it changes.
  const filter: Filter = lockedCategory ?? selectedFilter;
  const setFilter = (next: Filter) => setSelectedFilter(next);

  const results = React.useMemo(() => {
    const found = query.trim() ? searchTools(query) : tools;
    const scoped = lockedCategory
      ? found.filter((tool) => tool.category === lockedCategory)
      : filter === "all"
        ? found
        : found.filter((tool) => tool.category === filter);
    return scoped;
  }, [query, filter, lockedCategory]);

  const shown = limit ? results.slice(0, visible || limit) : results;
  const remaining = results.length - shown.length;

  return (
    <section className={cn("flex flex-col gap-6", className)} aria-label="Tool library">
      <div className="flex flex-col gap-4">
        <SearchBar value={query} onChange={setQuery} placeholder="Search by tool name, description or keyword…" />

        {showCategoryFilter ? (
          <div className="flex flex-wrap items-center gap-2">
            <FilterPill
              active={filter === "all"}
              onClick={() => setFilter("all")}
              count={lockedCategory ? counts[lockedCategory] : TOOL_COUNT}
            >
              All tools
            </FilterPill>
            {categories
              .filter((category) => !lockedCategory || category.id === lockedCategory)
              .map((category) => (
                <FilterPill
                  key={category.id}
                  active={filter === category.id}
                  onClick={() => setFilter(category.id)}
                  count={counts[category.id]}
                >
                  {category.name.replace(" Tools", "")}
                </FilterPill>
              ))}
            <div className="ml-auto hidden lg:block">
              <SegmentedControl
                label="Layout density"
                value={density}
                onChange={setDensity}
                options={[
                  { value: "grid", label: "Grid", icon: <LayoutGrid className="size-3.5" /> },
                  { value: "list", label: "Compact", icon: <Rows3 className="size-3.5" /> },
                ]}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-4 text-sm text-ink-muted">
        <p aria-live="polite">
          <span className="font-semibold text-ink">{results.length}</span>{" "}
          {results.length === 1 ? "tool" : "tools"}
          {query ? ` matching “${query}”` : ""}
        </p>
        {query ? (
          <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
            Clear search
          </Button>
        ) : null}
      </div>

      {results.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line bg-surface-2/40 px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-surface text-ink-muted">
            <SearchX className="size-6" />
          </span>
          <h3 className="text-base font-semibold text-ink">No tools matched your search</h3>
          <p className="max-w-sm text-sm text-ink-soft">
            Try a different keyword such as “compress”, “merge”, “trim” or “QR”, or reset the
            filters to browse everything.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setQuery("");
              setSelectedFilter("all");
            }}
          >
            Reset filters
          </Button>
        </div>
      ) : density === "grid" ? (
        <motion.div layout className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <AnimatePresence initial={false}>
            {shown.map((tool) => (
              <motion.div
                key={tool.slug}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <ToolCard tool={tool} />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((tool) => (
            <ToolCard key={tool.slug} tool={tool} compact />
          ))}
        </div>
      )}

      {remaining > 0 ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="lg" onClick={() => setVisible((v) => v + 24)}>
            <Filter className="size-4" />
            Show {Math.min(24, remaining)} more of {remaining}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function FilterPill({
  children,
  active,
  count,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all",
        active
          ? "border-brand bg-brand text-[var(--brand-ink)] shadow-soft"
          : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink",
      )}
    >
      {children}
      <span className={cn("text-[11px]", active ? "opacity-80" : "text-ink-muted")}>{count}</span>
    </button>
  );
}
