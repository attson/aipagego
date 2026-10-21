import { useCallback, useEffect, useState } from "react";
import { Crosshair, X, Minus, ExternalLink, MessageSquarePlus, ArrowLeft, Clock } from "lucide-react";
import { HistoryMode } from "./history-mode";
import { useElementCapture } from "./element-capture-hook";
import { ChatView } from "@/sidepanel/components/chat-view";
import { EmptyState } from "./empty-state";
import { InputRow } from "./input-row";
import { StatusBar } from "./status-bar";
import { ErrorBanner } from "./error-banner";
import { SaveEntry } from "./save-entry";
import {
  useSession,
  appendUserMessage,
  appendUserMessageWithImages,
  ensureSession,
  setCurrentTab,
} from "@/sidepanel/chat/session-store";
import type { ImagePart } from "@aipagego/shared/types";
import {
  getApproverForTab,
  broadcastApprovalDecision,
  type Decision,
} from "@/sidepanel/chat/approval";
import { rpc } from "@/sidepanel/rpc";
import { useSettings } from "@/sidepanel/chat/settings-store";
import { getPanelSize, setPanelSize } from "./per-site";
import { getWidgetTabInfo } from "./tab-info";
import { ResizeHandle } from "./resize-handle";

type Props = {
  onClose: () => void;
  onMinimize: () => void;
};

export function Panel({ onClose, onMinimize }: Props) {
  const [size, setSize] = useState({ w: 320, h: 480 });
  const [tabId, setTabId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [stagedImages, setStagedImages] = useState<ImagePart[]>([]);
  const [mode, setMode] = useState<"chat" | "history">("chat");

  const session = useSession();
  const maxRounds = useSettings((s) => s.maxRounds);

  useEffect(() => {
    getPanelSize().then(setSize);
    // Widget runs in a content script — cannot use `chrome.tabs.query`. Ask BG.
    getWidgetTabInfo()
      .then((info) => {
        setTabId(info.tabId);
        setCurrentTab(info.tabId);
        ensureSession(info.tabId, info.url);
      })
      .catch((e) => {
        console.warn("[aipagego-widget] tabId lookup failed:", e);
      });
  }, []);

  const isBusy =
    session.status === "streaming" ||
    session.status === "awaiting" ||
    session.status === "running";

  function handleStop() {
    if (!tabId) return;
    session.abortController?.abort();
  }

  async function handleSubmit() {
    if (!tabId) return;
    const text = input.trim();
    if (!text && stagedImages.length === 0) return;
    if (isBusy) return;
    const historyMessages = session.messages;
    const imagesToSend = stagedImages;
    if (imagesToSend.length > 0) {
      appendUserMessageWithImages(tabId, text, imagesToSend);
    } else {
      appendUserMessage(tabId, text);
    }
    setStagedImages([]);
    setInput("");
    try {
      const { runFromInput } = await import("./run-widget-session");
      await runFromInput(tabId, text, { images: imagesToSend, historyMessages });
    } catch (e) {
      console.warn("[aipagego-widget] runFromInput failed:", e);
    }
  }

  async function handleOpenSidepanel() {
    if (!tabId) return;
    await rpc.widgetOpenSidepanel({ tabId }).catch(() => {});
  }

  async function handleNewChat() {
    if (!tabId) return;
    const hasContent =
      session.messages.length > 0 || session.streamingAssistantText.length > 0;
    if (hasContent && !window.confirm("新建对话会归档当前会话,确定?")) return;
    try {
      const { newChatForTab } = await import("@/sidepanel/chat/new-chat");
      await newChatForTab(tabId);
      setInput("");
    } catch (e) {
      console.warn("[aipagego-widget] newChat failed:", e);
    }
  }

  const handleApprove = useCallback(
    (
      id: string,
      decisionKind: "run" | "run-and-always-allow" | "skip" | "deny",
      toolName?: string
    ) => {
      if (!tabId) return;
      const decision: Decision =
        decisionKind === "run-and-always-allow" && toolName
          ? { kind: "run-and-always-allow", toolName }
          : ({ kind: decisionKind } as Decision);
      // Resolve locally (handles the case where widget holds the pending promise)
      getApproverForTab(tabId).resolve(id, decision);
      // Broadcast to sidepanel context in case IT holds the pending promise
      broadcastApprovalDecision(tabId, id, decision);
    },
    [tabId]
  );

  const { startCapture } = useElementCapture((selector) => {
    setInput((prev) => (prev ? `${prev}\n\n针对元素 ${selector}:` : `针对元素 ${selector}:`));
  });

  return (
    <div
      style={{
        position: "fixed",
        right: 72,
        bottom: 16,
        width: size.w,
        height: size.h,
        zIndex: 2147483645,
      }}
      className="relative bg-zinc-900 text-zinc-100 rounded-lg border border-zinc-700 shadow-2xl flex flex-col overflow-hidden"
    >
      {/* Header */}
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs shrink-0">
        {mode === "history" && (
          <button
            className="p-1 hover:bg-zinc-800 rounded"
            title="返回对话"
            onClick={() => setMode("chat")}
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <b className="flex-1 select-none">⚡ AIPageGo</b>
        <button
          className="p-1 hover:bg-zinc-800 rounded"
          title="圈选页面元素"
          onClick={startCapture}
        >
          <Crosshair size={14} />
        </button>
        <button
          className="p-1 hover:bg-zinc-800 rounded"
          title="新建对话"
          onClick={handleNewChat}
        >
          <MessageSquarePlus size={14} />
        </button>
        <button
          className="p-1 hover:bg-zinc-800 rounded"
          title="打开扩展面板"
          onClick={handleOpenSidepanel}
        >
          <ExternalLink size={14} />
        </button>
        <button
          className="p-1 hover:bg-zinc-800 rounded"
          title="最小化"
          onClick={onMinimize}
        >
          <Minus size={14} />
        </button>
        <button
          className="p-1 hover:bg-zinc-800 rounded"
          title="关闭"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>

      {/* Error banner (only when session.errorMessage exists) */}
      <ErrorBanner session={session} tabId={tabId ?? -1} />

      {/* Sticky status bar (only when session non-idle) */}
      <StatusBar session={session} />

      {/* Body */}
      <div className="flex-1 overflow-auto min-h-0">
        {mode === "history" ? (
          <HistoryMode
            url={session.url}
            tabId={tabId ?? -1}
            onBack={() => setMode("chat")}
          />
        ) : session.messages.length === 0 && !isBusy ? (
          <EmptyState session={session} onFillInput={setInput} />
        ) : (
          <ChatView onApprove={handleApprove} />
        )}
        {tabId != null && <SaveEntry session={session} tabId={tabId} />}
      </div>

      {/* Footer: token usage + history toggle */}
      <footer className="px-2 py-1 text-[10px] text-zinc-500 border-t border-zinc-800 flex justify-between shrink-0 items-center">
        <button
          className="flex items-center gap-1 hover:text-zinc-300"
          onClick={() => setMode(mode === "history" ? "chat" : "history")}
          title="历史对话"
        >
          <Clock size={11} />
          <span>历史</span>
        </button>
        <span>
          {session.tokenUsage.input}in / {session.tokenUsage.output}out
        </span>
        <span>
          round {session.roundCount} / {maxRounds}
        </span>
      </footer>

      {tabId != null && (
        <InputRow
          session={session}
          tabId={tabId}
          input={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onStop={handleStop}
          stagedImages={stagedImages}
          onSetStagedImages={setStagedImages}
          disabled={isBusy}
          isBusy={isBusy}
        />
      )}
      <ResizeHandle
        size={size}
        onResize={(w, h) => setSize({ w, h })}
        onCommit={(w, h) => { void setPanelSize({ w, h }); }}
      />
    </div>
  );
}
