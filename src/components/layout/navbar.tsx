"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { categories, categoryCounts, TOOL_COUNT } from "@/lib/tools/registry";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Badge } from "@/components/ui/feedback";

export function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const [previousPath, setPreviousPath] = React.useState(pathname);
  const counts = React.useMemo(() => categoryCounts(), []);

  // Close the mobile menu on navigation. React's documented pattern for
  // adjusting state when a value changes: runs during render, so there is no
  // extra effect pass and no cascading re-render.
  if (previousPath !== pathname) {
    setPreviousPath(pathname);
    setOpen(false);
  }

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full border-b transition-all duration-300",
        scrolled
          ? "border-line bg-canvas/85 backdrop-blur-xl supports-[backdrop-filter]:bg-canvas/70"
          : "border-transparent bg-canvas",
      )}
    >
      <div className="hidden border-b border-line/70 bg-surface-2/60 lg:block">
        <div className="container-page flex h-9 items-center justify-between text-xs text-ink-muted">
          <p className="flex items-center gap-2">
            <ShieldCheck className="size-3.5 text-success" />
            {TOOL_COUNT} tools · files never leave your browser · no accounts, no uploads
          </p>
          <div className="flex items-center gap-4">
            <Link href="/how-it-works" className="transition-colors hover:text-ink">
              How it works
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-ink">
              Privacy
            </Link>
          </div>
        </div>
      </div>

      <div className="container-page flex h-16 items-center justify-between gap-4">
        <Link href="/" className="group flex items-center gap-2.5" aria-label="BrowserForge home">
          <span className="relative flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-accent text-white shadow-card transition-transform group-hover:scale-105">
            <Sparkles className="size-4.5" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-base font-semibold tracking-tight text-ink">BrowserForge</span>
            <span className="hidden text-[11px] text-ink-muted sm:block">
              {TOOL_COUNT} offline tools
            </span>
          </span>
        </Link>

        <nav aria-label="Tool categories" className="hidden items-center gap-1 lg:flex">
          {categories.map((category) => {
            const isActive = pathname.startsWith(`/categories/${category.id}`);
            return (
              <Link
                key={category.id}
                href={`/categories/${category.id}`}
                className={cn(
                  "group relative rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "text-brand" : "text-ink-soft hover:text-ink",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {category.name.replace(" Tools", "")}
                  <span className="text-[11px] font-normal text-ink-muted">{counts[category.id]}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="secondary" size="sm" className="hidden sm:inline-flex">
            <Link href="/tools">
              <Search className="size-4" />
              All tools
            </Link>
          </Button>
          <div className="hidden md:block">
            <ThemeToggle />
          </div>
          <div className="md:hidden">
            <ThemeToggle compact />
          </div>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex size-10 items-center justify-center rounded-lg border border-line bg-surface text-ink-soft transition-colors hover:text-ink lg:hidden"
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open ? (
          <motion.div
            id="mobile-nav"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-line bg-surface lg:hidden"
          >
            <div className="container-page flex flex-col gap-2 py-4">
              {categories.map((category) => (
                <Link
                  key={category.id}
                  href={`/categories/${category.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/60 px-3 py-3"
                >
                  <span className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <category.icon className="size-4" />
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium text-ink">{category.name}</span>
                      <span className="text-xs text-ink-muted">{category.tagline}</span>
                    </span>
                  </span>
                  <Badge tone="neutral">{counts[category.id]}</Badge>
                </Link>
              ))}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button asChild variant="secondary">
                  <Link href="/tools">All tools</Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/privacy">Privacy</Link>
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
