import { useState } from "react";
import { Check, ChevronRight, Loader2, LockKeyhole, Sparkles } from "lucide-react";
import type { LlmProvider } from "@aipagego/shared/types";

import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  useSettings,
} from "@/sidepanel/chat/settings-store";
import { pickClient } from "@/sidepanel/llm/client";
import { testLlmConnection } from "./connection-test";
import type { FirstRunDisposition } from "./first-run-state";

type Props = {
  currentUrl: string;
  onRunExample: (prompt: string) => Promise<boolean>;
  onFinish: (disposition: Exclude<FirstRunDisposition, "existing_user">) => Promise<void>;
};

const EXAMPLES = [
  { label: "总结当前页面", detail: "给出 5 条核心要点", prompt: "用 5 个要点总结当前页面的核心内容" },
  { label: "提取关键信息", detail: "识别名称、简介和主要内容", prompt: "提取当前页面的名称、简介和主要内容" },
  { label: "翻译页面要点", detail: "保留专有名词和链接", prompt: "把当前页面的主要内容翻译成中文，保留专有名词和链接" },
] as const;

function canReadPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname !== "chromewebstore.google.com" && url.hostname !== "chrome.google.com";
  } catch {
    return false;
  }
}

export function FirstRunOnboarding({ currentUrl, onRunExample, onFinish }: Props) {
  const settings = useSettings();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<LlmProvider>(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [endpoint, setEndpoint] = useState(settings.endpoint ?? "");
  const [sessionOnly, setSessionOnly] = useState(settings.apiKeyMode === "session");
  const [selectedPrompt, setSelectedPrompt] = useState<string>(EXAMPLES[0].prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveAndTest() {
    if (!apiKey.trim()) {
      setError("请输入 API Key 后再测试连接。");
      return;
    }
    if (!model.trim()) {
      setError("请输入 Model 后再测试连接。");
      return;
    }

    setBusy(true);
    setError(null);
    const patch = {
      provider,
      model: model.trim(),
      apiKey: apiKey.trim(),
      endpoint: endpoint.trim() || undefined,
      apiKeyMode: sessionOnly ? ("session" as const) : ("persistent" as const),
    };
    try {
      await settings.save(patch);
      const result = await testLlmConnection(patch, pickClient(provider));
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runExample() {
    setBusy(true);
    setError(null);
    try {
      const completed = await onRunExample(selectedPrompt);
      if (!completed) {
        setError("示例任务未完成，请查看错误后重试，或跳过试用进入聊天。");
        return;
      }
      await onFinish("task_completed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-sm flex-col px-2 py-3" aria-label="AIPageGo 首次设置">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">首次设置</div>
      <h1 className="mt-1 text-xl font-semibold text-zinc-100">让 AI 在当前网页上帮你做事</h1>
      <p className="mt-1 text-xs text-zinc-400">配置自己的模型，测试连接，再完成一条只读示例任务。</p>

      <ol className="my-5 grid grid-cols-3 gap-2 text-[10px]">
        {["配置模型", "测试连接", "当前页试用"].map((label, index) => {
          const number = (index + 1) as 1 | 2 | 3;
          const active = step === number;
          const done = step > number;
          return (
            <li
              key={label}
              className={`border-t-2 pt-2 ${active ? "border-emerald-500 text-emerald-300" : done ? "border-sky-500 text-sky-300" : "border-zinc-700 text-zinc-600"}`}
            >
              {number}&nbsp; {label}
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-100">连接你的模型</h2>
            <span className="rounded-full bg-sky-950 px-2 py-0.5 text-[10px] text-sky-300">密钥仅存本机</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-zinc-300">
              Provider
              <select
                aria-label="Provider"
                value={provider}
                onChange={(event) => {
                  const next = event.target.value as LlmProvider;
                  setProvider(next);
                  setModel(next === "anthropic" ? ANTHROPIC_MODELS[0] : OPENAI_MODELS[0]);
                }}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-xs text-zinc-100"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
            <label className="text-[11px] text-zinc-300">
              Model
              <input
                aria-label="Model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-xs text-zinc-100"
              />
            </label>
          </div>
          <label className="block text-[11px] text-zinc-300">
            API Key
            <input
              aria-label="API Key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-xs text-zinc-100"
            />
            <span className="mt-1 block text-[10px] text-zinc-500">不会写入聊天记录、工具或导出包。</span>
          </label>
          <label className="block text-[11px] text-zinc-300">
            Endpoint <span className="text-zinc-500">· 可选</span>
            <input
              aria-label="Endpoint"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="留空使用官方 Endpoint"
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-xs text-zinc-100"
            />
          </label>
          <label className="flex items-start gap-2 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={sessionOnly}
              onChange={(event) => setSessionOnly(event.target.checked)}
              className="mt-0.5"
            />
            仅本次浏览器会话保存，关闭浏览器后清除
          </label>
          <div className="flex gap-2 border-l-2 border-sky-500 bg-sky-950/50 px-3 py-2 text-[11px] text-sky-200">
            <LockKeyhole size={14} className="mt-0.5 shrink-0" />
            书签、历史记录和下载会在你使用对应功能时单独询问。
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveAndTest()}
            className="ml-auto flex items-center gap-1 rounded bg-emerald-700 px-3 py-2 text-xs text-white hover:bg-emerald-600 disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            保存并测试连接 <ChevronRight size={14} />
          </button>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="grid min-h-56 place-items-center text-center">
          <div>
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-emerald-950 text-emerald-300"><Check size={22} /></div>
            <h2 className="text-sm font-semibold text-zinc-100">连接正常</h2>
            <p className="mt-1 text-[11px] text-zinc-400">{model} 已成功返回响应。现在运行一条安全的只读任务。</p>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="mt-4 inline-flex items-center gap-1 rounded bg-emerald-700 px-3 py-2 text-xs text-white hover:bg-emerald-600"
            >
              选择示例任务 <ChevronRight size={14} />
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 && !canReadPage(currentUrl) ? (
        <div className="grid min-h-56 place-items-center text-center">
          <div>
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-zinc-800 text-zinc-300"><LockKeyhole size={21} /></div>
            <h2 className="text-sm font-semibold text-zinc-100">此页面不能被扩展读取</h2>
            <p className="mt-1 text-[11px] text-zinc-400">请切换到普通网页后重新打开侧边栏，或跳过试用直接进入 AIPageGo。</p>
            <button
              type="button"
              onClick={() => void onFinish("skipped")}
              className="mt-4 rounded bg-zinc-700 px-3 py-2 text-xs text-zinc-100 hover:bg-zinc-600"
            >
              跳过试用
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 && canReadPage(currentUrl) ? (
        <div className="space-y-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">在当前页面试一次</h2>
            <span className="rounded-full bg-sky-950 px-2 py-0.5 text-[10px] text-sky-300">只读任务</span>
          </div>
          {EXAMPLES.map((example) => (
            <button
              key={example.prompt}
              type="button"
              aria-pressed={selectedPrompt === example.prompt}
              onClick={() => setSelectedPrompt(example.prompt)}
              className={`flex w-full items-center gap-3 rounded border px-3 py-2.5 text-left ${selectedPrompt === example.prompt ? "border-sky-700 bg-sky-950/50" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"}`}
            >
              <Sparkles size={16} className="shrink-0 text-sky-300" />
              <span className="min-w-0 flex-1"><strong className="block text-xs text-zinc-100">{example.label}</strong><small className="text-[10px] text-zinc-500">{example.detail}</small></span>
            </button>
          ))}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={() => void onFinish("skipped")} className="px-2 py-2 text-[11px] text-zinc-400 hover:text-zinc-200">跳过试用</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runExample()}
              className="flex items-center gap-1 rounded bg-emerald-700 px-3 py-2 text-xs text-white hover:bg-emerald-600 disabled:opacity-60"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              运行示例任务
            </button>
          </div>
        </div>
      ) : null}

      {error ? <div role="alert" className="mt-3 rounded border border-rose-900 bg-rose-950/60 px-3 py-2 text-[11px] text-rose-200">{error}</div> : null}
    </section>
  );
}

