import Link from "next/link";
import { ArrowRight, Flame } from "lucide-react";
import { Hero } from "@/components/marketing/hero";
import {
  CategoryGrid,
  ClosingCta,
  Faq,
  HowItWorks,
  PrivacySection,
} from "@/components/marketing/sections";
import { ToolsExplorer } from "@/components/tools/tools-explorer";
import { ToolCard } from "@/components/tools/tool-card";
import { SectionHeading, Badge } from "@/components/ui/feedback";
import { popularTools, TOOL_COUNT } from "@/lib/tools/registry";

export default function HomePage() {
  const popular = popularTools(8);

  return (
    <>
      <Hero />

      <section id="popular" className="container-page py-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <SectionHeading
            eyebrow="Most used"
            title="Popular tools this week"
            description="The tools people reach for first — usually more than once a day."
          />
          <Link
            href="/tools"
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline"
          >
            See all {TOOL_COUNT} tools
            <ArrowRight className="size-4" />
          </Link>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {popular.map((tool) => (
            <ToolCard key={tool.slug} tool={tool} />
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          {popularTools(24)
            .slice(8)
            .map((tool) => (
              <Link
                key={tool.slug}
                href={`/tools/${tool.slug}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:text-brand"
              >
                <Flame className="size-3 text-warning" />
                {tool.name}
              </Link>
            ))}
        </div>
      </section>

      <CategoryGrid />

      <section id="all-tools" className="container-page py-16">
        <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="Complete library"
            title={`All ${TOOL_COUNT} tools in one place`}
            description="Search by name, description or keyword, then filter by category. Every card opens a full tool page with settings and a working download."
          />
          <Badge tone="neutral" className="hidden lg:inline-flex">
            Press / to search
          </Badge>
        </div>
        <ToolsExplorer />
      </section>

      <HowItWorks />
      <PrivacySection />
      <Faq />
      <ClosingCta />
    </>
  );
}
