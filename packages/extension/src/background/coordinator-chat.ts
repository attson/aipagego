import type {
  ServerToClient,
  ClientToServer,
  StartChatSession,
  AbortSession
} from "@aipagego/shared/protocol";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";
import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";
import type { RunSessionArgs, SessionEvent } from "@/sidepanel/chat/run-session";
import { runChatSession as defaultRunChatSession } from "@/sidepanel/chat/run-session";
import { MockLlmClient } from "./mock-llm-client";
import { BackgroundToolRunner } from "./bg-tool-runner";
import { Approver, type Decision } from "@/sidepanel/chat/approval";
import type { ToolRunner } from "@/sidepanel/chat/tool-runner";
import { TOOL_DEFS } from "@/sidepanel/llm/tool-schema";
import { loadAllowRemoteChat } from "./coordinator-state";
import { createRun, appendStepLog, finalizeRun } from "./storage/runs";
import type { Json, RunStepLogEntry } from "@aipagego/shared/types";

// Auto-approves every tool request. Used in coordinator-driven sessions
// where the user has already opted in via the allow_remote_chat flag —
// no further per-tool approval should be required.
class AutoApprover extends Approver {
  request(_id: string): Promise<Decision> {
    return Promise.resolve({ kind: "run" });
  }
}

type RunChatSessionFn = (args: RunSessionArgs) => Promise<unknown>;

export interface CoordinatorChatHostOptions {
  runChatSession?: RunChatSessionFn;
  loadSystemPrompt?: () => Promise<string>;
  pickActiveTab?: () => Promise<number>;
  urlFor?: (tabId: number) => Promise<string>;
  buildRealLlmClient?: () => Promise<LlmClient>;
  /** Override the tool runner (E2E tests use this to skip real chrome.scripting calls). */
  runner?: ToolRunner;
  onSessionStart?: (sessionId: string, tabId: number) => void | Promise<void>;
  onSessionStatus?: (sessionId: string, status: "running" | "awaiting") => void | Promise<void>;
  onSessionEnd?: (sessionId: string) => void | Promise<void>;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function chatEvent(session_id: string, event: SessionEvent): ClientToServer {
  return {
    type: "CHAT_EVENT",
    session_id,
    event: event as never,         // wire schema validates on send via CoordinatorClient
    nonce: randomNonce(),
    ts: Date.now(),
    protocol_version: PROTOCOL_VERSION
  };
}

function sessionEndError(reason: string): SessionEvent {
  return { type: "session_end", status: "error", lastOutput: null, reason };
}

export class CoordinatorChatHost {
  private active: { sessionId: string; abort: AbortController } | null = null;
  private readonly run: RunChatSessionFn;
  private readonly loadSystem: () => Promise<string>;
  private readonly pickTab: () => Promise<number>;
  private readonly url: (tabId: number) => Promise<string>;
  private readonly buildReal: () => Promise<LlmClient>;
  private readonly runner: ToolRunner | undefined;
  private readonly onSessionStart?: CoordinatorChatHostOptions["onSessionStart"];
  private readonly onSessionStatus?: CoordinatorChatHostOptions["onSessionStatus"];
  private readonly onSessionEnd?: CoordinatorChatHostOptions["onSessionEnd"];

  constructor(opts: CoordinatorChatHostOptions = {}) {
    this.run = opts.runChatSession ?? (defaultRunChatSession as RunChatSessionFn);
    this.loadSystem = opts.loadSystemPrompt ?? (async () => "");
    this.pickTab = opts.pickActiveTab ?? defaultPickActiveTab;
    this.url = opts.urlFor ?? defaultUrlFor;
    this.buildReal = opts.buildRealLlmClient ?? (async () => {
      // Fallback stub — only fails if something actually tries to stream.
      // This lets injected runChatSession (used in unit tests) ignore the client.
      return {
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error("no real LLM client available: mock_llm required in this build");
        }
      };
    });
    this.runner = opts.runner;
    this.onSessionStart = opts.onSessionStart;
    this.onSessionStatus = opts.onSessionStatus;
    this.onSessionEnd = opts.onSessionEnd;
  }

  async handle(
    msg: ServerToClient,
    send: (m: ClientToServer) => void
  ): Promise<void> {
    switch (msg.type) {
      case "START_CHAT_SESSION":
        await this.handleStart(msg, send);
        return;
      case "ABORT_SESSION":
        this.handleAbort(msg);
        return;
      default:
        return;
    }
  }

  private async handleStart(
    msg: StartChatSession,
    send: (m: ClientToServer) => void
  ): Promise<void> {
    if (this.active) {
      send(chatEvent(msg.session_id, sessionEndError("another session is running")));
      return;
    }
    if (!(await loadAllowRemoteChat())) {
      send(chatEvent(msg.session_id, sessionEndError("remote chat disabled in settings")));
      return;
    }

    const ac = new AbortController();
    this.active = { sessionId: msg.session_id, abort: ac };

    try {
      const client: LlmClient = msg.mock_llm
        ? new MockLlmClient(msg.mock_llm.rounds as LlmStreamEvent[][])
        : await this.buildReal();

      const tabId = msg.tab_id != null ? Number.parseInt(msg.tab_id, 10) : await this.pickTab();
      const url = await this.url(tabId);
      await this.onSessionStart?.(msg.session_id, tabId);

      await this.run({
        client,
        runner: this.runner ?? new BackgroundToolRunner(),
        approver: new AutoApprover(),
        rpc: makeBgRpc(),
        input: { userPrompt: msg.user_prompt, tabId, url },
        settings: {
          provider: "anthropic",
          model: "mock",
          apiKey: "",
          apiKeyMode: "session",
          maxRounds: msg.settings_override?.maxRounds ?? 20,
          trustedDangerTools: [],
          defaultPermissionMode: "default",
          theme: "dark",
          maxContinuationNudges: msg.settings_override?.maxContinuationNudges ?? 1,
          selfHealEnabled: true,
          maxSelfHealOutputTokens: 4096,
          defaultInjectionMode: "diagnostic",
          defaultAssistantEnabled: true,
          siteInjectionRules: [],
        },
        systemPrompt: await this.loadSystem(),
        tools: TOOL_DEFS,
        permissionMode: "default",
        getAttachedTabIds: () => [],
        abortSignal: ac.signal,
        onEvent: (e) => {
          if (e.type === "tool_use_end") void this.onSessionStatus?.(msg.session_id, "awaiting");
          if (e.type === "tool_running" || e.type === "text_delta" || e.type === "round_start") {
            void this.onSessionStatus?.(msg.session_id, "running");
          }
          send(chatEvent(msg.session_id, e));
        }
      });
    } catch (e) {
      send(chatEvent(msg.session_id, sessionEndError(e instanceof Error ? e.message : String(e))));
    } finally {
      await this.onSessionEnd?.(msg.session_id);
      this.active = null;
    }
  }

  private handleAbort(msg: AbortSession): void {
    if (this.active?.sessionId === msg.session_id) {
      this.active.abort.abort();
    }
  }
}

async function defaultPickActiveTab(): Promise<number> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return 0;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (id == null) throw new Error("no active tab to drive");
  return id;
}

async function defaultUrlFor(tabId: number): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.tabs?.get) return "";
  const t = await chrome.tabs.get(tabId);
  return t.url ?? "";
}

// makeBgRpc adapts the background storage functions to the SessionRpc shape
// runChatSession expects, with source="coordinator" on every run record.
function makeBgRpc() {
  return {
    async startSession(input: { url: string }): Promise<{ id: string }> {
      const r = await createRun({
        toolId: null,
        toolVersion: null,
        url: input.url,
        source: "coordinator"
      });
      return { id: r.id };
    },
    async appendStepLog(runId: string, entry: {
      stepIndex: number; input: Json; output: Json; ms: number; error?: string;
    }): Promise<unknown> {
      const log: RunStepLogEntry = {
        stepIndex: entry.stepIndex,
        input: entry.input,
        output: entry.output,
        ms: entry.ms,
        ...(entry.error != null ? { error: entry.error } : {})
      };
      await appendStepLog(runId, log);
      return null;
    },
    async finalizeSession(
      runId: string, status: "ok" | "error" | "aborted", output?: Json
    ): Promise<unknown> {
      await finalizeRun(runId, { status, output });
      return null;
    }
  };
}
