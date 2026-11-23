"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  Archive,
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  HardDrive,
  Images,
  Info,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import {
  applyRecommendations,
  buildCleanedZip,
  deleteWithDirectoryHandle,
  groupImages,
  isImageFile,
  releaseGroupingWorker,
  scanFiles,
  type DuplicateGroup,
  type KeepStrategy,
  type ScannedImage,
  type ScanProgress,
} from "@/lib/processing/duplicate-finder";
import { downloadBlob, formatBytes, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/feedback";
import { SegmentedControl, Select, Toggle } from "@/components/ui/form-controls";
import { Tooltip } from "@/components/ui/overlay";

type Phase = "select" | "scanning" | "results";

type SelectionState = Record<number, boolean>;

const THRESHOLD_PRESETS = [
  { value: "100", label: "100% exact" },
  { value: "95", label: "95% very similar" },
  { value: "90", label: "90% similar" },
  { value: "80", label: "80% loose" },
];

export function DuplicateImageFinder() {
  const [files, setFiles] = React.useState<File[]>([]);
  const [phase, setPhase] = React.useState<Phase>("select");
  const [progress, setProgress] = React.useState<ScanProgress>({
    stage: "idle",
    processed: 0,
    total: 0,
    currentFile: "",
    groupsFound: 0,
    duplicatesFound: 0,
  });
  const [images, setImages] = React.useState<ScannedImage[]>([]);
  const [skipped, setSkipped] = React.useState<string[]>([]);
  const [selection, setSelection] = React.useState<SelectionState>({});
  const [history, setHistory] = React.useState<SelectionState[]>([]);
  const [threshold, setThreshold] = React.useState(95);
  const [hashMethod, setHashMethod] = React.useState("phash");
  const [keepStrategy, setKeepStrategy] = React.useState<KeepStrategy>("resolution");
  const [groupExact, setGroupExact] = React.useState(true);
  const [filter, setFilter] = React.useState<"all" | "exact" | "similar">("all");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [directoryHandle, setDirectoryHandle] = React.useState<FileSystemDirectoryHandle | null>(null);
  const [deletionSummary, setDeletionSummary] = React.useState<string | null>(null);
  const [zipProgress, setZipProgress] = React.useState<number | null>(null);

  const handleRef = React.useRef<{ cancel: () => void; pause: () => void; resume: () => void } | null>(null);
  const [paused, setPaused] = React.useState(false);
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    return () => handleRef.current?.cancel();
  }, []);

  const addFiles = (incoming: File[]) => {
    const valid = incoming.filter(isImageFile);
    const rejected = incoming.length - valid.length;
    setFiles((current) => [...current, ...valid]);
    setError(null);
    setNotice(
      rejected > 0
        ? `${rejected} file${rejected === 1 ? "" : "s"} skipped — not a supported image type.`
        : null,
    );
    if (valid.length === 0 && incoming.length > 0) {
      setError("None of the selected files are images this browser can read.");
    }
  };

  const pickFolder = async () => {
    // Prefer the File System Access API: it also enables safe direct deletion.
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (picker) {
      try {
        const handle = await picker({ mode: "readwrite" });
        setDirectoryHandle(handle);
        const collected: File[] = [];
        await collectFromDirectory(handle, collected, 0, setProgress);
        addFiles(collected);
        setNotice(null);
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setError(error instanceof Error ? error.message : "Folder selection failed.");
        return;
      }
    }
    folderInputRef.current?.click();
  };

  const startScan = () => {
    if (files.length === 0) {
      setError("Select images or a folder first.");
      return;
    }
    setError(null);
    setNotice(null);
    setDeletionSummary(null);
    setPhase("scanning");
    setSelection({});
    setHistory([]);
    setGroups([]);
    setGrouping(false);

    const handle = scanFiles(files, {
      onProgress: (update) => setProgress(update),
    });
    handleRef.current = handle;

    handle.promise
      .then((result) => {
        setImages(result.images);
        setSkipped(result.skipped);
        if (result.cancelled) {
          setNotice("Scan cancelled — partial results are shown below.");
        }
        // Mark grouping as busy in the same update as the scan result. Without
        // this there was a render where `groups` was empty but `grouping` was
        // still false, which flashed "No duplicates found" for one frame
        // before the comparison pass produced real groups.
        setGrouping(true);
        setPhase("results");
      })
      .catch((scanError) => {
        setError(scanError instanceof Error ? scanError.message : "The scan failed.");
        setPhase("select");
      });
  };

  /**
   * Grouping runs in the hashing worker.
   *
   * It was previously a synchronous `useMemo`, which put a worst-case
   * quadratic comparison inside React's render cycle and froze the page for
   * seconds on large folders. It also used to be computed twice — once in the
   * scan callback and again in an effect keyed on both `images` and `phase`.
   */
  const [groups, setGroups] = React.useState<DuplicateGroup[]>([]);
  const [grouping, setGrouping] = React.useState(false);
  const [, startGrouping] = React.useTransition();

  /**
   * Request token: re-running the effect for a settings change supersedes any
   * in-flight pass, so a slow earlier result can never overwrite a newer one.
   */
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    // Fewer than two images cannot produce a group. `groups` is already empty
    // because every entry point (scan, reset, delete) clears it, so there is
    // nothing to reset here.
    if (images.length < 2) return;
    const token = (requestRef.current += 1);
    let cancelled = false;

    // Kicked off inside a transition so the busy flag is set as part of that
    // update rather than as a synchronous write in the effect body.
    startGrouping(() => {
      setGrouping(true);
      groupImages(images, threshold, hashMethod)
        .then((raw) => {
          if (cancelled || token !== requestRef.current) return;
          setGroups(applyRecommendations(raw, keepStrategy));
          setGrouping(false);
        })
        .catch((groupError) => {
          if (cancelled || token !== requestRef.current) return;
          setError(groupError instanceof Error ? groupError.message : "Grouping failed.");
          setGroups([]);
          setGrouping(false);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [images, threshold, hashMethod, keepStrategy, startGrouping]);

  React.useEffect(() => releaseGroupingWorker, []);

  const effectiveFilter = groupExact ? filter : "all";
  const visibleGroups = React.useMemo(
    () =>
      effectiveFilter === "all"
        ? groups
        : groups.filter((group) => group.kind === effectiveFilter),
    [groups, effectiveFilter],
  );

  const selectDuplicatesInGroup = (group: DuplicateGroup, keepRecommended: boolean) => {
    setHistory((current) => [...current.slice(-19), selection]);
    const next: SelectionState = { ...selection };
    for (const image of group.images) {
      if (keepRecommended && image.id === group.recommendedId) continue;
      next[image.id] = true;
    }
    setSelection(next);
  };

  const toggleImage = (id: number) => {
    setHistory((current) => [...current.slice(-19), selection]);
    setSelection((current) => ({ ...current, [id]: !current[id] }));
  };

  const undo = () => {
    setHistory((current) => {
      if (current.length === 0) return current;
      setSelection(current[current.length - 1]);
      return current.slice(0, -1);
    });
  };

  const clearSelection = () => {
    setHistory((current) => [...current.slice(-19), selection]);
    setSelection({});
  };

  const selectedImages = React.useMemo(
    () => images.filter((image) => selection[image.id]),
    [images, selection],
  );

  const recoverableBytes = selectedImages.reduce((total, image) => total + image.size, 0);

  const confirmAndDelete = async () => {
    if (selectedImages.length === 0) return;
    if (!directoryHandle) {
      setError("Direct deletion needs the File System Access API. Use “Download cleaned ZIP” instead.");
      return;
    }
    const label = `${selectedImages.length} file${selectedImages.length === 1 ? "" : "s"} (${formatBytes(recoverableBytes)})`;
    if (!window.confirm(`Permanently delete ${label} from your folder?\n\nThis cannot be undone in the browser.`)) {
      return;
    }
    setPhase("scanning");
    setProgress({ stage: "hashing", processed: 0, total: selectedImages.length, currentFile: "", groupsFound: 0, duplicatesFound: 0, message: "Deleting selected duplicates" });
    try {
      const { deleted, failed } = await deleteWithDirectoryHandle(
        directoryHandle,
        selectedImages.map((image) => image.path),
      );
      const removedIds = new Set(selectedImages.filter((image) => deleted.includes(image.path)).map((image) => image.id));
      setImages((current) => current.filter((image) => !removedIds.has(image.id)));
      setSelection({});
      setDeletionSummary(
        `Deleted ${deleted.length} file${deleted.length === 1 ? "" : "s"}, recovering about ${formatBytes(
          selectedImages.filter((image) => deleted.includes(image.path)).reduce((total, image) => total + image.size, 0),
        )}.${failed.length ? ` ${failed.length} file(s) could not be deleted.` : ""}`,
      );
      if (failed.length > 0) {
        setNotice(`Some files could not be removed: ${failed.map((entry) => entry.path).join(", ")}`);
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Deletion failed.");
    } finally {
      setPhase("results");
    }
  };

  const downloadCleanedZip = async () => {
    const keep = images.filter((image) => !selection[image.id]);
    if (keep.length === 0) {
      setError("Everything is marked for removal — there is nothing left to keep.");
      return;
    }
    setZipProgress(0);
    try {
      const blob = await buildCleanedZip(
        keep.map((image) => ({ name: image.path.split("/").pop() ?? image.name, blob: image.file })),
        (percent) => setZipProgress(percent),
      );
      downloadBlob(blob, "cleaned-images.zip");
      setNotice(`Downloaded ${keep.length} kept images. The originals are untouched on your device.`);
    } catch (zipError) {
      setError(zipError instanceof Error ? zipError.message : "Building the ZIP failed.");
    } finally {
      setZipProgress(null);
    }
  };

  const downloadReport = () => {
    const lines = [
      "Duplicate image scan report",
      "Generated locally by BrowserForge — no images were uploaded.",
      "",
      `Images scanned:      ${images.length}`,
      `Files skipped:       ${skipped.length}`,
      `Similarity threshold: ${threshold}%`,
      `Perceptual hash:     ${hashMethod}`,
      `Duplicate groups:    ${groups.length}`,
      `Exact groups:        ${groups.filter((group) => group.kind === "exact").length}`,
      `Similar groups:      ${groups.filter((group) => group.kind === "similar").length}`,
      `Images marked for removal: ${selectedImages.length}`,
      `Storage recoverable: ${formatBytes(recoverableBytes)}`,
      "",
      "Groups",
      "======",
      "",
    ];
    for (const group of groups) {
      lines.push(`${group.kind.toUpperCase()} group — ${group.similarity}% similarity — ${group.images.length} images`);
      for (const image of group.images) {
        lines.push(
          `  ${selection[image.id] ? "[REMOVE]" : image.id === group.recommendedId ? "[KEEP* ]" : "[      ]"} ${image.path} — ${formatBytes(image.size)} — ${image.width}×${image.height} — ${image.type.replace("image/", "")}`,
        );
      }
      lines.push("");
    }
    if (skipped.length) {
      lines.push("Skipped files", "=============", ...skipped.map((entry) => `  ${entry}`));
    }
    downloadBlob(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }), "duplicate-scan-report.txt");
  };

  const reset = () => {
    handleRef.current?.cancel();
    setFiles([]);
    setImages([]);
    setSelection({});
    setHistory([]);
    setSkipped([]);
    setPhase("select");
    setError(null);
    setNotice(null);
    setDeletionSummary(null);
    setDirectoryHandle(null);
    setPaused(false);
  };

  const totalDuplicates = groups.reduce((total, group) => total + group.images.length - 1, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Selection + controls */}
      <section className="rounded-xl border border-line bg-surface p-5 shadow-soft">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Images className="size-4 text-brand" aria-hidden />
              {files.length > 0
                ? `${files.length.toLocaleString("en-US")} image${files.length === 1 ? "" : "s"} selected`
                : "Select images or a whole folder"}
            </div>
            {files.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={reset}>
                <X className="size-3.5" />
                Clear
              </Button>
            ) : null}
          </div>

          {phase === "select" || files.length === 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="secondary" size="lg" onClick={() => fileInputRef.current?.click()}>
                <Images className="size-4" />
                Select images
              </Button>
              <Button variant="secondary" size="lg" onClick={pickFolder}>
                <FolderOpen className="size-4" />
                Select folder
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.heic,.heif,.tif,.tiff,.bmp"
                multiple
                className="sr-only"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                className="sr-only"
                // @ts-expect-error non-standard but widely supported directory picker
                webkitdirectory=""
                directory=""
                multiple
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label htmlFor="threshold" className="text-sm font-medium text-ink">
                Similarity threshold
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="threshold"
                  type="range"
                  min={80}
                  max={100}
                  step={1}
                  value={threshold}
                  onChange={(event) => setThreshold(Number(event.target.value))}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--brand)]"
                />
                <span className="w-14 rounded-md border border-line bg-surface-2 py-0.5 text-center font-mono text-xs text-ink">
                  {threshold}%
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {THRESHOLD_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => setThreshold(Number(preset.value))}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                      threshold === Number(preset.value)
                        ? "border-brand bg-brand text-[var(--brand-ink)]"
                        : "border-line bg-surface text-ink-muted hover:text-ink",
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="hashMethod" className="text-sm font-medium text-ink">
                  Perceptual hash
                </label>
                <Select
                  id="hashMethod"
                  value={hashMethod}
                  onChange={(event) => setHashMethod(event.target.value)}
                >
                  <option value="phash">pHash — frequency based (best)</option>
                  <option value="dhash">dHash — gradient based</option>
                  <option value="ahash">aHash — average based (fastest)</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="keepStrategy" className="text-sm font-medium text-ink">
                  Recommend keeping
                </label>
                <Select
                  id="keepStrategy"
                  value={keepStrategy}
                  onChange={(event) => setKeepStrategy(event.target.value as KeepStrategy)}
                >
                  <option value="resolution">Highest resolution</option>
                  <option value="size">Largest file size</option>
                  <option value="newest">Newest modification date</option>
                  <option value="oldest">Oldest modification date</option>
                  <option value="format">Preferred format (PNG → WebP → JPG)</option>
                </Select>
              </div>
            </div>
          </div>

          <Toggle
            label="Split exact and similar duplicates"
            description="On: byte-identical files get their own filter bucket. Off: every group is shown in one unified list."
            checked={groupExact}
            onCheckedChange={setGroupExact}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              onClick={startScan}
              disabled={phase === "scanning" || files.length === 0}
              loading={phase === "scanning" && !paused}
            >
              <ScanSearch className="size-4" />
              {phase === "scanning" ? "Scanning…" : `Scan ${files.length.toLocaleString("en-US")} images`}
            </Button>
            {phase === "scanning" ? (
              <>
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => {
                    if (paused) {
                      handleRef.current?.resume();
                      setPaused(false);
                    } else {
                      handleRef.current?.pause();
                      setPaused(true);
                    }
                  }}
                >
                  {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                  {paused ? "Resume" : "Pause"}
                </Button>
                <Button
                  variant="danger"
                  size="lg"
                  onClick={() => {
                    handleRef.current?.cancel();
                    setPhase("results");
                  }}
                >
                  <X className="size-4" />
                  Cancel
                </Button>
              </>
            ) : null}
            {images.length > 0 ? (
              <Button variant="ghost" size="lg" onClick={reset}>
                <RotateCcw className="size-4" />
                Start over
              </Button>
            ) : null}
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 p-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <p className="text-xs leading-relaxed text-ink-soft">
              Hashing runs in background Web Workers and every image stays in this tab. Nothing is
              uploaded, and no files are ever deleted automatically — deletion only happens after you
              explicitly confirm it.
            </p>
          </div>
        </div>
      </section>

      {/* Progress */}
      <AnimatePresence>
        {grouping ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-5"
            aria-live="polite"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="size-5 animate-spin text-violet-600 dark:text-violet-300" aria-hidden />
              <div className="flex flex-1 flex-col">
                <p className="text-sm font-semibold text-ink">
                  Comparing {images.length.toLocaleString("en-US")} images
                </p>
                <p className="text-xs text-ink-muted">
                  Perceptual matching runs in a background worker — the page stays responsive.
                </p>
              </div>
            </div>
          </motion.div>
        ) : null}

        {phase === "scanning" ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-5"
            aria-live="polite"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="size-5 animate-spin text-brand" aria-hidden />
              <div className="flex flex-1 flex-col">
                <p className="text-sm font-semibold text-ink">
                  {progress.message ?? "Scanning images locally"}
                </p>
                <p className="text-xs text-ink-muted">
                  {paused ? "Paused — resume whenever you are ready" : "Background workers are hashing your files"}
                </p>
              </div>
              <span className="font-mono text-sm font-semibold text-brand">
                {progress.total > 0 ? `${Math.round((progress.processed / progress.total) * 100)}%` : "…"}
              </span>
            </div>
            <Progress
              value={progress.total > 0 ? (progress.processed / progress.total) * 100 : 0}
              label="Scan progress"
            />
            {progress.currentFile ? (
              <p className="truncate font-mono text-xs text-ink-muted">{progress.currentFile}</p>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {error ? (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/5 p-5">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <p className="text-sm leading-relaxed text-ink-soft">{error}</p>
        </div>
      ) : null}

      {notice ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-xs leading-relaxed text-ink-soft">{notice}</p>
        </div>
      ) : null}

      {deletionSummary ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-success/40 bg-success/10 p-4">
          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <p className="text-xs leading-relaxed text-ink-soft">{deletionSummary}</p>
        </div>
      ) : null}

      {/* Results */}
      {phase === "results" && images.length > 0 && !grouping ? (

        <>
          <ScanSummary
            scanned={images.length}
            skipped={skipped.length}
            groups={groups.length}
            exact={groups.filter((group) => group.kind === "exact").length}
            similar={groups.filter((group) => group.kind === "similar").length}
            duplicates={totalDuplicates}
            recoverable={images.reduce((total, image) => total + image.size, 0) - images.filter((image) => !selection[image.id]).reduce((total, image) => total + image.size, 0)}
            selected={selectedImages.length}
          />

          {zipProgress !== null ? (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
              <p className="text-sm font-medium text-ink">Building cleaned ZIP…</p>
              <Progress value={zipProgress} label="ZIP progress" />
            </div>
          ) : null}

          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line bg-surface-2/40 px-6 py-14 text-center">
              <span className="flex size-12 items-center justify-center rounded-xl bg-success/12 text-success">
                <Check className="size-6" aria-hidden />
              </span>
              <h3 className="text-base font-semibold text-ink">No duplicates found</h3>
              <p className="max-w-md text-sm leading-relaxed text-ink-soft">
                Nothing matched at {threshold}% similarity. Lower the threshold to catch more loosely
                related shots, or try a different perceptual hash.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
                {groupExact ? (
                  <SegmentedControl
                    label="Filter groups"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: `All (${groups.length})` },
                      { value: "exact", label: `Exact (${groups.filter((group) => group.kind === "exact").length})` },
                      { value: "similar", label: `Similar (${groups.filter((group) => group.kind === "similar").length})` },
                    ]}
                  />
                ) : (
                  <p className="text-sm text-ink-soft">
                    Showing all {groups.length} duplicate group{groups.length === 1 ? "" : "s"} together
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={undo} disabled={history.length === 0}>
                    <Undo2 className="size-3.5" />
                    Undo
                  </Button>
                  <Button variant="secondary" size="sm" onClick={clearSelection} disabled={selectedImages.length === 0}>
                    <X className="size-3.5" />
                    Clear selection
                  </Button>
                  <Button variant="secondary" size="sm" onClick={downloadReport}>
                    <Archive className="size-3.5" />
                    Download report
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {visibleGroups.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    selection={selection}
                    splitExact={groupExact}
                    onToggle={toggleImage}
                    onSelectDuplicates={() => selectDuplicatesInGroup(group, true)}
                    onSelectAll={() => selectDuplicatesInGroup(group, false)}
                    onKeepRecommendedOnly={() => {
                      setHistory((current) => [...current.slice(-19), selection]);
                      const next: SelectionState = { ...selection };
                      for (const image of group.images) {
                        next[image.id] = image.id !== group.recommendedId;
                      }
                      setSelection(next);
                    }}
                  />
                ))}
              </div>

              <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border border-line bg-surface/95 p-4 shadow-lift backdrop-blur">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-ink-soft">
                    <span className="font-semibold text-ink">{selectedImages.length}</span> marked for removal ·{" "}
                    <span className="font-semibold text-ink">{formatBytes(recoverableBytes)}</span> recoverable
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="soft" size="sm" onClick={downloadCleanedZip}>
                      <Archive className="size-3.5" />
                      Download cleaned ZIP
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={confirmAndDelete}
                      disabled={selectedImages.length === 0 || !directoryHandle}
                    >
                      <Trash2 className="size-3.5" />
                      Delete selected
                    </Button>
                  </div>
                </div>
                {!directoryHandle ? (
                  <p className="text-xs leading-relaxed text-ink-muted">
                    <TriangleAlert className="mr-1 inline size-3.5 text-warning" aria-hidden />
                    {typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
                      ? "Direct deletion needs the folder to be re-selected with directory access, so it is disabled for files chosen with the file picker. Re-select the folder above to enable it."
                      : "This browser does not support the File System Access API, so originals cannot be deleted directly. Download the cleaned ZIP instead — it contains every image you did not mark for removal."}
                  </p>
                ) : null}
              </div>
            </>
          )}

          {skipped.length > 0 ? (
            <details className="rounded-xl border border-line bg-surface p-4">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                {skipped.length} file{skipped.length === 1 ? "" : "s"} could not be read
              </summary>
              <ul className="mt-3 flex flex-col gap-1">
                {skipped.map((entry) => (
                  <li key={entry} className="font-mono text-xs text-ink-muted">
                    {entry}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {phase === "select" && files.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line bg-surface-2/40 px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-surface text-brand shadow-soft">
            <ScanSearch className="size-6" aria-hidden />
          </span>
          <h3 className="text-base font-semibold text-ink">Ready to scan</h3>
          <p className="max-w-md text-sm leading-relaxed text-ink-soft">
            Select a folder of 1,000 or more images. Every hash is computed on your device by
            background Web Workers, so the interface stays responsive throughout.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------- sub views -------------------------------- */

async function collectFromDirectory(
  handle: FileSystemDirectoryHandle,
  collected: File[],
  depth: number,
  onProgress: (progress: ScanProgress) => void,
): Promise<void> {
  if (depth > 4) return;
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === "file") {
      try {
        const file = await entry.getFile();
        if (isImageFile(file)) collected.push(file);
        onProgress({
          stage: "hashing",
          processed: collected.length,
          total: collected.length,
          currentFile: name,
          groupsFound: 0,
          duplicatesFound: 0,
          message: `Reading folder — ${collected.length} images found`,
        });
      } catch {
        /* skip unreadable entries */
      }
    } else if (entry.kind === "directory") {
      await collectFromDirectory(entry, collected, depth + 1, onProgress);
    }
  }
}

function ScanSummary({
  scanned,
  skipped,
  groups,
  exact,
  similar,
  duplicates,
  recoverable,
  selected,
}: {
  scanned: number;
  skipped: number;
  groups: number;
  exact: number;
  similar: number;
  duplicates: number;
  recoverable: number;
  selected: number;
}) {
  const items = [
    { icon: Images, label: "Images scanned", value: scanned.toLocaleString("en-US") },
    { icon: Copy, label: "Duplicate groups", value: groups.toLocaleString("en-US") },
    { icon: Zap, label: "Exact matches", value: exact.toLocaleString("en-US") },
    { icon: Sparkles, label: "Similar matches", value: similar.toLocaleString("en-US") },
    { icon: HardDrive, label: "Duplicate images", value: duplicates.toLocaleString("en-US") },
    { icon: Trash2, label: "Marked for removal", value: selected.toLocaleString("en-US") },
    { icon: HardDrive, label: "Storage recoverable", value: formatBytes(Math.max(0, recoverable)) },
    { icon: TriangleAlert, label: "Files skipped", value: skipped.toLocaleString("en-US") },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-line bg-surface p-3">
          <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            <item.icon className="size-3" aria-hidden />
            {item.label}
          </dt>
          <dd className="mt-0.5 text-lg font-semibold text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function GroupCard({
  group,
  selection,
  splitExact = true,
  onToggle,
  onSelectDuplicates,
  onSelectAll,
  onKeepRecommendedOnly,
}: {
  group: DuplicateGroup;
  selection: SelectionState;
  splitExact?: boolean;
  onToggle: (id: number) => void;
  onSelectDuplicates: () => void;
  onSelectAll: () => void;
  onKeepRecommendedOnly: () => void;
}) {
  const [open, setOpen] = React.useState(group.images.length <= 6);
  const shown = open ? group.images : group.images.slice(0, 3);

  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-4 shadow-soft",
        group.kind === "exact" ? "border-rose-500/30" : "border-violet-500/30",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
              !splitExact
                ? "bg-surface-2 text-ink-soft"
                : group.kind === "exact"
                  ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                  : "bg-violet-500/12 text-violet-600 dark:text-violet-300",
            )}
          >
            {!splitExact ? (
              <Copy className="size-3" />
            ) : group.kind === "exact" ? (
              <Copy className="size-3" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {!splitExact
              ? "Duplicate group"
              : group.kind === "exact"
                ? "Exact duplicate"
                : "Visually similar"}
          </span>
          <span className="text-sm text-ink-soft">
            {group.images.length} images · {group.similarity}% match
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Tooltip label="Keep the recommended image and mark every other file in this group">
            <Button variant="soft" size="xs" onClick={onKeepRecommendedOnly}>
              <Star className="size-3" />
              Keep recommended
            </Button>
          </Tooltip>
          <Button variant="secondary" size="xs" onClick={onSelectDuplicates}>
            <Trash2 className="size-3" />
            Select duplicates
          </Button>
          <Button variant="ghost" size="xs" onClick={onSelectAll}>
            Select all
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setOpen((value) => !value)}>
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
            {open ? "Collapse" : "Expand"}
          </Button>
        </div>
      </div>

      <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((image) => {
          const selected = Boolean(selection[image.id]);
          const isRecommended = image.id === group.recommendedId;
          return (
            <li
              key={image.id}
              className={cn(
                "flex gap-3 rounded-lg border p-2.5 transition-colors",
                selected ? "border-danger bg-danger/5" : "border-line bg-surface-2/40",
                isRecommended && !selected && "border-success/50 bg-success/5",
              )}
            >
              <button
                type="button"
                onClick={() => onToggle(image.id)}
                aria-pressed={selected}
                aria-label={`${selected ? "Deselect" : "Select"} ${image.name}`}
                className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-3"
              >
                {image.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image.thumbnail} alt={image.name} className="size-full object-cover" loading="lazy" />
                ) : (
                  <Images className="size-5 text-ink-muted" aria-hidden />
                )}
              </button>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="truncate text-sm font-medium text-ink" title={image.path}>
                  {image.name}
                </p>
                <p className="truncate text-[11px] text-ink-muted" title={image.path}>
                  {image.path !== image.name ? image.path : "current selection"}
                </p>
                <dl className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-ink-muted">
                  <div className="flex gap-1">
                    <dt className="sr-only">File size</dt>
                    <dd>{formatBytes(image.size)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="sr-only">Resolution</dt>
                    <dd>{image.width > 0 ? `${image.width}×${image.height}` : "unknown"}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="sr-only">Format</dt>
                    <dd>{image.type.replace("image/", "").toUpperCase()}</dd>
                  </div>
                </dl>
                <div className="mt-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onToggle(image.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors",
                      selected
                        ? "bg-danger text-white"
                        : "border border-line bg-surface text-ink-soft hover:border-danger/50 hover:text-danger",
                    )}
                  >
                    {selected ? <Check className="size-3" /> : <Trash2 className="size-3" />}
                    {selected ? "Remove" : "Keep"}
                  </button>
                  {isRecommended ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-success/12 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                      <Star className="size-2.5" />
                      Recommended
                    </span>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {!open && group.images.length > 3 ? (
        <p className="mt-2 text-xs text-ink-muted">
          + {group.images.length - 3} more image{group.images.length - 3 === 1 ? "" : "s"} in this group
        </p>
      ) : null}
    </article>
  );
}
