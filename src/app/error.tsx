"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[BrowserForge]", error);
  }, [error]);

  return (
    <div className="container-page flex min-h-[60vh] items-center justify-center py-24">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-danger/10 text-danger">
          <AlertTriangle className="size-6" />
        </span>
        <h1 className="mt-5 text-xl font-semibold text-ink">Something went wrong</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          The page failed to render. Your files were never uploaded, so nothing was lost — retry
          or head back to the tool library.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-xs text-ink-muted">Reference: {error.digest}</p>
        ) : null}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button onClick={reset}>
            <RotateCcw className="size-4" />
            Try again
          </Button>
          <Button asChild variant="secondary">
            <Link href="/tools">Browse all tools</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
