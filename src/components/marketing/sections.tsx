import Link from "next/link";
import {
  ArrowRight,
  ChevronDown,
  Cpu,
  FileDown,
  Lock,
  MonitorSmartphone,
  MousePointerClick,
  ShieldCheck,
  UploadCloud,
  Zap,
} from "lucide-react";
import { categories, categoryCounts, TOOL_COUNT } from "@/lib/tools/registry";
import { CategoryCard } from "@/components/tools/category-card";
import { SectionHeading } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/feedback";

/* ------------------------------ How it works ------------------------------- */

const steps = [
  {
    icon: MousePointerClick,
    title: "Pick a tool",
    body: `Choose from ${TOOL_COUNT} tools across image, PDF, document, video, audio and utility categories.`,
  },
  {
    icon: UploadCloud,
    title: "Drop your files",
    body: "Files are read straight from disk with the FileReader and Blob APIs — nothing is transmitted.",
  },
  {
    icon: Cpu,
    title: "Process locally",
    body: "Canvas, Web Audio, MediaRecorder and WebAssembly engines do the work in a Web Worker.",
  },
  {
    icon: FileDown,
    title: "Download instantly",
    body: "Results are handed back as a Blob and saved with a single click. Close the tab and it is all gone.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="container-page py-20">
      <SectionHeading
        eyebrow="How it works"
        title="Four steps, zero servers involved"
        description="Traditional online tools upload your documents to a server, process them, and hope nothing leaks. BrowserForge replaces that server with your own browser."
        align="center"
        className="mx-auto"
      />
      <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="relative flex flex-col gap-3 rounded-xl border border-line bg-surface p-6 shadow-soft transition-all hover:-translate-y-1 hover:shadow-card"
          >
            <span className="absolute right-5 top-5 font-mono text-xs text-ink-muted">
              0{index + 1}
            </span>
            <span className="flex size-11 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <step.icon className="size-5" aria-hidden />
            </span>
            <h3 className="text-base font-semibold text-ink">{step.title}</h3>
            <p className="text-sm leading-relaxed text-ink-soft">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------- Privacy ---------------------------------- */

const privacyPoints = [
  {
    icon: Lock,
    title: "No uploads, ever",
    body: "There is no upload endpoint. Files are opened with local File handles and processed with typed arrays in memory.",
  },
  {
    icon: ShieldCheck,
    title: "No tracking of your data",
    body: "We do not inspect, log or store file names, contents or results. Nothing about your work leaves the tab.",
  },
  {
    icon: Cpu,
    title: "Works offline",
    body: "Once the page is cached, most tools keep working without a network connection at all.",
  },
  {
    icon: MonitorSmartphone,
    title: "Your device, your speed",
    body: "Processing speed depends on your CPU and GPU — the same hardware that renders the page you are reading.",
  },
];

export function PrivacySection() {
  return (
    <section id="privacy" className="relative overflow-hidden border-y border-line bg-surface">
      <div aria-hidden className="absolute inset-0 grid-glow opacity-60" />
      <div className="container-page relative grid gap-12 py-20 lg:grid-cols-[1fr_1.1fr] lg:items-center">
        <div className="flex flex-col gap-5">
          <Badge tone="success">
            <ShieldCheck className="size-3.5" />
            Privacy by architecture
          </Badge>
          <h2 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Your files never touch a server
          </h2>
          <p className="max-w-xl text-base leading-relaxed text-ink-soft">
            BrowserForge is architected so that uploading is impossible, not just discouraged.
            There is no storage bucket, no processing queue and no database holding your
            documents — because the browser does all of the work.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/privacy"
              className="inline-flex items-center gap-2 rounded-lg border border-line bg-canvas px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:border-brand/50 hover:text-brand"
            >
              Read the full privacy note
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/tools"
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-[var(--brand-ink)] transition-colors hover:bg-brand-strong"
            >
              Start a tool
            </Link>
          </div>
        </div>

        <ul className="grid gap-4 sm:grid-cols-2">
          {privacyPoints.map((point) => (
            <li
              key={point.title}
              className="flex flex-col gap-2.5 rounded-xl border border-line bg-canvas/80 p-5 backdrop-blur"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-success/12 text-success">
                <point.icon className="size-5" aria-hidden />
              </span>
              <h3 className="text-sm font-semibold text-ink">{point.title}</h3>
              <p className="text-sm leading-relaxed text-ink-soft">{point.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* -------------------------------- Categories ------------------------------- */

export function CategoryGrid() {
  const counts = categoryCounts();
  return (
    <section id="categories" className="container-page py-20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <SectionHeading
          eyebrow="Browse by category"
          title={`Six categories, ${TOOL_COUNT} tools`}
          description="Every category is fully self-contained, so you can bookmark the one you use daily."
        />
        <Link
          href="/tools"
          className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline"
        >
          View the complete list
          <ArrowRight className="size-4" />
        </Link>
      </div>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => (
          <CategoryCard key={category.id} category={category} count={counts[category.id]} />
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------- FAQ ----------------------------------- */

const faqs = [
  {
    q: "Are my files really never uploaded?",
    a: "Yes. BrowserForge has no upload endpoint at all. Files are read with the browser's File and Blob APIs, processed in memory with Canvas, Web Audio, MediaRecorder and WebAssembly, then turned back into a download. You can open your browser's network tab and watch: nothing is sent.",
  },
  {
    q: "Is there a file size limit?",
    a: "The limit is your device memory rather than an artificial server cap. Images and PDFs of a few hundred megabytes work comfortably on a modern laptop. Video re-encoding runs in real time, so long clips take as long as their runtime.",
  },
  {
    q: "Do I need to install anything?",
    a: "No. Everything runs in a modern browser — Chrome, Edge, Firefox, Safari or Brave on desktop, and Chrome or Safari on mobile. Some video and audio encoders vary by browser, and each tool states that clearly.",
  },
  {
    q: "Is it really free, with no account?",
    a: "Yes. There is no sign-up, no trial, no watermark and no daily quota. No paid APIs are used anywhere in the stack, which is exactly why it can stay free.",
  },
  {
    q: "How do the PDF tools work without a server?",
    a: "PDF pages are parsed and rewritten with a pure-JavaScript PDF engine that runs in the browser, including a WASM-free object model for merging, splitting and stamping. Rendering PDF pages to images uses the browser's own PDF rasteriser in a Web Worker.",
  },
  {
    q: "What happens if I close the tab?",
    a: "Everything is discarded. Results live in memory as Blobs, so closing the tab clears them. If you need the output, download it before leaving.",
  },
  {
    q: "Can I use the tools offline?",
    a: "Mostly yes. Once the tool pages are cached they run without a connection, since all engines ship with the page and no processing requires a network call.",
  },
  {
    q: "Which formats are supported?",
    a: "Images: JPG, PNG, WebP, AVIF, GIF and BMP. Documents: TXT, MD, HTML, JSON, CSV. PDF: standard PDF 1.4+. Video and audio support depends on the codecs your browser ships — MP4, WebM, MOV and MKV in Chromium, with clear fallbacks elsewhere.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="container-page py-20">
      <SectionHeading
        eyebrow="FAQ"
        title="Questions, answered honestly"
        description="Including the places where browser-only processing has genuine limits."
        align="center"
        className="mx-auto"
      />
      <div className="mx-auto mt-10 flex max-w-3xl flex-col gap-3">
        {faqs.map((faq) => (
          <details
            key={faq.q}
            className="group rounded-xl border border-line bg-surface px-5 shadow-soft transition-colors open:border-brand/40"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15px] font-semibold text-ink">
              {faq.q}
              <ChevronDown
                aria-hidden
                className="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-180"
              />
            </summary>
            <p className="pb-5 text-sm leading-relaxed text-ink-soft">{faq.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------- CTA ----------------------------------- */

export function ClosingCta() {
  return (
    <section className="container-page pb-4">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-brand/12 via-surface to-accent/10 p-10 text-center shadow-card sm:p-14">
        <div aria-hidden className="absolute inset-0 dot-grid opacity-30" />
        <div className="relative flex flex-col items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-xl bg-brand text-[var(--brand-ink)] shadow-card">
            <Zap className="size-6" />
          </span>
          <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {TOOL_COUNT} tools, zero uploads, one tab
          </h2>
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft sm:text-base">
            Stop pasting confidential documents into websites that store them forever. Open a tool,
            drop a file, download the result.
          </p>
          <Link
            href="/tools"
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-[var(--brand-ink)] shadow-card transition-all hover:-translate-y-0.5 hover:bg-brand-strong"
          >
            Browse the tool library
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
