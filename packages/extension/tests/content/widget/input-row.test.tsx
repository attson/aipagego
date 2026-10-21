import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputRow } from "@/content/widget/input-row";
import type { SessionData } from "@/sidepanel/chat/session-store";
import type { ImagePart } from "@aipagego/shared/types";

vi.mock("@/sidepanel/chat/session-store", async (orig) => {
  const actual = await orig<typeof import("@/sidepanel/chat/session-store")>();
  return { ...actual, setPermissionMode: vi.fn() };
});

vi.mock("@/sidepanel/chat/settings-store", () => ({
  useSettings: (selector: any) =>
    selector({ trustedDangerTools: [], save: vi.fn().mockResolvedValue(undefined) }),
}));

function makeSession(patch: Partial<SessionData>): SessionData {
  return {
    tabId: 1, url: "", runRecordId: null,
    messages: [], streamingAssistantText: "", cards: [],
    status: "idle", errorMessage: null, roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [], lastOutput: null, showSaveDialog: false,
    abortController: null, logs: [], logsOpen: false,
    inputDraft: "", attachedTabs: [], llmExchanges: [],
    permissionMode: "default", debugBadge: null,
    chatMode: "compact", _rev: 0,
    ...patch,
  } as SessionData;
}

describe("InputRow", () => {
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

  it("shows send button when not busy", async () => {
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "idle" })}
          tabId={1}
          input="hello"
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
          stagedImages={[]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={false}
        />
      )
    );
    expect(container.querySelector("[data-testid=widget-send-btn]")).toBeTruthy();
    expect(container.querySelector("[data-testid=widget-stop-btn]")).toBeNull();
  });

  it("shows stop button when busy and calls onStop on click", async () => {
    const onStop = vi.fn();
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "running" })}
          tabId={1}
          input=""
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={onStop}
          stagedImages={[]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={true}
        />
      )
    );
    const stopBtn = container.querySelector("[data-testid=widget-stop-btn]") as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    await act(async () => stopBtn.click());
    expect(onStop).toHaveBeenCalled();
  });

  it("renders staged images strip", async () => {
    const img: ImagePart = {
      type: "image",
      media_type: "image/png",
      data: "AAAA",
    };
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "idle" })}
          tabId={1}
          input=""
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
          stagedImages={[img]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={false}
        />
      )
    );
    expect(container.querySelector("[data-testid=staged-images]")).toBeTruthy();
  });

  it("send button disabled when input empty and no images", async () => {
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "idle" })}
          tabId={1}
          input=""
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
          stagedImages={[]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={false}
        />
      )
    );
    const sendBtn = container.querySelector("[data-testid=widget-send-btn]") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });
});
