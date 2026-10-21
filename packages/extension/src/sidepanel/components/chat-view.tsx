import { useEffect, useRef } from "react";
import { useSession, type StepCardState } from "../chat/session-store";
import { useSettings } from "../chat/settings-store";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage, TextPart, ToolUsePart } from "@aipagego/shared/types";
import { classifyTool, evaluateAutoApproval } from "../chat/severity";
import { AssistantBubble } from "./assistant-bubble";

const SYSTEM_PREFIXES = ["🆕", "🗑", "⚠", "[页面跳转]", "[已恢复]", "[自愈]"];

function isSystemNote(content: string): boolean {
  return SYSTEM_PREFIXES.some((p) => content.startsWith(p));
}

type Props = {
  onApprove: (
    id: string,
    decision: "run" | "run-and-always-allow" | "skip" | "deny",
    toolName?: string
  ) => void;
  onRegenerate?: () => void;
};

export function ChatView({ onApprove, onRegenerate }: Props) {
  const session = useSession();
  const settings = useSettings();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [
    session.messages.length,
    session.streamingAssistantText,
    session.cards.length,
    session.cards.map((c) => c.status).join(",")
  ]);

  const cardsById = new Map<string, StepCardState>();
  for (const c of session.cards) cardsById.set(c.toolUseId, c);

  function needsApproval(card: StepCardState): boolean {
    if (!card.inputReady) return false;
    return !evaluateAutoApproval(
      card.name,
      classifyTool(card.name, card.input),
      session.permissionMode,
      settings.trustedDangerTools ?? []
    );
  }

  // finalized 的 assistant turn 已收录的 toolUseIds
  const finalizedIds = new Set<string>();
  for (const m of session.messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.content) if (c.type === "tool_use") finalizedIds.add(c.id);
  }

  // 流式中：尚未 finalize 的 cards（按出现顺序）
  const pendingCards = session.cards.filter((c) => !finalizedIds.has(c.toolUseId));
  const isStreaming =
    session.status === "streaming" ||
    session.status === "awaiting" ||
    session.status === "running";

  // Index of the last assistant message — used to gate "重生成" button.
  let lastAssistantIdx = -1;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const sessionIdle =
    session.status === "idle" || session.status === "done" || session.status === "aborted";

  return (
    <div ref={ref} className="flex-1 overflow-auto flex flex-col gap-2 p-3">
      {session.messages.map((m, i) => renderMessage(m, i))}
      {isStreaming && (session.streamingAssistantText || pendingCards.length > 0) && (
        <AssistantBubble
          key="live-bubble"
          text={session.streamingAssistantText}
          toolUses={[]}
          pendingCards={pendingCards}
          cardsById={cardsById}
          onApprove={onApprove}
          needsApproval={needsApproval}
          isLive
        />
      )}
      {session.messages.length === 0 && !isStreaming && (
        <div className="text-zinc-500 text-xs text-center mt-8">
          输入指令，让 AI 帮你浏览、总结、操作或采集网页…
        </div>
      )}
    </div>
  );

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      // 跳过 tool_result 注入（只在 chat history 内部有意义，UI 不展示）
      if (typeof m.content !== "string") {
        const hasVisibleContent = m.content.some((part) => part.type === "text" || part.type === "image");
        return hasVisibleContent ? <MessageBubble key={i} message={m} /> : null;
      }
      if (isSystemNote(m.content)) {
        return (
          <div key={i} className="text-[11px] text-zinc-500 italic px-2 py-1">
            {m.content}
          </div>
        );
      }
      return <MessageBubble key={i} message={m} />;
    }
    const text = m.content
      .filter((c): c is TextPart => c.type === "text")
      .map((c) => c.text)
      .join("");
    const toolUses = m.content.filter((c): c is ToolUsePart => c.type === "tool_use");
    if (!text && toolUses.length === 0) return null;
    const isLastIdle = i === lastAssistantIdx && sessionIdle;
    return (
      <AssistantBubble
        key={i}
        text={text}
        toolUses={toolUses}
        cardsById={cardsById}
        onApprove={onApprove}
        needsApproval={needsApproval}
        isLive={false}
        isLastIdle={isLastIdle}
        onRegenerate={isLastIdle ? onRegenerate : undefined}
      />
    );
  }
}
