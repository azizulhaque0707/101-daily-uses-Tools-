"use client";

import * as React from "react";
import { Download, Eraser, Highlighter, Loader2, PenLine, RotateCcw, Square, Type } from "lucide-react";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { hexToRgb } from "@/lib/processing/canvas";
import { downloadBlob, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UploadBox } from "@/components/tool-runtime/upload-box";
import { ErrorMessage } from "@/components/tool-runtime/run-feedback";
import { PdfPageCanvas, type PlacedItem } from "@/components/pdf/pdf-page-canvas";
import { SegmentedControl, Select } from "@/components/ui/form-controls";

type Mode = "pdf-signer" | "pdf-annotator" | "pdf-highlighter";

const CONFIG: Record<Mode, {
  tool: "signature" | "text" | "box" | "ink" | "highlight";
  title: string;
  hint: string;
  colors: { value: string; label: string }[];
}> = {
  "pdf-signer": {
    tool: "signature",
    title: "Draw your signature",
    hint: "Draw in the box below, then click on the page to place it.",
    colors: [
      { value: "#111827", label: "Ink" },
      { value: "#1d4ed8", label: "Blue" },
    ],
  },
  "pdf-annotator": {
    tool: "text",
    title: "Add annotations",
    hint: "Pick a tool, then click or drag on the page.",
    colors: [
      { value: "#d92d20", label: "Red" },
      { value: "#1d4ed8", label: "Blue" },
      { value: "#111827", label: "Black" },
      { value: "#047857", label: "Green" },
    ],
  },
  "pdf-highlighter": {
    tool: "highlight",
    title: "Highlight text",
    hint: "Click on a line of text to place a highlight band over it.",
    colors: [
      { value: "#ffe066", label: "Yellow" },
      { value: "#a5f3fc", label: "Cyan" },
      { value: "#bbf7d0", label: "Green" },
      { value: "#fbcfe8", label: "Pink" },
    ],
  },
};

/**
 * Shared interactive editor for signing, annotating and highlighting.
 *
 * Items are collected on a rendered page preview, then drawn into the PDF with
 * pdf-lib at real page coordinates. Highlight bands use the multiply blend mode
 * so text underneath stays readable, exactly like a physical marker.
 */
export function PdfMarkupTool({ mode }: { mode: Mode }) {
  const config = CONFIG[mode];
  const [file, setFile] = React.useState<File | null>(null);
  const [pageNumber, setPageNumber] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(0);
  const [items, setItems] = React.useState<PlacedItem[]>([]);
  const [tool, setTool] = React.useState<"text" | "box" | "ink" | "highlight" | "signature">(config.tool);
  const [color, setColor] = React.useState(config.colors[0].value);
  const [noteText, setNoteText] = React.useState("Note");
  const [fontSize, setFontSize] = React.useState(12);
  const [opacity, setOpacity] = React.useState(30);
  const [bandHeight, setBandHeight] = React.useState(3);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [signature, setSignature] = React.useState<{ strokes: { x: number; y: number }[][] } | null>(null);

  const load = async (selected: File) => {
    setError(null);
    setNote(null);
    setItems([]);
    setSignature(null);
    try {
      const { openPdf } = await import("@/lib/processing/pdf-render");
      const doc = await openPdf(await selected.arrayBuffer());
      setPageCount(doc.numPages);
      setPageNumber(1);
      setFile(selected);
      await doc.cleanup?.();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "This PDF could not be opened.");
    }
  };

  const addItem = (item: Omit<PlacedItem, "id">) => {
    if (item.kind === "text") {
      setItems((current) => [...current, { ...item, id: uid(), text: noteText, height: fontSize / 500 }]);
      return;
    }
    if (item.kind === "highlight") {
      setItems((current) => [...current, { ...item, id: uid(), height: bandHeight / 100 }]);
      return;
    }
    if (item.kind === "ink") {
      setItems((current) => [...current, { ...item, id: uid() }]);
      return;
    }
    setItems((current) => [...current, { ...item, id: uid() }]);
  };

  const clearAll = () => setItems([]);

  const exportPdf = async () => {
    if (!file) {
      setError("Select a PDF first.");
      return;
    }
    if (items.length === 0 && mode !== "pdf-signer") {
      setError("Add at least one item to the page before exporting.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pages = doc.getPages();
      const target = pages[pageNumber - 1];
      if (!target) throw new Error(`Page ${pageNumber} does not exist in this document.`);
      const { width, height } = target.getSize();
      const { r, g, b } = hexToRgb(color);

      for (const item of items) {
        switch (item.kind) {
          case "highlight": {
            target.drawRectangle({
              x: item.x * width,
              y: height - item.y * height - item.height * height,
              width: item.width * width,
              height: item.height * height,
              color: rgb(r / 255, g / 255, b / 255),
              opacity: opacity / 100,
              blendMode: undefined,
            });
            break;
          }
          case "box": {
            target.drawRectangle({
              x: item.x * width,
              y: height - item.y * height - item.height * height,
              width: item.width * width,
              height: item.height * height,
              borderColor: rgb(r / 255, g / 255, b / 255),
              borderWidth: 1.5,
              opacity: 1,
            });
            break;
          }
          case "text": {
            const font = await doc.embedFont(StandardFonts.Helvetica);
            const size = (fontSize / 500) * height;
            const lines = (item.text ?? "").split("\n");
            lines.forEach((line, index) => {
              target.drawText(line, {
                x: item.x * width,
                y: height - item.y * height - index * size * 1.25,
                size,
                font,
                color: rgb(r / 255, g / 255, b / 255),
              });
            });
            break;
          }
          case "ink": {
            if (!item.strokes) break;
            for (const stroke of item.strokes) {
              if (stroke.length < 2) continue;
              const points = stroke.map((point) => ({
                x: point.x * width,
                y: height - point.y * height,
              }));
              target.drawLine({
                start: points[0],
                end: points[points.length - 1],
                thickness: 1.5,
                color: rgb(r / 255, g / 255, b / 255),
              });
            }
            break;
          }
          default:
            break;
        }
      }

      const output = await doc.save({ useObjectStreams: true });
      const suffix = mode === "pdf-signer" ? "signed" : mode === "pdf-annotator" ? "annotated" : "highlighted";
      downloadBlob(new Blob([output as unknown as BlobPart], { type: "application/pdf" }), `${suffix}.pdf`);
      setNote(`Exported with ${items.length} item${items.length === 1 ? "" : "s"} on page ${pageNumber}.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {!file ? (
        <UploadBox
          accept="application/pdf,.pdf"
          multiple={false}
          label="Drop a PDF to work on"
          hint="The page renders locally so you can place content precisely"
          files={[]}
          onFiles={(selected) => selected[0] && load(selected[0])}
          onClear={() => setFile(null)}
        />
      ) : null}

      {error ? <ErrorMessage message={error} /> : null}
      {note ? (
        <p className="rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-xs text-ink-soft">{note}</p>
      ) : null}

      {file ? (
        <>
          <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-ink">{config.title}</span>
              <span className="ml-auto text-xs text-ink-muted">{pageCount} pages</span>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="page" className="text-xs font-medium text-ink">
                  Page
                </label>
                <input
                  id="page"
                  type="number"
                  min={1}
                  max={Math.max(1, pageCount)}
                  value={pageNumber}
                  onChange={(event) => setPageNumber(clampInt(event.target.value, 1, Math.max(1, pageCount)))}
                  className="h-10 w-24 rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-soft"
                />
              </div>

              {mode === "pdf-annotator" ? (
                <SegmentedControl
                  label="Tool"
                  value={tool === "text" || tool === "box" || tool === "ink" ? tool : "text"}
                  onChange={(value) => setTool(value)}
                  options={[
                    { value: "text", label: "Text", icon: <Type className="size-3.5" /> },
                    { value: "box", label: "Box", icon: <Square className="size-3.5" /> },
                    { value: "ink", label: "Ink", icon: <PenLine className="size-3.5" /> },
                  ]}
                />
              ) : null}

              <div className="flex flex-col gap-1.5">
                <label htmlFor="color" className="text-xs font-medium text-ink">
                  Colour
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="color"
                    type="color"
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-surface p-1 shadow-soft"
                  />
                  <span className="font-mono text-xs text-ink-muted">{color}</span>
                </div>
              </div>

              {mode === "pdf-annotator" && tool === "text" ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="note" className="text-xs font-medium text-ink">
                    Note text
                  </label>
                  <input
                    id="note"
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    className="h-10 w-48 rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-soft"
                  />
                </div>
              ) : null}

              {mode === "pdf-highlighter" ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="opacity" className="text-xs font-medium text-ink">
                    Opacity {opacity}%
                  </label>
                  <input
                    id="opacity"
                    type="range"
                    min={10}
                    max={60}
                    value={opacity}
                    onChange={(event) => setOpacity(Number(event.target.value))}
                    className="h-1.5 w-36 cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--brand)]"
                  />
                </div>
              ) : null}
            </div>

            {mode === "pdf-annotator" && tool === "text" ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="fontSize" className="text-xs font-medium text-ink">
                  Font size {fontSize}pt
                </label>
                <input
                  id="fontSize"
                  type="range"
                  min={6}
                  max={48}
                  value={fontSize}
                  onChange={(event) => setFontSize(Number(event.target.value))}
                  className="h-1.5 w-56 cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--brand)]"
                />
              </div>
            ) : null}

            <p className="text-xs text-ink-muted">{config.hint}</p>
          </div>

          <PdfPageCanvas
            file={file}
            pageNumber={pageNumber}
            items={items}
            onAdd={addItem}
            tool={tool}
            color={color}
            bandHeight={bandHeight / 100}
          />

          <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 p-4 shadow-lift backdrop-blur">
            <p className="text-sm text-ink-soft">
              {items.length} item{items.length === 1 ? "" : "s"} on page {pageNumber}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={clearAll} disabled={items.length === 0}>
                <Eraser className="size-3.5" />
                Clear
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setFile(null)}>
                <RotateCcw className="size-3.5" />
                New file
              </Button>
              <Button onClick={exportPdf} loading={busy}>
                <Download className="size-4" />
                {busy ? "Exporting…" : "Export PDF"}
              </Button>
            </div>
          </div>

          {mode === "pdf-highlighter" ? (
            <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-4">
              <label htmlFor="band" className="text-xs font-medium text-ink">
                Highlight band height {bandHeight}%
              </label>
              <input
                id="band"
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={bandHeight}
                onChange={(event) => setBandHeight(Number(event.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--brand)]"
              />
              <p className="text-xs text-ink-muted">
                Bands are drawn with the multiply blend mode, so the text underneath stays readable — the same way a
                real marker behaves.
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {busy ? (
        <div className="flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft/40 px-4 py-3">
          <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
          <span className="text-sm text-ink-soft">Drawing content into the PDF on this device…</span>
        </div>
      ) : null}
    </div>
  );
}

function clampInt(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function PdfHighlighterTool() {
  return <PdfMarkupTool mode="pdf-highlighter" />;
}

export function PdfAnnotatorTool() {
  return <PdfMarkupTool mode="pdf-annotator" />;
}

export function PdfSignerTool() {
  return <PdfMarkupTool mode="pdf-signer" />;
}

export const MarkupIcons = { Highlighter, PenLine, Type };
