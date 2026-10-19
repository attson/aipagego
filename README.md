```
   █████╗ ████████╗    ██╗    ██╗███████╗██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗
  ██╔══██╗╚══██╔══╝    ██║    ██║██╔════╝██╔══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝
  ███████║   ██║       ██║ █╗ ██║█████╗  ██████╔╝██████╔╝██║██║     ██║   ██║   ██║
  ██╔══██║   ██║       ██║███╗██║██╔══╝  ██╔══██╗██╔═══╝ ██║██║     ██║   ██║   ██║
  ██║  ██║   ██║       ╚███╔███╔╝███████╗██████╔╝██║     ██║███████╗╚██████╔╝   ██║
  ╚═╝  ╚═╝   ╚═╝        ╚══╝╚══╝ ╚══════╝╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝
```

**浏览器侧边栏里的 AI 网页助手**  ·  OPEN SOURCE [TYPESCRIPT · REACT]

在你正在浏览的网页上读、写、采:总结与翻译、填表与提交、抓图片评论和商品参数。任意一段成功对话都能固化成按 URL 匹配的可重放工具,网站小改动时自动自愈。也可以作为 MCP server 交给 Codex 或 Claude Code 驱动。

---

- **体验** — <https://attson.github.io/atwebpilot/>
- **下载** — [GitHub Releases](https://github.com/attson/atwebpilot/releases/latest)
- **文档** — <https://attson.github.io/atwebpilot/guide/install>
- **协议** — Apache-2.0

---

## 跑起来

```bash
# 只用扩展:到 Releases 下载 zip,在 chrome://extensions 加载已解压的扩展。

# 交给 Codex 驱动:
npx -y @attson/atwebpilot-mcp --install-codex-skill
codex mcp add atwebpilot -- npx -y @attson/atwebpilot-mcp

# 或交给 Claude Code 驱动:
claude mcp add atwebpilot --scope user -- npx -y @attson/atwebpilot-mcp

# 源码调试:
pnpm install
pnpm build      # 产出 packages/extension/dist/
pnpm dev        # 扩展开发模式
```

依赖 Node 20+ / pnpm 9。首次使用需在设置页填 LLM provider 与 API Key。

Codex Skill 安装到用户级 `~/.agents/skills/atwebpilot-browser/`，不会修改任何项目的 `AGENTS.md`。MCP **不用手填端口**:AI 第一次通过 `browser_start` 操作网页时会自动弹出配对页,点「允许」即接入,之后本机会话免确认。

---

## 文档

[安装](https://attson.github.io/atwebpilot/guide/install) ·
[配置](https://attson.github.io/atwebpilot/guide/config) ·
[第一条任务](https://attson.github.io/atwebpilot/guide/first-task) ·
[工具参考](https://attson.github.io/atwebpilot/tools/overview) ·
[保存为工具](https://attson.github.io/atwebpilot/advanced/save-as-tool) ·
[MCP Bridge](https://attson.github.io/atwebpilot/advanced/mcp-bridge) ·
[多会话配对](https://attson.github.io/atwebpilot/advanced/pairing) ·
[页面事件录制](https://attson.github.io/atwebpilot/advanced/recorder)

贡献者从 [AGENTS.md](./AGENTS.md) 开始;设计与实施文档在 [docs/superpowers/](./docs/superpowers/)。
