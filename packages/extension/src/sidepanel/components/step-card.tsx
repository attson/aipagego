import { runStaticScan } from "@aipagego/shared/static-scan";
import type { ScanFinding } from "@aipagego/shared/types";
import { useSession } from "../chat/session-store";
import type { StepCardState } from "../chat/session-store";
import { classifyTool } from "../chat/severity";
import { StaticScanBadge } from "./static-scan-badge";

type Props = {
  card: StepCardState;
  onApprove: (
    id: string,
    decision: "run" | "run-and-always-allow" | "skip" | "deny",
    toolName?: string
  ) => void;
  needsManualApproval: boolean;
};

export function StepCard({ card, onApprove, needsManualApproval }: Props) {
  const severity = classifyTool(card.name, card.input);
  const session = useSession();
  const argTab = (card.input as { tabId?: number } | null | undefined)?.tabId;
  const showCrossTab = typeof argTab === "number" && argTab !== session.tabId;
  const findings: ScanFinding[] =
    card.name === "runJS" && typeof (card.input as { source?: string })?.source === "string"
      ? runStaticScan((card.input as { source: string }).source)
      : [];

  const cls =
    severity === "dangerous"
      ? "border-red-700"
      : severity === "caution"
      ? "border-amber-700"
      : "border-zinc-700";

  return (
    <div
      data-approval-id={card.toolUseId}
      className={`rounded border ${cls} bg-zinc-900 p-2 text-xs flex flex-col gap-1`}
    >
      <div className="flex items-center gap-2">
        <span className="text-zinc-400">tool:</span>
        <span className="font-medium">{card.name}</span>
        {showCrossTab && (
          <span className="text-blue-400 text-[10px]">→ Tab #{argTab}</span>
        )}
        <SeverityPill severity={severity} />
        <CardStatus card={card} />
      </div>
      <StaticScanBadge findings={findings} />
      <SourceOrArgs card={card} />
      {card.status === "ok" && (
        <details className="mt-1">
          <summary className="cursor-pointer text-zinc-400">output</summary>
          <pre className="text-[10px] text-zinc-300 mt-1 overflow-auto">
            {JSON.stringify(card.output, null, 2)}
          </pre>
        </details>
      )}
      {card.status === "error" && (
        <div className="text-red-400 text-[10px]">error: {card.error}</div>
      )}
      {card.status === "awaiting" && needsManualApproval && (
        <div className="flex gap-2 mt-1">
          <button
            onClick={() => onApprove(card.toolUseId, "run")}
            className="px-2 py-0.5 bg-emerald-700 rounded"
          >
            ✓ 通过
          </button>
          {card.name === "attachTab" && (
            <button
              onClick={() =>
                onApprove(card.toolUseId, "run-and-always-allow", card.name)
              }
              className="px-2 py-0.5 bg-emerald-800 rounded"
            >
              ✓ 允许并始终通过
            </button>
          )}
          <button
            onClick={() => onApprove(card.toolUseId, "skip")}
            className="px-2 py-0.5 bg-zinc-700 rounded"
          >
            ⊘ 跳过
          </button>
          <button
            onClick={() => onApprove(card.toolUseId, "deny")}
            className="px-2 py-0.5 bg-red-800 rounded"
          >
            ✕ 终止
          </button>
        </div>
      )}
    </div>
  );
}

function SeverityPill({ severity }: { severity: ReturnType<typeof classifyTool> }) {
  const cls =
    severity === "dangerous"
      ? "bg-red-700"
      : severity === "caution"
      ? "bg-amber-700"
      : "bg-emerald-700";
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${cls}`}>{severity}</span>;
}

function CardStatus({ card }: { card: StepCardState }) {
  const text =
    card.status === "draft"
      ? "draft…"
      : card.status === "awaiting"
      ? "awaiting"
      : card.status === "running"
      ? "running…"
      : card.status === "ok"
      ? `✓ ${card.ms ?? 0}ms`
      : card.status === "error"
      ? "error"
      : card.status === "skipped"
      ? "skipped"
      : "denied";
  return <span className="text-zinc-400 ml-auto">{text}</span>;
}

function SourceOrArgs({ card }: { card: StepCardState }) {
  if (card.name === "runJS") {
    const src =
      typeof (card.input as { source?: string }).source === "string"
        ? (card.input as { source: string }).source
        : card.partialJson;
    return (
      <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-2 overflow-auto">
        {src}
      </pre>
    );
  }
  return (
    <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-2 overflow-auto">
      {card.inputReady ? JSON.stringify(card.input, null, 2) : card.partialJson || "…"}
    </pre>
  );
}
