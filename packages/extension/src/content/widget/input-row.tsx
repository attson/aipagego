import { Send, Square } from "lucide-react";
import { PermissionModePill } from "@/sidepanel/input/permission-mode-pill";
import { StagedImages } from "@/sidepanel/components/staged-images";
import { InputBox } from "@/sidepanel/input/input-box";
import { fileToImagePart, MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from "@/sidepanel/lib/image-utils";
import { setPermissionMode } from "@/sidepanel/chat/session-store";
import { useSettings } from "@/sidepanel/chat/settings-store";
import type { ImagePart } from "@aipagego/shared/types";
import type { SessionData } from "@/sidepanel/chat/session-store";
import type { PermissionMode } from "@/sidepanel/chat/severity";

type Props = {
  session: SessionData;
  tabId: number;
  input: string;
  onInputChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  stagedImages: ImagePart[];
  onSetStagedImages: (imgs: ImagePart[]) => void;
  disabled: boolean;
  isBusy: boolean;
};

export function InputRow({
  session, tabId, input, onInputChange,
  onSubmit, onStop, stagedImages, onSetStagedImages,
  disabled, isBusy,
}: Props) {
  const trustedDangerTools = useSettings((s) => s.trustedDangerTools);
  const saveSettings = useSettings((s) => s.save);

  const canSend = !isBusy && (input.trim().length > 0 || stagedImages.length > 0);

  async function handleImageFiles(files: File[]) {
    const room = Math.max(0, MAX_IMAGES_PER_TURN - stagedImages.length);
    const accepted = files
      .filter((f) => f.size <= MAX_IMAGE_BYTES)
      .slice(0, room);
    const parts = await Promise.all(accepted.map(fileToImagePart));
    onSetStagedImages([...stagedImages, ...parts]);
  }

  return (
    <div className="flex flex-col shrink-0">
      {/* Pill row */}
      <div className="flex items-center gap-2 px-2 py-1 border-t border-zinc-800">
        <PermissionModePill
          mode={session.permissionMode as PermissionMode}
          onChange={(m) => setPermissionMode(tabId, m)}
          trustedDangerTools={trustedDangerTools}
          onTrustedChange={(next) => void saveSettings({ trustedDangerTools: next })}
        />
      </div>
      {/* Staged images (renders null if empty) */}
      <StagedImages
        images={stagedImages}
        onRemove={(idx) => onSetStagedImages(stagedImages.filter((_, i) => i !== idx))}
      />
      {/* Input + send/stop */}
      <div className="flex items-end gap-2 p-2">
        <div className="flex-1">
          <InputBox
            value={input}
            onChange={onInputChange}
            onSubmit={onSubmit}
            onImageFiles={handleImageFiles}
            disabled={disabled}
            placeholder="告诉 AI 你要做什么…"
          />
        </div>
        {isBusy ? (
          <button
            data-testid="widget-stop-btn"
            onClick={onStop}
            title="停止"
            className="h-9 px-2 bg-red-800 hover:bg-red-700 rounded text-red-100"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            data-testid="widget-send-btn"
            onClick={onSubmit}
            disabled={!canSend}
            title="发送"
            className="h-9 px-2 bg-emerald-700 hover:bg-emerald-600 rounded text-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
