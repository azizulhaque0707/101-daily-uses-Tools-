import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Eye, HardDrive, Lock, Server, ShieldCheck, WifiOff } from "lucide-react";
import { Breadcrumb, Badge, SectionHeading } from "@/components/ui/feedback";
import { TOOL_COUNT } from "@/lib/tools/registry";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How BrowserForge keeps your files private by architecture rather than by policy: no uploads, no storage, no tracking, no backend processing.",
};

const guarantees = [
  {
    icon: Server,
    title: "No upload endpoint exists",
    body: "The application has no route that accepts file data. You can open your browser's network panel while using any tool and confirm nothing is sent.",
  },
  {
    icon: HardDrive,
    title: "No storage of your files",
    body: "There is no object store, no temporary directory and no queue. Results live in memory as Blobs and vanish when you close the tab.",
  },
  {
    icon: Eye,
    title: "No inspection of your data",
    body: "We do not read, log, analyse or transmit file names, file contents, or generated output. There is nothing to inspect them with.",
  },
  {
    icon: WifiOff,
    title: "Works offline",
    body: "Once a tool page is cached, most tools keep working with no network connection at all, because every engine ships with the page.",
  },
];

const facts = [
  "No account or email required",
  "No cookies for tracking",
  "No analytics on tool usage",
  "No paid or free processing APIs",
  "No database holding your documents",
  "No file size quota or daily limit",
];

export default function PrivacyPage() {
  return (
    <>
      <div className="border-b border-line bg-surface">
        <div className="container-page py-6">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Privacy" },
            ]}
          />
        </div>
      </div>

      <div className="container-page flex flex-col gap-14 py-10 lg:py-16">
        <header className="flex flex-col gap-5">
          <Badge tone="success">
            <ShieldCheck className="size-3.5" />
            Privacy by architecture
          </Badge>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-ink sm:text-4xl lg:text-5xl">
            Your files never leave your device
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-ink-soft">
            Most privacy policies promise good behaviour. BrowserForge removes the possibility of bad
            behaviour instead: {TOOL_COUNT} tools, all processed locally, with no server ever
            receiving a byte of your work.
          </p>
        </header>

        <section className="flex flex-col gap-5">
          <SectionHeading eyebrow="Guarantees" title="What this design makes impossible" />
          <div className="grid gap-3 sm:grid-cols-2">
            {guarantees.map((item) => (
              <article
                key={item.title}
                className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-soft"
              >
                <span className="flex size-10 items-center justify-center rounded-lg bg-success/12 text-success">
                  <item.icon className="size-5" aria-hidden />
                </span>
                <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                <p className="text-sm leading-relaxed text-ink-soft">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-surface p-6 sm:p-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
            <Lock className="size-4 text-brand" aria-hidden />
            Verify it yourself
          </h2>
          <ol className="mt-4 flex flex-col gap-3">
            {[
              "Open any tool page in Chrome, Edge or Firefox.",
              "Open Developer Tools and switch to the Network tab.",
              "Drop a confidential file into the tool and run it.",
              "Watch the list — no request carrying your file appears, because there is no endpoint that could accept one.",
              "Download your result, then close the tab. Nothing persists.",
            ].map((step, index) => (
              <li key={step} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft font-mono text-[11px] font-bold text-brand">
                  {index + 1}
                </span>
                <span className="text-sm leading-relaxed text-ink-soft">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-surface p-6">
            <h2 className="text-lg font-semibold text-ink">Plain facts</h2>
            <ul className="mt-4 flex flex-col gap-2.5">
              {facts.map((fact) => (
                <li key={fact} className="flex items-start gap-2 text-sm text-ink-soft">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                  {fact}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-warning/40 bg-warning/5 p-6">
            <h2 className="text-lg font-semibold text-ink">What we cannot help with</h2>
            <ul className="mt-4 flex flex-col gap-2.5 text-sm leading-relaxed text-ink-soft">
              <li>
                If you download a result and share it elsewhere, that is outside our control — and
                outside this app.
              </li>
              <li>
                Some tools need one initial page load before they work offline, since the engines
                themselves are downloaded with the page.
              </li>
              <li>
                Browser extensions, malware or a compromised device could observe local memory. No
                website can protect against that.
              </li>
            </ul>
          </div>
        </section>

        <section className="flex flex-col items-start gap-4 rounded-2xl border border-line bg-gradient-to-br from-brand/12 via-surface to-accent/10 p-8">
          <h2 className="text-xl font-semibold text-ink sm:text-2xl">
            {TOOL_COUNT} tools, zero uploads
          </h2>
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
            Pick a tool, drop a file, download the result. Nothing about your work is transmitted,
            stored or observed.
          </p>
          <Link
            href="/tools"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-[var(--brand-ink)] shadow-card transition-all hover:-translate-y-0.5 hover:bg-brand-strong"
          >
            Browse the tool library
            <ArrowRight className="size-4" />
          </Link>
        </section>
      </div>
    </>
  );
}
