"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Crop, Download, FileText, Loader2, RotateCw, Trash2, Undo2 } from "lucide-react";
import { PDFDocument, degrees } from "pdf-lib";
import { renderThumbnails, type PageThumb } from "@/lib/processing/pdf-render";
import { downloadBlob, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/feedback";
import { UploadBox } from "@/components/tool-runtime/upload-box";
import { ErrorMessage } from "@/components/tool-runtime/run-feedback";

type PageState = { id: string; source: number; rotation: number; thumb: PageThumb };

/**
 * Drag-and-drop page organizer.
 *
 * Thumbnails are rendered lazily through PDF.js, and the export rebuilds the
 * document by copying pages from the source in the new order, so page content
 * is never re-encoded.
 */
export function PdfPageOrganizer({ onProgress }: { onProgress?: (v: number, label?: string) => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [bytes, setBytes] = React.useState<ArrayBuffer | null>(null);
  const [pages, setPages] = React.useState<PageState[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [history, setHistory] = React.useState<PageState[][]>([]);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const load = async (selected: File) => {
    setError(null);
    setNote(null);
    setLoading(true);
    setPages([]);
    setHistory([]);
    try {
      const buffer = await selected.arrayBuffer();
      setFile(selected);
      setBytes(buffer);
      const thumbs = await renderThumbnails(buffer, {
        maxWidth: 200,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setPages(
        thumbs.map((thumb, index) => ({
          id: `p-${index}-${Math.random().toString(36).slice(2, 7)}`,
          source: index + 1,
          rotation: 0,
          thumb,
        })),
      );
      setNote(`${thumbs.length} page${thumbs.length === 1 ? "" : "s"} loaded. Drag any page to reorder it.`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "This PDF could not be opened.");
    } finally {
      setLoading(false);
    }
  };

  const snapshot = () => setHistory((current) => [...current.slice(-19), pages]);

  const move = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    snapshot();
    setPages((current) => {
      const from = current.findIndex((page) => page.id === fromId);
      const to = current.findIndex((page) => page.id === toId);
      if (from === -1 || to === -1) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const remove = (id: string) => {
    snapshot();
    setPages((current) => current.filter((page) => page.id !== id));
  };

  const rotate = (id: string) => {
    snapshot();
    setPages((current) =>
      current.map((page) => (page.id === id ? { ...page, rotation: (page.rotation + 90) % 360 } : page)),
    );
  };

  const undo = () => {
    setHistory((current) => {
      if (!current.length) return current;
      setPages(current[current.length - 1]);
      return current.slice(0, -1);
    });
  };

  const reverse = () => {
    snapshot();
    setPages((current) => [...current].reverse());
  };

  const duplicateFirst = () => {
    snapshot();
    setPages((current) => (current.length ? [...current, current[0]] : current));
  };

  const exportPdf = async () => {
    if (!bytes || pages.length === 0) {
      setError("Load a PDF and keep at least one page before exporting.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const target = await PDFDocument.create();
      target.setProducer("BrowserForge (client-side)");

      // Copy in the new order; duplicate entries are copied independently.
      const indices = pages.map((page) => page.source - 1);
      const copied = await target.copyPages(source, indices);
      copied.forEach((page, index) => {
        const wanted = pages[index].rotation;
        if (wanted) page.setRotation(degrees(wanted));
        target.addPage(page);
      });

      const output = await target.save({ useObjectStreams: true });
      downloadBlob(new Blob([output as unknown as BlobPart], { type: "application/pdf" }), "organised.pdf");
      setNote(`Exported ${pages.length} pages. Nothing was uploaded — the file was rebuilt on this device.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {!bytes ? (
        <UploadBox
          accept="application/pdf,.pdf"
          multiple={false}
          label="Drop a PDF to organise"
          hint="Pages are rendered locally as thumbnails"
          files={file ? [file] : []}
          onFiles={(selected) => selected[0] && load(selected[0])}
          onClear={() => setFile(null)}
        />
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-5">
          <div className="flex items-center gap-3">
            <Loader2 className="size-5 animate-spin text-brand" aria-hidden />
            <p className="text-sm font-semibold text-ink">Rendering page thumbnails…</p>
            <span className="ml-auto font-mono text-sm text-brand">
              {progress.done}/{progress.total}
            </span>
          </div>
          <Progress
            value={progress.total ? (progress.done / progress.total) * 100 : 0}
            label="Thumbnail progress"
          />
        </div>
      ) : null}

      {error ? <ErrorMessage message={error} /> : null}

      {note ? (
        <p className="rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-xs text-ink-soft">{note}</p>
      ) : null}

      {pages.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
            <span className="mr-auto text-sm text-ink-soft">
              <span className="font-semibold text-ink">{pages.length}</span> pages ·{" "}
              {pages.filter((page) => page.rotation !== 0).length} rotated
            </span>
            <Button variant="secondary" size="sm" onClick={undo} disabled={history.length === 0}>
              <Undo2 className="size-3.5" />
              Undo
            </Button>
            <Button variant="secondary" size="sm" onClick={reverse}>
              Reverse
            </Button>
            <Button variant="secondary" size="sm" onClick={duplicateFirst}>
              Duplicate first
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setBytes(null)}>
              Close
            </Button>
          </div>

          <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {pages.map((page, index) => (
              <motion.li
                key={page.id}
                layout
                draggable
                onDragStart={() => setDragging(page.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging) move(dragging, page.id);
                }}
                className={cn(
                  "group relative flex cursor-grab flex-col gap-2 rounded-lg border bg-surface p-2 shadow-soft transition-all active:cursor-grabbing",
                  dragging === page.id ? "border-brand opacity-60" : "border-line hover:border-brand/50",
                )}
              >
                <span className="absolute left-2 top-2 z-10 flex size-5 items-center justify-center rounded-full bg-ink text-[10px] font-bold text-canvas">
                  {index + 1}
                </span>
                <div className="relative overflow-hidden rounded-md bg-surface-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.thumb.dataUrl}
                    alt={`Page ${page.source}`}
                    className="w-full transition-transform duration-200"
                    style={{ transform: `rotate(${page.rotation}deg)` }}
                    draggable={false}
                  />
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
                    {Math.round(page.thumb.width)}×{Math.round(page.thumb.height)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] text-ink-muted">source p.{page.source}</span>
                  <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      aria-label={`Rotate page ${index + 1}`}
                      onClick={() => rotate(page.id)}
                      className="flex size-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <RotateCw className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete page ${index + 1}`}
                      onClick={() => remove(page.id)}
                      className="flex size-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                </div>
              </motion.li>
            ))}
          </ol>

          <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 p-4 shadow-lift backdrop-blur">
            <p className="text-sm text-ink-soft">
              {pages.length} page{pages.length === 1 ? "" : "s"} in the new order
            </p>
            <Button onClick={exportPdf} loading={busy} disabled={pages.length === 0}>
              <Download className="size-4" />
              Export organised PDF
            </Button>
          </div>
        </>
      ) : null}

      {file && !loading && pages.length === 0 && !error ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-line bg-surface-2/40 px-4 py-8 text-sm text-ink-muted">
          <FileText className="size-4" aria-hidden />
          No pages left. Use Undo to restore them.
        </p>
      ) : null}

      <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
        <Crop className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Thumbnails are rendered by PDF.js on this device and the export copies pages without re-encoding, so quality is
        preserved.
      </p>
      {onProgress ? null : null}
    </div>
  );
}
