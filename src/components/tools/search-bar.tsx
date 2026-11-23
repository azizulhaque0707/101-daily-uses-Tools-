"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOOL_COUNT } from "@/lib/tools/registry";

export function SearchBar({
  value,
  onChange,
  placeholder = `Search ${TOOL_COUNT} tools…`,
  className,
  autoFocus = false,
  shortcut = true,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  shortcut?: boolean;
  onSubmit?: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!shortcut) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcut]);

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 shadow-card transition-all",
        "focus-within:border-brand/60 focus-within:shadow-lift",
        className,
      )}
    >
      <Search aria-hidden className="size-5 shrink-0 text-ink-muted" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="Search tools"
        className="h-12 w-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted sm:h-14 sm:text-base"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-4" />
        </button>
      ) : (
        <kbd className="hidden shrink-0 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted sm:block">
          /
        </kbd>
      )}
    </form>
  );
}
