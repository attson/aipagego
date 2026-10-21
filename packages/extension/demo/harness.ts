import type { Json } from "@aipagego/shared/types";
import { callTool } from "@/content/tools";
import { serveBridge } from "./bridge";

/**
 * Plays the service worker for the demo: receives steps from the panel iframe
 * and resolves them against this document, which holds the mock page.
 *
 * The point is that it calls the product's own `callTool` — the highlight and
 * the expanded comments a visitor sees are produced by the same code that runs
 * on a real site, not by demo choreography.
 */

type Step =
  | { kind: "tool"; tool: string; args?: Json }
  | { kind: "js"; source: string }
  | Record<string, unknown>;

/**
 * Tools that need extension-only APIs. They get canned results rather than
 * failing, so the panel renders a normal card instead of an error the visitor
 * would read as a broken product.
 */
const CANNED: Record<string, Json> = {
  screenshot: { media_type: "image/png", data: "", byteLen: 0 } as unknown as Json,
  downloadSpreadsheet: { downloadId: 1, filename: "demo.xlsx", sheets: 1, rows: 3 } as unknown as Json,
  downloadImage: { downloadId: 2, filename: "demo.png" } as unknown as Json,
  listTabs: [{ tabId: 1, url: location.href, title: document.title, active: true }] as unknown as Json,
  openTab: { tabId: 1, url: location.href, title: document.title } as unknown as Json,
  closeTab: { ok: true, tabId: 1 } as unknown as Json,
  switchToTab: { ok: true, tabId: 1 } as unknown as Json,
  searchBookmarks: [] as unknown as Json,
  searchHistory: [] as unknown as Json
};

export async function runDemoStep(step: unknown): Promise<Json> {
  const s = (step ?? {}) as Step;

  if ("kind" in s && s.kind === "js") {
    // Arbitrary JS has no place in a demo that anyone can load.
    return { ok: false, reason: "runJS is disabled in the demo" } as unknown as Json;
  }

  const tool = "tool" in s ? String((s as { tool: string }).tool) : "";
  if (!tool) throw new Error("demo harness: step has no tool");

  if (tool in CANNED) return CANNED[tool];

  const args = ("args" in s ? (s as { args?: Json }).args : undefined) ?? ({} as Json);
  // Errors propagate: the panel already renders them as error cards, and a demo
  // that cannot show a failure is misleading in its own way.
  return callTool(tool as Parameters<typeof callTool>[0], args);
}

export function installHarness(self: Window = window): () => void {
  return serveBridge(self, (step) => runDemoStep(step));
}
