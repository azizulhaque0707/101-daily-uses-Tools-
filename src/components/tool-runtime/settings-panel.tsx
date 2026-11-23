"use client";

import type { ToolOption, ToolOptionValue } from "@/lib/tools/types";
import { ColorInput, Input, Select, Slider, Textarea, Toggle } from "@/components/ui/form-controls";

export function SettingsPanel({
  options,
  values,
  onChange,
}: {
  options: ToolOption[];
  values: Record<string, ToolOptionValue>;
  onChange: (id: string, value: ToolOptionValue) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {options.map((option) => {
        const value = values[option.id];

        switch (option.type) {
          case "number":
            return (
              <div key={option.id} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor={option.id} className="text-sm font-medium text-ink">
                    {option.label}
                  </label>
                  <span className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink">
                    {typeof value === "number" ? value : option.default}
                    {option.unit ? ` ${option.unit}` : ""}
                  </span>
                </div>
                <Slider
                  id={option.id}
                  value={[typeof value === "number" ? value : option.default]}
                  min={option.min}
                  max={option.max}
                  step={option.step ?? 1}
                  onValueChange={(next) => onChange(option.id, next[0])}
                  aria-label={option.label}
                />
                {option.help ? (
                  <p className="text-xs leading-relaxed text-ink-muted">{option.help}</p>
                ) : null}
              </div>
            );

          case "select":
            return (
              <div key={option.id} className="flex flex-col gap-2">
                <label htmlFor={option.id} className="text-sm font-medium text-ink">
                  {option.label}
                </label>
                <Select
                  id={option.id}
                  value={typeof value === "string" ? value : option.default}
                  onChange={(event) => onChange(option.id, event.target.value)}
                >
                  {option.choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </Select>
                {option.help ? (
                  <p className="text-xs leading-relaxed text-ink-muted">{option.help}</p>
                ) : null}
              </div>
            );

          case "toggle":
            return (
              <Toggle
                key={option.id}
                label={option.label}
                description={option.help}
                checked={typeof value === "boolean" ? value : option.default}
                onCheckedChange={(next) => onChange(option.id, next)}
              />
            );

          case "color":
            return (
              <div key={option.id} className="flex flex-col gap-2">
                <label htmlFor={option.id} className="text-sm font-medium text-ink">
                  {option.label}
                </label>
                <ColorInput
                  id={option.id}
                  aria-label={option.label}
                  value={typeof value === "string" ? value : option.default}
                  onChange={(event) => onChange(option.id, event.target.value)}
                />
                {option.help ? (
                  <p className="text-xs leading-relaxed text-ink-muted">{option.help}</p>
                ) : null}
              </div>
            );

          default:
            return (
              <div key={option.id} className="flex flex-col gap-2">
                <label htmlFor={option.id} className="text-sm font-medium text-ink">
                  {option.label}
                </label>
                <Textarea
                  id={option.id}
                  rows={option.id.toLowerCase().includes("textb") ? 10 : 3}
                  value={typeof value === "string" ? value : option.default}
                  placeholder={option.placeholder}
                  onChange={(event) => onChange(option.id, event.target.value)}
                  className="font-mono text-xs"
                />
                {option.help ? (
                  <p className="text-xs leading-relaxed text-ink-muted">{option.help}</p>
                ) : null}
              </div>
            );
        }
      })}
    </div>
  );
}

export function NumberField({ value }: { value: number }) {
  return <Input readOnly value={value} />;
}
