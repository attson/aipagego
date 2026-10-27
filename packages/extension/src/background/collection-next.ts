import {
  CollectionPageExtractionSchema,
  type CollectionRecipeV1,
} from "@aipagego/shared/collection";
import type { CollectionAdvanceNextResult } from "./collection-orchestrator";

export type CollectionNextDeps = {
  clickNext: (tabId: number, selector: string) => Promise<"clicked" | "missing" | "disabled">;
  readTab: (tabId: number) => Promise<{ url?: string; status?: string }>;
  extractPage: (tabId: number, recipe: CollectionRecipeV1) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export async function advanceCollectionNextPage(
  input: {
    tabId: number;
    selector: string;
    recipe: CollectionRecipeV1;
    previousUrl: string;
    previousFingerprint: string;
    signal: AbortSignal;
  },
  deps: CollectionNextDeps,
  timeoutMs = 15_000
): Promise<CollectionAdvanceNextResult> {
  const clicked = await deps.clickNext(input.tabId, input.selector);
  if (clicked !== "clicked") return { status: clicked };

  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (input.signal.aborted) return { status: "aborted" };
    try {
      const [tab, rawPage] = await Promise.all([
        deps.readTab(input.tabId),
        deps.extractPage(input.tabId, input.recipe),
      ]);
      const page = CollectionPageExtractionSchema.parse(rawPage);
      const urlChanged = (tab.url ?? "") !== input.previousUrl;
      const pageChanged = tab.status !== "loading" && (
        urlChanged || page.fingerprint !== input.previousFingerprint
      );
      if (pageChanged) {
        return { status: "changed", page };
      }
    } catch {
      // Navigation temporarily removes the content receiver; retry until the
      // explicit 15s contract expires.
    }
    await deps.sleep(250);
  }
  return input.signal.aborted ? { status: "aborted" } : { status: "timeout" };
}
