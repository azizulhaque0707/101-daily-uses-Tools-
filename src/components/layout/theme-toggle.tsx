"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Laptop, Moon, Sun } from "lucide-react";
import { SegmentedControl } from "@/components/ui/form-controls";
import { Tooltip } from "@/components/ui/overlay";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme, resolvedTheme } = useTheme();

  if (compact) {
    // Icons are swapped by the `.dark` class that next-themes writes onto
    // <html>, so no mounted flag is needed and there is no hydration flash.
    return (
      <Tooltip
        label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        <button
          type="button"
          aria-label="Toggle colour theme"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="inline-flex size-10 items-center justify-center rounded-lg border border-line bg-surface text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
        >
          <Sun className="hidden size-4 dark:block" aria-hidden />
          <Moon className="size-4 dark:hidden" aria-hidden />
        </button>
      </Tooltip>
    );
  }

  const active = (theme === "light" || theme === "dark" ? theme : "system") as
    | "light"
    | "dark"
    | "system";

  return (
    <SegmentedControl
      label="Colour theme"
      value={active}
      onChange={(value) => setTheme(value)}
      options={[
        { value: "light", label: "Light", icon: <Sun className="size-3.5" /> },
        { value: "dark", label: "Dark", icon: <Moon className="size-3.5" /> },
        { value: "system", label: "System", icon: <Laptop className="size-3.5" /> },
      ]}
    />
  );
}
