import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Cpu, FileDown, Lock, MousePointerClick, UploadCloud, Zap } from "lucide-react";
import { HowItWorks, PrivacySection, ClosingCta } from "@/components/marketing/sections";
import { SectionHeading, Badge } from "@/components/ui/feedback";
import { Breadcrumb } from "@/components/ui/feedback";
import { featuredTools, TOOL_COUNT } from "@/lib/tools/registry";
import { ToolCardRow } from "@/components/tools/tool-card";

export const metadata: Metadata = {
  title: "How the offline engine works",
  description:
    "A technical explanation of how BrowserForge processes files entirely inside your browser using Canvas, Web Audio, WebAssembly and Web Workers.",
};

const stack = [
  {
    icon: Cpu,
    name: "Canvas 2D",
    role: "Image processing",
    detail:
      "Drawing, resizing, cropping, filters and convolution kernels. Runs on the GPU where the browser allows it, so large batches stay fast.",
  },
  {
    icon: Zap,
    name: "WebAssembly",
    role: "HEIC & PDF decoding",
    detail:
      "A WASM build of libheif decodes iPhone HEIC photos, and the PDF object model is rewritten in pure JavaScript running on the main thread or a worker.",
  },
  {
    icon: FileDown,
    name: "Blob & File APIs",
    role: "Input and output",
    detail:
      "Files are read straight from disk as Blobs and results are handed back as Blobs, saved with a local object URL. Nothing transits the network.",
  },
  {
    icon: Lock,
    name: "Web Crypto",
    role: "Hashing",
    detail:
      "SHA-1, SHA-256, SHA-384 and SHA-512 digests are computed by the browser's native crypto module — the same primitive used for TLS.",
  },
  {
    icon: Cpu,
    name: "Web Workers",
    role: "Background processing",
    detail:
      "Hashing and heavy comparison run off the main thread, so a 5,000 image scan never freezes the interface.",
  },
  {
    icon: UploadCloud,
    name: "Web Audio & MediaRecorder",
    role: "Audio and video",
    detail:
      "An OfflineAudioContext renders sample-accurate audio, and MediaRecorder captures canvas frames into MP4 or WebM in real time.",
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <div className="border-b border-line bg-surface">
        <div className="container-page py-6">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "How it works" },
            ]}
          />
        </div>
      </div>

      <div className="container-page flex flex-col gap-14 py-10 lg:py-16">
        <header className="flex flex-col gap-5">
          <Badge tone="brand">
            <MousePointerClick className="size-3.5" />
            Architecture
          </Badge>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-ink sm:text-4xl lg:text-5xl">
            The server has been replaced by your browser
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-ink-soft">
            Traditional online tools upload your documents to a server, process them there, and hope
            nothing leaks. BrowserForge removes that server entirely. {TOOL_COUNT} tools run on the
            same hardware that renders this page.
          </p>
        </header>

        <section className="flex flex-col gap-5">
          <SectionHeading
            eyebrow="The stack"
            title="Browser-native engines"
            description="No processing API is called, free or paid. Every engine ships with the page and runs on your device."
          />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stack.map((item) => (
              <article
                key={item.name}
                className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-soft transition-all hover:-translate-y-1 hover:shadow-card"
              >
                <span className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <item.icon className="size-5" aria-hidden />
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-semibold text-ink">{item.name}</h3>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                    {item.role}
                  </p>
                </div>
                <p className="text-sm leading-relaxed text-ink-soft">{item.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-5">
          <SectionHeading
            eyebrow="Where the limits are"
            title="Honest constraints"
            description="Browser-only processing cannot do everything a server farm can. These are the real limits."
          />
          <ul className="grid gap-3 sm:grid-cols-2">
            {[
              {
                title: "MP3 encoding",
                body: "No browser ships an MP3 encoder. Audio is exported as lossless WAV or Opus in WebM instead.",
              },
              {
                title: "Video encoding speed",
                body: "MediaRecorder captures in real time, so a 60 second clip takes about 60 seconds to re-encode.",
              },
              {
                title: "Video codecs vary by browser",
                body: "Chrome and Edge can write MP4. Firefox and Safari currently write WebM. Each tool says which you will get.",
              },
              {
                title: "Scanned PDFs",
                body: "PDF text extraction needs a text layer. OCR is not part of the offline build, so pure scans return no text.",
              },
              {
                title: "Direct file deletion",
                body: "Only the File System Access API can delete originals, and only in Chromium browsers. Elsewhere you get a cleaned ZIP.",
              },
              {
                title: "Complex CSS to PDF",
                body: "A full layout engine cannot run in the browser, so HTML is converted into structured text blocks.",
              },
            ].map((item) => (
              <li key={item.title} className="rounded-xl border border-line bg-surface p-5">
                <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-5">
          <SectionHeading
            eyebrow="Start here"
            title="Popular entry points"
            description="The tools people usually open first."
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {featuredTools()
              .slice(0, 12)
              .map((tool) => (
                <ToolCardRow key={tool.slug} tool={tool} />
              ))}
          </div>
          <Link
            href="/tools"
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline"
          >
            Browse all {TOOL_COUNT} tools
            <ArrowRight className="size-4" />
          </Link>
        </section>
      </div>

      <HowItWorks />
      <PrivacySection />
      <ClosingCta />
    </>
  );
}
