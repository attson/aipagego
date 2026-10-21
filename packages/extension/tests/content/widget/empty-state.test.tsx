import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmptyState } from "@/content/widget/empty-state";
import type { SessionData } from "@/sidepanel/chat/session-store";

const mockMatch = vi.fn();
vi.mock("@aipagego/shared/match-presets", () => ({
  matchPresetsByUrl: (url: string) => mockMatch(url),
}));

function makeSession(url: string): SessionData {
  return {
    tabId: 1, url, runRecordId: null,
    messages: [], streamingAssistantText: "", cards: [],
    status: "idle", errorMessage: null, roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [], lastOutput: null, showSaveDialog: false,
    abortController: null, logs: [], logsOpen: false,
    inputDraft: "", attachedTabs: [], llmExchanges: [],
    permissionMode: "default", debugBadge: null,
    chatMode: "compact", _rev: 0,
  } as SessionData;
}

describe("EmptyState", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows QuickActions when no presets match", async () => {
    mockMatch.mockReturnValue([]);
    await act(async () =>
      root.render(
        <EmptyState
          session={makeSession("https://random.site/")}
          onFillInput={() => {}}
        />
      )
    );
    // QuickActions renders buttons (总结 / 抽重点 / 抽评论)
    expect(container.textContent).toContain("告诉 AI 你想让它做什么");
  });

  it("calls onFillInput with prompt when preset chip clicked", async () => {
    mockMatch.mockReturnValue([
      {
        id: "p1", name: "知乎摘要", description: "", category: "content",
        urlPatterns: ["https://zhihu.com/**"], version: 1,
        kind: "prompt", prompt: "总结这个问题下的高赞回答",
      },
    ]);
    let filled = "";
    await act(async () =>
      root.render(
        <EmptyState
          session={makeSession("https://zhihu.com/question/1")}
          onFillInput={(t) => (filled = t)}
        />
      )
    );
    // find button labeled 知乎摘要 and click
    const btns = Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];
    const target = btns.find((b) => b.textContent?.includes("知乎摘要"));
    expect(target).toBeTruthy();
    await act(async () => target!.click());
    expect(filled).toBe("总结这个问题下的高赞回答");
  });
});
