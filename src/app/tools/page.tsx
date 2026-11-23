import type { Metadata } from "next";
import { ToolsExplorer } from "@/components/tools/tools-explorer";
import { SectionHeading, Badge } from "@/components/ui/feedback";
import { TOOL_COUNT } from "@/lib/tools/registry";

export const metadata: Metadata = {
  title: `All ${TOOL_COUNT} browser-based tools`,
  description: `Browse every one of the ${TOOL_COUNT} privacy-first tools. Search by name, description or keyword and filter by category.`,
};

export default async function ToolsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  return (
    <div className="container-page py-10 lg:py-14">
      <div className="mb-8 flex flex-col gap-4">
        <SectionHeading
          eyebrow="Complete library"
          title={`All ${TOOL_COUNT} tools`}
          description="Every tool runs entirely inside your browser. Search by name, description or keyword, then filter by category."
        />
        <div className="flex flex-wrap gap-2">
          <Badge tone="success">No uploads</Badge>
          <Badge tone="brand">No sign-up</Badge>
          <Badge tone="accent">No file limits</Badge>
          <Badge tone="neutral">Works offline</Badge>
        </div>
      </div>
      <ToolsExplorer initialQuery={q ?? ""} />
    </div>
  );
}
