import { z } from "zod";
import {
  CollectionRecipeSchema,
  CollectionRunSummarySchema,
  type CollectionRecipeV1,
  type CollectionRunSummary,
} from "@aipagego/shared/collection";
import type { Json, RunSource } from "@aipagego/shared/types";

export type CollectionExecutionContext = {
  timeoutMs?: number;
  source?: RunSource;
};

export type CollectionRunner = {
  runAndWait(input: {
    tabId: number;
    recipe: CollectionRecipeV1;
    timeoutMs?: number;
    source?: RunSource;
  }): Promise<CollectionRunSummary>;
};

let registeredRunner: CollectionRunner | null = null;

export function registerCollectionRunner(runner: CollectionRunner): void {
  registeredRunner = runner;
}

export function createCollectStructuredDataHandler(runner: CollectionRunner) {
  return async (
    args: Json,
    tabId: number,
    context: CollectionExecutionContext = {},
  ): Promise<Json> => {
    const parsed = z.object({ recipe: CollectionRecipeSchema }).parse(args);
    const summary = await runner.runAndWait({
      tabId,
      recipe: parsed.recipe,
      ...(context.timeoutMs == null ? {} : { timeoutMs: context.timeoutMs }),
      ...(context.source == null ? {} : { source: context.source }),
    });
    return CollectionRunSummarySchema.parse(summary) as unknown as Json;
  };
}

export async function collectStructuredData(
  args: Json,
  tabId: number,
  context?: CollectionExecutionContext,
): Promise<Json> {
  if (!registeredRunner) throw new Error("collection runner is not initialized");
  return createCollectStructuredDataHandler(registeredRunner)(args, tabId, context);
}
