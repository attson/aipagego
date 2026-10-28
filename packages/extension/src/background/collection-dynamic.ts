import {
  CollectionPageExtractionSchema,
  type CollectionPageExtraction,
  type CollectionRecipeV1,
} from "@aipagego/shared/collection";

export type CollectionDynamicAction =
  | { kind: "loadMore"; selector: string }
  | { kind: "infiniteScroll" };

export type CollectionAdvanceDynamicResult =
  | { status: "changed"; page: CollectionPageExtraction }
  | { status: "missing" | "disabled" | "no_change" | "aborted" };

export type CollectionDynamicDeps = {
  advance: (
    tabId: number,
    action: CollectionDynamicAction
  ) => Promise<"clicked" | "scrolled" | "missing" | "disabled">;
  extractPage: (tabId: number, recipe: CollectionRecipeV1) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export async function advanceCollectionDynamicPage(
  input: {
    tabId: number;
    recipe: CollectionRecipeV1;
    previousFingerprint: string;
    previousMatchedCount: number;
    action: CollectionDynamicAction;
    signal: AbortSignal;
  },
  deps: CollectionDynamicDeps,
  timeoutMs = 15_000
): Promise<CollectionAdvanceDynamicResult> {
  if (input.signal.aborted) return { status: "aborted" };
  const advanced = await deps.advance(input.tabId, input.action);
  if (advanced === "missing" || advanced === "disabled") {
    return { status: advanced };
  }

  const deadline = deps.now() + timeoutMs;
  let observedPage = false;
  let lastExtractionError: unknown;
  while (deps.now() < deadline) {
    if (input.signal.aborted) return { status: "aborted" };
    try {
      const page = CollectionPageExtractionSchema.parse(
        await deps.extractPage(input.tabId, input.recipe)
      );
      observedPage = true;
      if (
        page.matchedCount > input.previousMatchedCount ||
        page.fingerprint !== input.previousFingerprint
      ) {
        return { status: "changed", page };
      }
    } catch (error) {
      lastExtractionError = error;
      // A page may briefly replace its DOM or content receiver while loading.
      // Keep polling until the explicit wait window expires.
    }
    await deps.sleep(250);
  }
  if (!observedPage && lastExtractionError != null) throw lastExtractionError;
  return input.signal.aborted ? { status: "aborted" } : { status: "no_change" };
}
