import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { categories, getCategory, toolsByCategory } from "@/lib/tools/registry";
import { ToolCard } from "@/components/tools/tool-card";
import { Breadcrumb, SectionHeading, Badge } from "@/components/ui/feedback";
import { ToolsExplorer } from "@/components/tools/tools-explorer";

export function generateStaticParams() {
  return categories.map((category) => ({ id: category.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const category = getCategory(id);
  if (!category) return { title: "Category not found" };
  return {
    title: `${category.name} — ${toolsByCategory(category.id).length} free browser tools`,
    description: category.description,
  };
}

export default async function CategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const category = getCategory(id);
  if (!category) notFound();

  const tools = toolsByCategory(category.id);
  const accentClasses: Record<string, string> = {
    brand: "bg-brand-soft text-brand",
    accent: "bg-accent-soft text-accent",
    violet: "bg-violet-500/12 text-violet-600 dark:text-violet-300",
    amber: "bg-amber-500/12 text-amber-600 dark:text-amber-300",
    emerald: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300",
    rose: "bg-rose-500/12 text-rose-600 dark:text-rose-300",
  };

  return (
    <>
      <div className="border-b border-line bg-surface">
        <div className="container-page py-6">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Tools", href: "/tools" },
              { label: category.name },
            ]}
          />
        </div>
      </div>

      <div className="container-page py-10 lg:py-14">
        <header className="flex flex-col gap-5">
          <div className="flex items-start gap-4">
            <span
              className={`flex size-14 shrink-0 items-center justify-center rounded-2xl ${accentClasses[category.accent]}`}
            >
              <category.icon className="size-7" aria-hidden />
            </span>
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
                {category.name}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{tools.length} tools</Badge>
                <Badge tone="success">
                  <ShieldCheck className="size-3" />
                  All processing local
                </Badge>
              </div>
            </div>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-ink-soft sm:text-base">
            {category.description}
          </p>
        </header>

        <div className="mt-8">
          <ToolsExplorer lockedCategory={category.id} showCategoryFilter={false} />
        </div>

        <section className="mt-12 border-t border-line pt-8">
          <SectionHeading title="Other categories" className="mb-5" />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {categories
              .filter((entry) => entry.id !== category.id)
              .map((entry) => (
                <Link
                  key={entry.id}
                  href={`/categories/${entry.id}`}
                  className="group flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 transition-all hover:border-brand/40 hover:shadow-card"
                >
                  <span className="flex items-center gap-2">
                    <span className={`flex size-8 items-center justify-center rounded-lg ${accentClasses[entry.accent]}`}>
                      <entry.icon className="size-4" aria-hidden />
                    </span>
                    <span className="text-sm font-medium text-ink">
                      {entry.name.replace(" Tools", "")}
                    </span>
                  </span>
                  <span className="text-xs text-ink-muted">{toolsByCategory(entry.id).length}</span>
                </Link>
              ))}
          </div>
        </section>
      </div>
    </>
  );
}
