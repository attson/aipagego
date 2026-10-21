import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFabPos, getPanelSize, hideHost, setFabPos } from "@/content/widget/per-site";

const storage: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  (globalThis as any).chrome = {
    storage: { local: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, storage[key]]))),
      set: vi.fn(async (values: Record<string, unknown>) => Object.assign(storage, values))
    } }
  };
});

describe("widget per-site state", () => {
  it("adds an assistant-disabled override for the current host", async () => {
    storage["aipagego.llm"] = { siteInjectionRules: [] };
    await hideHost("WWW.Example.com.");
    expect(storage["aipagego.llm"]).toEqual({
      siteInjectionRules: [{ pattern: "www.example.com", injectionMode: "inherit", assistant: "disabled" }]
    });
  });

  it("stores FAB positions per host", async () => {
    await setFabPos("x.com", { x: 100, y: 200 });
    expect(await getFabPos("x.com")).toEqual({ x: 100, y: 200 });
    expect(await getFabPos("other.com")).toBeNull();
  });

  it("uses the default panel size when none is stored", async () => {
    expect(await getPanelSize()).toEqual({ w: 320, h: 480 });
  });
});
