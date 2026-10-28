import type { CollectionRecipeV1 } from "@aipagego/shared/collection";
import { matchesAny } from "@aipagego/shared/url-pattern";
import { ToolDraftSchema, ToolSchema } from "@aipagego/shared/messages";
import { getActiveStepsVersion } from "@aipagego/shared/workflow";
import type { Tool } from "@aipagego/shared/types";

/**
 * Stands in for the extension runtime so the real side panel can run as a plain
 * web page.
 *
 * The surface is small because `sidepanel/rpc.ts` funnels every background call
 * through one `chrome.runtime.sendMessage(req)`. Beyond that the panel only
 * touches storage, tabs, and a little bookmarks/history.
 *
 * Anything the shim does not recognise resolves `{ok:false}` rather than
 * hanging: the panel's RPC retries four times with backoff on a missing
 * receiver, so a silent drop would stall the demo for seconds.
 */

export type PageStepRunner = (step: unknown, bindings?: unknown) => Promise<unknown>;

export type ShimOptions = {
  /** Resolves steps that need the page — forwarded to the harness. */
  onPageStep?: PageStepRunner;
  /** Seeds storage so the panel starts configured and never asks for a key. */
  seed?: Record<string, unknown>;
  tabId?: number;
  url?: string;
  title?: string;
};

type Listener = (changes: Record<string, unknown>, area: string) => void;
type RuntimeListener = (message: unknown) => unknown;

export const DEMO_TAB_ID = 1;
export const DEMO_URL = "https://demo.aipagego.local/product/ergo-chair-pro";
export const DEMO_TITLE = "人体工学办公椅 Pro";

/** Settings that make the panel behave as if it were already configured. */
export function demoSeed(): Record<string, unknown> {
  return {
    "aipagego.llm": {
      provider: "anthropic",
      model: "demo-model",
      apiKey: "demo-key",
      apiKeyMode: "persistent",
      maxTokens: 4096,
      maxRounds: 20,
      defaultPermissionMode: "default"
    },
    "aipagego.firstRun.v1": {
      version: 1,
      disposition: "existing_user",
      updatedAt: "2026-10-23T00:00:00.000Z"
    },
    // Keep public demos and store screenshots deterministic: UpdateBanner
    // reads this cache instead of depending on the latest GitHub release.
    "aipagego.update_check_v1": {
      tag: "v0.0.0",
      ts: 4_102_444_800_000,
    },
    "aipagego.demo": true
  };
}

export function installChromeShim(opts: ShimOptions = {}): void {
  const store = new Map<string, unknown>(Object.entries({ ...demoSeed(), ...opts.seed }));
  const listeners = new Set<Listener>();
  const runtimeListeners = new Set<RuntimeListener>();
  const collectionRuns = new Map<string, Record<string, unknown>>();
  const collectionResults = new Map<string, Array<Record<string, string | null>>>();
  const savedTools = new Map<string, Record<string, unknown>>();
  const cancelledRuns = new Set<string>();
  let collectionSequence = 0;
  let toolSequence = 0;
  let toolRunSequence = 0;
  const tabId = opts.tabId ?? DEMO_TAB_ID;
  const tab = {
    id: tabId,
    windowId: 1,
    active: true,
    url: opts.url ?? DEMO_URL,
    title: opts.title ?? DEMO_TITLE
  };

  const ok = (data: unknown) => ({ ok: true as const, data });
  const fail = (error: string) => ({ ok: false as const, error });
  const broadcast = (message: unknown) => {
    for (const listener of runtimeListeners) listener(message);
  };

  async function handleRpc(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as {
      type?: string;
      step?: unknown;
      bindings?: unknown;
      recipe?: unknown;
      runId?: string;
      resultId?: string;
      id?: string;
      offset?: number;
      limit?: number;
      version?: number;
      basedOnVersion?: number;
      parameters?: unknown[];
      steps?: unknown[];
      outputBinding?: string;
      outputSchema?: unknown;
      note?: string;
      url?: string;
      draft?: Record<string, unknown>;
      target?: { kind?: string; id?: string; draft?: Record<string, unknown> };
    };
    switch (r.type) {
      case "runs.runOneStep":
      case "scripting.injectMain": {
        if (!opts.onPageStep) return fail("demo: no page runner wired");
        try {
          return ok(await opts.onPageStep(r.step ?? req, r.bindings));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
      case "collections.preview": {
        if (!opts.onPageStep) return fail("demo: no page runner wired");
        try {
          return ok(await opts.onPageStep({ kind: "collectionPreview", recipe: r.recipe }));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
      case "collections.start": {
        if (!opts.onPageStep) return fail("demo: no page runner wired");
        const sequence = ++collectionSequence;
        const runId = `demo_collection_run_${sequence}`;
        const resultId = `demo_collection_result_${sequence}`;
        const startedAt = Date.now();
        const sourceUrl = tab.url ?? "";
        collectionRuns.set(runId, {
          runId,
          resultId,
          tabId,
          sourceUrl,
          recipe: r.recipe,
          status: "running",
          phase: "starting",
          rowCount: 0,
          byteSize: 0,
          pageCount: 0,
          duplicateCount: 0,
          missingRequiredCount: 0,
          startedAt,
        });
        broadcast({
          type: "collection.progress",
          runId,
          phase: "starting",
          pageCount: 0,
          rowCount: 0,
          byteSize: 0,
        });
        void (async () => {
          try {
            collectionRuns.set(runId, {
              ...collectionRuns.get(runId),
              phase: "extracting",
            });
            broadcast({
              type: "collection.progress",
              runId,
              phase: "extracting",
              pageCount: 0,
              rowCount: 0,
              byteSize: 0,
            });
            const recipe = r.recipe as CollectionRecipeV1;
            const rows: Array<Record<string, string | null>> = [];
            const seen = new Set<string>();
            const fingerprints = new Set<string>();
            let missingRequiredCount = 0;
            let duplicateCount = 0;
            let byteSize = 0;
            let pageCount = 0;
            let stopReason = "completed";
            while (true) {
              if (cancelledRuns.has(runId)) {
                stopReason = "aborted";
                break;
              }
              const extracted = await opts.onPageStep!({
                kind: "collectionExtractPage",
                recipe,
              }) as {
                rows?: Array<{ values?: Record<string, string | null>; missingRequired?: string[] }>;
                fingerprint?: string;
                duplicateCount?: number;
                truncatedBy?: "max_rows" | "max_bytes" | null;
              };
              if (extracted.fingerprint && fingerprints.has(extracted.fingerprint)) {
                stopReason = "repeated_page";
                break;
              }
              if (extracted.fingerprint) fingerprints.add(extracted.fingerprint);
              duplicateCount += extracted.duplicateCount ?? 0;
              for (const row of extracted.rows ?? []) {
                const values = row.values ?? {};
                const dedupeValues = recipe.dedupeBy.map((fieldId) => values[fieldId]);
                const key = recipe.dedupeBy.length > 0 && dedupeValues.every(
                  (value) => value != null && value !== ""
                ) ? JSON.stringify(dedupeValues) : null;
                if (key != null && seen.has(key)) {
                  duplicateCount += 1;
                  continue;
                }
                if (rows.length >= recipe.maxRows) {
                  stopReason = "max_rows";
                  break;
                }
                const nextByteSize = byteSize + new TextEncoder().encode(JSON.stringify(values)).byteLength;
                if (nextByteSize > recipe.maxBytes) {
                  stopReason = "max_bytes";
                  break;
                }
                if (key != null) seen.add(key);
                rows.push(values);
                byteSize = nextByteSize;
                if ((row.missingRequired?.length ?? 0) > 0) missingRequiredCount += 1;
              }
              pageCount += 1;
              if (stopReason !== "completed") break;
              if (extracted.truncatedBy) {
                stopReason = extracted.truncatedBy;
                break;
              }
              if (recipe.pagination.kind === "single") break;
              if (pageCount >= recipe.pagination.maxPages) {
                stopReason = "max_pages";
                break;
              }
              const advanced = recipe.pagination.kind === "next"
                ? await opts.onPageStep!({
                    kind: "collectionAdvanceNext",
                    selector: recipe.pagination.selector,
                  }) as { status?: "clicked" | "missing" | "disabled" }
                : await opts.onPageStep!({
                    kind: "collectionAdvanceDynamic",
                    action: recipe.pagination.kind === "loadMore"
                      ? { kind: "loadMore", selector: recipe.pagination.selector }
                      : { kind: "infiniteScroll" },
                  }) as { status?: "clicked" | "scrolled" | "missing" | "disabled" };
              if (advanced.status !== "clicked" && advanced.status !== "scrolled") {
                stopReason = advanced.status === "disabled"
                  ? "pagination_disabled"
                  : "pagination_missing";
                break;
              }
            }
            const finishedAt = Date.now();
            const status = stopReason === "completed" ? "completed" : "partial";
            const summary = {
              runId,
              resultId,
              sourceUrl,
              status,
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
            collectionResults.set(resultId, rows);
            collectionRuns.set(runId, {
              runId,
              resultId,
              tabId,
              sourceUrl,
              recipe,
              status,
              phase: "completed",
              rowCount: rows.length,
              byteSize,
              pageCount,
              duplicateCount,
              missingRequiredCount,
              startedAt,
              finishedAt,
              stopReason,
              summary,
            });
            broadcast({
              type: "collection.progress",
              runId,
              phase: "completed",
              pageCount,
              rowCount: rows.length,
              byteSize,
              stopReason,
            });
          } catch (error) {
            collectionRuns.set(runId, {
              ...collectionRuns.get(runId),
              status: "error",
              phase: "completed",
              error: error instanceof Error ? error.message : String(error),
              finishedAt: Date.now(),
            });
            broadcast({
              type: "collection.progress",
              runId,
              phase: "completed",
              pageCount: 0,
              rowCount: 0,
              byteSize: 0,
            });
          }
        })();
        return ok({ runId });
      }
      case "collections.runs.get":
        return ok(r.runId ? collectionRuns.get(r.runId) ?? null : null);
      case "collections.cancel":
        if (r.runId) cancelledRuns.add(r.runId);
        return ok(null);
      case "collections.results.read": {
        const rows = r.resultId ? collectionResults.get(r.resultId) : undefined;
        if (!rows) return fail(`result_expired: ${String(r.resultId)}`);
        const offset = r.offset ?? 0;
        const limit = r.limit ?? 50;
        const page = rows.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        const hasMore = nextOffset < rows.length;
        return ok({ rows: page, hasMore, nextOffset: hasMore ? nextOffset : null });
      }
      case "tools.save": {
        const parsed = ToolDraftSchema.safeParse(r.draft);
        if (!parsed.success) return fail(`demo shim: invalid tool draft: ${parsed.error.message}`);
        const draft = parsed.data;
        const id = `demo_tool_${++toolSequence}`;
        const now = Date.now();
        const candidate = draft.kind === "steps"
          ? {
              kind: "steps",
              id,
              name: draft.name,
              description: draft.description,
              urlPatterns: draft.urlPatterns,
              activeVersion: 1,
              createdAt: now,
              updatedAt: now,
              versions: [{
                version: 1,
                kind: "steps",
                parameters: draft.parameters ?? [],
                steps: draft.steps,
                outputBinding: draft.outputBinding,
                outputSchema: draft.outputSchema ?? {},
                createdAt: now,
              }],
              stats: { runs: 0 },
            }
          : {
              ...draft,
              id,
              createdAt: now,
              updatedAt: now,
              versions: [{ version: 1, kind: "prompt", prompt: draft.prompt, createdAt: now }],
              stats: { runs: 0 },
            };
        const parsedTool = ToolSchema.safeParse(candidate);
        if (!parsedTool.success) return fail(`demo shim: invalid tool: ${parsedTool.error.message}`);
        savedTools.set(id, parsedTool.data as unknown as Record<string, unknown>);
        return ok(parsedTool.data);
      }
      case "tools.list":
        return ok([...savedTools.values()]);
      case "tools.get":
        return ok(r.id ? savedTools.get(r.id) ?? null : null);
      case "tools.matching":
        return ok([...savedTools.values()].filter((tool) =>
          Array.isArray(tool.urlPatterns) && matchesAny(r.url ?? tab.url ?? "", tool.urlPatterns as string[])
        ));
      case "workflows.publish": {
        const parsed = ToolSchema.safeParse(r.id ? savedTools.get(r.id) : undefined);
        if (!parsed.success || parsed.data.kind !== "steps") return fail("demo shim: workflow not found");
        const tool = parsed.data;
        if (tool.activeVersion !== r.basedOnVersion) return fail("workflow_version_conflict");
        const next = Math.max(...tool.versions.map((version) => version.version)) + 1;
        const now = Date.now();
        const updated = ToolSchema.safeParse({
          ...tool,
          activeVersion: next,
          updatedAt: now,
          versions: [...tool.versions, {
            version: next,
            kind: "steps",
            parameters: r.parameters ?? [],
            steps: r.steps,
            outputBinding: r.outputBinding,
            outputSchema: r.outputSchema ?? {},
            createdAt: now,
            note: r.note,
            basedOnVersion: r.basedOnVersion,
          }],
        });
        if (!updated.success) return fail(`demo shim: invalid workflow: ${updated.error.message}`);
        savedTools.set(tool.id, updated.data as unknown as Record<string, unknown>);
        return ok(updated.data);
      }
      case "workflows.activate": {
        const parsed = ToolSchema.safeParse(r.id ? savedTools.get(r.id) : undefined);
        if (!parsed.success || parsed.data.kind !== "steps") return fail("demo shim: workflow not found");
        if (!parsed.data.versions.some((snapshot) => snapshot.version === r.version)) {
          return fail("workflow_version_not_found");
        }
        const updated = { ...parsed.data, activeVersion: r.version!, updatedAt: Date.now() };
        savedTools.set(parsed.data.id, updated as unknown as Record<string, unknown>);
        return ok(updated);
      }
      case "runs.list":
      case "presets.list":
        return ok([]);
      case "tabs.list":
        return ok([tab]);
      case "tabs.open":
        return ok({ tabId, url: tab.url, title: tab.title });
      case "chat.session.start":
        return ok({ id: `demo_run_${Date.now()}` });
      case "chat.session.appendLog":
        return ok(null);
      case "chat.session.end":
        return ok({ id: "demo_run", status: "ok" });
      case "runs.start": {
        const target = r.target;
        let tool: Record<string, unknown> | undefined;
        let toolVersion = 1;
        if (target?.kind === "tool") {
          tool = target.id ? savedTools.get(target.id) : undefined;
          if (!tool) return fail("demo shim: tool not found");
          const parsed = ToolSchema.safeParse(tool);
          if (!parsed.success || parsed.data.kind !== "steps") {
            return fail("demo shim: prompt tools cannot run in the background");
          }
          const active = getActiveStepsVersion(parsed.data as Tool & { kind: "steps" });
          tool = { kind: "steps", steps: active.steps };
          toolVersion = active.version;
        } else if (target?.kind === "draft") {
          const parsed = ToolDraftSchema.safeParse(target.draft);
          if (!parsed.success) return fail(`demo shim: invalid run draft: ${parsed.error.message}`);
          tool = parsed.data as unknown as Record<string, unknown>;
        } else {
          return fail("demo shim: invalid run target");
        }
        if (tool.kind !== "steps" || !Array.isArray(tool.steps)) {
          return fail("demo shim: prompt tools cannot run in the background");
        }
        const step = tool.steps[0] as {
          kind?: string;
          tool?: string;
          args?: { recipe?: CollectionRecipeV1 };
        };
        if (step.kind !== "tool" || step.tool !== "collectStructuredData" || !step.args?.recipe) {
          return fail("demo shim: unsupported replay step");
        }
        const started = await handleRpc({ type: "collections.start", recipe: step.args.recipe }) as {
          ok: boolean;
          data?: { runId: string };
          error?: string;
        };
        if (!started.ok || !started.data) return fail(started.error ?? "demo collection failed to start");
        let snapshot: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 200; attempt++) {
          snapshot = collectionRuns.get(started.data.runId);
          if (snapshot?.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!snapshot || snapshot.status === "running") return fail("demo collection replay timeout");
        const runId = `demo_tool_run_${++toolRunSequence}`;
        const failed = snapshot.status === "error";
        return ok({
          id: runId,
          toolId: target?.id ?? null,
          toolVersion,
          url: tab.url ?? "",
          startedAt: snapshot.startedAt ?? Date.now(),
          finishedAt: snapshot.finishedAt ?? Date.now(),
          status: failed ? "error" : "ok",
          stepLog: [{
            stepIndex: 0,
            input: step.args,
            output: failed ? null : snapshot.summary,
            ms: 0,
            ...(failed ? { error: snapshot.error } : {}),
          }],
          output: failed ? undefined : snapshot.summary,
          source: "user",
        });
      }
      default:
        // Never hang. An unknown type is a bug in the demo, not a reason to
        // make the visitor wait through four retries.
        return fail(`demo shim: unhandled rpc ${String(r.type)}`);
    }
  }

  const shim = {
    runtime: {
      id: "aipagego-demo",
      getManifest: () => ({ version: "demo" }),
      getURL: (p: string) => p,
      sendMessage: (req: unknown) => handleRpc(req),
      onMessage: {
        addListener: (listener: RuntimeListener) => runtimeListeners.add(listener),
        removeListener: (listener: RuntimeListener) => runtimeListeners.delete(listener),
      },
      lastError: undefined
    },
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          const out: Record<string, unknown> = {};
          const wanted =
            typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [...store.keys()];
          for (const k of wanted) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store.get(k), newValue: v };
            store.set(k, v);
          }
          for (const l of listeners) l(changes, "local");
        },
        remove: async (key: string) => {
          store.delete(key);
        },
        clear: async () => store.clear()
      },
      session: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined
      },
      onChanged: {
        addListener: (fn: Listener) => listeners.add(fn),
        removeListener: (fn: Listener) => listeners.delete(fn)
      }
    },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      update: async () => tab,
      create: async () => tab,
      remove: async () => undefined,
      sendMessage: async () => undefined,
      captureVisibleTab: async () =>
        // 1x1 transparent png — the demo never shows a screenshot, but the
        // panel's visual-evidence path expects a data URL rather than a throw.
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      onRemoved: { addListener: () => undefined, removeListener: () => undefined },
      onUpdated: { addListener: () => undefined, removeListener: () => undefined },
      onActivated: { addListener: () => undefined, removeListener: () => undefined }
    },
    windows: { update: async () => undefined },
    bookmarks: { search: async () => [], getTree: async () => [] },
    history: { search: async () => [] },
    permissions: {
      contains: async () => false,
      request: async () => false,
      remove: async () => true,
    },
    downloads: { download: async () => 1 },
    alarms: {
      create: () => undefined,
      clear: async () => true,
      onAlarm: { addListener: () => undefined, removeListener: () => undefined }
    },
    sidePanel: { setOptions: async () => undefined, open: async () => undefined }
  };

  (globalThis as unknown as { chrome: unknown }).chrome = shim;
}
