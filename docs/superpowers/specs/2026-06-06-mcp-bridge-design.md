# MCP Bridge（Phase 3）— 让 Claude 经 Coordinator 驱动浏览器

> 状态：设计已评审通过，待 writing-plans。
> 对应 plan：`../plans/2026-06-06-mcp-bridge.md`（待生成）。

## 1. 目标与场景

让 **Claude Code（在终端里，stdio MCP 客户端）** 能直接驱动 **一个本地浏览器扩展**，在网页上读 / 写 / 采。

架构硬约束：扩展永远是「主动拨出」连 WS 服务器的 worker，它自己不监听端口。所以 Claude 不能直连扩展，必须经过一个 coordinator WS 服务器中转：

```
Claude Code ──stdio/MCP──► MCP server ──verbs──► Coordinator ──ws──► 浏览器扩展 ──► 网页
                           （= 一个本地进程，同时是 ws 服务器）
```

**模式**：EXEC（Claude 当大脑，逐步发工具步、读 RESULT、再决策）。不在本期做 CHAT 远程驱动（`START_CHAT_SESSION` 那条路是 Plan 12 的事，与此正交）。

### 范围决策（brainstorming 结论）

- **本地单人交互**：单 worker、stdio 启动、无需真正的多租户认证（token 仅本地比对）。不做多 worker 选择、跨机、打包发布。
- **自动生成工具面**：复用扩展现成的 `TOOL_DEFS`（19 个内置工具的完整 JSON Schema），启动时为每个生成一个带真 schema 的 MCP 工具，Claude **零猜测、零漂移**。
- **复用 Coordinator 门面**：走现有 `session / quota / policy / catalog` 状态机，兑现 `coordinator.ts` 注释里「MCP server (Phase 3) 复用门面」的原始设计，并为未来远程多租户铺路。
- **拓扑方案 A**：新建 `packages/mcp-server` 独占重运行时依赖；`@aipagego/coordinator` 保持纯逻辑零运行时依赖。

### 非目标（YAGNI）

- 多 worker 选择 / `list_workers`（接口留 `worker_id`，未来再加）。
- 真正的配对码 / TLS / 远程认证（Phase 4 远程 server 的事）。
- CHAT 远程驱动、saved-tool 重放（Catalog 虽被门面带入，但本期不暴露对应 MCP 工具）；shared 现有的 `CONTROL_PLANE_TOOLS` 注册表（`list_tools`/`run_tool` 等远程愿景 schema）保持不动，mcp-server 在本包内定义务实的 4 个控制面 schema。
- `runJS` 与 4 个 tab 控制工具（`listTabs/openTab/attachTab/detachTab`）不纳入自动生成的执行面（见 §4）。
- 打包发布 / 跨平台分发。

## 2. 架构与包布局

```
packages/mcp-server/                 ← 新包
  package.json        deps: @aipagego/coordinator, @aipagego/shared,
                            ws, @modelcontextprotocol/sdk, zod
  src/
    index.ts          bin 入口：读 env（PORT / TOKEN）→ 装配并启动
    loopback-ws-hub.ts  实现 WSHub：绑真 ws 服务器 + req_id↔RESULT 配对
    mcp-server.ts     建 McpServer(stdio)，注册控制面 + 执行面工具
    tool-gen.ts       从 shared 的 TOOL_DEFS 生成 19 个 browser_* 工具
    wire.ts           hub.onMessage(HELLO/RESULT/PING…) ↔ coordinator.handle*
```

一个进程，两个面：

```
        ┌──────────────────── packages/mcp-server (1 个进程) ────────────────────┐
 Claude  │  stdio   ┌───────────┐      ┌─────────────┐      ┌─────────────────┐  │
 Code  ──┼─────────►│ mcp-server│─────►│ Coordinator │─────►│ LoopbackWSHub   │  │
         │  MCP     │ (工具注册) │ verbs│  门面(复用)  │ send │ (ws.Server:PORT)│  │
         │  ◄───────│           │◄─────│             │◄─────│ req_id↔RESULT   │  │
         └──────────┴───────────┴──────┴─────────────┴──────┴────────┬────────┘  │
                                                                      │ ws 子协议   │
                                                            bearer.<token>        │
                                                                      ▼           │
                                                           浏览器扩展 (worker)──► 网页
```

- `@aipagego/coordinator` **不改**，保持零运行时依赖。
- 新包独占 `ws` 与 `@modelcontextprotocol/sdk`。

## 3. 组件职责

### ① `LoopbackWSHub`（核心新代码）— implements 现有 `WSHub` 接口

- `new WebSocketServer({ port, path: "/worker" })`。握手时从 `Sec-WebSocket-Protocol` 取 `bearer.<token>` 比对（缺省 token 时放行任意非空），不匹配以 4401 close。
- 收 `HELLO` → 回 `WELCOME{ nonce, ts, protocol_version: 1, server_time, heartbeat_interval_ms }` → 经 `wire` 调 `coordinator.registerWorker(...)`。
- **配对职责**（`WSHub` 接口本身没有、但 coordinator 注释指明是 consumer 的责任）：维护 `Map<req_id, { resolve, reject, timer }>`。对外暴露 `exec(worker_id, tab_id, step): Promise<Result>`：生成 `req_id`、发 `EXEC`、挂 promise + 超时计时器；收到 `RESULT{req_id}` 时 resolve 并清计时器。
- 实现接口其余方法：`send` / `onMessage` / `onDisconnect` / `connectedWorkers` / `disconnect`。`onDisconnect` → `coordinator.unregisterWorker` + reject 所有 pending。

### ② `tool-gen.ts`

遍历 `TOOL_DEFS`（**从 `packages/extension/src/sidepanel/llm/tool-schema.ts` 上提到 `@aipagego/shared`**，扩展与 MCP server 共用一份源头），每条生成一个 MCP 工具：

- 名字 `browser_<toolName>`（如 `browser_click`）。
- input schema = 该工具的 `input_schema`，**移除内部 `tabId` 字段**（target tab 由 session 决定），**注入 `session_id`（required）**。
- handler：`sessions.get(session_id)` 拿 `worker_id + tab_id` → `coordinator.validateCall({ kind, tool, … })`（能力域 + 配额）→ 失败回 MCP isError；成功 `coordinator.recordCall(session_id, dangerous)` + `hub.exec(worker_id, tab_id, { tool, args })` → 把 `RESULT.return` 作为工具结果返回。

### ③ `mcp-server.ts`

注册控制面工具（复用 `shared/mcp-tools/schemas.ts` 已有 schema）+ tool-gen 的 19 个执行面工具，跑在 stdio transport。

### ④ `wire.ts`

`hub.onMessage` 分发：`HELLO→registerWorker`、`PING→heartbeat`、`RESULT→hub 内部配对`、其余 C→S（`PROGRESS / SESSION_EVENT / STATE_SNAPSHOT`）按需记日志。

## 4. 工具面（Claude 看到的完整清单）

### 控制面（4 个）

| 工具 | 入参 | 行为 |
|---|---|---|
| `list_tabs` | — | 返回当前 worker 的 `available_tabs`：`[{tab_id,url,title}]`。无 worker 时报友好错误。 |
| `open_session` | `tab_id`，`capabilities?`（缺省=全部已知能力），`idle_timeout_min?` | `coordinator.openSession({ worker_id: 唯一 worker, tab_id, scope })` → 返回 `session_id` |
| `close_session` | `session_id` | `coordinator.closeSession` |
| `get_quota` | `session_id` | `coordinator.quotaFor` → `{ max_steps, steps_used, max_dangerous, dangerous_used, ms_until_expiry }` |

`capabilities` 可选、缺省给全量——本地用 Claude 不必逐项报能力域；门面的价值落在**配额**（`max_steps=200`、`max_dangerous=50`）与「未来想收紧策略有地方收」。

### 执行面（19 个，自动生成）

自动生成的 19 个 = `BuiltinTool` 联合（与 `capabilityForTool` 的穷尽 switch 一一对应）。每个 `browser_<tool>`，入参 = `session_id` + 该工具真实 args（去掉内部 `tabId`）。dispatcher 多数按工具名判 dangerous，`httpRequest` **按参数升级**：

- safe：`browser_snapshotDOM` `browser_querySelector` `browser_querySelectorAll` `browser_extractText` `browser_extractImages` `browser_getValue` `browser_extractFormState` `browser_hover` `browser_focus` `browser_scroll` `browser_waitFor`
- caution：`browser_click` `browser_fillInput` `browser_setCheckbox` `browser_selectOption`
- 按参数升级：`browser_httpRequest`（默认 `httpRequest:no-cookie` caution；`withCredentials=true` → `httpRequest:cookied` dangerous，handler 据此置 `httpCookied`）
- dangerous（配额单独计数）：`browser_submitForm` `browser_uploadFile` `browser_readStorage`

> handler 调 `validateCall` 时按工具填 `DispatchInput`：`kind:"extension_tool"` + `tool`；`httpRequest` 额外带 `httpCookied`（取自 `args.withCredentials`）。
>
> **不生成**：`runJS`（`Step{kind:"js"}` 走 EXEC 无现成通路，且需静态扫描判 `unsafe`）与 4 个 tab 控制工具（`listTabs/openTab/attachTab/detachTab`，依赖会话 `attachedTabs` 语义）—— 均列入非目标，见 §1。

## 5. 数据流（一次 `browser_click`）

```
Claude ──browser_click{session_id,selector}──► mcp-server
  session = sessions.get(session_id)                    // 拿 worker_id + tab_id
  coordinator.validateCall({kind:"extension_tool", tool:"click", session_id})
     ├─ 域不覆盖 / 配额超 → MCP isError  ◄── Claude 收到结构化错误
     └─ ok → coordinator.recordCall(session_id, dangerous=false)
  hub.exec(worker_id, tab_id, {tool:"click", args:{selector}})
     生成 req_id；发 EXEC{nonce,ts,protocol_version,req_id,session_id,tab_id,step}
     Map[req_id] = {resolve, reject, timer}
                      │ ws
                      ▼
            扩展 handleExec → runOneStep(click) → RESULT{req_id, ok, return}
                      │ ws
                      ▼
  hub 收 RESULT → Map[req_id].resolve(return) → 清计时器
  mcp-server 把 return 作为工具结果回给 Claude
```

不变量：**`req_id` 是配对唯一钥匙**，由 hub 生成与消费；EXEC 的 `session_id` / `tab_id` 取自 session。

## 6. 错误处理与边界

| 情况 | 处理 |
|---|---|
| 还没 worker 连上就调 `list_tabs`/`open_session` | MCP isError：「没有浏览器连入，请在扩展设置页填 `ws://127.0.0.1:<port>/worker` 连接」 |
| EXEC 发出后超时无 RESULT（默认 ~30s） | 计时器触发 → reject → MCP `Timeout` 错误，清 Map 项 |
| worker 中途掉线 | `onDisconnect`：unregisterWorker + reject 所有 pending（`WorkerDisconnected`）；门面 `pauseByWorker` 标记其 session |
| 扩展侧步骤失败 | RESULT `{ok:false,error}` 原样透传为 MCP isError（含 PageScriptError 消息） |
| `session_id` 无效 / 已 close / 过期 | `validateCall` 返回 `SessionNotFound/SessionExpired` → MCP isError |
| 配额耗尽 | `SessionExhausted` / `DangerousQuotaExceeded` → MCP isError，提示开新 session |
| token 不匹配 | ws 握手阶段 4401 拒绝 |
| 多个 worker 同时连 | v1 单 worker：`open_session` 选「唯一」worker；若 >1 报错让用户只留一个（接口已留 `worker_id`，未来加 `list_workers`） |

## 7. 测试策略

沿用仓库现有风格（无 Playwright；真 `ws` 端到端；注入 `Clock`/`IdGen` 保确定性）：

- **单元 `tool-gen`**：喂 `TOOL_DEFS`，断言生成的 MCP 工具名 / schema（去掉 `tabId`、注入 `session_id`、`required` 正确）。
- **`LoopbackWSHub` 端到端**：起真 ws server，假 worker socket 连入发 `HELLO` → 断言收 `WELCOME`；`hub.exec` 发 `EXEC`、假 worker 回 `RESULT` → 断言 promise resolve；另测超时 reject、掉线 reject 两条路径。
- **桥接集成**：真门面 + `FakeClock`/`FakeIdGen`，跑 `open_session → browser_click → close_session` 全链路，断言 `validateCall` 被调、配额自增、`RESULT` 透传。
- **协议复用**：EXEC/RESULT 仍走 `@aipagego/shared` zod 校验；参照现有 `coordinator-e2e.test.ts`。

## 8. 影响面 / 改动清单

- **新增** `packages/mcp-server/`（4 个 src 文件 + package.json + tests）。
- **改动** `@aipagego/shared`：上提 `TOOL_DEFS`（及其 `LlmTool` 类型依赖）到 `shared/mcp-tools/`（或 `shared/builtin-tools/`），导出供两端复用。
- **改动** `packages/extension`：`tool-schema.ts` 改为 re-export shared 的 `TOOL_DEFS`（保持扩展侧零行为变化）。
- **不改** `@aipagego/coordinator`（仅被复用）。
- 根 `package.json` workspace / `pnpm-workspace.yaml` 纳入新包；`pnpm -r typecheck/test/build` 覆盖。

## 9. 手动验收

1. `node packages/mcp-server/dist/index.js`（或经 Claude Code MCP 配置启动），监听 `ws://127.0.0.1:<port>/worker`。
2. 扩展设置页 → Coordinator 子页填该 URL + 任意 token → 连接。
3. Claude 调 `list_tabs` 看到当前标签；`open_session(tab_id)` 拿 `session_id`。
4. `browser_snapshotDOM(session_id)` 返回当前页结构；`browser_click(session_id, selector)` 实际点击生效。
5. `get_quota` 显示 steps_used 递增；`close_session` 后再调报 `SessionNotFound`。
