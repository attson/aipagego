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
    const got = await chrome.storage.local.get("aipagego.settings");
    expect((got["aipagego.settings"] as { model: string }).model).toBe("demo-model");
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

  it("returns empty collections for the list endpoints", async () => {
    installChromeShim();
    for (const type of ["tools.list", "tools.matching", "runs.list", "presets.list"]) {
      expect(await chrome.runtime.sendMessage({ type })).toEqual({ ok: true, data: [] });
    }
  });
});
