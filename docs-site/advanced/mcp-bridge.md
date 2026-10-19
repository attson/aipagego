# MCP Bridge — Codex / Claude Code 驱动浏览器

## 概念

MCP Bridge = stdio MCP server + 本地 Coordinator，两者打包在 `@attson/atwebpilot-mcp`。装了之后：

```
Codex / Claude Code ─(MCP stdio)─→ atwebpilot-mcp ─(WS worker)─→ Chrome 扩展 ─→ 网页
```

Codex 或 Claude Code 里就能调 `browser_*` 系列工具在真实网页上读、写、采。

值得先知道方向：**MCP server 进程是 WS 服务端，扩展是客户端**。MV3 的 service worker 没有
监听端口的能力，所以只能由扩展主动拨号。这也是配对页存在的原因 —— 服务端没法自己找到浏览器，
只能把端口**告知**扩展。

## 安装

### Codex CLI

```bash
npx -y @attson/atwebpilot-mcp --install-codex-skill
codex mcp add atwebpilot -- npx -y @attson/atwebpilot-mcp
```

第一条命令安装用户级 Skill，第二条把 server 加到 Codex 的用户级 MCP 配置；两者都不会修改
项目的 `AGENTS.md`。新开一个 Codex 会话后，可用
`codex mcp get atwebpilot` 检查配置。

### Claude Code

```bash
claude mcp add atwebpilot --scope user -- npx -y @attson/atwebpilot-mcp
```

### 连接扩展

然后照常装扩展。**不用手填端口**：

1. 会话启动时不绑任何端口 —— 不碰网页的会话零副作用
2. AI 第一次调 `browser_start` 时才绑一个空闲端口，自动打开配对页并等待最多 45 秒
3. 你在浏览器里点「允许」后，同一次调用在 tab 唯一时直接返回 ready session；多个候选时返回 `select_tab`
4. 之后本机的会话都免确认；端口能复用时连配对页都不会弹

详见 [多会话配对](/advanced/pairing)。

可选环境变量：

| 变量 | 说明 |
|---|---|
| `ATWEBPILOT_WS_PORT` | 固定端口。默认是自动选一个空闲端口并复用上次那个 |
| `ATWEBPILOT_WS_TOKEN` | 要求扩展带 `bearer.<token>` 子协议 |
| `ATWEBPILOT_MCP_TOOLS` | 连接前仅控制面；连接后为 `core`（默认 31 个）或 `full`（全部 51 个） |
| `ATWEBPILOT_CODEX_SKILLS_DIR` | 覆盖 Skill 安装根目录；默认 `~/.agents/skills` |

## Codex / Claude Code 可用的 MCP tools

| 工具 | 用途 |
|---|---|
| `browser_start` | 真实网页任务的首选入口：配对、无歧义选 tab、创建 session |
| `pairing_status` | 无阻塞启动/检查浏览器配对状态 |
| `list_tabs` | 底层兼容入口：列出所有 tab，含 `busy` / `mine` 占用标记 |
| `open_session` | 底层兼容入口：开启一个 session，绑定某 tab |
| `browser_*` × 51 | 扩展全部内置工具的 MCP 包装 |
| `get_quota` | 查询当前 session 剩余次数 |
| `close_session` | 关闭 session |
| `atwebpilot_skill_read` | 读取推荐的工具使用流程与安全约定 |

`browser_*` 与扩展内置工具一一对应，参数一致，只是把 `tabId` 换成 `session_id`。详见
[工具参考](/tools/overview)。

不暴露的三个：`askUser`（MCP 会话没有人在侧边栏应答）、`attachTab` / `detachTab`
（侧边栏多 tab 记账，MCP 的目标 tab 已由 `open_session` 绑定）。

工具列表会和扩展上报的 `supported_tools` 求交集，所以旧版扩展配新版 server 时不会出现
「列出来但一调就 unknown tool」。

## 替代 `@playwright/mcp --extension`

playwright-ext 的每个能力这里都有对应项（名字是 AtWebPilot 的）：

| playwright-ext | AtWebPilot |
|---|---|
| `browser_snapshot` | `browser_takeSnapshot`（uid 可直接喂给 `clickByUid` / `fillByUid`） |
| `browser_find` | `browser_findElements` |
| `browser_click` / `browser_type` | `browser_click`（含 `doubleClick`/`button`/`modifiers`）、`browser_fillInput`（含 `slowly`/`submit`） |
| `browser_drag` / `browser_drop` | 同名 |
| `browser_navigate` / `browser_navigate_back` | `browser_navigate`（`action` 取 `goto` / `back` / `forward` / `reload`） |
| `browser_resize` | `browser_resize` |
| `browser_take_screenshot` | `browser_screenshot`（含 `fullPage` / `format` / `scale`） |
| `browser_wait_for` | `browser_waitFor`（含 `text` / `textGone`） |
| `browser_evaluate` | `browser_runJS` |
| `browser_console_messages` | `browser_consoleMessages` |
| `browser_network_requests` | `browser_networkRequests` / `browser_networkRequestDetail` |
| `browser_handle_dialog` | `browser_handleDialog` |

两处语义差异要知道，见 [页面事件录制](/advanced/recorder)：默认档下 `handleDialog` 是**预先策略**
而不是反应式；`resize` 动的是真实窗口。

AtWebPilot 额外有的：页面索引四件套、`extractImages`、`httpRequest`、`downloadSpreadsheet`
（真 `.xlsx`）、书签与历史搜索。

## 手起 mcp-server（开发用）

```bash
pnpm -F @attson/atwebpilot-mcp start
```

不绑端口；首次用到浏览器时才绑并弹配对页。用于本地调试 mcp-server 逻辑，不用装 npx 包。

详见 `packages/mcp-server/README.md`。
