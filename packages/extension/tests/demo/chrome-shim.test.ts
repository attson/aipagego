import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_TAB_ID, installChromeShim } from "../../demo/chrome-shim";

const realChrome = globalThis.chrome;
afterEach(() => {
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

describe("chrome shim", () => {
  it("starts the panel already configured", async () => {
    installChromeShim();
    const got = await chrome.storage.local.get([
      "aipagego.llm",
      "aipagego.firstRun.v1",
      "aipagego.update_check_v1",
    ]);
    expect((got["aipagego.llm"] as { model: string; apiKey: string }).model).toBe("demo-model");
    expect((got["aipagego.llm"] as { model: string; apiKey: string }).apiKey).toBe("demo-key");
    expect(got["aipagego.firstRun.v1"]).toMatchObject({
      version: 1,
      disposition: "existing_user",
    });
    expect(got["aipagego.update_check_v1"]).toMatchObject({ tag: "v0.0.0" });
  });

  it("round-trips storage and notifies listeners", async () => {
    installChromeShim();
    const seen: unknown[] = [];
    chrome.storage.onChanged.addListener((c) => seen.push(c));
    await chrome.storage.local.set({ k: 1 });
    expect((await chrome.storage.local.get("k")).k).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("reports exactly one tab", async () => {
    installChromeShim();
    const tabs = await chrome.tabs.query({});
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(DEMO_TAB_ID);
    expect(String(tabs[0].url)).toContain("http");
  });

  it("forwards page steps to the harness and returns the result", async () => {
    const onPageStep = vi.fn(async () => ({ clicked: true }));
    installChromeShim({ onPageStep });
    const res = await chrome.runtime.sendMessage({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "click", args: {} }
    });
    expect(onPageStep).toHaveBeenCalled();
    expect(res).toEqual({ ok: true, data: { clicked: true } });
  });

  it("forwards collection previews to the page harness", async () => {
    const onPageStep = vi.fn(async () => ({ returnedCount: 1 }));
    installChromeShim({ onPageStep });
    const recipe = {
      version: 1,
      mode: "single",
      fields: [{
        id: "title",
        name: "标题",
        selector: "h1",
        valueMode: "text",
        required: true,
      }],
      pagination: { kind: "single" },
      dedupeBy: [],
      maxRows: 2_000,
      maxBytes: 5 * 1024 * 1024,
    };

    const res = await chrome.runtime.sendMessage({
      type: "collections.preview",
      tabId: DEMO_TAB_ID,
      recipe,
    });

    expect(onPageStep).toHaveBeenCalledWith({ kind: "collectionPreview", recipe });
    expect(res).toEqual({ ok: true, data: { returnedCount: 1 } });
  });

  it("runs and restores a demo collection through the production page extractor", async () => {
    const runtimeMessages: unknown[] = [];
    const onPageStep = vi.fn(async () => ({
      rows: [{ values: { title: "人体工学办公椅 Pro" }, missingRequired: [] }],
      pageUrl: "https://demo.aipagego.local/product/ergo-chair-pro",
      fingerprint: "page-1",
      matchedCount: 1,
      truncatedBy: null,
    }));
    installChromeShim({ onPageStep });
    chrome.runtime.onMessage.addListener((message) => {
      runtimeMessages.push(message);
      return false;
    });
    const recipe = {
      version: 1,
      mode: "single",
      fields: [{ id: "title", name: "标题", selector: "h1", valueMode: "text", required: true }],
      pagination: { kind: "single" },
      dedupeBy: [],
      maxRows: 2_000,
      maxBytes: 5 * 1024 * 1024,
    };

    const started = await chrome.runtime.sendMessage({
      type: "collections.start",
      tabId: DEMO_TAB_ID,
      recipe,
    }) as { ok: true; data: { runId: string } };
    await vi.waitFor(async () => {
      expect(await chrome.runtime.sendMessage({
        type: "collections.runs.get",
        runId: started.data.runId,
      })).toMatchObject({ ok: true, data: { status: "completed", rowCount: 1 } });
    });
    const snapshot = await chrome.runtime.sendMessage({
      type: "collections.runs.get",
      runId: started.data.runId,
    }) as { ok: true; data: { resultId: string } };
    expect(await chrome.runtime.sendMessage({
      type: "collections.results.read",
      resultId: snapshot.data.resultId,
      offset: 0,
      limit: 50,
    })).toMatchObject({ ok: true, data: { rows: [{ title: "人体工学办公椅 Pro" }] } });
    expect(onPageStep).toHaveBeenCalledWith({ kind: "collectionExtractPage", recipe });
    expect(runtimeMessages).toContainEqual(expect.objectContaining({
      type: "collection.progress",
      phase: "completed",
      rowCount: 1,
    }));
  });

  it("keeps two next pages and a machine-readable final stop reason", async () => {
    let pageIndex = 1;
    installChromeShim({
      onPageStep: async (step: unknown) => {
        const input = step as { kind?: string };
        if (input.kind === "collectionAdvanceNext") {
          if (pageIndex === 1) {
            pageIndex = 2;
            return { status: "clicked" };
          }
          return { status: "missing" };
        }
        return {
          rows: [{ values: { title: `P${pageIndex}` }, missingRequired: [] }],
          pageUrl: `https://demo.example/${pageIndex}`,
          fingerprint: `page-${pageIndex}`,
          matchedCount: 1,
          duplicateCount: 0,
          truncatedBy: null,
        };
      },
    });
    const started = await chrome.runtime.sendMessage({
      type: "collections.start",
      tabId: DEMO_TAB_ID,
      recipe: {
        version: 1,
        mode: "single",
        fields: [{ id: "title", name: "标题", selector: "h1", valueMode: "text", required: true }],
        pagination: { kind: "next", selector: ".next", maxPages: 3 },
        dedupeBy: [],
        maxRows: 2_000,
        maxBytes: 5 * 1024 * 1024,
      },
    }) as { ok: true; data: { runId: string } };

    await vi.waitFor(async () => {
      expect(await chrome.runtime.sendMessage({
        type: "collections.runs.get",
        runId: started.data.runId,
      })).toMatchObject({
        ok: true,
        data: {
          status: "partial",
          stopReason: "pagination_missing",
          pageCount: 2,
          rowCount: 2,
        },
      });
    });
  });

  it("runs load-more pages through the dynamic page action", async () => {
    let pageIndex = 1;
    installChromeShim({
      onPageStep: async (step: unknown) => {
        const input = step as { kind?: string; action?: { kind?: string; selector?: string } };
        if (input.kind === "collectionAdvanceDynamic") {
          expect(input.action).toEqual({ kind: "loadMore", selector: ".more" });
          if (pageIndex === 1) {
            pageIndex = 2;
            return { status: "clicked" };
          }
          return { status: "missing" };
        }
        return {
          rows: Array.from({ length: pageIndex }, (_, index) => ({
            values: { title: `P${index + 1}` },
            missingRequired: [],
          })),
          pageUrl: "https://demo.example/list",
          fingerprint: `page-${pageIndex}`,
          matchedCount: pageIndex,
          duplicateCount: 0,
          truncatedBy: null,
        };
      },
    });

    const started = await chrome.runtime.sendMessage({
      type: "collections.start",
      tabId: DEMO_TAB_ID,
      recipe: {
        version: 1,
        mode: "list",
        itemSelector: ".item",
        fields: [{ id: "title", name: "标题", selector: ".title", valueMode: "text", required: true }],
        pagination: { kind: "loadMore", selector: ".more", maxPages: 3 },
        dedupeBy: ["title"],
        maxRows: 2_000,
        maxBytes: 5 * 1024 * 1024,
      },
    }) as { ok: true; data: { runId: string } };

    await vi.waitFor(async () => {
      expect(await chrome.runtime.sendMessage({
        type: "collections.runs.get",
        runId: started.data.runId,
      })).toMatchObject({
        ok: true,
        data: {
          status: "partial",
          stopReason: "pagination_missing",
          pageCount: 2,
          rowCount: 2,
          duplicateCount: 1,
        },
      });
    });
  });

  it("turns a page-step failure into an rpc error", async () => {
    installChromeShim({
      onPageStep: async () => {
        throw new Error("selector miss");
      }
    });
    const res = (await chrome.runtime.sendMessage({ type: "runs.runOneStep", step: {} })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("selector miss");
  });

  it("saves, matches and replays a structured collection tool on a similar URL", async () => {
    const onPageStep = vi.fn(async () => ({
      rows: [{ values: { title: "相似页面商品" }, missingRequired: [] }],
      pageUrl: "https://demo.aipagego.local/product/another",
      fingerprint: "similar-page",
      matchedCount: 1,
      truncatedBy: null,
    }));
    installChromeShim({
      url: "https://demo.aipagego.local/product/another",
      onPageStep,
      seed: { "aipagego.llm": { apiKey: "" } },
    });
    const recipe = {
      version: 1,
      mode: "single",
      fields: [{ id: "title", name: "标题", selector: "h1", valueMode: "text", required: true }],
      pagination: { kind: "single" },
      dedupeBy: [],
      maxRows: 2_000,
      maxBytes: 5 * 1024 * 1024,
    };
    const saved = await chrome.runtime.sendMessage({
      type: "tools.save",
      draft: {
        kind: "steps",
        name: "相似商品采集",
        urlPatterns: ["https://*.aipagego.local/product/**"],
        description: "",
        steps: [{ kind: "tool", tool: "collectStructuredData", args: { recipe }, timeoutMs: 600_000 }],
        outputSchema: { type: "object" },
      },
    }) as { ok: true; data: Record<string, unknown> & { id: string } };

    expect(saved.data).toMatchObject({ kind: "steps", activeVersion: 1 });
    expect(saved.data).not.toHaveProperty("steps");
    expect(saved.data).not.toHaveProperty("outputSchema");
    expect(saved.data.versions).toEqual([expect.objectContaining({ parameters: [] })]);

    expect(await chrome.runtime.sendMessage({
      type: "tools.matching",
      url: "https://demo.aipagego.local/product/another",
    })).toMatchObject({ ok: true, data: [{ id: saved.data.id }] });

    const replayed = await chrome.runtime.sendMessage({
      type: "runs.start",
      target: { kind: "tool", id: saved.data.id },
      tabId: DEMO_TAB_ID,
    });
    expect(replayed).toMatchObject({
      ok: true,
      data: {
        status: "ok",
        output: { rowCount: 1, resultId: expect.any(String) },
      },
    });
    expect(onPageStep).toHaveBeenCalledWith({ kind: "collectionExtractPage", recipe });
  });

  it("publishes and activates canonical workflow snapshots without copying versions", async () => {
    installChromeShim();
    const saved = await chrome.runtime.sendMessage({
      type: "tools.save",
      draft: {
        kind: "steps",
        name: "Workflow demo",
        urlPatterns: ["https://example.com/**"],
        description: "",
        steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" }, bindResultTo: "title" }],
        outputBinding: "title",
        outputSchema: { type: "string" },
      },
    }) as { ok: true; data: { id: string } };

    expect(await chrome.runtime.sendMessage({
      type: "workflows.publish",
      id: saved.data.id,
      basedOnVersion: 1,
      parameters: [],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h2" }, bindResultTo: "title" }],
      outputBinding: "title",
      outputSchema: { type: "string" },
    })).toMatchObject({ ok: true, data: { activeVersion: 2, versions: [{ version: 1 }, { version: 2 }] } });

    const activated = await chrome.runtime.sendMessage({
      type: "workflows.activate",
      id: saved.data.id,
      version: 1,
    });
    expect(activated).toMatchObject({ ok: true, data: { activeVersion: 1 } });
    expect((activated as { data: { versions: unknown[] } }).data.versions).toHaveLength(2);
  });

  it("rejects invalid saved tools and missing replay targets instead of returning demo success", async () => {
    installChromeShim();

    expect(await chrome.runtime.sendMessage({
      type: "tools.save",
      draft: {
        kind: "steps",
        name: "未知工具",
        urlPatterns: ["https://example.com/**"],
        description: "",
        steps: [{ kind: "tool", tool: "unknownFutureTool", args: {} }],
        outputSchema: {},
      },
    })).toMatchObject({ ok: false, error: expect.stringContaining("invalid tool draft") });

    expect(await chrome.runtime.sendMessage({
      type: "runs.start",
      target: { kind: "tool", id: "missing" },
      tabId: DEMO_TAB_ID,
    })).toEqual({ ok: false, error: "demo shim: tool not found" });
  });

  it("answers an unknown request instead of hanging", async () => {
    installChromeShim();
    const res = (await chrome.runtime.sendMessage({ type: "nope.unknown" })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unhandled rpc");
  });

  it("says so when no page runner is wired", async () => {
    installChromeShim();
    const res = (await chrome.runtime.sendMessage({ type: "runs.runOneStep", step: {} })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no page runner");
  });

  it("returns empty collections for the untouched list endpoints", async () => {
    installChromeShim();
    for (const type of ["tools.list", "tools.matching", "runs.list", "presets.list"]) {
      expect(await chrome.runtime.sendMessage({ type })).toEqual({ ok: true, data: [] });
    }
  });
});
