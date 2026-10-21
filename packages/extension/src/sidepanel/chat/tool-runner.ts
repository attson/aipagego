import type { Json, Step } from "@aipagego/shared/types";

export interface ToolRunner {
  runStep(
    step: Step,
    tabId: number,
    attachedTabIds: number[],
    bindings: Record<string, Json>
  ): Promise<Json>;
}

export class RpcToolRunner implements ToolRunner {
  constructor(
    private send: (req: unknown) => Promise<
      { ok: true; data: Json } | { ok: false; error: string } | undefined
    >
  ) {}

  async runStep(
    step: Step,
    tabId: number,
    attachedTabIds: number[],
    bindings: Record<string, Json>
  ): Promise<Json> {
    const res = await this.send({
      type: "runs.runOneStep",
      step,
      tabId,
      attachedTabIds,
      bindings
    });
    // chrome.runtime.sendMessage resolves to undefined if the BG listener
    // closes the channel without sending a response. That happens when the
    // RpcRequest schema rejects the envelope (e.g. an unknown tool name).
    // Without this guard we'd crash with the opaque `Cannot read properties
    // of undefined (reading 'ok')` TypeError.
    if (res == null) {
      const toolName = step.kind === "tool" ? step.tool : "runJS";
      throw new Error(
        `BG returned no response for ${toolName} — likely a schema mismatch on the request envelope. Reload the extension (chrome://extensions → 重载) and re-open the side panel.`
      );
    }
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }
}
