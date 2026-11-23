import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, CheckCircle2, Clock, Cpu, Lock, ShieldCheck, Sparkles } from "lucide-react";
import { getCategory, getTool, relatedTools, tools, TOOL_COUNT } from "@/lib/tools/registry";
import { Breadcrumb, Badge } from "@/components/ui/feedback";
import { ToolRunner } from "@/components/tool-runtime/tool-runner";
import type { ToolRuntimeConfig } from "@/lib/tools/runtime-config";
import { DuplicateImageFinder } from "@/components/tools/duplicate-finder";
import { PdfPageOrganizer } from "@/components/pdf/pdf-organizer";
import { PdfMarkupTool } from "@/components/pdf/pdf-markup";
import { PdfFormFiller } from "@/components/pdf/pdf-form-filler";
import { WordDocumentViewer } from "@/components/document/word-viewer";
import { ToolCardRow } from "@/components/tools/tool-card";

export function generateStaticParams() {
  return tools.map((tool) => ({ slug: tool.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tool = getTool(slug);
  if (!tool) return { title: "Tool not found" };
  const category = getCategory(tool.category);
  return {
    title: `${tool.name} — free, private, browser-based`,
    description: `${tool.description} Runs entirely in your browser with no uploads and no sign-up.`,
    keywords: [tool.name, ...tool.keywords, "free", "online", "no upload"],
    openGraph: {
      title: `${tool.name} | BrowserForge`,
      description: tool.description,
    },
    alternates: { canonical: `/tools/${tool.slug}` },
  };
}

export default async function ToolPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tool = getTool(slug);
  if (!tool) notFound();

  const category = getCategory(tool.category);
  const related = relatedTools(tool, 6);
  const isDuplicateFinder = tool.slug === "duplicate-image-finder";
  const isOrganizer = tool.slug === "pdf-page-organizer";
  const isFormFiller = tool.slug === "pdf-form-filler";
  const isWordViewer = tool.slug === "word-document-viewer";
  const markupMode =
    tool.slug === "pdf-signer"
      ? "pdf-signer"
      : tool.slug === "pdf-annotator"
        ? "pdf-annotator"
        : tool.slug === "pdf-highlighter"
          ? "pdf-highlighter"
          : null;
  const runtimeConfig: ToolRuntimeConfig = {
    slug: tool.slug,
    name: tool.name,
    category: tool.category,
    fileInput: tool.fileInput,
    textInput: tool.textInput,
    options: tool.options,
    limitation: tool.limitation,
  };

  const steps = tool.steps.length > 0 ? tool.steps : ["Add your files", "Adjust settings", "Download the result"];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: tool.name,
            applicationCategory: "UtilitiesApplication",
            operatingSystem: "Any (browser-based)",
            description: tool.description,
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          }),
        }}
      />

      <div className="border-b border-line bg-surface">
        <div className="container-page py-6">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Tools", href: "/tools" },
              { label: category?.name ?? "Category", href: `/categories/${tool.category}` },
              { label: tool.name },
            ]}
          />
        </div>
      </div>

      <div className="container-page grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:py-14">
        <div className="flex min-w-0 flex-col gap-8">
          <header className="flex flex-col gap-5">
            <div className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand shadow-soft">
                <tool.icon className="size-6" aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{tool.name}</h1>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brand">{category?.name ?? "Tool"}</Badge>
                  <Badge tone="success">
                    <ShieldCheck className="size-3" />
                    No upload
                  </Badge>
                  <Badge tone="neutral">{tool.outputHint}</Badge>
                </div>
              </div>
            </div>
            <p className="max-w-2xl text-sm leading-relaxed text-ink-soft sm:text-base">
              {tool.description}
            </p>
          </header>

          {isDuplicateFinder ? (
            <DuplicateImageFinder />
          ) : isOrganizer ? (
            <PdfPageOrganizer />
          ) : isFormFiller ? (
            <PdfFormFiller />
          ) : isWordViewer ? (
            <WordDocumentViewer />
          ) : markupMode ? (
            <PdfMarkupTool mode={markupMode} />
          ) : (
            <ToolRunner tool={runtimeConfig} />
          )}

          {tool.limitation ? (
            <section className="rounded-xl border border-warning/40 bg-warning/5 p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Sparkles className="size-4 text-warning" aria-hidden />
                Browser limitation, stated honestly
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{tool.limitation}</p>
            </section>
          ) : null}

          <section className="grid gap-4 sm:grid-cols-3">
            {[
              {
                icon: ShieldCheck,
                title: "Your files stay local",
                body: "This tool reads your file with a browser File handle and processes it in memory. There is no upload endpoint to send it to.",
              },
              {
                icon: Cpu,
                title: "Processed on your device",
                body: "Canvas, Web Audio, MediaRecorder and WebAssembly engines run inside this tab, using your own CPU and GPU.",
              },
              {
                icon: Clock,
                title: "Instant, unlimited",
                body: "No queue, no daily quota, no sign-up and no watermark. Run it as many times as you like.",
              },
            ].map((item) => (
              <div key={item.title} className="rounded-xl border border-line bg-surface p-4">
                <span className="flex size-9 items-center justify-center rounded-lg bg-success/12 text-success">
                  <item.icon className="size-4" aria-hidden />
                </span>
                <h3 className="mt-3 text-sm font-semibold text-ink">{item.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">{item.body}</p>
              </div>
            ))}
          </section>
        </div>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold text-ink">How to use it</h2>
            <ol className="mt-3 flex flex-col gap-3">
              {steps.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft font-mono text-[10px] font-bold text-brand">
                    {index + 1}
                  </span>
                  <span className="text-sm leading-relaxed text-ink-soft">{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold text-ink">Privacy check</h2>
            <ul className="mt-3 flex flex-col gap-2.5">
              {[
                "No file is uploaded to any server",
                "No backend processing of any kind",
                "No account, cookies or tracking",
                "Output is generated as a local Blob",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-ink-soft">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
            <Link
              href="/privacy"
              className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-brand hover:underline"
            >
              Read the privacy note
              <ArrowRight className="size-3" />
            </Link>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 px-1 text-sm font-semibold text-ink">
              <Lock className="size-3.5 text-brand" aria-hidden />
              Related tools
            </h2>
            <div className="flex flex-col gap-2">
              {related.map((candidate) => (
                <ToolCardRow key={candidate.slug} tool={candidate} />
              ))}
            </div>
            <Link
              href="/tools"
              className="mt-1 inline-flex items-center gap-1.5 px-1 text-xs font-semibold text-brand hover:underline"
            >
              Browse all {TOOL_COUNT} tools
              <ArrowRight className="size-3" />
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}
