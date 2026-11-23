"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Cpu, Gauge, Lock, Search, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/feedback";
import { SearchBar } from "@/components/tools/search-bar";
import { useRouter } from "next/navigation";
import { TOOL_COUNT } from "@/lib/tools/registry";

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export function Hero() {
  const router = useRouter();

  return (
    <section className="relative overflow-hidden border-b border-line">
      <div aria-hidden className="absolute inset-0 grid-glow opacity-70" />
      <div
        aria-hidden
        className="absolute inset-0 dot-grid opacity-[0.35] [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]"
      />

      <div className="container-page relative flex flex-col items-center gap-8 py-16 text-center sm:py-24">
        <motion.div variants={fadeUp} initial="hidden" animate="show" custom={0}>
          <Badge tone="brand" className="px-3 py-1 text-xs backdrop-blur">
            <Sparkles className="size-3.5" />
            {TOOL_COUNT} tools · 6 categories · 0 uploads
          </Badge>
        </motion.div>

        <motion.h1
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={0.06}
          className="max-w-4xl text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl lg:text-6xl"
        >
          Every file tool you need,
          <br className="hidden sm:block" />{" "}
          <span className="text-gradient">running in your browser</span>
        </motion.h1>

        <motion.p
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={0.12}
          className="max-w-2xl text-base leading-relaxed text-ink-soft sm:text-lg"
        >
          Compress images, merge PDFs, trim video, normalise audio and generate QR codes —
          {` ${TOOL_COUNT}`} tools in total, all processed locally with WebAssembly, Web Workers
          and browser-native APIs. No uploads, no queues, no accounts.
        </motion.p>

        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={0.18}
          className="flex w-full max-w-2xl flex-col items-center gap-3"
        >
          <SearchBar
            value=""
            onChange={(value) => router.push(value ? `/tools?q=${encodeURIComponent(value)}` : "/tools")}
            onSubmit={() => router.push("/tools")}
            placeholder="Search for a tool: “compress image”, “merge pdf”, “trim audio”…"
            shortcut={false}
          />
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-ink-muted">
            <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1">
              <ShieldCheck className="size-3.5 text-success" />
              Files stay on device
            </span>
            <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1">
              <Lock className="size-3.5 text-brand" />
              No backend processing
            </span>
            <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1">
              <Gauge className="size-3.5 text-accent" />
              Instant results
            </span>
          </div>
        </motion.div>

        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={0.24}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <Button asChild size="lg">
            <Link href="/tools">
              <Search className="size-4" />
              Browse all {TOOL_COUNT} tools
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href="/how-it-works">
              <Cpu className="size-4" />
              How the offline engine works
            </Link>
          </Button>
        </motion.div>

        <motion.dl
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={0.3}
          className="mt-6 grid w-full max-w-3xl grid-cols-2 divide-line rounded-xl border border-line bg-surface/80 px-2 py-4 shadow-soft backdrop-blur sm:grid-cols-4 sm:divide-x"
        >
          {[
            { value: `${TOOL_COUNT}`, label: "Tools available" },
            { value: "0", label: "Bytes uploaded" },
            { value: "6", label: "Categories" },
            { value: "∞", label: "Free usage" },
          ].map((stat) => (
            <div key={stat.label} className="flex flex-col items-center gap-0.5 px-3 py-2">
              <dt className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
                {stat.value}
              </dt>
              <dd className="text-xs text-ink-muted">{stat.label}</dd>
            </div>
          ))}
        </motion.dl>

        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={0.36}
          className="flex items-center gap-2 text-sm text-ink-muted"
        >
          <ArrowRight className="size-4" />
          <Link href="/#popular" className="font-medium text-brand hover:underline">
            Jump to the most popular tools
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
