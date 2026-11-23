import Link from "next/link";
import { Compass, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { popularTools } from "@/lib/tools/registry";

export default function NotFound() {
  const suggestions = popularTools(6);

  return (
    <div className="container-page flex min-h-[70vh] items-center justify-center py-24">
      <div className="w-full max-w-xl text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <Compass className="size-7" />
        </span>
        <p className="mt-6 font-mono text-xs uppercase tracking-[0.3em] text-ink-muted">
          Error 404
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink">
          This tool does not exist
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-soft">
          The page you were looking for moved or never existed. Try one of these instead.
        </p>
        <div className="mt-7 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild size="lg">
            <Link href="/tools">
              <Search className="size-4" />
              Search all tools
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href="/">Back to home</Link>
          </Button>
        </div>
        <ul className="mt-10 flex flex-wrap justify-center gap-2">
          {suggestions.map((tool) => (
            <li key={tool.slug}>
              <Link
                href={`/tools/${tool.slug}`}
                className="inline-flex rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-brand hover:text-brand"
              >
                {tool.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
