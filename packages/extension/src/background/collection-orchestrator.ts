import {
  CollectionPageExtractionSchema,
  CollectionRecipeSchema,
  CollectionRunSummarySchema,
  type CollectionPageExtraction,
  type CollectionProgress,
  type CollectionRecipeV1,
  type CollectionRow,
  type CollectionRunSnapshot,
  type CollectionRunSummary,
  type CollectionStopReason,
} from "@aipagego/shared/collection";
import type { Json, RunSource } from "@aipagego/shared/types";
import type { CollectionAdvanceDynamicResult } from "./collection-dynamic";
import {
  checkpointCollectionResult,
  createCollectionResult,
  failCollectionResult,
  finalizeCollectionResult,
  getCollectionRunSnapshot,
  pruneCollectionResults,
  updateCollectionProgress,
} from "./storage/collection-results";
import { createRun, finalizeRun, getRun } from "./storage/runs";

type ActiveRun = {
  runId: string;
  resultId: string;
  tabId: number;
  aborted: boolean;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
};

export type CollectionAdvanceNextResult =
  | { status: "changed"; page: unknown }
  | { status: "missing" | "disabled" | "timeout" | "aborted" };

export type { CollectionAdvanceDynamicResult } from "./collection-dynamic";

type CollectionOrchestratorDeps = {
  getTab: (tabId: number) => Promise<{ url?: string }>;
  extractPage: (tabId: number, recipe: CollectionRecipeV1) => Promise<unknown>;
  advanceNext?: (input: {
    tabId: number;
    selector: string;
    recipe: CollectionRecipeV1;
    previousUrl: string;
    previousFingerprint: string;
    signal: AbortSignal;
  }) => Promise<CollectionAdvanceNextResult>;
  advanceDynamic?: (input: {
    tabId: number;
    recipe: CollectionRecipeV1;
    previousFingerprint: string;
    previousMatchedCount: number;
    action:
      | { kind: "loadMore"; selector: string }
      | { kind: "infiniteScroll" };
    signal: AbortSignal;
  }) => Promise<CollectionAdvanceDynamicResult>;
  broadcast: (progress: CollectionProgress) => void;
  now?: () => number;
  randomId?: () => string;
};

const encoder = new TextEncoder();

function rowByteSize(row: CollectionRow): number {
  return encoder.encode(JSON.stringify(row)).byteLength;
}

function dedupeKey(row: CollectionRow, fieldIds: string[]): string | null {
  if (fieldIds.length === 0) return null;
  const values = fieldIds.map((fieldId) => row[fieldId]);
  if (values.some((value) => value == null || value === "")) return null;
  return JSON.stringify(values);
}

type AbortableResult<T> =
  | { aborted: true }
  | { aborted: false; value: T };

function waitUnlessAborted<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<AbortableResult<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class CollectionOrchestrator {
  private readonly activeTabs = new Set<number>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly deps: CollectionOrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? (() => crypto.randomUUID());
  }

  async start(input: {
    tabId: number;
    recipe: CollectionRecipeV1;
    source?: RunSource;
  }): Promise<{ runId: string }> {
    const recipe = CollectionRecipeSchema.parse(input.recipe);
    if (this.activeTabs.has(input.tabId)) throw new Error("collection_already_running");

    this.activeTabs.add(input.tabId);
    try {
      const tab = await this.deps.getTab(input.tabId);
      const sourceUrl = tab.url ?? "";
      const resultId = this.randomId();
      const run = await createRun({
        toolId: null,
        toolVersion: null,
        url: sourceUrl,
        source: input.source,
        collection: { resultId, tabId: input.tabId, sourceUrl },
      });
      await createCollectionResult({
        resultId,
        runId: run.id,
        tabId: input.tabId,
        sourceUrl,
        recipe,
        startedAt: run.startedAt,
      });
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      const active: ActiveRun = {
        runId: run.id,
        resultId,
        tabId: input.tabId,
        aborted: false,
        controller: new AbortController(),
        done,
        resolveDone,
      };
      this.activeRuns.set(run.id, active);
      this.emit(active, "starting", 0, 0, 0);
      void this.execute(active, recipe, sourceUrl, run.startedAt);
      return { runId: run.id };
    } catch (error) {
      this.activeTabs.delete(input.tabId);
      throw error;
    }
  }

  async runAndWait(input: {
    tabId: number;
    recipe: CollectionRecipeV1;
    timeoutMs?: number;
    source?: RunSource;
  }): Promise<CollectionRunSummary> {
    const { runId } = await this.start(input);
    const active = this.activeRuns.get(runId);
    if (active) {
      const timeoutMs = input.timeoutMs ?? 600_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        timer = setTimeout(() => this.cancel(runId), timeoutMs);
        await active.done;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const snapshot = await this.get(runId);
    if (!snapshot) throw new Error(`collection run ${runId} not found`);
    if (snapshot.status === "error") {
      throw new Error(snapshot.error ?? "collection extraction failed");
    }
    if (!snapshot.summary) throw new Error(`collection run ${runId} completed without summary`);
    return CollectionRunSummarySchema.parse(snapshot.summary);
  }

  async get(runId: string): Promise<CollectionRunSnapshot | null> {
    const stored = await getCollectionRunSnapshot(runId);
    if (stored) return stored;

    const run = await getRun(runId);
    if (!run?.collection) return null;
    const parsedSummary = CollectionRunSummarySchema.safeParse(run.output);
    if (!parsedSummary.success) return null;
    const summary = parsedSummary.data;
    return {
      runId,
      resultId: run.collection.resultId,
      tabId: run.collection.tabId,
      sourceUrl: run.collection.sourceUrl,
      status: summary.status,
      phase: "completed",
      rowCount: summary.rowCount,
      byteSize: summary.byteSize,
      pageCount: summary.pageCount,
      duplicateCount: summary.duplicateCount,
      missingRequiredCount: summary.missingRequiredCount,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      stopReason: summary.stopReason,
      summary,
      resultExpired: true,
    };
  }

  cancel(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.aborted = true;
      active.controller.abort();
    }
  }

  private async execute(
    active: ActiveRun,
    recipe: CollectionRecipeV1,
    sourceUrl: string,
    startedAt: number
  ): Promise<void> {
    try {
      const rows: CollectionRow[] = [];
      const seen = new Set<string>();
      const fingerprints = new Set<string>();
      let byteSize = 0;
      let duplicateCount = 0;
      let missingRequiredCount = 0;
      let pageCount = 0;
      let noNewRowsRounds = 0;
      await updateCollectionProgress(active.resultId, {
        phase: "extracting",
        pageCount: 0,
        rowCount: 0,
        byteSize: 0,
      });
      this.emit(active, "extracting", 0, 0, 0);
      const initialPage = await waitUnlessAborted(
        this.deps.extractPage(active.tabId, recipe),
        active.controller.signal,
      );
      if (initialPage.aborted) {
        await this.finish(
          active,
          sourceUrl,
          startedAt,
          rows,
          duplicateCount,
          missingRequiredCount,
          "aborted",
          byteSize,
          pageCount,
        );
        return;
      }
      let rawPage: unknown = initialPage.value;

      while (true) {
        await updateCollectionProgress(active.resultId, {
          phase: "extracting",
          pageCount,
          rowCount: rows.length,
          byteSize,
        });
        this.emit(active, "extracting", pageCount, rows.length, byteSize);
        const page = CollectionPageExtractionSchema.parse(rawPage) as CollectionPageExtraction;

        if (active.aborted) {
          await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "aborted", byteSize, pageCount);
          return;
        }
        if (fingerprints.has(page.fingerprint)) {
          await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "repeated_page", byteSize, pageCount);
          return;
        }
        fingerprints.add(page.fingerprint);

        duplicateCount += page.duplicateCount;
        const rowCountBeforePage = rows.length;
        let stopReason: CollectionStopReason = page.truncatedBy ?? "completed";
        for (const extracted of page.rows) {
          const key = dedupeKey(extracted.values, recipe.dedupeBy);
          if (key != null && seen.has(key)) {
            duplicateCount += 1;
            continue;
          }
          if (rows.length >= recipe.maxRows) {
            stopReason = "max_rows";
            break;
          }
          const nextByteSize = byteSize + rowByteSize(extracted.values);
          if (nextByteSize > recipe.maxBytes) {
            stopReason = "max_bytes";
            break;
          }
          if (key != null) seen.add(key);
          rows.push(extracted.values);
          byteSize = nextByteSize;
          if (recipe.fields.some(
            (field) => field.required && extracted.values[field.id] == null
          )) {
            missingRequiredCount += 1;
          }
        }

        pageCount += 1;
        await checkpointCollectionResult(active.resultId, {
          rows,
          byteSize,
          pageCount,
          duplicateCount,
          missingRequiredCount,
        });
        this.emit(active, "persisting", pageCount, rows.length, byteSize);

        if (active.aborted) stopReason = "aborted";
        if (stopReason !== "completed") {
          await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, stopReason, byteSize, pageCount);
          return;
        }
        if (pageCount > 1 && (
          recipe.pagination.kind === "loadMore" ||
          recipe.pagination.kind === "infiniteScroll"
        )) {
          noNewRowsRounds = rows.length === rowCountBeforePage ? noNewRowsRounds + 1 : 0;
          if (noNewRowsRounds >= 2) {
            await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "no_new_rows", byteSize, pageCount);
            return;
          }
        }
        if (recipe.pagination.kind === "single") {
          await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "completed", byteSize, pageCount);
          return;
        }
        if (pageCount >= recipe.pagination.maxPages) {
          await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "max_pages", byteSize, pageCount);
          return;
        }
        if (recipe.pagination.kind === "next") {
          if (!this.deps.advanceNext) throw new Error("collection next-page runner missing");
          const advanceResult = await waitUnlessAborted(
            this.deps.advanceNext({
              tabId: active.tabId,
              selector: recipe.pagination.selector,
              recipe,
              previousUrl: page.pageUrl,
              previousFingerprint: page.fingerprint,
              signal: active.controller.signal,
            }),
            active.controller.signal,
          );
          if (advanceResult.aborted) {
            await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "aborted", byteSize, pageCount);
            return;
          }
          const advanced = advanceResult.value;
          const advanceStop: Partial<Record<typeof advanced.status, CollectionStopReason>> = {
            missing: "pagination_missing",
            disabled: "pagination_disabled",
            timeout: "navigation_timeout",
            aborted: "aborted",
          };
          if (advanced.status !== "changed") {
            await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, advanceStop[advanced.status]!, byteSize, pageCount);
            return;
          }
          rawPage = advanced.page;
          continue;
        }

        if (!this.deps.advanceDynamic) throw new Error("collection dynamic-page runner missing");
        while (true) {
          const advanceResult = await waitUnlessAborted(
            this.deps.advanceDynamic({
              tabId: active.tabId,
              recipe,
              previousFingerprint: page.fingerprint,
              previousMatchedCount: page.matchedCount,
              action: recipe.pagination.kind === "loadMore"
                ? { kind: "loadMore", selector: recipe.pagination.selector }
                : { kind: "infiniteScroll" },
              signal: active.controller.signal,
            }),
            active.controller.signal,
          );
          if (advanceResult.aborted) {
            await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "aborted", byteSize, pageCount);
            return;
          }
          const advanced = advanceResult.value;
          if (advanced.status === "changed") {
            rawPage = advanced.page;
            break;
          }
          if (advanced.status === "no_change") {
            pageCount += 1;
            noNewRowsRounds += 1;
            await checkpointCollectionResult(active.resultId, {
              rows,
              byteSize,
              pageCount,
              duplicateCount,
              missingRequiredCount,
            });
            this.emit(active, "persisting", pageCount, rows.length, byteSize);
            if (noNewRowsRounds >= 2) {
              await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "no_new_rows", byteSize, pageCount);
              return;
            }
            if (pageCount >= recipe.pagination.maxPages) {
              await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, "max_pages", byteSize, pageCount);
              return;
            }
            continue;
          }
          const stopReason: CollectionStopReason = advanced.status === "missing"
            ? "pagination_missing"
            : advanced.status === "disabled"
              ? "pagination_disabled"
              : "aborted";
          await this.finish(active, sourceUrl, startedAt, rows, duplicateCount, missingRequiredCount, stopReason, byteSize, pageCount);
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failCollectionResult(active.resultId, message).catch(() => undefined);
      await finalizeRun(active.runId, { status: "error" }).catch(() => undefined);
      this.emit(active, "completed", 0, 0, 0);
    } finally {
      this.activeRuns.delete(active.runId);
      this.activeTabs.delete(active.tabId);
      active.resolveDone();
    }
  }

  private async finish(
    active: ActiveRun,
    sourceUrl: string,
    startedAt: number,
    rows: CollectionRow[],
    duplicateCount: number,
    missingRequiredCount: number,
    stopReason: CollectionStopReason,
    byteSize = 0,
    pageCount = 0
  ): Promise<void> {
    if (pageCount === 0) {
      await checkpointCollectionResult(active.resultId, {
        rows,
        byteSize,
        pageCount,
        duplicateCount,
        missingRequiredCount,
      });
    }
    const finishedAt = this.now();
    const summary: CollectionRunSummary = {
      runId: active.runId,
      resultId: active.resultId,
      sourceUrl,
      status: stopReason === "completed" ? "completed" : "partial",
      stopReason,
      rowCount: rows.length,
      byteSize,
      pageCount,
      duplicateCount,
      missingRequiredCount,
      preview: rows.slice(0, 5),
      startedAt,
      finishedAt,
    };
    await finalizeCollectionResult(active.resultId, summary);
    await finalizeRun(active.runId, { status: "ok", output: summary as unknown as Json });
    this.emit(active, "completed", pageCount, rows.length, byteSize, stopReason);
    await pruneCollectionResults();
  }

  private emit(
    active: ActiveRun,
    phase: CollectionProgress["phase"],
    pageCount: number,
    rowCount: number,
    byteSize: number,
    stopReason?: CollectionStopReason
  ): void {
    try {
      this.deps.broadcast({
        type: "collection.progress",
        runId: active.runId,
        phase,
        pageCount,
        rowCount,
        byteSize,
        ...(stopReason == null ? {} : { stopReason }),
      });
    } catch {
      // The sidepanel is optional; a closed UI must not stop the run.
    }
  }
}
