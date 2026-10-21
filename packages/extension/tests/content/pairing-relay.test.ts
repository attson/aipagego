import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPairingRelay } from "@/content/pairing-relay";
import {
  PAIR_PAGE_SOURCE,
  PAIR_READY_SOURCE,
  PAIR_RESULT_SOURCE
} from "@aipagego/shared/pairing";

const realChrome = globalThis.chrome;

const payload = {
  v: 1,
  installId: "inst_abc",
  secret: "s3cr3t",
  sessionId: "sess_1",
  label: "~/code/aipagego",
  pid: 1234,
  port: 51234,
  mcpVersion: "0.0.74"
};

let sent: unknown[];
let reply: unknown;

/** Waits for the relay's async round-trip to settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function results(): Array<Record<string, unknown>> {
  return posted.filter((m) => m.source === PAIR_RESULT_SOURCE);
}
let posted: Array<Record<string, unknown>>;

beforeEach(() => {
  sent = [];
  posted = [];
  reply = { decision: "trusted" };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.0.75" }),
      sendMessage: vi.fn(async (m: unknown) => {
        sent.push(m);
        return reply;
      })
    }
  } as unknown as typeof chrome;

  document.documentElement.innerHTML = "<body></body>";
  window.addEventListener("message", (ev) => {
    const d = ev.data as Record<string, unknown>;
    if (d && d.source === PAIR_RESULT_SOURCE) posted.push(d);
  });
  installPairingRelay();
});

afterEach(() => {
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

/**
 * Dispatched rather than posted so `source` is genuinely `window` — happy-dom's
 * postMessage sets it to an unrelated EventTarget, which the relay correctly
 * refuses.
 */
const pairMessage = (p: unknown = payload) =>
  window.dispatchEvent(
    new MessageEvent("message", { data: { source: PAIR_PAGE_SOURCE, payload: p }, source: window })
  );

describe("pairing relay", () => {
  it("forwards a well-formed payload to the worker", async () => {
    pairMessage();
    await settle();
    expect(sent[0]).toMatchObject({ type: "pairing.request", payload });
  });

  it("ignores messages from another source", async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { source: "something-else", payload }, source: window })
    );
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("ignores a message from a foreign frame", async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: PAIR_PAGE_SOURCE, payload },
        source: null
      })
    );
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("ignores a payload that fails the shape check", async () => {
    for (const bad of [
      null,
      "string",
      { ...payload, v: 2 },
      { ...payload, installId: "" },
      { ...payload, port: "51234" },
      { ...payload, secret: undefined }
    ]) {
      pairMessage(bad);
    }
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("reports success without an overlay when already trusted", async () => {
    pairMessage();
    await settle();
    expect(document.querySelector("[data-aipagego-pairing]")).toBeNull();
    expect(results()[0]).toMatchObject({
      ok: true,
      trusted: true,
      extensionVersion: "0.0.75",
      versionWarning: "MCP v0.0.74 低于扩展 v0.0.75，请更新 MCP"
    });
  });

  it("accepts a legacy payload and reports that its MCP version is unknown", async () => {
    const { mcpVersion: _mcpVersion, ...legacy } = payload;
    pairMessage(legacy);
    await settle();
    expect(results()[0]).toMatchObject({
      ok: true,
      versionWarning: "MCP 版本未知，客户端可能过旧，请更新 MCP"
    });
  });

  it("does not warn when MCP and extension versions match", async () => {
    pairMessage({ ...payload, mcpVersion: "0.0.75" });
    await settle();
    expect(results()[0]).toMatchObject({
      ok: true,
      extensionVersion: "0.0.75",
      versionWarning: null
    });
  });

  it("renders an overlay when the worker asks", async () => {
    reply = { decision: "ask" };
    pairMessage();
    await settle();
    expect(document.querySelector("[data-aipagego-pairing]")).not.toBeNull();
  });

  it("keeps the overlay out of the page's reach", async () => {
    reply = { decision: "ask" };
    pairMessage();
    await settle();
    const host = document.querySelector("[data-aipagego-pairing]")!;
    // A closed shadow root is not reachable from the page.
    expect(host.shadowRoot).toBeNull();
  });

  it("reports a connection error separately from user denial", async () => {
    reply = { error: "boom" };
    pairMessage();
    await settle();
    expect(results()[0]).toMatchObject({ ok: false, reason: "connection_error" });
  });
});

describe("pairing relay — install ordering", () => {
  // The page's inline script runs during parsing; the content script hosting
  // this relay runs at document_idle. A page that posts once, before the relay
  // exists, would otherwise wait forever.
  it("announces readiness when it installs", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const listener = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown>;
      if (d && d.source === PAIR_READY_SOURCE) seen.push(d);
    };
    window.addEventListener("message", listener);
    installPairingRelay();
    await settle();
    window.removeEventListener("message", listener);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("handles a request that arrives after the announcement", async () => {
    installPairingRelay();
    await settle();
    pairMessage();
    await settle();
    expect(sent.some((m) => (m as { type?: string }).type === "pairing.request")).toBe(true);
  });
});
