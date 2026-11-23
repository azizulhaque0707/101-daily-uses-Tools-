"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileArchive,
  Info,
  Loader2,
  PackageOpen,
  RotateCcw,
} from "lucide-react";
import type { EngineArtifact, EnginePreview, EngineResult, EngineStat } from "@/lib/tools/types";
import { downloadBlob, formatBytes, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/feedback";
import { EmptyState } from "@/components/tool-runtime/upload-box";

/* --------------------------- Processing indicator --------------------------- */

export function ProcessingIndicator({
  progress,
  label,
  indeterminate,
}: {
  progress: number;
  label?: string;
  indeterminate?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-5"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <Loader2 className="size-5 animate-spin text-brand" aria-hidden />
        <div className="flex flex-1 flex-col">
          <p className="text-sm font-semibold text-ink">{label ?? "Processing locally"}</p>
          <p className="text-xs text-ink-muted">
            Running in your browser — nothing is being uploaded.
          </p>
        </div>
        <span className="font-mono text-sm font-semibold text-brand">
          {indeterminate ? "…" : `${Math.round(progress)}%`}
        </span>
      </div>
      <Progress value={indeterminate ? 0 : progress} label="Processing progress" />
    </motion.div>
  );
}

/* ------------------------------ Error message ------------------------------ */

export function ErrorMessage({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-danger/40 bg-danger/5 p-5"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
        <div className="flex flex-1 flex-col gap-1">
          <p className="text-sm font-semibold text-ink">Could not finish</p>
          <p className="text-sm leading-relaxed text-ink-soft">{message}</p>
        </div>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="self-start">
          <RotateCcw className="size-3.5" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------ Download button ---------------------------- */

export function DownloadButton({
  artifact,
  variant = "primary",
  size = "md",
}: {
  artifact: EngineArtifact;
  variant?: "primary" | "secondary" | "soft";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => downloadBlob(artifact.blob, artifact.name)}
      className="group"
    >
      <Download className="size-4 transition-transform group-hover:translate-y-0.5" />
      Download {artifact.name.split(".").pop()?.toUpperCase() ?? "file"}
      <span className="ml-1 hidden text-xs opacity-70 sm:inline">
        {formatBytes(artifact.blob.size)}
      </span>
    </Button>
  );
}

export function DownloadAllButton({ artifacts }: { artifacts: EngineArtifact[] }) {
  const [busy, setBusy] = React.useState(false);

  if (artifacts.length < 2) return null;

  const downloadAll = async () => {
    setBusy(true);
    try {
      const { zip } = await import("fflate");
      const entries: Record<string, Uint8Array> = {};
      for (const artifact of artifacts) {
        entries[artifact.name] = new Uint8Array(await artifact.blob.arrayBuffer());
      }
      const buffer = await new Promise<Uint8Array>((resolve, reject) => {
        zip(entries, { level: 4 }, (error, data) => (error ? reject(error) : resolve(data)));
      });
      downloadBlob(new Blob([buffer.slice()], { type: "application/zip" }), "browserforge-output.zip");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="secondary" onClick={downloadAll} loading={busy}>
      <FileArchive className="size-4" />
      Download all {artifacts.length} files (.zip)
    </Button>
  );
}

/* -------------------------------- Result ----------------------------------- */

export function ResultPanel({ result }: { result: EngineResult }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-5 rounded-xl border border-success/40 bg-success/5 p-5"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <CheckCircle2 className="size-5 text-success" aria-hidden />
        <div className="flex flex-1 flex-col">
          <p className="text-sm font-semibold text-ink">
            Done — {result.artifacts.length} file{result.artifacts.length === 1 ? "" : "s"} ready
          </p>
          <p className="text-xs text-ink-muted">
            {formatBytes(result.artifacts.reduce((total, artifact) => total + artifact.blob.size, 0))} total · generated
            on this device
          </p>
        </div>
      </div>

      {result.stats && result.stats.length > 0 ? <StatGrid stats={result.stats} /> : null}

      {result.notice ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-xs leading-relaxed text-ink-soft">{result.notice}</p>
        </div>
      ) : null}

      {result.preview ? <PreviewBlock preview={result.preview} /> : null}

      <ArtifactList artifacts={result.artifacts} />

      <div className="flex flex-wrap gap-2.5 border-t border-line/70 pt-4">
        {result.artifacts.slice(0, 3).map((artifact) => (
          <DownloadButton key={artifact.name} artifact={artifact} />
        ))}
        <DownloadAllButton artifacts={result.artifacts} />
      </div>
    </motion.section>
  );
}

function StatGrid({ stats }: { stats: EngineStat[] }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-lg border border-line bg-surface p-3">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            {stat.label}
          </dt>
          <dd className="mt-0.5 truncate text-sm font-semibold text-ink" title={stat.value}>
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewBlock({ preview }: { preview: EnginePreview }) {
  if (preview.type === "stats") {
    return <StatGrid stats={preview.data} />;
  }
  const isJson = preview.type === "json";
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Preview</p>
      <pre
        className={cn(
          "max-h-80 overflow-auto rounded-lg border border-line bg-surface p-4 text-xs leading-relaxed text-ink-soft",
          isJson && "font-mono",
        )}
      >
        {preview.data}
      </pre>
    </div>
  );
}

function ArtifactList({ artifacts }: { artifacts: EngineArtifact[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {artifacts.slice(0, 8).map((artifact) => (
        <li
          key={artifact.name}
          className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-muted">
            <PackageOpen className="size-4" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-ink">{artifact.name}</span>
            <span className="text-xs text-ink-muted">
              {formatBytes(artifact.blob.size)}
              {artifact.note ? ` · ${artifact.note}` : ""}
            </span>
          </span>
          <Button variant="ghost" size="iconSm" aria-label={`Download ${artifact.name}`} onClick={() => downloadBlob(artifact.blob, artifact.name)}>
            <Download className="size-4" />
          </Button>
        </li>
      ))}
      {artifacts.length > 8 ? (
        <li className="text-xs text-ink-muted">+ {artifacts.length - 8} more files in the download bundle</li>
      ) : null}
    </ul>
  );
}

export function ArtifactPreview({ artifacts }: { artifacts: EngineArtifact[] }) {
  const image = artifacts.find((artifact) => artifact.kind === "image" && artifact.blob.type.startsWith("image/"));
  const audio = artifacts.find((artifact) => artifact.kind === "audio");
  const video = artifacts.find((artifact) => artifact.kind === "video");
  const [url, setUrl] = React.useState<string | null>(null);

  // Same rationale as FilePreview: an object URL is an external resource that
  // needs create/revoke lifecycle handling, which only an effect can provide.
  React.useEffect(() => {
    const target = image ?? audio ?? video;
    if (!target) return;
    const objectUrl = URL.createObjectURL(target.blob);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URLs need effect-scoped create/revoke
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image, audio, video]);

  if (!url) return null;

  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt="Processed output preview"
        className="max-h-96 w-full rounded-lg border border-line bg-surface-2 object-contain"
      />
    );
  }
  if (audio) {
    return <audio controls src={url} className="w-full" />;
  }
  return <video controls src={url} className="max-h-96 w-full rounded-lg border border-line bg-black" />;
}

export function ResultEmptyState() {
  return (
    <EmptyState
      icon={<PackageOpen className="size-6" aria-hidden />}
      title="No results yet"
      description="Add your files and settings, then run the tool. Your output will appear here with a download button."
    />
  );
}
