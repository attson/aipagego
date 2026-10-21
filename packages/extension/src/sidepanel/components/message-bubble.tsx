import type { ChatMessage } from "@aipagego/shared/types";
import { Copy } from "lucide-react";

function CopyMessageButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      aria-label="复制消息"
      title="复制消息"
      className="shrink-0 rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => undefined);
      }}
    >
      <Copy size={13} aria-hidden="true" />
    </button>
  );
}

export function MessageBubble(props: { message: ChatMessage }) {
  const m = props.message;
  if (m.role === "user") {
    if (typeof m.content === "string") {
      return (
        <div className="bg-blue-900/40 rounded p-2 text-xs flex flex-col gap-1">
          <div className="flex justify-end">
            <CopyMessageButton text={m.content} />
          </div>
          <div className="whitespace-pre-wrap">{m.content}</div>
        </div>
      );
    }
    // Array content: render images + text together (skip tool_result, that's chat history plumbing)
    const images = m.content.filter((c): c is Extract<typeof c, { type: "image" }> => c.type === "image");
    const texts = m.content.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text");
    if (images.length === 0 && texts.length === 0) return null;
    const text = texts.map((t) => t.text).join("");
    return (
      <div className="bg-blue-900/40 rounded p-2 text-xs space-y-1.5">
        {text && (
          <div className="flex justify-end">
            <CopyMessageButton text={text} />
          </div>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.media_type};base64,${img.data}`}
                alt={`image ${i + 1}`}
                className="max-h-32 rounded border border-blue-800"
              />
            ))}
          </div>
        )}
        {texts.length > 0 && (
          <div className="whitespace-pre-wrap">{text}</div>
        )}
      </div>
    );
  }
  const text = m.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (!text) return null;
  return (
    <div className="bg-zinc-800/60 rounded p-2 text-xs flex flex-col gap-1">
      <div className="flex justify-end">
        <CopyMessageButton text={text} />
      </div>
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
}
