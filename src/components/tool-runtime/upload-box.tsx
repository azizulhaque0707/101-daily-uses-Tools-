"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FileText, ImageUp, Trash2, UploadCloud, X } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function UploadBox({
  accept,
  multiple,
  label,
  hint,
  files,
  onFiles,
  onClear,
  className,
}: {
  accept?: string;
  multiple?: boolean;
  label: string;
  hint?: string;
  files: File[];
  onFiles: (files: File[]) => void;
  onClear: () => void;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length > 0) onFiles(multiple ? [...files, ...dropped] : dropped.slice(0, 1));
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-all",
          dragging
            ? "border-brand bg-brand-soft"
            : "border-line bg-surface-2/40 hover:border-brand/50 hover:bg-surface",
        )}
      >
        <span
          className={cn(
            "flex size-12 items-center justify-center rounded-xl transition-transform",
            dragging ? "bg-brand text-white" : "bg-surface text-brand shadow-soft group-hover:scale-105",
          )}
        >
          <UploadCloud className="size-6" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-ink">{label}</p>
          <p className="text-xs text-ink-muted">
            {hint ?? "Drag and drop, or click to browse — files stay on this device"}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="sr-only"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            if (selected.length > 0) onFiles(multiple ? [...files, ...selected] : selected.slice(0, 1));
            event.target.value = "";
          }}
        />
      </div>

      {files.length > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2">
          <p className="text-xs text-ink-muted">
            {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(files.reduce((total, file) => total + file.size, 0))} · never uploaded
          </p>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="xs" onClick={() => inputRef.current?.click()}>
              <ImageUp className="size-3.5" />
              Add
            </Button>
            <Button variant="ghost" size="xs" onClick={onClear}>
              <Trash2 className="size-3.5" />
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function FilePreview({ files, onRemove }: { files: File[]; onRemove?: (index: number) => void }) {
  const [previews, setPreviews] = React.useState<Record<string, string>>({});

  // Object URLs are an external resource: they must be created after mount and
  // revoked on change, otherwise they leak. That lifecycle only fits an effect,
  // so the resulting state is written here rather than derived during render.
  React.useEffect(() => {
    const images = files.filter((file) => file.type.startsWith("image/")).slice(0, 24);
    const urls: Record<string, string> = {};
    images.forEach((file) => {
      urls[file.name + file.size] = URL.createObjectURL(file);
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URLs need effect-scoped create/revoke
    setPreviews(urls);
    return () => {
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  if (files.length === 0) return null;

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      <AnimatePresence initial={false}>
        {files.map((file, index) => {
          const preview = previews[file.name + file.size];
          return (
            <motion.li
              key={`${file.name}-${file.size}-${index}`}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface p-2.5"
            >
              <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2">
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="" className="size-full object-cover" />
                ) : (
                  <FileText className="size-4 text-ink-muted" aria-hidden />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-ink">{file.name}</span>
                <span className="text-xs text-ink-muted">
                  {formatBytes(file.size)}
                  {file.type ? ` · ${file.type.replace("image/", "").replace("application/", "")}` : ""}
                </span>
              </span>
              {onRemove ? (
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onRemove(index)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-danger"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line bg-surface-2/40 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-surface text-ink-muted shadow-soft">
        {icon ?? <FileText className="size-6" aria-hidden />}
      </span>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-ink-soft">{description}</p>
      {action}
    </div>
  );
}
