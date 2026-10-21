import { useUi, type DrawerKind } from "../chat/ui-store";
import type { DebugBadge } from "../chat/session-store";
import { Plus, History, Wrench, Settings, Bug, Eye, EyeOff, Layers } from "lucide-react";

type Props = {
  debugBadge: DebugBadge;
  onNewChat: () => void;
  chatMode: "compact" | "full";
  onToggleChatMode: () => void;
};

function badgeClass(b: DebugBadge): string | null {
  if (!b) return null;
  if (b.kind === "error") return "bg-red-500";
  if (b.kind === "exchange") return "bg-amber-500";
  return "bg-blue-500";
}

export function Header({ debugBadge, onNewChat, chatMode, onToggleChatMode }: Props) {
  const open = useUi((s) => s.open);
  const dot = badgeClass(debugBadge);

  return (
    <div className="border-b border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between px-3 pt-2.5">
        <div className="flex items-baseline gap-1.5 truncate">
          <span className="font-bold text-zinc-100 text-[13px] tracking-tight">AIPageGo</span>
          <span className="text-zinc-500 text-[10px] font-mono" data-testid="header-version">
            v{__APP_VERSION__}
          </span>
        </div>
        <div className="flex gap-0.5">
          <IconBtn
            label={chatMode === "compact" ? "当前简洁模式，点切换详细" : "当前详细模式，点切换简洁"}
            onClick={onToggleChatMode}
          >
            {chatMode === "compact" ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconBtn>
          <IconBtn label="新会话" onClick={onNewChat}><Plus size={14} /></IconBtn>
          <IconBtn label="历史" onClick={() => open("history")}><History size={14} /></IconBtn>
          <IconBtn label="场景库" onClick={() => open("scenarios")}><Layers size={14} /></IconBtn>
          <IconBtn label="工具库" onClick={() => open("tools")}><Wrench size={14} /></IconBtn>
          <IconBtn label="设置" onClick={() => open("settings")}><Settings size={14} /></IconBtn>
          <IconBtn label="调试" onClick={() => open("debug")} badge={dot}><Bug size={14} /></IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  badge,
  children,
}: {
  label: string;
  onClick: () => void;
  badge?: string | null;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="relative w-7 h-7 rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 flex items-center justify-center text-base"
    >
      {children}
      {badge && (
        <span
          data-testid={`badge-${label}`}
          className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${badge}`}
        />
      )}
    </button>
  );
}

/** Helper for callers that need the DrawerKind enum at use sites. */
export type { DrawerKind };
