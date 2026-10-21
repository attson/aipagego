import { EmptySuggestions } from "@/sidepanel/chat/empty-suggestions";
import { QuickActions } from "@/sidepanel/chat/quick-actions";
import { matchPresetsByUrl } from "@aipagego/shared/match-presets";
import type { Preset } from "@aipagego/shared/preset";
import type { SessionData } from "@/sidepanel/chat/session-store";

type Props = {
  session: SessionData;
  onFillInput: (text: string) => void;
};

/**
 * Widget 空态:URL 命中 preset 时展示 chip 卡片 + QuickActions 默认 3 条。
 * 点击任何一条 → 把对应文本塞进 input(不 auto-send)让用户可修改。
 */
export function EmptyState({ session, onFillInput }: Props) {
  const url = session.url;
  const presets = url ? matchPresetsByUrl(url) : [];

  function onPresetPick(p: Preset) {
    // tool-form preset:首版降级为让 AI 自主挑对应保存工具
    if (p.kind === "prompt") {
      onFillInput(p.prompt);
    } else {
      onFillInput(`运行 preset "${p.name}"`);
    }
  }

  return (
    <div className="p-3 space-y-3 text-xs text-zinc-400">
      {presets.length > 0 && (
        <EmptySuggestions
          matchedTools={[]}
          onRun={() => {}}
          onDetail={() => {}}
          presets={presets}
          onPresetPick={onPresetPick}
        />
      )}
      <QuickActions currentUrl={url || undefined} onPick={onFillInput} />
      <div className="text-center text-zinc-500 pt-2">告诉 AI 你想让它做什么</div>
    </div>
  );
}
