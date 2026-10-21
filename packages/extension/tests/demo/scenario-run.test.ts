import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChatSession } from "@/sidepanel/chat/run-session";
import { Approver } from "@/sidepanel/chat/approval";
import { MockLlmClient } from "@/background/mock-llm-client";
import { DEMO_PROMPT, DEMO_ROUNDS } from "../../demo/scenario";
import { COMMENTS_ID, mountMockPage } from "../../demo/page";
import { runDemoStep } from "../../demo/harness";
import { TOOL_DEFS } from "@aipagego/shared/llm";

/**
 * The demo's headline claim, end to end: the scripted conversation drives the
 * product's own tools and the mock page really changes. Covers everything
 * except the iframe plumbing, which the bridge tests own.
 */
describe("demo scenario, executed", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id='root'></div>";
    mountMockPage(document.getElementById("root")!);
  });

  it("runs to completion and expands the comments on the real page", async () => {
    const approver = new Approver();
    // Auto-approve as soon as anything is requested, standing in for the click
    // a visitor makes on the approval bar.
    const originalRequest = approver.request.bind(approver);
    vi.spyOn(approver, "request").mockImplementation((id: string) => {
      queueMicrotask(() => approver.resolve(id, { kind: "approve" } as never));
      return originalRequest(id);
    });

    const seenTools: string[] = [];

    const result = await runChatSession({
      client: new MockLlmClient(DEMO_ROUNDS),
      runner: {
        runStep: async (step) => {
          const s = step as { tool?: string };
          if (s.tool) seenTools.push(s.tool);
          return (await runDemoStep(step)) as never;
        }
      },
      approver,
      rpc: {
        startSession: async () => ({ id: "demo" }),
        appendStepLog: async () => undefined,
        finalizeSession: async () => undefined
      } as never,
      input: { userPrompt: DEMO_PROMPT, tabId: 1, url: "https://demo.test/p" },
      settings: {
        provider: "anthropic",
        model: "demo",
        maxTokens: 4096,
        maxRounds: 20,
        trustedDangerTools: []
      } as never,
      systemPrompt: "demo",
      tools: TOOL_DEFS,
      permissionMode: "yolo"
    });

    expect(["done", "max_rounds"]).toContain(result.status);
    expect(seenTools).toContain("click");
    // The claim: the product's own click tool changed the real DOM.
    expect(document.querySelector<HTMLElement>(`#${COMMENTS_ID}`)!.hidden).toBe(false);
  }, 20000);
});
