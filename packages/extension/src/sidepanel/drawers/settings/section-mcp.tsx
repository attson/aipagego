import { Check, Copy } from "lucide-react";
import { useState } from "react";

const CLAUDE_CODE_COMMAND =
  "claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp";
const WS_URL = "ws://127.0.0.1:8787/worker";

const JSON_CONFIG = JSON.stringify(
  {
    mcpServers: {
      aipagego: {
        command: "npx",
        args: ["-y", "@attson/aipagego-mcp"],
      },
    },
  },
  null,
  2
);

export function SectionMcp() {
  return (
    <section className="bg-zinc-900 rounded p-3 space-y-3 text-xs">
      <h3 className="text-zinc-300">MCP 配置</h3>
      <p className="text-zinc-500 text-[11px]">
        MCP server 会在本机启动 WebSocket coordinator。扩展连接到这个地址后，Claude Code
        等 MCP 客户端就能通过工具驱动当前浏览器页面。
      </p>

      <ConfigBlock
        title="Claude Code"
        description="推荐方式，一行命令添加用户级 MCP server。"
        code={CLAUDE_CODE_COMMAND}
        copyLabel="复制 Claude Code MCP 命令"
      />

      <ConfigBlock
        title="通用 MCP JSON"
        description="适合支持 mcpServers JSON 的客户端。"
        code={JSON_CONFIG}
        copyLabel="复制 MCP JSON 配置"
      />

      <ConfigBlock
        title="扩展 Coordinator"
        description="打开左侧 Coordinator 分类，把 WS URL 填为下面地址，然后点击连接。Token 默认可留空；设置 AIPAGEGO_WS_TOKEN 时需填同一个 token。"
        code={WS_URL}
        copyLabel="复制 Coordinator WS URL"
      />

      <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-[11px] text-zinc-400 space-y-1">
        <div>可选环境变量：</div>
        <code className="block text-zinc-300">AIPAGEGO_WS_PORT=8787</code>
        <code className="block text-zinc-300">AIPAGEGO_WS_TOKEN=your-token</code>
      </div>
    </section>
  );
}

function ConfigBlock(props: {
  title: string;
  description: string;
  code: string;
  copyLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(props.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-zinc-200">{props.title}</div>
          <div className="text-zinc-500 text-[10px]">{props.description}</div>
        </div>
        <button
          type="button"
          aria-label={props.copyLabel}
          title={props.copyLabel}
          onClick={() => void copy()}
          className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-zinc-950 border border-zinc-800 p-2 text-[11px] text-zinc-300 whitespace-pre-wrap break-words">
        <code>{props.code}</code>
      </pre>
    </div>
  );
}
