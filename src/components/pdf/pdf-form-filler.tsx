"use client";

import * as React from "react";
import { PDFDocument } from "pdf-lib";
import { CheckSquare, Download, Loader2, RotateCcw } from "lucide-react";
import { downloadBlob, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UploadBox } from "@/components/tool-runtime/upload-box";
import { ErrorMessage } from "@/components/tool-runtime/run-feedback";
import { Input, Select, Toggle } from "@/components/ui/form-controls";

type FieldKind = "text" | "checkbox" | "radio" | "choice";

type FormField = {
  name: string;
  label: string;
  kind: FieldKind;
  value: string;
  options?: string[];
  isMultiLine?: boolean;
};

/**
 * PDF AcroForm filler.
 *
 * Reads the interactive fields with pdf-lib, renders a native form for them,
 * then writes the values back and optionally flattens them into the page.
 */
export function PdfFormFiller() {
  const [file, setFile] = React.useState<File | null>(null);
  const [fields, setFields] = React.useState<FormField[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [flatten, setFlatten] = React.useState(true);
  const [noFields, setNoFields] = React.useState(false);

  const load = async (selected: File) => {
    setError(null);
    setNotice(null);
    setNoFields(false);
    setFields([]);
    setLoading(true);
    try {
      const doc = await PDFDocument.load(await selected.arrayBuffer(), { ignoreEncryption: true });
      const form = doc.getForm();
      const discovered: FormField[] = [];

      for (const field of form.getFields()) {
        const name = field.getName();
        const constructor = field.constructor.name;
        if (constructor.includes("PDFTextField")) {
          const textField = form.getTextField(name);
          discovered.push({
            name,
            label: name,
            kind: "text",
            value: textField.getText() ?? "",
            isMultiLine: Boolean(textField.isMultiline()),
          });
        } else if (constructor.includes("PDFCheckBox")) {
          discovered.push({ name, label: name, kind: "checkbox", value: "" });
        } else if (constructor.includes("PDFRadioGroup")) {
          const radio = form.getRadioGroup(name);
          discovered.push({ name, label: name, kind: "radio", value: radio.getSelected() ?? "", options: radio.getOptions() });
        } else if (constructor.includes("PDFDropdown")) {
          const dropdown = form.getDropdown(name);
          discovered.push({
            name,
            label: name,
            kind: "choice",
            value: dropdown.getSelected()[0] ?? "",
            options: dropdown.getOptions(),
          });
        }
      }

      setFile(selected);
      setFields(discovered);
      setNoFields(discovered.length === 0);
      if (discovered.length === 0) {
        setNotice(
          "No interactive AcroForm fields were found. This PDF either has no form, or it uses XFA — which is not supported here.",
        );
      } else {
        setNotice(`${discovered.length} form field${discovered.length === 1 ? "" : "s"} detected and filled in below.`);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "This PDF could not be opened.");
    } finally {
      setLoading(false);
    }
  };

  const update = (name: string, value: string) => {
    setFields((current) => current.map((field) => (field.name === name ? { ...field, value } : field)));
  };

  const exportPdf = async () => {
    if (!file) {
      setError("Select a PDF form first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      const form = doc.getForm();

      for (const field of fields) {
        try {
          if (field.kind === "text") {
            form.getTextField(field.name).setText(field.value);
          } else if (field.kind === "checkbox") {
            const box = form.getCheckBox(field.name);
            if (field.value === "on") box.check();
            else box.uncheck();
          } else if (field.kind === "radio") {
            if (field.value) form.getRadioGroup(field.name).select(field.value);
          } else if (field.kind === "choice") {
            if (field.value) form.getDropdown(field.name).select(field.value);
          }
        } catch {
          // A field that no longer matches is skipped so the rest still saves.
        }
      }

      // Flatten bakes the values into the page so they cannot be edited again.
      if (flatten) form.flatten();

      const output = await doc.save({ useObjectStreams: true });
      downloadBlob(new Blob([output as unknown as BlobPart], { type: "application/pdf" }), "completed-form.pdf");
      setNotice("Completed form exported. Values were written on this device, nothing was uploaded.");
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
          label="Drop a PDF form to fill"
          hint="Interactive AcroForm fields are detected automatically"
          files={[]}
          onFiles={(selected) => selected[0] && load(selected[0])}
          onClear={() => setFile(null)}
        />
      ) : null}

      {loading ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/50 px-4 py-3">
          <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
          <span className="text-sm text-ink-soft">Reading form fields…</span>
        </div>
      ) : null}

      {error ? <ErrorMessage message={error} /> : null}
      {notice ? (
        <p
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            noFields ? "border-warning/40 bg-warning/10 text-ink-soft" : "border-success/40 bg-success/5 text-ink-soft",
          )}
        >
          {notice}
        </p>
      ) : null}

      {fields.length > 0 ? (
        <>
          <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Form fields</h3>
              <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
                <RotateCcw className="size-3.5" />
                New file
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((field) => (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <label htmlFor={`field-${field.name}`} className="text-xs font-medium text-ink">
                    {field.label}
                    <span className="ml-1.5 font-mono text-[10px] text-ink-muted">{field.kind}</span>
                  </label>
                  {field.kind === "text" ? (
                    <Input
                      id={`field-${field.name}`}
                      value={field.value}
                      onChange={(event) => update(field.name, event.target.value)}
                      placeholder={field.isMultiLine ? "Multi-line field" : "Enter value"}
                    />
                  ) : field.kind === "checkbox" ? (
                    <Toggle
                      label={field.value === "on" ? "Checked" : "Unchecked"}
                      checked={field.value === "on"}
                      onCheckedChange={(next) => update(field.name, next ? "on" : "off")}
                    />
                  ) : (
                    <Select
                      id={`field-${field.name}`}
                      value={field.value}
                      onChange={(event) => update(field.name, event.target.value)}
                    >
                      <option value="">— none —</option>
                      {(field.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              ))}
            </div>

            <Toggle
              label="Flatten fields after filling"
              description="Bakes the values into the page so they cannot be edited again. Turn off to keep the form editable."
              checked={flatten}
              onCheckedChange={setFlatten}
            />
          </div>

          <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 p-4 shadow-lift backdrop-blur">
            <p className="text-sm text-ink-soft">{fields.length} fields</p>
            <Button onClick={exportPdf} loading={busy}>
              <Download className="size-4" />
              Export completed form
            </Button>
          </div>
        </>
      ) : null}

      {noFields ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-5">
          <CheckSquare className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-sm leading-relaxed text-ink-soft">
            This PDF has no interactive AcroForm fields. Some government and enterprise forms use XFA instead, which is
            a different technology the in-browser engine cannot read. You can still add text on top of the page with
            the PDF Annotator.
          </p>
        </div>
      ) : null}
    </div>
  );
}
