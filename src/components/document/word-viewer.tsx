"use client";

import * as React from "react";
import { Download, Eye, Loader2, RotateCcw, Printer } from "lucide-react";
import { downloadBlob } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UploadBox } from "@/components/tool-runtime/upload-box";
import { ErrorMessage } from "@/components/tool-runtime/run-feedback";

/**
 * Renders a .docx file in the browser using mammoth, with no upload.
 * The document can then be exported as HTML or as a PDF rendered locally.
 */
export function WordDocumentViewer() {
  const [file, setFile] = React.useState<File | null>(null);
  const [html, setHtml] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [scale, setScale] = React.useState(100);
  const [stats, setStats] = React.useState<{ words: number; chars: number } | null>(null);

  const load = async (selected: File) => {
    setError(null);
    setNotice(null);
    setLoading(true);
    setHtml("");
    setStats(null);
    try {
      const { default: mammoth } = await import("mammoth/mammoth.browser");
      const arrayBuffer = await selected.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      if (!result.value.trim()) {
        setError("This document converted but contains no readable text. It may be empty or image-only.");
        setFile(selected);
        return;
      }
      setFile(selected);
      setHtml(result.value);
      const text = result.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      setStats({ words: text ? text.split(/\s+/).length : 0, chars: text.length });
      const warnings = result.messages.filter((message) => message.type === "warning").length;
      setNotice(
        warnings > 0
          ? `Rendered locally with ${warnings} formatting warning${warnings === 1 ? "" : "s"}. Headers, footers, footnotes and images are not shown.`
          : "Rendered locally. Headers, footers, footnotes and images are not shown.",
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error && /zip|corrupt/i.test(loadError.message)
          ? "This file is not a valid .docx document. Legacy .doc files are not supported."
          : loadError instanceof Error
            ? loadError.message
            : "This document could not be read.",
      );
    } finally {
      setLoading(false);
    }
  };

  const downloadHtml = () => {
    if (!html || !file) return;
    const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${file.name.replace(/\.docx$/i, "")}</title>
<style>
  body { max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; font: 16px/1.65 system-ui, sans-serif; color: #1f2430; }
  pre { background: #f4f5f8; padding: 1rem; border-radius: .5rem; overflow: auto; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #ddd; padding: 6px 10px; }
</style>
</head>
<body>
${html}
</body>
</html>
`;
    downloadBlob(new Blob([document], { type: "text/html;charset=utf-8" }), `${file.name.replace(/\.docx$/i, "")}.html`);
  };

  const downloadPdf = async () => {
    if (!html || !file) return;
    setError(null);
    try {
      const { renderBlocksToPdf, htmlToBlocks } = await import("@/lib/processing/doc-blocks");
      const blocks = htmlToBlocks(html);
      const { bytes } = await renderBlocksToPdf(blocks, {
        size: "a4",
        baseFontSize: 11,
        margin: 46,
        title: file.name.replace(/\.docx$/i, ""),
      });
      downloadBlob(new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }), `${file.name.replace(/\.docx$/i, "")}.pdf`);
    } catch (pdfError) {
      setError(pdfError instanceof Error ? pdfError.message : "PDF export failed.");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {!file ? (
        <UploadBox
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          multiple={false}
          label="Drop a Word document to view"
          hint="Rendered entirely in your browser — nothing is uploaded"
          files={[]}
          onFiles={(selected) => selected[0] && load(selected[0])}
          onClear={() => setFile(null)}
        />
      ) : null}

      {loading ? (
        <div className="flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft/40 px-4 py-3">
          <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
          <span className="text-sm text-ink-soft">Converting document locally…</span>
        </div>
      ) : null}

      {error ? <ErrorMessage message={error} /> : null}
      {notice ? (
        <p className="rounded-lg border border-info/40 bg-accent-soft/40 px-3 py-2 text-xs text-ink-soft">{notice}</p>
      ) : null}

      {html ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
            <span className="flex items-center gap-2 text-sm font-medium text-ink">
              <Eye className="size-4 text-brand" aria-hidden />
              {file?.name}
            </span>
            {stats ? (
              <span className="text-xs text-ink-muted">
                {stats.words.toLocaleString("en-US")} words · {stats.chars.toLocaleString("en-US")} characters
              </span>
            ) : null}
            <div className="ml-auto flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
                <RotateCcw className="size-3.5" />
                New file
              </Button>
              <Button variant="secondary" size="sm" onClick={downloadHtml}>
                <Download className="size-3.5" />
                HTML
              </Button>
              <Button variant="secondary" size="sm" onClick={downloadPdf}>
                <Download className="size-3.5" />
                PDF
              </Button>
              <Button variant="ghost" size="sm" onClick={() => window.print()}>
                <Printer className="size-3.5" />
                Print
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
            <label htmlFor="scale" className="text-xs font-medium text-ink">
              Reading size {scale}%
            </label>
            <input
              id="scale"
              type="range"
              min={80}
              max={160}
              step={5}
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--brand)]"
            />
          </div>

          <article
            className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-surface p-6 shadow-card sm:p-10"
            style={{ fontSize: `${scale}%` }}
          >
            <div
              className="docx-viewer prose-neutral max-w-none text-[0.95rem] leading-relaxed text-ink
                [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold
                [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold
                [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold
                [&_p]:mb-3 [&_p]:mt-0 [&_p]:leading-relaxed
                [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6
                [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6
                [&_li]:mb-1
                [&_table]:mb-4 [&_table]:w-full [&_table]:border-collapse
                [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5
                [&_th]:border [&_th]:border-line [&_th]:bg-surface-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:font-semibold
                [&_pre]:mb-4 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-surface-2 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs
                [&_strong]:font-semibold
                [&_em]:italic
                [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-4 [&_blockquote]:text-ink-soft"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </article>
        </>
      ) : null}
    </div>
  );
}
