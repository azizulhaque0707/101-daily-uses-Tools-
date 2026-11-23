import Link from "next/link";
import { Code2, Heart, Lock, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { categories, categoryCounts, popularTools, TOOL_COUNT } from "@/lib/tools/registry";
import { Badge } from "@/components/ui/feedback";

export function Footer() {
  const counts = categoryCounts();
  const popular = popularTools(6);
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-line bg-surface">
      <div className="container-page py-14">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="flex flex-col gap-4">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-accent text-white shadow-card">
                <Sparkles className="size-4.5" />
              </span>
              <span className="text-base font-semibold tracking-tight text-ink">BrowserForge</span>
            </Link>
            <p className="max-w-sm text-sm leading-relaxed text-ink-soft">
              {TOOL_COUNT} free browser tools for images, PDFs, documents, video, audio and
              everyday utilities. Every byte is processed on your own device.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success">
                <ShieldCheck className="size-3" />
                No uploads
              </Badge>
              <Badge tone="brand">
                <Lock className="size-3" />
                No tracking
              </Badge>
              <Badge tone="accent">
                <Zap className="size-3" />
                No sign-up
              </Badge>
            </div>
          </div>

          <FooterColumn
            title="Categories"
            links={categories.map((category) => ({
              label: `${category.name} (${counts[category.id]})`,
              href: `/categories/${category.id}`,
            }))}
          />

          <FooterColumn
            title="Popular tools"
            links={popular.map((tool) => ({ label: tool.name, href: `/tools/${tool.slug}` }))}
          />

          <FooterColumn
            title="Platform"
            links={[
              { label: "All tools", href: "/tools" },
              { label: "How it works", href: "/how-it-works" },
              { label: "Privacy", href: "/privacy" },
              { label: "FAQ", href: "/#faq" },
            ]}
          />
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-muted">
            © {year} BrowserForge. Built with Next.js, Web Workers and browser-native APIs.
          </p>
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            Made with <Heart className="size-3 text-danger" /> for people who care about privacy.
            <Code2 className="ml-2 size-3.5" />
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{title}</h3>
      <ul className="flex flex-col gap-2">
        {links.map((link) => (
          <li key={link.href + link.label}>
            <Link
              href={link.href}
              className="text-sm text-ink-soft transition-colors hover:text-brand"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
