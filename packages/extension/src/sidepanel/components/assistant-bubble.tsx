import { useState } from "react";
import { Copy } from "lucide-react";
import type { ToolUsePart } from "@aipagego/shared/types";
import { useSession, type StepCardState } from "../chat/session-store";
import { StepCard } from "./step-card";
import { StepRow } from "./step-row";
import { MarkdownText } from "./markdown-text";

type Props = {
  text: string;
  toolUses: ToolUsePart[];         // finalized 的（来自 messages）
  pendingCards?: StepCardState[];  // 流式中尚未 finalize 的 cards
  cardsById: Map<string, StepCardState>;
  onApprove: (
    id: string,
    decision: "run" | "run-and-always-allow" | "skip" | "deny",
    toolName?: string
  ) => void;
  needsApproval: (card: StepCardState) => boolean;
  isLive: boolean;
  /** True if this is the final assistant message and the session is idle.
   *  Enables the "复制 / 重生成" per-message actions row. */
  isLastIdle?: boolean;
  onRegenerate?: () => void;
};

export function AssistantBubble({
  text,
  toolUses,
  pendingCards = [],
  cardsById,
  onApprove,
  needsApproval,
  isLive,
  isLastIdle,
  onRegenerate
}: Props) {
  const chatMode = useSession().chatMode;

  const allCards: StepCardState[] = [];
  for (const tu of toolUses) {
    const c = cardsById.get(tu.id);
    if (c) allCards.push(c);
  }
  for (const c of pendingCards) allCards.push(c);

  const hasAwaiting = allCards.some(
    (c) => (c.status === "awaiting" && needsApproval(c)) || c.status === "running"
  );

  // ── 所有 hooks 都无条件调用，保持 hooks 顺序稳定 ──
  const [open, setOpen] = useState<boolean>(isLive || hasAwaiting);              // full 分支消费
  const [expanded, setExpanded] = useState<Set<string>>(new Set());              // compact 分支消费（单行→StepCard）
  const [userOverride, setUserOverride] = useState<boolean | undefined>(undefined); // compact 分支消费（summary 三态）

  const done = allCards.filter((c) => c.status === "ok").length;
  const errs = allCards.filter((c) => c.status === "error").length;

  const actions =
    !isLive && (text || allCards.length > 0) ? (
      <div
        data-testid="message-actions"
        className="self-end flex gap-1"
      >
        {text && (
          <button
            type="button"
            aria-label="复制消息"
            title="复制消息"
            className="rounded p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700"
            onClick={() => {
              navigator.clipboard?.writeText(text).catch(() => undefined);
            }}
          >
            <Copy size={13} aria-hidden="true" />
          </button>
        )}
        {isLastIdle && onRegenerate && (
          <button
            type="button"
            aria-label="重生成"
            className="px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-700"
            onClick={onRegenerate}
          >
            重生成
          </button>
        )}
      </div>
    ) : null;

  // ─────────────── compact 分支 ───────────────
  if (chatMode === "compact") {
    const autoOpen = isLive || hasAwaiting;
    const summaryOpen = userOverride !== undefined ? userOverride : autoOpen;
    const summaryText = errs > 0 ? `✓${done} · ✗${errs}` : `${allCards.length} 步`;

    const toggleCard = (id: string) => {
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };

    return (
      <div className="bg-zinc-800/60 rounded p-2 text-xs flex flex-col gap-1.5">
        {allCards.length > 0 && (
          <>
            <button
              onClick={() => setUserOverride(!summaryOpen)}
              className="self-start text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
            >
              <span>{summaryOpen ? "▾" : "▸"}</span>
              <span>{summaryText}</span>
            </button>
            {summaryOpen && (
              <div className="flex flex-col gap-0.5">
                {allCards.map((card) => {
                  const mustExpand =
                    (card.status === "awaiting" && needsApproval(card)) ||
                    expanded.has(card.toolUseId);
                  return mustExpand ? (
                    <StepCard
                      key={card.toolUseId}
                      card={card}
                      onApprove={onApprove}
                      needsManualApproval={needsApproval(card)}
                    />
                  ) : (
                    <StepRow
                      key={card.toolUseId}
                      card={card}
                      onExpand={() => toggleCard(card.toolUseId)}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
        {text && <MarkdownText text={text} />}
        {actions}
      </div>
    );
  }

  // ─────────────── full 分支（现有实现原样保留） ───────────────
  const summary =
    allCards.length === 0
      ? null
      : (() => {
          const wait = allCards.filter(
            (c) => c.status === "awaiting" && needsApproval(c)
          ).length;
          const pieces = [`${allCards.length} 次工具调用`];
          if (done) pieces.push(`✓${done}`);
          if (errs) pieces.push(`✗${errs}`);
          if (wait) pieces.push(`待审 ${wait}`);
          return pieces.join(" · ");
        })();

  const effectiveOpen = open || hasAwaiting || isLive;

  return (
    <div className="bg-zinc-800/60 rounded p-2 text-xs flex flex-col gap-2">
      {allCards.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setOpen(!open)}
            className="self-start text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            <span>{effectiveOpen ? "▾" : "▸"}</span>
            <span>{summary}</span>
          </button>
          {effectiveOpen && (
            <div className="flex flex-col gap-1 pl-3 border-l-2 border-zinc-700">
              {allCards.map((card) => (
                <StepCard
                  key={card.toolUseId}
                  card={card}
                  onApprove={onApprove}
                  needsManualApproval={needsApproval(card)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {text && <MarkdownText text={text} />}
      {actions}
    </div>
  );
}
