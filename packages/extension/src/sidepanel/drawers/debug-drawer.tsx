import { useState } from "react";
import type { ChatMessage, LlmExchange } from "@aipagego/shared/types";
import { useSession, type LogEntry } from "@/sidepanel/chat/session-store";
import { useUi } from "@/sidepanel/chat/ui-store";
import { Drawer } from "@/sidepanel/shell/drawer";

type Tab = "logs" | "exchanges";

function fmt(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds()
  ).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function colorFor(level: LogEntry["level"]): string {
  if (level === "error") return "text-red-400";
  if (level === "warn") return "text-amber-400";
  return "text-zinc-400";
}

export function DebugDrawer() {
  const opened = useUi((s) => s.openedDrawer);
  const close = useUi((s) => s.close);
  const session = useSession();
  const open = opened === "debug";
  const initialTab: Tab = session.debugBadge?.kind === "exchange" ? "exchanges" : "logs";
  const [tab, setTab] = useState<Tab>(initialTab);

  function exportBundle() {
    const bundle = {
      exportedAt: new Date().toISOString(),
      schema: "aipagego.session-bundle.v1",
      session: {
        tabId: session.tabId,
        url: session.url,
        runRecordId: session.runRecordId,
        status: session.status,
        errorMessage: session.errorMessage,
        roundCount: session.roundCount,
        tokenUsage: session.tokenUsage,
        permissionMode: session.permissionMode,
      },
      messages: session.messages,
      cards: session.cards,
      executedSteps: session.executedSteps,
      llmExchanges: session.llmExchanges,
      logs: session.logs,
      attachedTabs: session.attachedTabs,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aipagego-session-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Drawer open={open} title="调试" onClose={close}>
      <div className="flex items-stretch border-b border-zinc-800 text-xs">
        <TabBtn active={tab === "logs"} onClick={() => setTab("logs")}>
          日志 ({session.logs.length})
        </TabBtn>
        <TabBtn active={tab === "exchanges"} onClick={() => setTab("exchanges")}>
          Exchanges ({session.llmExchanges.length})
        </TabBtn>
        <button
          type="button"
          onClick={exportBundle}
          title="导出完整会话诊断包（messages / cards / logs / exchanges / executedSteps）"
          className="ml-auto self-center mr-2 px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[11px]"
        >
          导出诊断包
        </button>
      </div>
      {tab === "logs" ? <LogsPane logs={session.logs} onClear={() => session.clearLogs()} /> : null}
      {tab === "exchanges" ? <ExchangesPane exchanges={session.llmExchanges} /> : null}
    </Drawer>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-[11px] ${
        active ? "text-zinc-100 border-b-2 border-blue-500" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function LogsPane({ logs, onClear }: { logs: LogEntry[]; onClear: () => void }) {
  async function copy() {
    const text = logs
      .map(
        (l) =>
          `[${fmt(l.ts)}] ${l.level.toUpperCase()} ${l.message}${l.details ? "\n" + l.details : ""}`
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  return (
    <div className="p-2 text-xs">
      <div className="flex gap-2 mb-2">
        <button onClick={copy} className="px-2 py-0.5 bg-zinc-700 rounded text-[11px]">
          复制
        </button>
        <button onClick={onClear} className="px-2 py-0.5 bg-zinc-700 rounded text-[11px]">
          清空
        </button>
      </div>
      <ol className="space-y-1 font-mono">
        {logs.length === 0 && <li className="text-zinc-500 text-[11px]">暂无日志</li>}
        {logs.map((l, i) => (
          <li key={i} className="text-[11px] leading-tight">
            <span className="text-zinc-600">{fmt(l.ts)}</span>{" "}
            <span className={colorFor(l.level)}>{l.level}</span>{" "}
            <span className="text-zinc-200 whitespace-pre-wrap">{l.message}</span>
            {l.details && (
              <pre className="mt-1 text-[10px] text-zinc-400 bg-zinc-900 rounded p-1 overflow-auto max-h-32">
                {l.details}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ExchangesPane({ exchanges }: { exchanges: LlmExchange[] }) {
  async function copyOne(ex: LlmExchange) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(ex, null, 2));
    } catch {
      // ignore
    }
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify(exchanges, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `llm-exchanges-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-2 text-xs">
      <div className="flex gap-2 mb-2">
        <button onClick={exportAll} className="px-2 py-0.5 bg-zinc-700 rounded text-[11px]">
          导出全部
        </button>
      </div>
      <div className="space-y-2">
        {exchanges.length === 0 && <div className="text-zinc-500">暂无交互记录</div>}
        {exchanges.map((ex) => (
          <ExchangeCard key={ex.id} ex={ex} onCopy={() => copyOne(ex)} />
        ))}
      </div>
    </div>
  );
}

function ExchangeCard({ ex, onCopy }: { ex: LlmExchange; onCopy: () => void }) {
  const [open, setOpen] = useState(false);
  const u = ex.response.usage;
  const bad = ex.response.error || ex.response.aborted;
  return (
    <div className={`rounded border ${bad ? "border-amber-700" : "border-zinc-700"} bg-zinc-900`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left p-2 flex items-center gap-2 flex-wrap"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="font-medium">#{ex.round}</span>
        <span className="text-zinc-400">{ex.request.model}</span>
        <span className="text-zinc-500">{ex.durationMs}ms</span>
        {u && (
          <span className="text-zinc-500">
            in {u.input_tokens}/out {u.output_tokens}
          </span>
        )}
        {ex.response.stopReason && <span className="text-zinc-500">{ex.response.stopReason}</span>}
        {ex.response.aborted && <span className="text-amber-400">aborted</span>}
        {ex.response.error && <span className="text-red-400">error</span>}
      </button>
      {open && (
        <div className="p-2 border-t border-zinc-800 space-y-2">
          <button onClick={onCopy} className="px-2 py-0.5 bg-zinc-700 rounded text-[11px]">
            复制本条
          </button>
          <Section title="Request">
            <Field label="system" value={ex.request.system} />
            <div className="text-zinc-500">
              tools: {ex.request.toolNames.join(", ") || "(none)"} · max_tokens:{" "}
              {ex.request.maxTokens ?? "(默认)"}
              {ex.request.endpoint ? ` · endpoint: ${ex.request.endpoint}` : ""}
            </div>
            <MessageList messages={ex.request.messages} />
          </Section>
          <Section title="Response">
            {ex.response.text && <Field label="text" value={ex.response.text} />}
            {ex.response.toolUses.map((t) => (
              <Field
                key={t.id}
                label={`tool_use ${t.name}`}
                value={JSON.stringify(t.input, null, 2)}
              />
            ))}
            {ex.response.error && <div className="text-red-400">error: {ex.response.error}</div>}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-zinc-300 font-medium">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-1 overflow-auto whitespace-pre-wrap max-h-48">
        {value}
      </pre>
    </div>
  );
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="space-y-1">
      {messages.map((m, i) => (
        <div key={i}>
          <div className="text-zinc-500">[{m.role}]</div>
          <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-1 overflow-auto whitespace-pre-wrap max-h-48">
            {typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
