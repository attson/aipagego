import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoordinatorChatHost } from "@/background/coordinator-chat";
import * as state from "@/background/coordinator-state";
import type { ServerToClient, ClientToServer } from "@aipagego/shared/protocol";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";
import type { Approver } from "@/sidepanel/chat/approval";

function makeEnv() {
  return { nonce: "n", ts: 0, protocol_version: PROTOCOL_VERSION };
}

const startMsg = (sessionId = "s1", mock_llm?: unknown): ServerToClient => ({
  ...makeEnv(),
  type: "START_CHAT_SESSION",
  session_id: sessionId,
  user_prompt: "do thing",
  ...(mock_llm ? { mock_llm } : {})
} as ServerToClient);

beforeEach(() => {
  vi.spyOn(state, "loadAllowRemoteChat").mockResolvedValue(true);
});

describe("CoordinatorChatHost.handle", () => {
  it("rejects START_CHAT_SESSION when allow flag is false", async () => {
    vi.spyOn(state, "loadAllowRemoteChat").mockResolvedValue(false);
    const sent: ClientToServer[] = [];
    const fakeRun = vi.fn();
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    await host.handle(startMsg(), (m) => sent.push(m));
    expect(fakeRun).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("CHAT_EVENT");
    if (sent[0].type !== "CHAT_EVENT") throw new Error();
    expect(sent[0].event.type).toBe("session_end");
    if (sent[0].event.type !== "session_end") throw new Error();
    expect(sent[0].event.status).toBe("error");
    expect(sent[0].event.reason).toMatch(/disabled/);
  });

  it("rejects a second START_CHAT_SESSION while one is running", async () => {
    const sent: ClientToServer[] = [];
    let resolveFirst: (() => void) | null = null;
    const fakeRun = vi.fn(() =>
      new Promise<void>((r) => { resolveFirst = r; })
    );
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    void host.handle(startMsg("first"), (m) => sent.push(m));
    await new Promise((r) => setTimeout(r, 0));
    await host.handle(startMsg("second"), (m) => sent.push(m));
    const rej = sent.find((m) =>
      m.type === "CHAT_EVENT" && m.session_id === "second"
    );
    expect(rej).toBeTruthy();
    if (rej && rej.type === "CHAT_EVENT" && rej.event.type === "session_end") {
      expect(rej.event.reason).toMatch(/another session/i);
    } else {
      throw new Error("expected error session_end for second");
    }
    (resolveFirst as (() => void) | null)?.();
  });

  it("ABORT_SESSION aborts the matching session", async () => {
    let aborted = false;
    const fakeRun = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      return new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => { aborted = true; resolve(); });
      });
    });
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    void host.handle(startMsg("s1"), () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    await host.handle({ ...makeEnv(), type: "ABORT_SESSION", session_id: "s1" }, () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
  });

  it("ABORT_SESSION with mismatched id is silently ignored", async () => {
    const fakeRun = vi.fn(() => new Promise<void>(() => undefined));  // never resolves
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    void host.handle(startMsg("s1"), () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    // doesn't throw, doesn't send anything
    await host.handle({ ...makeEnv(), type: "ABORT_SESSION", session_id: "other" }, () => undefined);
  });

  it("forwards SessionEvents as CHAT_EVENT messages", async () => {
    const sent: ClientToServer[] = [];
    const fakeRun = vi.fn(async ({ onEvent }: { onEvent?: (e: unknown) => void }) => {
      onEvent?.({ type: "round_start", round: 0 });
      onEvent?.({ type: "text_delta", text: "hi" });
      onEvent?.({ type: "session_end", status: "done", lastOutput: null });
    });
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    await host.handle(startMsg("s1"), (m) => sent.push(m));
    const chatEvents = sent.filter((m) => m.type === "CHAT_EVENT");
    expect(chatEvents).toHaveLength(3);
    expect(chatEvents.every((m) => m.type === "CHAT_EVENT" && m.session_id === "s1")).toBe(true);
  });

  it("auto-approves dangerous tools via injected approver", async () => {
    let approverDecision: unknown = null;
    const fakeRun = vi.fn(async ({ approver }: { approver: Approver }) => {
      // Simulate run-session needing to approve a dangerous tool
      approverDecision = await approver.request("tool-use-id-1");
    });
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    await host.handle(startMsg("s1", { rounds: [] }), () => undefined);
    expect(approverDecision).toEqual({ kind: "run" });
  });

  it("reports remote tab-group lifecycle and awaiting status", async () => {
    const onSessionStart = vi.fn();
    const onSessionStatus = vi.fn();
    const onSessionEnd = vi.fn();
    const fakeRun = vi.fn(async ({ onEvent }: { onEvent?: (e: any) => void }) => {
      onEvent?.({ type: "tool_use_end", id: "t", name: "click", input: {} });
      onEvent?.({ type: "tool_running", id: "t" });
    });
    const host = new CoordinatorChatHost({
      runChatSession: fakeRun as never,
      pickActiveTab: async () => 42,
      urlFor: async () => "https://example.com/",
      onSessionStart,
      onSessionStatus,
      onSessionEnd
    });

    await host.handle(startMsg("remote-1"), () => undefined);

    expect(onSessionStart).toHaveBeenCalledWith("remote-1", 42);
    expect(onSessionStatus).toHaveBeenCalledWith("remote-1", "awaiting");
    expect(onSessionStatus).toHaveBeenCalledWith("remote-1", "running");
    expect(onSessionEnd).toHaveBeenCalledWith("remote-1");
  });
});
