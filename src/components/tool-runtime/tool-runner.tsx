"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Cpu, Play, RotateCcw, Settings2, Sparkles } from "lucide-react";
import type { ToolOptionValue } from "@/lib/tools/types";
import { ToolError } from "@/lib/tools/types";
import { runTool, type EngineResult } from "@/lib/processing";
import type { ToolRuntimeConfig } from "@/lib/tools/runtime-config";
import { UploadBox, FilePreview } from "@/components/tool-runtime/upload-box";
import { SettingsPanel } from "@/components/tool-runtime/settings-panel";
import {
  ArtifactPreview,
  ErrorMessage,
  ProcessingIndicator,
  ResultEmptyState,
  ResultPanel,
} from "@/components/tool-runtime/run-feedback";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlay";

/** Radix tab values used by the runner. */
type TabKey = "input" | "settings" | "result";

export function ToolRunner({ tool }: { tool: ToolRuntimeConfig }) {
  const [files, setFiles] = React.useState<File[]>([]);
  const [text, setText] = React.useState(tool.textInput?.default ?? "");
  const [values, setValues] = React.useState<Record<string, ToolOptionValue>>(() =>
    Object.fromEntries(tool.options.map((option) => [option.id, option.default])),
  );
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState({ value: 0, label: "" });
  const [result, setResult] = React.useState<EngineResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<TabKey>("input");

  const needsFile = Boolean(tool.fileInput);
  const needsText = Boolean(tool.textInput);
  const hasFiles = files.length > 0;
  const hasText = text.trim().length > 0;
  const canRun = busy ? false : needsFile ? hasFiles : needsText ? hasText : true;

  const setOption = (id: string, value: ToolOptionValue) => {
    setValues((current) => ({ ...current, [id]: value }));
  };

  const reset = () => {
    setTab("input");
    setFiles([]);
    setText(tool.textInput?.default ?? "");
    setValues(Object.fromEntries(tool.options.map((option) => [option.id, option.default])));
    setResult(null);
    setError(null);
    setProgress({ value: 0, label: "" });
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ value: 4, label: "Preparing" });
    // Jump straight to the outcome so users never wonder where the result went.
    setTab("result");
    try {
      const output = await runTool(tool, {
        files,
        text,
        options: values,
        report: (value, label) => setProgress({ value, label: label ?? "" }),
      });
      setResult(output);
      setTab("result");
    } catch (runError) {
      if (runError instanceof ToolError) setError(runError.message);
      else setError(runError instanceof Error ? runError.message : "Something went wrong.");
    } finally {
      setBusy(false);
      setProgress({ value: 0, label: "" });
    }
  };

  const hasSettings = tool.options.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} className="w-full">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="input">
              <Sparkles className="size-3.5" />
              Input
            </TabsTrigger>
            {hasSettings ? (
              <TabsTrigger value="settings">
                <Settings2 className="size-3.5" />
                Settings
                <span className="ml-1 rounded-full bg-surface-3 px-1.5 text-[10px]">{tool.options.length}</span>
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="result">
              <Cpu className="size-3.5" />
              Result
            </TabsTrigger>
          </TabsList>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
            <Button onClick={run} disabled={!canRun} loading={busy}>
              <Play className="size-4" />
              {busy ? "Processing…" : "Run tool"}
            </Button>
          </div>
        </div>

        <TabsContent value="input" className="mt-4">
          <div className="flex flex-col gap-5">
            {tool.fileInput ? (
              <UploadBox
                accept={tool.fileInput.accept}
                multiple={tool.fileInput.multiple}
                label={tool.fileInput.label}
                hint={tool.fileInput.hint}
                files={files}
                onFiles={setFiles}
                onClear={() => setFiles([])}
              />
            ) : null}

            {tool.fileInput ? (
              <FilePreview
                files={files}
                onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
              />
            ) : null}

            {tool.textInput ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="tool-text" className="text-sm font-medium text-ink">
                  {tool.textInput.label}
                </label>
                <textarea
                  id="tool-text"
                  value={text}
                  rows={tool.textInput.rows ?? 8}
                  placeholder={tool.textInput.placeholder}
                  onChange={(event) => setText(event.target.value)}
                  className="min-h-32 w-full resize-y rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-ink shadow-soft transition-colors placeholder:text-ink-muted focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                />
              </div>
            ) : null}

            {tool.limitation ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3.5">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <p className="text-xs leading-relaxed text-ink-soft">{tool.limitation}</p>
              </div>
            ) : null}

            {hasSettings ? (
              <details className="rounded-xl border border-line bg-surface p-4 lg:hidden">
                <summary className="cursor-pointer text-sm font-medium text-ink">Settings</summary>
                <div className="mt-4">
                  <SettingsPanel options={tool.options} values={values} onChange={setOption} />
                </div>
              </details>
            ) : null}
          </div>
        </TabsContent>

        {hasSettings ? (
          <TabsContent value="settings" className="mt-4">
            <div className="rounded-xl border border-line bg-surface p-5">
              <SettingsPanel options={tool.options} values={values} onChange={setOption} />
            </div>
          </TabsContent>
        ) : null}

        <TabsContent value="result" className="mt-4">
          <div className="flex flex-col gap-5">
            {busy ? (
              <ProcessingIndicator
                progress={progress.value}
                label={progress.label || "Processing locally"}
              />
            ) : null}

            {error ? <ErrorMessage message={error} onRetry={run} /> : null}

            {result ? (
              <div className="flex flex-col gap-5">
                <ArtifactPreview artifacts={result.artifacts} />
                <ResultPanel result={result} />
              </div>
            ) : !busy && !error ? (
              <ResultEmptyState />
            ) : null}
          </div>
        </TabsContent>
      </Tabs>

      {busy ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-ink-muted"
        >
          <Cpu className="size-3.5 text-brand" aria-hidden />
          Processing happens on this device. Closing the tab clears everything.
        </motion.div>
      ) : null}
    </div>
  );
}
