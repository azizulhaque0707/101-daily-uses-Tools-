"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { openPdf } from "@/lib/processing/pdf-render";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/feedback";

export type PlacedItem = {
  id: string;
  /** Normalised 0–1 coordinates relative to the rendered page. */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "text" | "box" | "ink" | "highlight" | "signature";
  text?: string;
  strokes?: { x: number; y: number }[][];
};

type RenderedPage = { pageNumber: number; dataUrl: string; width: number; height: number };

/**
 * Renders one PDF page and lets the user click or drag to place items.
 *
 * All coordinates are stored normalised (0–1), so the same item can be drawn
 * onto the real PDF at page scale without any conversion drift.
 */
export function PdfPageCanvas({
  file,
  pageNumber,
  items,
  onAdd,
  tool,
  className,
  color = "#d92d20",
  bandHeight = 0.03,
}: {
  file: File;
  pageNumber: number;
  items: PlacedItem[];
  onAdd: (item: Omit<PlacedItem, "id">) => void;
  tool: "text" | "box" | "ink" | "highlight" | "signature";
  className?: string;
  color?: string;
  bandHeight?: number;
}) {
  const [page, setPage] = React.useState<RenderedPage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [drawing, setDrawing] = React.useState<{ x: number; y: number }[] | null>(null);
  const [dragStart, setDragStart] = React.useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = React.useState<{ x: number; y: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const imageRef = React.useRef<HTMLImageElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const buffer = await file.arrayBuffer();
        const doc = await openPdf(buffer);
        const count = doc.numPages;
        if (pageNumber < 1 || pageNumber > count) {
          setError(`This document has ${count} pages. Page ${pageNumber} is out of range.`);
          await doc.cleanup?.();
          return;
        }
        const pdfPage = await doc.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(1, 780 / viewport.width);
        const scaled = pdfPage.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(scaled.width));
        canvas.height = Math.max(1, Math.floor(scaled.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas is unavailable in this browser.");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvas, canvasContext: ctx, viewport: scaled }).promise;
        if (cancelled) return;
        setPage({
          pageNumber,
          dataUrl: canvas.toDataURL("image/jpeg", 0.85),
          width: viewport.width,
          height: viewport.height,
        });
        pdfPage.cleanup();
        await doc.cleanup?.();
      } catch (renderError) {
        if (!cancelled) setError(renderError instanceof Error ? renderError.message : "The page could not be rendered.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, pageNumber]);

  const relative = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!page) return;
    const point = relative(event);
    if (tool === "ink" || tool === "signature") {
      setDrawing([point]);
      return;
    }
    if (tool === "highlight") {
      onAdd({ x: point.x, y: point.y - bandHeight / 2, width: 0.35, height: bandHeight, kind: "highlight" });
      return;
    }
    if (tool === "text") {
      onAdd({ x: point.x, y: point.y, width: 0.3, height: 0.03, kind: "text" });
      return;
    }
    if (tool === "box") {
      setDragStart(point);
      setDragEnd(point);
    }
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (drawing) setDrawing([...drawing, relative(event)]);
    if (dragStart) setDragEnd(relative(event));
  };

  const handlePointerUp = () => {
    if (drawing && drawing.length > 2) {
      onAdd({ x: 0, y: 0, width: 0, height: 0, kind: "ink", strokes: [drawing] });
    }
    if (dragStart && dragEnd) {
      const x = Math.min(dragStart.x, dragEnd.x);
      const y = Math.min(dragStart.y, dragEnd.y);
      const width = Math.abs(dragEnd.x - dragStart.x);
      const height = Math.abs(dragEnd.y - dragStart.y);
      if (width > 0.01 && height > 0.01) {
        onAdd({ x, y, width, height, kind: "box" });
      }
    }
    setDrawing(null);
    setDragStart(null);
    setDragEnd(null);
  };

  const overlay = (() => {
    if (dragStart && dragEnd) {
      return (
        <div
          className="pointer-events-none absolute border-2 border-dashed"
          style={{
            left: `${Math.min(dragStart.x, dragEnd.x) * 100}%`,
            top: `${Math.min(dragStart.y, dragEnd.y) * 100}%`,
            width: `${Math.abs(dragEnd.x - dragStart.x) * 100}%`,
            height: `${Math.abs(dragEnd.y - dragStart.y) * 100}%`,
            borderColor: color,
          }}
        />
      );
    }
    if (drawing) {
      const points = drawing.map((point) => `${point.x * 100},${point.y * 100}`).join(" ");
      return (
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points={points} fill="none" stroke={color} strokeWidth={0.5} />
        </svg>
      );
    }
    return null;
  })();

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {error ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-ink-soft">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/50 px-4 py-3">
          <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
          <span className="text-sm text-ink-soft">Rendering page {pageNumber}…</span>
        </div>
      ) : null}

      {page ? (
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className={cn(
            "relative mx-auto w-full max-w-3xl select-none touch-none overflow-hidden rounded-lg border border-line bg-white shadow-card",
            tool === "ink" || tool === "signature" ? "cursor-crosshair" : "cursor-copy",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={imageRef} src={page.dataUrl} alt={`Page ${pageNumber}`} className="block w-full" draggable={false} />

          {items.map((item) => (
            <ItemOverlay key={item.id} item={item} color={color} />
          ))}

          {overlay}
        </div>
      ) : null}
    </div>
  );
}

function ItemOverlay({ item, color }: { item: PlacedItem; color: string }) {
  if (item.kind === "highlight") {
    return (
      <div
        className="pointer-events-none absolute"
        style={{
          left: `${item.x * 100}%`,
          top: `${item.y * 100}%`,
          width: `${item.width * 100}%`,
          height: `${item.height * 100}%`,
          backgroundColor: color,
          mixBlendMode: "multiply",
        }}
      />
    );
  }
  if (item.kind === "box") {
    return (
      <div
        className="pointer-events-none absolute border-2"
        style={{
          left: `${item.x * 100}%`,
          top: `${item.y * 100}%`,
          width: `${item.width * 100}%`,
          height: `${item.height * 100}%`,
          borderColor: color,
        }}
      />
    );
  }
  if (item.kind === "text" || item.kind === "signature") {
    return (
      <div
        className="pointer-events-none absolute rounded px-1 py-0.5 text-[10px] font-semibold leading-tight"
        style={{
          left: `${item.x * 100}%`,
          top: `${item.y * 100}%`,
          color: item.kind === "signature" ? "#111" : color,
          maxWidth: `${Math.max(item.width, 0.1) * 100}%`,
          wordBreak: "break-word",
        }}
      >
        {item.text}
      </div>
    );
  }
  if (item.strokes) {
    return (
      <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {item.strokes.map((stroke, index) => (
          <polyline
            key={index}
            points={stroke.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={0.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    );
  }
  return null;
}
