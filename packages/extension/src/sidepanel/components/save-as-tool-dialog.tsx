import { useState } from "react";
import { inferJsonSchema } from "@aipagego/shared/infer-json-schema";
import { highestSeverity, runStaticScan } from "@aipagego/shared/static-scan";
import type { ChatMessage, Json, LlmSettings, ScanFinding, Step } from "@aipagego/shared/types";
import { addLlmExchange } from "../chat/session-store";
import { pickClient } from "../llm/client";
import { createRecordingClient } from "../llm/recording-client";
import {
  generatePromptToolDraft,
  generateStepsToolDraft,
  type GeneratedPromptToolDraft,
  type GeneratedStepsToolDraft
} from "../llm/tool-draft-generator";
import { rpc } from "../rpc";

type Props = {
  tabId: number;
  initialName: string;
  initialDescription: string;
  initialUrl: string;
  steps: Step[];
  lastOutput: Json;
  messages: ChatMessage[];
  llmSettings: LlmSettings;
  onClose: () => void;
  onSaved: (toolId: string) => void;
};

type ToolKindChoice = "prompt" | "steps";

type CandidateState =
  | { phase: "idle" }
  | { phase: "generating"; abort: AbortController }
  | { phase: "promptReady"; draft: GeneratedPromptToolDraft }
  | {
      phase: "stepsReady";
      draft: GeneratedStepsToolDraft;
      findings: ScanFinding[];
      severity: "info" | "caution" | "dangerous";
    }
  | { phase: "error"; error: string };

function defaultPattern(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const baseHost = host.split(".").slice(-2).join(".");
    return `https://*.${baseHost}/**`;
  } catch {
    return "https://example.com/**";
  }
}

export function SaveAsToolDialog(props: Props) {
  const [choice, setChoice] = useState<ToolKindChoice | null>(null);
  const [name, setName] = useState(props.initialName || "新工具");
  const [description, setDescription] = useState(props.initialDescription || "");
  const [patternsText, setPatternsText] = useState(defaultPattern(props.initialUrl));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<CandidateState>({ phase: "idle" });

  async function generateCandidate() {
    if (!choice) return;
    if (!props.llmSettings.apiKey) {
      setCandidate({ phase: "error", error: "请先在设置页填入 API Key" });
      return;
    }
    const ac = new AbortController();
    setCandidate({ phase: "generating", abort: ac });
    try {
      const client = createRecordingClient(
        pickClient(props.llmSettings.provider),
        (ex) => addLlmExchange(props.tabId, ex),
        { provider: props.llmSettings.provider, kind: "tool-draft" }
      );
      const input = {
        client,
        apiKey: props.llmSettings.apiKey,
        model: props.llmSettings.model,
        endpoint: props.llmSettings.endpoint,
        maxTokens: props.llmSettings.maxTokens,
        currentUrl: props.initialUrl,
        messages: props.messages,
        executedSteps: props.steps,
        lastOutput: props.lastOutput,
        abortSignal: ac.signal
      };
      if (choice === "prompt") {
        const draft = await generatePromptToolDraft(input);
        setName(draft.name);
        setDescription(draft.description);
        setCandidate({ phase: "promptReady", draft });
      } else {
        const draft = await generateStepsToolDraft(input);
        setName(draft.name);
        setDescription(draft.description);
        const findings = draft.steps.flatMap((step) =>
          step.kind === "js" ? runStaticScan(step.source) : []
        );
        setCandidate({ phase: "stepsReady", draft, findings, severity: highestSeverity(findings) });
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        setCandidate({ phase: "idle" });
        return;
      }
      setCandidate({ phase: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  function cancelGeneration() {
    if (candidate.phase === "generating") candidate.abort.abort();
    setCandidate({ phase: "idle" });
  }

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const urlPatterns = patternsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (urlPatterns.length === 0) throw new Error("至少填一个 URL 模式");
      if (candidate.phase === "promptReady") {
        const tool = await rpc.saveTool({
          kind: "prompt",
          name,
          urlPatterns,
          description,
          prompt: candidate.draft.prompt
        });
        props.onSaved(tool.id);
        return;
      }
      if (candidate.phase === "stepsReady") {
        const tool = await rpc.saveTool({
          kind: "steps",
          name,
          urlPatterns,
          description,
          steps: candidate.draft.steps,
          outputSchema: inferJsonSchema(props.lastOutput)
        });
        props.onSaved(tool.id);
        return;
      }
      throw new Error("请先让 AI 生成候选工具");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = candidate.phase === "promptReady" || candidate.phase === "stepsReady";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-10">
      <div className="bg-zinc-900 rounded p-4 w-[90%] max-w-md text-xs flex flex-col gap-2 max-h-[90vh] overflow-auto">
        <h3 className="text-base font-medium">保存为工具</h3>
        {!choice && (
          <div className="grid grid-cols-1 gap-2">
            <button
              onClick={() => setChoice("prompt")}
              className="text-left bg-zinc-800 hover:bg-zinc-700 rounded p-3"
            >
              <div className="text-emerald-300 font-medium">提示词工具</div>
              <div className="text-zinc-400 mt-1">
                适合多轮对话沉淀、页面略有变化、需要 AI 判断的任务。运行时回到聊天页由 AI 重新执行。
              </div>
            </button>
            <button
              onClick={() => setChoice("steps")}
              className="text-left bg-zinc-800 hover:bg-zinc-700 rounded p-3"
            >
              <div className="text-sky-300 font-medium">纯函数工具</div>
              <div className="text-zinc-400 mt-1">
                适合字段采集、格式转换、页面结构稳定的任务。运行时不调用 LLM，直接执行固定 steps。
              </div>
            </button>
          </div>
        )}

        {choice && (
          <>
            <div className="flex items-center gap-2 text-zinc-400">
              <span>类型：{choice === "prompt" ? "提示词工具" : "纯函数工具"}</span>
              <button onClick={() => { setChoice(null); setCandidate({ phase: "idle" }); }} className="ml-auto px-2 py-0.5 bg-zinc-700 rounded">
                重选
              </button>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-400">名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className="bg-zinc-800 px-2 py-1 rounded" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-400">URL 模式（每行一条）</span>
              <textarea value={patternsText} onChange={(e) => setPatternsText(e.target.value)} rows={3} className="bg-zinc-800 px-2 py-1 rounded font-mono" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-400">描述</span>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="bg-zinc-800 px-2 py-1 rounded" />
            </label>
            <CandidatePanel
              state={candidate}
              choice={choice}
              onGenerate={generateCandidate}
              onCancel={cancelGeneration}
              onReset={() => setCandidate({ phase: "idle" })}
              hasApiKey={!!props.llmSettings.apiKey}
            />
          </>
        )}

        {err && <p className="text-red-400">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={props.onClose} className="px-3 py-1 bg-zinc-700 rounded" disabled={busy}>
            取消
          </button>
          {choice && (
            <button onClick={save} className="px-3 py-1 bg-emerald-700 rounded disabled:opacity-50" disabled={busy || !ready}>
              {busy ? "保存中…" : "保存"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CandidatePanel(props: {
  state: CandidateState;
  choice: ToolKindChoice;
  onGenerate: () => void;
  onCancel: () => void;
  onReset: () => void;
  hasApiKey: boolean;
}) {
  const { state } = props;
  return (
    <section className="bg-zinc-950 border border-zinc-800 rounded p-2 flex flex-col gap-2">
      <div className="text-zinc-300">AI 生成候选</div>
      {state.phase === "idle" && (
        <button onClick={props.onGenerate} disabled={!props.hasApiKey} className="self-start px-2 py-0.5 bg-emerald-700 rounded disabled:opacity-50">
          让 AI 生成候选
        </button>
      )}
      {state.phase === "generating" && (
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-zinc-300">AI 生成中…</span>
          <button onClick={props.onCancel} className="ml-auto px-2 py-0.5 bg-zinc-700 rounded">
            取消生成
          </button>
        </div>
      )}
      {state.phase === "promptReady" && (
        <>
          <div className="text-emerald-300">✓ AI 已生成提示词工具</div>
          <details className="bg-zinc-900 rounded p-1" open>
            <summary className="cursor-pointer text-zinc-300 text-[11px]">提示词</summary>
            <pre className="text-[10px] text-zinc-300 mt-1 overflow-auto max-h-48 whitespace-pre-wrap">{state.draft.prompt}</pre>
          </details>
          <CandidateActions onGenerate={props.onGenerate} onReset={props.onReset} />
        </>
      )}
      {state.phase === "stepsReady" && (
        <>
          <div className="text-emerald-300 flex items-center gap-2 flex-wrap">
            <span>✓ AI 已生成纯函数工具</span>
            {state.findings.length > 0 && (
              <span className={(state.severity === "dangerous" ? "bg-red-700" : state.severity === "caution" ? "bg-amber-700" : "bg-zinc-700") + " text-[10px] px-1 py-0.5 rounded"}>
                {state.severity}: {state.findings.map((f) => f.rule).join(", ")}
              </span>
            )}
          </div>
          <details className="bg-zinc-900 rounded p-1" open>
            <summary className="cursor-pointer text-zinc-300 text-[11px]">steps JSON</summary>
            <pre className="text-[10px] text-zinc-300 mt-1 overflow-auto max-h-48 whitespace-pre-wrap">{JSON.stringify(state.draft.steps, null, 2)}</pre>
          </details>
          <CandidateActions onGenerate={props.onGenerate} onReset={props.onReset} />
        </>
      )}
      {state.phase === "error" && (
        <>
          <div className="text-red-400 text-[11px] whitespace-pre-wrap break-words">{state.error}</div>
          <CandidateActions onGenerate={props.onGenerate} onReset={props.onReset} />
        </>
      )}
    </section>
  );
}

function CandidateActions(props: { onGenerate: () => void; onReset: () => void }) {
  return (
    <div className="flex gap-2 flex-wrap">
      <button onClick={props.onGenerate} className="px-2 py-0.5 bg-zinc-700 rounded">
        重新生成
      </button>
      <button onClick={props.onReset} className="px-2 py-0.5 bg-zinc-700 rounded">
        取消
      </button>
    </div>
  );
}
