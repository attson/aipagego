# @attson/atwebpilot-mcp

让 Codex 或 Claude Code 经一个本地 ws 中继驱动 atwebpilot 浏览器扩展操作网页（读 / 写 / 采）。

## 给用户：一行装

Codex：

    codex mcp add atwebpilot -- npx -y @attson/atwebpilot-mcp

Claude Code：

    claude mcp add atwebpilot --scope user -- npx -y @attson/atwebpilot-mcp

然后[下载 release zip](https://github.com/attson/atwebpilot/releases/latest) 加载已解压扩展。

**不需要手填端口。** 从 Plan 33 起是配对流程：

1. 会话启动时**不绑任何端口** —— 不碰网页的会话零副作用。
2. AI 第一次调 `list_tabs` 时才绑一个空闲端口，通过 MCP URL elicitation 请宿主打开配对页；不支持该能力的宿主回退到系统默认浏览器。`list_tabs` 最多等待 45 秒。
3. 你在浏览器里点「允许」，扩展即接入；同一次 `list_tabs` 调用直接返回 tab，AI 无需让你回复「已连接」。只有等待超时才返回 `pairing_required + pair_url`；`pairing_status` 始终是立即返回的非阻塞状态检查。
4. 之后本机的会话都免确认（信任是安装级的）；端口能复用时连配对页都不会弹。

若宿主和系统都未弹出浏览器，可在超时结果中打开 `pair_url`。授权成功只以扩展实际建立连接并发送 `HELLO` 为准；打开配对页本身不代表已连接。

多个 Codex / Claude Code 会话可以同时接入同一个浏览器，各自一条连接。可在扩展设置 →
Coordinator 查看已接入的会话、单独断开，或撤销信任。

可选环境变量：

- `ATWEBPILOT_WS_PORT`：固定端口（默认是自动选一个空闲端口并复用上次的）
- `ATWEBPILOT_WS_TOKEN`：要求扩展带 `bearer.<token>` 子协议

## 给开发者：本地 monorepo

    pnpm -F @attson/atwebpilot-mcp start

环境变量同上，路径用 `tsx src/index.ts` 直跑（包内 `start` script 已封）。

## 多会话

每个 MCP server 进程是 WS **服务端**，扩展是**客户端** —— MV3 service worker 没有
listen 端口的能力，所以方向只能如此。这也是配对页存在的原因：服务端没法主动找到浏览器，
只能由它把自己的端口**告知**扩展。

扩展侧维护一个连接池，每个已配对会话一条连接。`list_tabs` 会告诉你哪些 tab 正被**别的**
会话占用（`busy` / `busy_label`）——只是提示，不拦截；AI 看到占用通常直接 `openTab` 开一个新的就行。

## 工具面

- 控制面 5 个：`pairing_status / list_tabs / open_session / close_session / get_quota`
- 发现 1 个：`browser_discoverTools` —— 已知工具时直接传 `enable: [...]`，已知分组时直接传 `enableGroups: ["export", ...]`，也可用 `profile: "core" | "full"` 切换整套工具面；只有这些都未知时才不带参数读取目录。选中的工具会加入本进程的 `tools/list`（发送 `tools/list_changed`），并始终返回完整 schema，包括已经启用的工具。
- 同轮执行桥 1 个：`browser_call({session_id, tool, args})` —— 某些宿主虽已刷新 `tools/list`，却不会在当前模型轮次注入新工具。AI 可在 `discoverTools` 后立刻通过该桥执行，不需要让用户回复“继续”；下一轮看到原生工具后仍优先使用原生工具。
- 批量编排 1 个：`browser_runSteps({session_id, steps, return_bindings?})` —— 在步骤和参数已经明确时，把 1–20 个 safe/caution 工具合并为一次 MCP 调用；`${binding}` 可引用前序结果。整批先做工具支持、权限和配额预检，dangerous、脚本、截图、下载与 tab 生命周期操作保持单步。
- 执行面在浏览器连接前不进入 `tools/list`；连接确认后加载默认 **core 31 个** `browser_*`。其余 20 个由 AI 按需 `discoverTools` 拉取，用户不用配置。
- 不暴露 `askUser`（MCP 会话没有人在侧边栏应答）和 `attachTab` / `detachTab`（目标 tab 已由 `open_session` 绑定）。

MCP 层的描述是精简英文（≈2.5k tokens for core），侧边栏内置 LLM 仍用中文长描述；两者共享同一份 `TOOL_DEFS`，靠 `mcp` 字段区分。

工具列表会和扩展 `HELLO` 里上报的 `supported_tools` 求交集，所以旧版扩展配新版 server 时不会
出现「列出来但一调就 unknown tool」。字段缺失（Plan 32 之前的扩展）时回落到旧版扩展支持的内置
工具集，与 core 求交集后只剩 9 个（`extractText / click / fillInput / selectOption / setCheckbox /
hover / uploadFile / scroll / waitFor`）；`browser_storage` 也不会列出，因为旧版没有
`writeStorage`。请升级扩展。

### 环境变量 `ATWEBPILOT_MCP_TOOLS`

| 值 | 效果 |
|---|---|
| `core`（默认） | 连接前仅控制面、发现工具、同轮执行桥与批量编排；连接后再列出 31 个核心工具 |
| `full` | 连接前同上；连接后列出全部 51 个原生工具 |

无法识别的值（包括已移除的 `parity`）按 `core` 处理，并往 stderr 打一条提示。

## 本地会话效率分析

在仓库根目录运行：

```bash
pnpm analyze:sessions
pnpm analyze:sessions -- --since 7d --clients claude --format json
pnpm analyze:sessions -- --since 24h --clients codex --latest-session
```

分析器只读扫描 `~/.claude/projects` 与 `~/.codex/sessions` 中最近 30 天的
JSONL，识别真实 AtWebPilot 工具调用及重复验证、固定等待、重复截图、可批量填表、配对超时与无状态重试等
模式。输出只包含聚合计数、参数字段名与不可逆指纹；不会输出或保存 prompt、参数值、
工具结果正文、凭证或绝对会话路径。Codex 嵌套调用会关联 wait cell 的耗时、错误以及
cached/uncached token；使用 `--latest-session` 只看最近一条真实使用记录。

### 从 0.0.70 及更早版本迁移

| 旧 | 新 |
|---|---|
| `browser_navigateBack` / `browser_navigateForward` | `browser_navigate({ action: "back" \| "forward" })` |
| `browser_highlightElement` / `browser_highlightText` | `browser_highlight({ selector \| uid \| text })` |
| `browser_readStorage` / `browser_writeStorage` | `browser_storage({ op: "get" \| "set", store, key, value? })` |
| `ATWEBPILOT_MCP_TOOLS=parity` | 已移除；默认即 `core` |
| 默认列出全部工具 | 默认只列 core；其余通过 `browser_discoverTools` 获取，或设 `ATWEBPILOT_MCP_TOOLS=full` |

## 替代 playwright-ext

`@playwright/mcp --extension` 的每个工具在这里都有对应项（名字是 AtWebPilot 的，不是 playwright 的）：

| playwright-ext | AtWebPilot |
|---|---|
| `browser_snapshot` | `browser_takeSnapshot`（uid 可直接喂给 `clickByUid` / `fillByUid`） |
| `browser_find` | `browser_findElements` |
| `browser_click` | `browser_click`（含 `doubleClick` / `button` / `modifiers`）、`browser_clickByUid` |
| `browser_type` | `browser_fillInput`（含 `slowly` / `submit`） |
| `browser_fill_form` | `browser_fillForm` |
| `browser_select_option` / `browser_hover` / `browser_press_key` | 同名去掉下划线：`browser_selectOption` / `browser_hover` / `browser_pressKey` |
| `browser_drag` / `browser_drop` | `browser_drag` / `browser_drop` |
| `browser_file_upload` | `browser_uploadFile` |
| `browser_navigate` / `browser_navigate_back` | `browser_navigate`（`action` 取 `goto` / `back` / `forward` / `reload`） |
| `browser_tabs` | `browser_listTabs` / `openTab` / `closeTab`; `switchToTab` 需按需发现，仅用于用户明确要求前台切换 |
| `browser_close` | `browser_closeTab` |
| `browser_resize` | `browser_resize` |
| `browser_take_screenshot` | `browser_screenshot`（含 `fullPage` / `format` / `scale`） |
| `browser_wait_for` | `browser_waitFor`（含 `text` / `textGone`） |
| `browser_evaluate` / `browser_run_code_unsafe` | `browser_runJS` |
| `browser_console_messages` | `browser_consoleMessages` |
| `browser_network_requests` / `browser_network_request` | `browser_networkRequests` / `browser_networkRequestDetail` |
| `browser_handle_dialog` | `browser_handleDialog`（默认档是预设策略，见下） |

两处语义差异，调用前要知道：

- **`handleDialog` 在默认档是预先策略，不是反应式。** `alert` / `confirm` / `prompt` 是同步的，
  打了补丁也没法挂起等 agent 决定。开启设置里的 CDP 档之后弹窗真挂起，行为才和 playwright 一致。
- **`networkRequestDetail` 的 body 默认不记。** 先 `recorderConfig({bodies:true})` 再复现请求。
  不开时返回元数据加一条 `bodyUnavailable` 说明怎么开。

AtWebPilot 额外有 playwright-ext 没有的：page-index 四件套、`extractImages`、`httpRequest`、
`downloadSpreadsheet`（真 `.xlsx`）、书签/历史搜索。

详细协议与设计见 [`../../docs/superpowers/specs/2026-06-06-mcp-bridge-design.md`](../../docs/superpowers/specs/2026-06-06-mcp-bridge-design.md)。

⚠ 进程禁止往 stdout 写非 MCP 内容（stdout 是 MCP 通道）。所有日志走 stderr。
