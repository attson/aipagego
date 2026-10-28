import type {
  ReplayableTool,
  ChatMessage,
  Json,
  LlmSettings,
  Step,
  TextPart,
  ToolResultPart,
  ToolUsePart
} from "@aipagego/shared/types";
import type { LlmClient, LlmTool } from "@/sidepanel/llm/types";
import { truncateContent } from "@/sidepanel/llm/truncate";
import type { ToolRunner } from "./tool-runner";
import { Approver, type Decision } from "./approval";
import { classifyTool, evaluateAutoApproval, type PermissionMode } from "./severity";
import type { UserMessageContent } from "./context-manager";
import {
  parsePermissionRequired,
  type PermissionRequired,
} from "@aipagego/shared/optional-permissions";

export type SessionRpc = {
  startSession: (input: { url: string }) => Promise<{ id: string }>;
  appendStepLog: (
    runId: string,
    entry: {
      stepIndex: number;
      input: Json;
      output: Json;
      ms: number;
      error?: string;
    }
  ) => Promise<unknown>;
  finalizeSession: (
    runId: string,
    status: "ok" | "error" | "aborted",
    output?: Json
  ) => Promise<unknown>;
};

export type CrossTabRpc = {
  listTabs: (
    windowId?: number
  ) => Promise<{ tabs: Array<{ tabId: number; windowId: number; url: string; title: string }> }>;
  openTab: (input: {
    url: string;
    active?: boolean;
    incognito?: boolean;
    windowId?: number;
  }) => Promise<{ tabId: number; url: string; title: string }>;
};

export type RunSessionInput = {
  userPrompt: string;
  userContent?: UserMessageContent;
  tabId: number;
  url: string;
};

export type SessionEvent =
  | { type: "round_start"; round: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string; input: Json }
  | { type: "assistant_turn_end"; toolUses: ToolUsePart[] }
  | { type: "tool_running"; id: string }
  | { type: "tool_done"; id: string; output: Json; ms: number }
  | { type: "tool_error"; id: string; error: string; ms: number }
  | { type: "tool_skipped"; id: string }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "continuation_nudge"; round: number; attempt: number }
  | { type: "stream_error"; error: string }
  | { type: "exception"; error: string }
  | { type: "session_end"; status: "done" | "aborted" | "max_rounds" | "error"; lastOutput: Json; reason?: string }
  | { type: "self_heal_started"; toolId: string; toolName: string; failedStepIndex: number }
  | { type: "self_heal_completed"; toolId: string; newVersion: number; fixedStepIndex: number }
  | { type: "self_heal_failed"; toolId: string; reason: "llm_error" | "budget_exceeded" | "invalid_output" | "static_scan_reject" | "step_still_fails" | "no_sidepanel" | "no_api_key" | "self_heal_disabled" }
  | {
      type: "permission_required";
      toolUseId: string;
      permission: PermissionRequired["permission"];
      capability: PermissionRequired["capability"];
    }
  | {
      type: "permission_resolved";
      toolUseId: string;
      permission: PermissionRequired["permission"];
      granted: boolean;
    };

export type RunSessionArgs = {
  client: LlmClient;
  runner: ToolRunner;
  approver: Approver;
  rpc: SessionRpc;
  input: RunSessionInput;
  settings: LlmSettings;
  systemPrompt: string;
  tools: LlmTool[];
  permissionMode: PermissionMode;
  askUser?: (input: unknown) => Promise<unknown>;
  screenshot?: (input: unknown) => Promise<{
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
    byteLen: number;
    target?: Json;
  }>;
  /** Sidepanel-side handlers for meta-plane tools (closeTab / switchToTab /
   *  searchBookmarks / searchHistory / downloadImage). Keyed by tool name. */
  metaTools?: Record<string, (input: unknown) => Promise<unknown>>;
  requestPermission?: (
    required: PermissionRequired & { toolUseId: string },
  ) => Promise<{ granted: true } | { granted: false; reason: "user_denied" }>;
  abortSignal?: AbortSignal;
  onEvent?: (e: SessionEvent) => void;
  initialMessages?: ChatMessage[];
  getAttachedTabIds?: () => number[];
  tabsRpc?: CrossTabRpc;
  onCrossTabResult?: (result: {
    kind: "attached" | "detached" | "opened";
    tabId: number;
    url?: string;
    title?: string;
    windowId?: number;
  }) => void;
};

export type RunSessionResult = {
  status: "done" | "aborted" | "max_rounds" | "error";
  runRecordId: string;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
};

const MAX_PARSE_RETRIES = 3;

const DEFAULT_MAX_CONTINUATION_NUDGES = 1;
const TOOL_RESULT_CONTEXT_CHAR_CAP = 12_000;
const OLD_TOOL_RESULT_CONTEXT_CHAR_CAP = 2_000;
const AGGRESSIVE_OLD_TOOL_RESULT_CONTEXT_CHAR_CAP = 600;
const LLM_MESSAGES_CONTEXT_CHAR_BUDGET = 28_000;
const SUBSTANTIAL_FINAL_TEXT_CHAR_THRESHOLD = 800;

function toolResultContent(value: Json): string {
  return truncateContent(JSON.stringify(value), TOOL_RESULT_CONTEXT_CHAR_CAP);
}

function toolResultPartSize(part: ToolResultPart): number {
  return typeof part.content === "string" ? part.content.length : JSON.stringify(part.content).length;
}

function compactToolResultPart(
  part: ToolResultPart,
  cap: number
): ToolResultPart {
  if (typeof part.content === "string") {
    return { ...part, content: truncateContent(part.content, cap) };
  }

  let remaining = cap;
  const content = part.content.map((block): TextPart => {
    if (block.type === "image") {
      return {
        type: "text",
        text: `[earlier screenshot omitted: ${block.media_type}, ${block.data.length} base64 chars]`
      };
    }
    const text = truncateContent(block.text, Math.max(0, remaining));
    remaining = Math.max(0, remaining - text.length);
    return { ...block, text };
  });
  return { ...part, content };
}

function compactMessagesForLlmWithCaps(
  messages: ChatMessage[],
  oldToolResultCap: number,
  latestToolResultCap: number
): ChatMessage[] {
  const toolResultParts = messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((part): part is ToolResultPart => part.type === "tool_result") : []
  );
  const latestToolResult = toolResultParts.at(-1);

  return messages.map((m): ChatMessage => {
    if (m.role === "assistant") return m;
    if (typeof m.content === "string") return m;

    return {
      role: "user",
      content: m.content.map((part) => {
        if (part.type !== "tool_result") return part;
        const cap = part === latestToolResult ? latestToolResultCap : oldToolResultCap;
        return toolResultPartSize(part) > cap ? compactToolResultPart(part, cap) : part;
      })
    };
  });
}

function compactMessagesForLlm(messages: ChatMessage[]): ChatMessage[] {
  let compacted = compactMessagesForLlmWithCaps(
    messages,
    OLD_TOOL_RESULT_CONTEXT_CHAR_CAP,
    TOOL_RESULT_CONTEXT_CHAR_CAP
  );
  if (JSON.stringify(compacted).length <= LLM_MESSAGES_CONTEXT_CHAR_BUDGET) return compacted;

  compacted = compactMessagesForLlmWithCaps(
    messages,
    AGGRESSIVE_OLD_TOOL_RESULT_CONTEXT_CHAR_CAP,
    Math.floor(TOOL_RESULT_CONTEXT_CHAR_CAP / 2)
  );
  if (JSON.stringify(compacted).length <= LLM_MESSAGES_CONTEXT_CHAR_BUDGET) return compacted;

  return compactMessagesForLlmWithCaps(messages, 240, 2_000);
}

function hasToolResultHistory(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((part) => part.type === "tool_result")
  );
}

function shouldNudgeTextOnlyTurn(
  text: string,
  messages: ChatMessage[],
  totalNudges: number,
  maxNudges: number
): boolean {
  if (totalNudges >= maxNudges) return false;
  if (
    hasToolResultHistory(messages) &&
    text.trim().length >= SUBSTANTIAL_FINAL_TEXT_CHAR_THRESHOLD
  ) {
    return false;
  }
  return true;
}

/**
 * Sent as a user turn when the model stops calling tools but the task may not
 * actually be finished. It asks the model to verify completeness (especially
 * for collection tasks) and either resume tool calls or give the final result.
 */
export const CONTINUATION_NUDGE_PROMPT = [
  "系统检查：你这一轮没有调用任何工具就停下了。请先确认任务是否真的已经全部完成——",
  "尤其是数据采集类任务：所有评论 / 分页 / 懒加载内容是否都已拉全？是否已按用户要求把数据完整返回、没有省略？",
  "如果还有没做完的部分，请继续调用工具把任务做完；如果确认已全部完成，再用一段文本给出最终完整结果即可。"
].join("\n");

export async function runChatSession(args: RunSessionArgs): Promise<RunSessionResult> {
  const messages: ChatMessage[] = [
    ...(args.initialMessages ?? []),
    { role: "user", content: args.input.userContent ?? args.input.userPrompt }
  ];
  const executedSteps: Step[] = [];
  let lastOutput: Json = null;
  const { id: runRecordId } = await args.rpc.startSession({ url: args.input.url });

  let parseFailures = 0;
  let stepIndexGlobal = 0;
  const maxNudges = args.settings.maxContinuationNudges ?? DEFAULT_MAX_CONTINUATION_NUDGES;
  let totalNudges = 0;

  for (let round = 0; round < args.settings.maxRounds; round++) {
    args.onEvent?.({ type: "round_start", round });

    const messagesForLlm = compactMessagesForLlm(messages);
    const stream = args.client.stream({
      apiKey: args.settings.apiKey,
      model: args.settings.model,
      system: args.systemPrompt,
      messages: messagesForLlm,
      tools: args.tools,
      endpoint: args.settings.endpoint,
      maxTokens: args.settings.maxTokens,
      abortSignal: args.abortSignal
    });

    const inputBufs = new Map<string, string>();
    const tuMeta = new Map<string, { name: string }>();
    const completedToolUses: ToolUsePart[] = [];
    let textBuf = "";
    let streamErr: string | null = null;

    try {
      for await (const ev of stream) {
        if (args.abortSignal?.aborted) {
          await args.rpc.finalizeSession(runRecordId, "aborted");
          args.onEvent?.({ type: "session_end", status: "aborted", lastOutput });
          return { status: "aborted", runRecordId, messages, executedSteps, lastOutput };
        }
        switch (ev.type) {
          case "text_delta":
            textBuf += ev.text;
            args.onEvent?.({ type: "text_delta", text: ev.text });
            break;
          case "tool_use_start":
            tuMeta.set(ev.id, { name: ev.name });
            inputBufs.set(ev.id, "");
            args.onEvent?.({ type: "tool_use_start", id: ev.id, name: ev.name });
            break;
          case "tool_use_input_delta":
            inputBufs.set(ev.id, (inputBufs.get(ev.id) ?? "") + ev.partial_json);
            args.onEvent?.({
              type: "tool_use_input_delta",
              id: ev.id,
              partial_json: ev.partial_json
            });
            break;
          case "tool_use_end": {
            const meta = tuMeta.get(ev.id);
            if (!meta) break;
            completedToolUses.push({ type: "tool_use", id: ev.id, name: meta.name, input: ev.input });
            args.onEvent?.({ type: "tool_use_end", id: ev.id, input: ev.input });
            break;
          }
          case "message_end":
            if (ev.usage) {
              args.onEvent?.({
                type: "usage",
                input_tokens: ev.usage.input_tokens,
                output_tokens: ev.usage.output_tokens
              });
            }
            break;
          case "error":
            streamErr = ev.error;
            args.onEvent?.({ type: "stream_error", error: ev.error });
            break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (args.abortSignal?.aborted) {
        await args.rpc.finalizeSession(runRecordId, "aborted");
        args.onEvent?.({ type: "session_end", status: "aborted", lastOutput });
        return { status: "aborted", runRecordId, messages, executedSteps, lastOutput };
      }
      args.onEvent?.({ type: "exception", error: msg });
      await args.rpc.finalizeSession(runRecordId, "error");
      args.onEvent?.({ type: "session_end", status: "error", lastOutput, reason: msg });
      throw new Error(msg);
    }

    if (streamErr) {
      parseFailures++;
      if (parseFailures >= MAX_PARSE_RETRIES) {
        await args.rpc.finalizeSession(runRecordId, "error");
        args.onEvent?.({
          type: "session_end",
          status: "error",
          lastOutput,
          reason: `LLM stream error (${parseFailures} times): ${streamErr}`
        });
        return { status: "error", runRecordId, messages, executedSteps, lastOutput };
      }
      messages.push({
        role: "user",
        content: `Previous response had a streaming error: ${streamErr}. Please try again.`
      });
      continue;
    }

    const assistantContent: Array<TextPart | ToolUsePart> = [];
    if (textBuf) assistantContent.push({ type: "text", text: textBuf });
    for (const tu of completedToolUses) assistantContent.push(tu);
    messages.push({ role: "assistant", content: assistantContent });
    args.onEvent?.({ type: "assistant_turn_end", toolUses: completedToolUses });

    if (completedToolUses.length === 0) {
      if (textBuf) lastOutput = textBuf;
      if (shouldNudgeTextOnlyTurn(textBuf, messages, totalNudges, maxNudges)) {
        totalNudges++;
        args.onEvent?.({ type: "continuation_nudge", round, attempt: totalNudges });
        messages.push({ role: "user", content: CONTINUATION_NUDGE_PROMPT });
        continue;
      }
      await args.rpc.finalizeSession(runRecordId, "ok", lastOutput);
      args.onEvent?.({ type: "session_end", status: "done", lastOutput });
      return { status: "done", runRecordId, messages, executedSteps, lastOutput };
    }

    const results: ToolResultPart[] = [];
    for (const tu of completedToolUses) {
      const sev = classifyTool(tu.name, tu.input);
      let decision: Decision;
      if (evaluateAutoApproval(tu.name, sev, args.permissionMode, args.settings.trustedDangerTools)) {
        decision = { kind: "run" };
      } else {
        decision = await args.approver.request(tu.id);
      }

      if (decision.kind === "deny") {
        await args.rpc.finalizeSession(runRecordId, "aborted");
        args.onEvent?.({ type: "session_end", status: "aborted", lastOutput });
        return { status: "aborted", runRecordId, messages, executedSteps, lastOutput };
      }
      if (decision.kind === "skip") {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: toolResultContent({ skipped: true })
        });
        args.onEvent?.({ type: "tool_skipped", id: tu.id });
        continue;
      }

      args.onEvent?.({ type: "tool_running", id: tu.id });

      if (tu.name === "screenshot") {
        const start = Date.now();
        try {
          if (!args.screenshot) throw new Error("screenshot: handler not provided");
          const shot = await args.screenshot(tu.input);
          // Encode the result as a Anthropic-style tool_result with a text + image block
          // pair. Sidepanel's anthropic client passes it through; OpenAI client will
          // collapse the image block to a text note (degraded mode).
          const targetText = shot.target ? ` target=${JSON.stringify(shot.target)}` : "";
          const resultContent = [
            { type: "text" as const, text: `screenshot:ok bytes=${shot.byteLen}${targetText}` },
            { type: "image" as const, media_type: shot.media_type, data: shot.data }
          ];
          const ms = Date.now() - start;
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: { byteLen: shot.byteLen, media_type: shot.media_type, ...(shot.target ? { target: shot.target } : {}) },
            ms
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: resultContent
          });
          lastOutput = { byteLen: shot.byteLen, ...(shot.target ? { target: shot.target } : {}) };
          args.onEvent?.({
            type: "tool_done",
            id: tu.id,
            output: { byteLen: shot.byteLen, ...(shot.target ? { target: shot.target } : {}) },
            ms
          });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: null,
            error: errMsg,
            ms: Date.now() - start
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: toolResultContent({ error: errMsg }),
            is_error: true
          });
          args.onEvent?.({ type: "tool_error", id: tu.id, error: errMsg, ms: Date.now() - start });
        }
        continue;
      }

      if (args.metaTools && args.metaTools[tu.name]) {
        const start = Date.now();
        try {
          const handler = args.metaTools[tu.name];
          let out: Json;
          try {
            out = (await handler(tu.input)) as Json;
          } catch (error) {
            const required = parsePermissionRequired(error);
            if (!required || !args.requestPermission) throw error;
            args.onEvent?.({
              type: "permission_required",
              toolUseId: tu.id,
              permission: required.permission,
              capability: required.capability,
            });
            const resolution = await args.requestPermission({ ...required, toolUseId: tu.id });
            args.onEvent?.({
              type: "permission_resolved",
              toolUseId: tu.id,
              permission: required.permission,
              granted: resolution.granted,
            });
            if (!resolution.granted) {
              throw new Error(`${required.permission} 未授权，因此未执行 ${required.capability}`);
            }
            // Permission was granted from an explicit user gesture. Retry the
            // exact same tool use once; any second failure follows the normal
            // tool-error path and never requests again.
            out = (await handler(tu.input)) as Json;
          }
          const ms = Date.now() - start;
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: out,
            ms
          });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: toolResultContent(out) });
          lastOutput = out;
          args.onEvent?.({ type: "tool_done", id: tu.id, output: out, ms });
        } catch (e) {
          const repeatedPermission = parsePermissionRequired(e);
          const errMsg = repeatedPermission
            ? `${repeatedPermission.permission} 权限授权后仍不可用，未再次申请 ${repeatedPermission.capability}`
            : e instanceof Error ? e.message : String(e);
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: null,
            error: errMsg,
            ms: Date.now() - start
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: toolResultContent({ error: errMsg }),
            is_error: true
          });
          args.onEvent?.({ type: "tool_error", id: tu.id, error: errMsg, ms: Date.now() - start });
        }
        continue;
      }

      if (tu.name === "askUser") {
        const start = Date.now();
        try {
          if (!args.askUser) throw new Error("askUser: handler not provided");
          const out = (await args.askUser(tu.input)) as unknown as Json;
          const ms = Date.now() - start;
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: out,
            ms
          });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: toolResultContent(out) });
          lastOutput = out;
          args.onEvent?.({ type: "tool_done", id: tu.id, output: out, ms });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: null,
            error: errMsg,
            ms: Date.now() - start
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: toolResultContent({ error: errMsg }),
            is_error: true
          });
          args.onEvent?.({ type: "tool_error", id: tu.id, error: errMsg, ms: Date.now() - start });
        }
        continue;
      }

      if (
        tu.name === "listTabs" ||
        tu.name === "openTab" ||
        tu.name === "attachTab" ||
        tu.name === "detachTab"
      ) {
        const start = Date.now();
        try {
          let out: Json;
          switch (tu.name) {
            case "listTabs": {
              if (!args.tabsRpc) throw new Error("listTabs: tabsRpc not provided");
              const r = await args.tabsRpc.listTabs(
                (tu.input as { windowId?: number }).windowId
              );
              out = r as unknown as Json;
              break;
            }
            case "openTab": {
              if (!args.tabsRpc) throw new Error("openTab: tabsRpc not provided");
              const input = tu.input as {
                url: string;
                active?: boolean;
                incognito?: boolean;
                windowId?: number;
              };
              const r = await args.tabsRpc.openTab({
                url: input.url,
                active: input.active,
                incognito: input.incognito,
                windowId: input.windowId
              });
              out = r as unknown as Json;
              args.onCrossTabResult?.({
                kind: "opened",
                tabId: r.tabId,
                url: r.url,
                title: r.title
              });
              break;
            }
            case "attachTab": {
              const tabId = (tu.input as { tabId: number }).tabId;
              out = { ok: true, tabId } as unknown as Json;
              args.onCrossTabResult?.({ kind: "attached", tabId });
              break;
            }
            case "detachTab": {
              const tabId = (tu.input as { tabId: number }).tabId;
              out = { ok: true, tabId } as unknown as Json;
              args.onCrossTabResult?.({ kind: "detached", tabId });
              break;
            }
          }
          const ms = Date.now() - start;
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: out,
            ms
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: toolResultContent(out)
          });
          lastOutput = out;
          args.onEvent?.({ type: "tool_done", id: tu.id, output: out, ms });
        } catch (e) {
          const ms = Date.now() - start;
          const errStr = e instanceof Error ? e.message : String(e);
          await args.rpc.appendStepLog(runRecordId, {
            stepIndex: stepIndexGlobal++,
            input: tu.input,
            output: null,
            ms,
            error: errStr
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: toolResultContent({ error: errStr }),
            is_error: true
          });
          args.onEvent?.({ type: "tool_error", id: tu.id, error: errStr, ms });
        }
        continue;
      }

      const step: Step =
        tu.name === "runJS"
          ? { kind: "js", source: (tu.input as { source: string }).source }
          : { kind: "tool", tool: tu.name as ReplayableTool, args: tu.input };

      const start = Date.now();
      try {
        const runStep = () =>
          args.runner.runStep(step, args.input.tabId, args.getAttachedTabIds?.() ?? [], {});
        let out: Json;
        try {
          out = await runStep();
        } catch (error) {
          const required = parsePermissionRequired(error);
          if (!required) throw error;
          if (!args.requestPermission) {
            throw new Error(`${required.permission} 未授权，因此未执行 ${required.capability}`);
          }
          args.onEvent?.({
            type: "permission_required",
            toolUseId: tu.id,
            permission: required.permission,
            capability: required.capability,
          });
          const resolution = await args.requestPermission({ ...required, toolUseId: tu.id });
          args.onEvent?.({
            type: "permission_resolved",
            toolUseId: tu.id,
            permission: required.permission,
            granted: resolution.granted,
          });
          if (!resolution.granted) {
            throw new Error(`${required.permission} 未授权，因此未执行 ${required.capability}`);
          }
          out = await runStep();
        }
        const ms = Date.now() - start;
        await args.rpc.appendStepLog(runRecordId, {
          stepIndex: stepIndexGlobal++,
          input: tu.input,
          output: out,
          ms
        });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: toolResultContent(out)
        });
        executedSteps.push(step);
        lastOutput = out;
        args.onEvent?.({ type: "tool_done", id: tu.id, output: out, ms });
      } catch (e) {
        const ms = Date.now() - start;
        const repeatedPermission = parsePermissionRequired(e);
        const errStr = repeatedPermission
          ? `${repeatedPermission.permission} 权限授权后仍不可用，未再次申请 ${repeatedPermission.capability}`
          : e instanceof Error ? e.message : String(e);
        await args.rpc.appendStepLog(runRecordId, {
          stepIndex: stepIndexGlobal++,
          input: tu.input,
          output: null,
          ms,
          error: errStr
        });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: toolResultContent({ error: errStr }),
          is_error: true
        });
        args.onEvent?.({ type: "tool_error", id: tu.id, error: errStr, ms });
      }
    }

    messages.push({ role: "user", content: results });
  }

  await args.rpc.finalizeSession(runRecordId, "error");
  args.onEvent?.({ type: "session_end", status: "max_rounds", lastOutput });
  return { status: "max_rounds", runRecordId, messages, executedSteps, lastOutput };
}
