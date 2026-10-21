import { useEffect, useRef, useState } from "react";
import { Paperclip, Crosshair } from "lucide-react";
import type { AttachedTab, ImagePart } from "@aipagego/shared/types";
import type { LlmSettings } from "@aipagego/shared/types";
import type { PermissionMode } from "../chat/severity";
import { optimizePrompt } from "@/sidepanel/lib/optimize-prompt";
import { StagedImages } from "../components/staged-images";
import { StagedSelectors } from "../components/staged-selectors";
import { AboveInputTabs } from "./above-input-tabs";
import { InputBox } from "./input-box";
import {
  MentionPicker,
  type MentionTabOption,
  type MentionToolOption,
  type MentionBookmarkOption,
} from "./mention-picker";
import { PermissionModePill } from "./permission-mode-pill";
import { PromptOptimizeButton } from "./prompt-optimize-button";
import { PromptOptimizePreview } from "./prompt-optimize-preview";

export type InputStatus = "idle" | "streaming" | "awaiting" | "error";

type Props = {
  // input state
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  onStop: () => void;

  // chips
  currentTabUrl: string;
  attachedTabs: AttachedTab[];
  pickableTabs: MentionTabOption[];
  pickableTools: MentionToolOption[];
  pickableBookmarks: MentionBookmarkOption[];
  onAttachTab: (opt: MentionTabOption) => void;
  onMentionTool: (opt: MentionToolOption) => void;
  onMentionBookmark: (opt: MentionBookmarkOption) => void;
  onDetachTab: (tabId: number) => void;
  onOpenTabPicker: () => void;

  // permission mode
  permissionMode: PermissionMode;
  onPermissionChange: (m: PermissionMode) => void;
  trustedDangerTools: string[];
  onTrustedChange: (next: string[]) => void;

  // images
  stagedImages: ImagePart[];
  stagedSelectors: string[];
  onImageFiles: (files: File[]) => void;
  onRemoveImage: (idx: number) => void;
  onRemoveSelector: (idx: number) => void;

  /** "选元素" 按钮回调（向 content script 发 startCapture） */
  onStartCapture: () => void;

  // status meta
  status: InputStatus;

  // prompt optimize
  settings: LlmSettings;
  currentTabId: number | null;
  roundCount: number;
  maxRounds: number;
  tokensIn: number;
  tokensOut: number;
};

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

export function InputToolbar(props: Props) {
  const [mentionOpen, setMentionOpen] = useState(false);
  const tokenTotal = props.tokensIn + props.tokensOut;
  const fileRef = useRef<HTMLInputElement>(null);
  const canSubmit =
    !!props.value.trim() ||
    props.stagedImages.length > 0;

  type OptState =
    | { kind: "closed" }
    | { kind: "loading"; original: string; ac: AbortController }
    | { kind: "preview"; original: string; optimized: string }
    | { kind: "error"; original: string; error: string };
  const [opt, setOpt] = useState<OptState>({ kind: "closed" });
  const optRef = useRef(opt);
  optRef.current = opt;

  useEffect(() => {
    return () => {
      // 卸载时 / 切换 tab 时如果还在 loading，取消请求
      if (optRef.current.kind === "loading") {
        optRef.current.ac.abort();
        setOpt({ kind: "closed" });
      }
    };
  }, [props.currentTabId]);

  async function runOptimize(original: string) {
    if (props.currentTabId == null) return;
    const ac = new AbortController();
    setOpt({ kind: "loading", original, ac });
    try {
      const optimized = await optimizePrompt({
        draft: original,
        tabId: props.currentTabId,
        settings: props.settings,
        signal: ac.signal,
      });
      // 若在等待期间被 abort 或替换，忽略结果
      if (ac.signal.aborted) return;
      setOpt({ kind: "preview", original, optimized });
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setOpt({ kind: "error", original, error: msg });
    }
  }

  function handleOptimizeClick() {
    if (opt.kind === "loading" || opt.kind === "preview") return;
    if (opt.kind === "error") {
      // 直接重试
      void runOptimize(opt.original);
      return;
    }
    const draft = props.value.trim();
    if (!draft) return;
    void runOptimize(props.value);
  }

  const optimizeStatus: "idle" | "loading" | "error" =
    opt.kind === "loading" ? "loading" : opt.kind === "error" ? "error" : "idle";
  const optimizeDisabled = !props.value.trim() || props.status === "streaming";

  return (
    <div className="bg-zinc-950">
      <AboveInputTabs
        currentTabUrl={props.currentTabUrl}
        attachedTabs={props.attachedTabs}
        onDetach={props.onDetachTab}
        onAddTab={props.onOpenTabPicker}
      />
      <StagedImages images={props.stagedImages} onRemove={props.onRemoveImage} />
      <StagedSelectors selectors={props.stagedSelectors} onRemove={props.onRemoveSelector} />

      <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-2 space-y-2 relative">
        {opt.kind !== "closed" && (
          <PromptOptimizePreview
            original={opt.original}
            optimized={opt.kind === "preview" ? opt.optimized : undefined}
            error={opt.kind === "error" ? opt.error : undefined}
            loading={opt.kind === "loading"}
            onAccept={() => {
              if (opt.kind === "preview") {
                props.onChange(opt.optimized);
                setOpt({ kind: "closed" });
              }
            }}
            onRegenerate={() => {
              if (opt.kind === "loading") opt.ac.abort();
              void runOptimize(opt.original);
            }}
            onDiscard={() => {
              if (opt.kind === "loading") opt.ac.abort();
              setOpt({ kind: "closed" });
            }}
          />
        )}
        <InputBox
          value={props.value}
          onChange={props.onChange}
          onSubmit={() => props.onSubmit(props.value)}
          canSubmit={canSubmit}
          onAtTrigger={() => setMentionOpen(true)}
          onImageFiles={props.onImageFiles}
          disabled={props.status === "streaming"}
          placeholder={
            props.stagedSelectors.length > 0
              ? "针对已选元素输入指令..."
              : undefined
          }
          rightAction={
            <PromptOptimizeButton
              status={optimizeStatus}
              disabled={optimizeDisabled}
              onClick={handleOptimizeClick}
            />
          }
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 relative">
            <PermissionModePill
              mode={props.permissionMode}
              onChange={props.onPermissionChange}
              trustedDangerTools={props.trustedDangerTools}
              onTrustedChange={props.onTrustedChange}
            />
            <button
              type="button"
              aria-label="@ 引用 tab"
              className="px-2 py-1 rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 text-[11px]"
              onClick={() => setMentionOpen((o) => !o)}
            >
              @
            </button>
            <button
              type="button"
              aria-label="加图片"
              className="px-2 py-1 rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 text-[11px]"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip size={14} />
            </button>
            <button
              type="button"
              aria-label="选元素"
              title="点页面任意元素，作为引用添加"
              className="px-2 py-1 rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 text-[11px]"
              onClick={props.onStartCapture}
            >
              <Crosshair size={14} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                const list = e.target.files;
                if (!list || list.length === 0) return;
                props.onImageFiles(Array.from(list));
                e.target.value = "";
              }}
            />
            {mentionOpen && (
              <MentionPicker
                tabs={props.pickableTabs}
                tools={props.pickableTools}
                bookmarks={props.pickableBookmarks}
                onPickTab={(opt) => {
                  setMentionOpen(false);
                  props.onAttachTab(opt);
                }}
                onPickTool={(opt) => {
                  setMentionOpen(false);
                  props.onMentionTool(opt);
                }}
                onPickBookmark={(opt) => {
                  setMentionOpen(false);
                  props.onMentionBookmark(opt);
                }}
                onClose={() => setMentionOpen(false)}
              />
            )}
          </div>

          <div className="flex items-center gap-2 text-[10px]">
            {props.roundCount > 0 && (
              <span className="text-zinc-500" data-testid="round-pill">
                {props.roundCount}/{props.maxRounds}
              </span>
            )}
            {tokenTotal > 0 && (
              <span className="text-zinc-500" data-testid="token-meter">
                {formatTokens(tokenTotal)}
              </span>
            )}
            {props.status === "streaming" ? (
              <button
                type="button"
                onClick={props.onStop}
                aria-label="停止"
                className="px-3 py-1 rounded-md bg-red-900 text-red-100 text-[12px] hover:bg-red-800"
              >
                ■
              </button>
            ) : (
              <button
                type="button"
                aria-label="发送"
                disabled={!canSubmit}
                onClick={() => props.onSubmit(props.value)}
                className="px-3 py-1 rounded-md bg-blue-700 text-white text-[12px] hover:bg-blue-600 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
