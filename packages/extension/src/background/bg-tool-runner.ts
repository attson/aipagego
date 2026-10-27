import type { Json, Step } from "@aipagego/shared/types";
import type { ToolRunner } from "@/sidepanel/chat/tool-runner";
import { runOneStep } from "./rpc-handlers";

/**
 * ToolRunner implementation that runs tools directly in the background
 * service worker. Used by CoordinatorChatHost when running a coordinator-
 * driven chat session — there's no sidepanel to round-trip through.
 */
export class BackgroundToolRunner implements ToolRunner {
  async runStep(
    step: Step,
    tabId: number,
    attachedTabIds: number[],
    bindings: Record<string, Json>
  ): Promise<Json> {
    return runOneStep(step, tabId, attachedTabIds, bindings, {
      source: "coordinator",
    });
  }
}
