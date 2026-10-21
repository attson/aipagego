import { beforeEach, describe, expect, it, vi } from "vitest";
import { install } from "@/content/recorder/main-world";

type Rec = ReturnType<typeof install>;

function fresh(): Rec {
  const w = window as unknown as { __AIPAGEGO_REC__?: unknown };
  delete w.__AIPAGEGO_REC__;
  return install();
}

describe("main-world recorder — console", () => {
  let rec: Rec;
  beforeEach(() => {
    rec = fresh();
  });

  it("captures console calls with level and serialised text", () => {
    console.warn("careful", { n: 1 });
    const entry = rec.console.toArray().at(-1)!;
    expect(entry.level).toBe("warn");
    expect(entry.text).toContain("careful");
    expect(entry.text).toContain("n: 1");
  });

  it("still forwards to the underlying console", () => {
    const seen: unknown[] = [];
    const before = console.log;
    console.log = (...a: unknown[]) => seen.push(a[0]);
    const r = fresh();
    console.log("hi");
    expect(seen).toEqual(["hi"]);
    expect(r.console.toArray().at(-1)!.text).toBe("hi");
    r.uninstall();
    console.log = before;
  });

  it("records uncaught errors with file and line", () => {
    window.dispatchEvent(
      new ErrorEvent("error", { message: "kaboom", filename: "a.js", lineno: 7 })
    );
    const entry = rec.console.toArray().at(-1)!;
    expect(entry.level).toBe("error");
    expect(entry.text).toContain("kaboom");
    expect(entry.line).toBe(7);
    expect(entry.url).toBe("a.js");
  });

  it("stops recording when the console channel is switched off", () => {
    rec.configure({ console: false });
    const before = rec.console.toArray().length;
    console.error("ignored");
    expect(rec.console.toArray()).toHaveLength(before);
  });
});

describe("main-world recorder — network", () => {
  let rec: Rec;

  beforeEach(() => {
    window.fetch = vi.fn(
      async () =>
        new Response("{\"ok\":true}", {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json" }
        })
    ) as typeof fetch;
    rec = fresh();
  });

  it("records method, url and status", async () => {
    await window.fetch("https://a.test/api", { method: "POST" });
    const entry = rec.network.toArray().at(-1)!;
    expect(entry.method).toBe("POST");
    expect(entry.url).toBe("https://a.test/api");
    expect(entry.status).toBe(201);
    expect(typeof entry.ms).toBe("number");
  });

  it("skips response bodies unless armed", async () => {
    await window.fetch("https://a.test/one");
    const first = rec.network.toArray().at(-1)!.id;
    expect(rec.details.get(first)?.responseBody).toBeUndefined();

    rec.configure({ bodies: true });
    await window.fetch("https://a.test/two");
    const second = rec.network.toArray().at(-1)!.id;
    expect(rec.details.get(second)?.responseBody).toBe("{\"ok\":true}");
  });

  it("always keeps response headers for inspection", async () => {
    await window.fetch("https://a.test/hdr");
    const id = rec.network.toArray().at(-1)!.id;
    expect(rec.details.get(id)?.responseHeaders?.["content-type"]).toContain("application/json");
  });

  it("records rejections and rethrows", async () => {
    window.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const r = fresh();
    await expect(window.fetch("https://a.test/down")).rejects.toThrow("Failed to fetch");
    expect(r.network.toArray().at(-1)!.error).toContain("Failed to fetch");
  });
});

describe("main-world recorder — lifecycle", () => {
  it("uninstall restores globals and drops the handle", () => {
    const rec = fresh();
    const patched = console.log;
    rec.uninstall();
    expect(console.log).not.toBe(patched);
    expect(rec.console.toArray()).toEqual([]);
    expect(window.__AIPAGEGO_REC__).toBeUndefined();
  });

  it("configure clears only the requested buffers", () => {
    const rec = fresh();
    console.log("a");
    rec.dialog.push({ id: 99, ts: 1, kind: "alert", message: "m", handled: "passthrough" });
    rec.configure({ clear: ["console"] });
    expect(rec.console.toArray()).toEqual([]);
    expect(rec.dialog.toArray()).toHaveLength(1);
  });
});
