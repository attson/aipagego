import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildHello } from "../../src/background/coordinator-hello";
import { HelloSchema, PROTOCOL_VERSION } from "@aipagego/shared/protocol";

function fakeChrome(tabs: { id: number; url: string; title: string }[] = []) {
  return {
    tabs: {
      query: vi.fn(async () => tabs)
    },
    runtime: { id: "chrome-ext-id-fake", getManifest: () => ({ version: "0.0.8" }) }
  };
}

beforeEach(() => {
  vi.stubGlobal("chrome", fakeChrome([
    { id: 1, url: "https://example.com", title: "Example" },
    { id: 2, url: "https://shop.example.com/goods.html", title: "Shop goods" }
  ]));
});

describe("buildHello", () => {
  it("produces a payload that parses with HelloSchema", async () => {
    const payload = await buildHello({
      worker_id: "worker_abc",
      saved_tools: [],
      labels: []
    });
    const parsed = HelloSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("includes protocol_version + type=HELLO + worker_id", async () => {
    const payload = await buildHello({
      worker_id: "worker_abc",
      saved_tools: [],
      labels: []
    });
    expect(payload.type).toBe("HELLO");
    expect(payload.worker_id).toBe("worker_abc");
    expect(payload.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it("advertises incognito tab opening", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [],
      labels: []
    });
    expect(payload.capabilities).toContain("tab:open-incognito");
  });

  it("maps open tabs to available_tabs entries (tab_id as string)", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [],
      labels: []
    });
    expect(payload.available_tabs).toEqual([
      { tab_id: "1", url: "https://example.com", title: "Example" },
      { tab_id: "2", url: "https://shop.example.com/goods.html", title: "Shop goods" }
    ]);
  });

  it("passes through saved_tools and labels", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [
        { id: "shop_v3", version: 1, hash: "abc", url_pattern: ["https://*.example.com/**"] }
      ],
      labels: ["chrome:macos", "logged-in:shop"]
    });
    expect(payload.saved_tools[0].id).toBe("shop_v3");
    expect(payload.labels).toEqual(["chrome:macos", "logged-in:shop"]);
  });

  it("fingerprint has ext_hash/os/chrome fields filled", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [],
      labels: []
    });
    expect(payload.fingerprint.ext_hash.length).toBeGreaterThan(0);
    expect(payload.fingerprint.chrome.length).toBeGreaterThan(0);
  });
});
