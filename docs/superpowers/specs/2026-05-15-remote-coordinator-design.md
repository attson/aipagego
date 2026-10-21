# 远程协调器：把 AIPageGo 暴露给外部 AI 与服务端 — 设计文档

- 日期：2026-05-15
- 状态：草案，待评审
- 范围：让 AIPageGo 扩展能被三类外部消费者驱动——本地 MCP 客户端（Claude Desktop / Code / Cursor 等）、用户自己的业务后端、未来的远程 SaaS——同时保留现有 sidepanel 用户路径完全不变
- 前置：Plan 1–7 全部已落地（19 个内置工具、step / 工具持久化、URL pattern、static-scan、多 tab 上下文）

## 1. 背景与目标

当前 AIPageGo 只有一条驱动路径：用户在 sidepanel 输入指令 → LLM 调工具 → 工具改页面。两个反复出现的诉求让这条路径不够：

1. **想让自己写的服务端代码下指令**：跑长任务、批量采集、定时巡查、和现有业务系统串成流水线，而不是手动开浏览器一个个跑
2. **想让别的 AI 用这套能力**：Claude Code 在写代码时直接调"这个页面的主图采下来"；Claude Desktop 在做分析时直接"把这三个 tab 里的表汇总"——而不是 copy/paste

这两个诉求底层共享同一个能力：**让 AIPageGo 扩展接受来自浏览器外的指令**。本设计把这条能力抽象成 "Coordinator + Worker" 模型，让两个场景共用一套协议、一套核心代码，部署上分两种形态。

目标：

- MCP 用户零配置（装扩展 + 装一个本地二进制 + 配对码）就能在 Claude Desktop 里用 AIPageGo 工具
- 业务后端能在自己的代码里 `POST /tasks` 派一个采集任务，扩展跑完结果回流
- attended（真人浏览器）和 unattended（headless Chrome）两种 worker 用同一套接入协议
- 不影响 sidepanel 现有用户路径与工具体验

非目标：

- 不做 SaaS / 多租户账号体系（v1 自托管）
- 不内置任何第三方代理 / 反爬 / 验证码服务
- 不做 MCP HTTP/SSE 远程暴露（v1 仅 stdio 本地；server 形态只走 REST）
- 不替换扩展内现有 LLM agent loop——它仍是 sidepanel 用户的入口
- 不动 IndexedDB schema、不动现 19 个工具的 input/output schema

## 2. 顶层架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          上游消费者                                       │
│  ┌─────────────────┐    ┌───────────────────┐    ┌───────────────────┐ │
│  │ Claude Desktop  │    │ Claude Code/Cursor│    │ 你的业务后端/cron │ │
│  │ Cline / ...     │    │                   │    │ (Python/Node/...) │ │
│  └────────┬────────┘    └─────────┬─────────┘    └─────────┬─────────┘ │
│           │  MCP stdio            │  MCP stdio             │ REST/SDK   │
└───────────┼───────────────────────┼────────────────────────┼────────────┘
            ▼                       ▼                        ▼
   ┌──────────────────┐    ┌────────────────┐    ┌─────────────────────┐
   │ aipagego-daemon  │    │ aipagego-daemon│    │   aipagego-server   │
   │   (本地单进程)    │    │   (本地)       │    │   (你的机房/云)     │
   │  ─────────────── │    │ ─────────────  │    │  ─────────────────  │
   │  MCP Server      │    │  MCP Server    │    │  REST API           │
   │  Coordinator     │    │  Coordinator   │    │  Task Queue         │
   │  WS Hub (loop)   │    │  WS Hub (loop) │    │  Coordinator        │
   │                  │    │                │    │  WS Hub (TLS)       │
   └────────┬─────────┘    └───────┬────────┘    └──────────┬──────────┘
            │ WS                    │ WS              WS │ (token + TLS)
            ▼                       ▼                    ▼
       ┌─────────┐             ┌─────────┐         ┌────────────────────┐
       │ 真人浏  │             │ 真人浏  │         │  Worker 池          │
       │ 览器+   │             │ 览器+   │         │  ┌───────────────┐  │
       │ 扩展    │             │ 扩展    │         │  │ attended 浏览器│  │
       │(worker) │             │(worker) │         │  └───────────────┘  │
       └─────────┘             └─────────┘         │  ┌───────────────┐  │
                                                   │  │ headless+扩展 │  │
                                                   │  └───────────────┘  │
                                                   └────────────────────┘
```

**3 个核心不变量**：

1. **扩展是同一份代码 + 同一套协议**——不知道连的是 daemon 还是 server，区别只是配置里写哪个 ws url + token。同一时刻只连一个 coordinator（避免双脑指挥），可在设置里切换 profile。
2. **daemon 和 server 共享 Coordinator 核心**——session 管理、worker 注册、capability 校验、dispatch、catalog 聚合都是同一个 npm package，差异只在外层（stdio MCP + loopback / REST + TLS）。
3. **同一份 step 定义**——扩展、daemon、server 三边共享 TypeScript 类型，新增工具一处加、三处可见。

## 3. 仓库布局（monorepo 改造）

从单包改为 pnpm workspaces：

```
aipagego2/
├─ packages/
│  ├─ shared/                    ← 三方共享，纯函数 + 类型
│  │  ├─ src/
│  │  │  ├─ steps/               ← 现 src/shared/steps 迁过来
│  │  │  ├─ static-scan/         ← 现 src/shared/static-scan
│  │  │  ├─ url-pattern/
│  │  │  ├─ protocol/            ← 新：worker WS 消息 schema (zod)
│  │  │  ├─ mcp-tools/           ← 新：MCP tool JSON Schema 定义
│  │  │  └─ capability/          ← 新：capability scope 定义 + 校验
│  │  └─ package.json
│  ├─ coordinator/               ← 新：daemon 与 server 共享调度核
│  │  ├─ src/
│  │  │  ├─ session-manager.ts
│  │  │  ├─ worker-registry.ts
│  │  │  ├─ dispatcher.ts
│  │  │  ├─ catalog.ts
│  │  │  ├─ ws-hub.ts            ← 抽象接口，loopback/tls 各自实现
│  │  │  └─ index.ts
│  │  └─ package.json
│  ├─ extension/                 ← 现 src/ 整体迁过来
│  │  └─ src/
│  │     ├─ background/
│  │     │  ├─ ...
│  │     │  └─ coordinator-client.ts   ← 新
│  │     ├─ content/             ← 不动
│  │     └─ sidepanel/
│  │        ├─ ...
│  │        └─ pages/CoordinatorSettings.tsx   ← 新
│  ├─ daemon/                    ← 新：本地 MCP 入口
│  │  ├─ src/
│  │  │  ├─ cli.ts               ← `aipagego-daemon` 入口
│  │  │  ├─ mcp-server.ts        ← @modelcontextprotocol/sdk stdio
│  │  │  ├─ pair.ts              ← 配对码生成/校验
│  │  │  └─ index.ts
│  │  └─ package.json            ← pkg/bun 打成单 binary
│  └─ server/                    ← 新：中心服务
│     ├─ src/
│     │  ├─ http/                ← REST: /tasks /workers /tools
│     │  ├─ queue/               ← v1: 内存 + Postgres lock
│     │  ├─ db/                  ← PG schema
│     │  ├─ auth/                ← token / 租户
│     │  └─ index.ts
│     ├─ docker-compose.yml
│     └─ package.json
├─ pnpm-workspace.yaml
└─ package.json
```

**边界约定**：

| 包 | 唯一职责 | 主要依赖 |
|---|---|---|
| `shared` | 纯函数 + 类型，零状态 | zod、ts |
| `coordinator` | 内存中的 session/worker/catalog 状态机 | `shared` |
| `extension` | 浏览器侧执行器 + 用户 UI | `shared` |
| `daemon` | 单租户 stdio MCP 网关 | `shared`、`coordinator`、MCP SDK |
| `server` | 多租户 REST + 持久化 + 队列 | `shared`、`coordinator`、PG client |

约束：

- `coordinator` 不直接 IO；WS hub 通过依赖注入。`coordinator` 单测可全程内存。
- `extension` 不依赖 `coordinator` 或 `daemon`，仅依赖 `shared/protocol` 拿消息 schema。

**对现有代码的入侵面**：

- monorepo 迁移：~30 个 import 路径调整，主要靠 codemod
- `background/index.ts` 加 `coordinator-client.start()`，~50 行
- `sidepanel` 加配对/设置页 + capability 勾选 UI
- `rpc-handlers.ts` 加 `source: 'sidepanel' | 'coordinator'` 用于 audit
- 不动现 sidepanel 工作流、不动 19 个 tool 实现、不动 IDB schema

## 4. 协议与数据流

### 4.1 配置决策（已敲定）

| 决策点 | 选择 |
|---|---|
| 部署拓扑 | 双拓扑：本地 daemon（MCP 场景） + 中心 server（采集场景） |
| Worker 形态 | attended（真人浏览器） + unattended（headless Chrome），同一协议接入 |
| Worker ↔ Coordinator 协议 | WebSocket 长连接 + 20s 心跳；MV3 用 `chrome.alarms` 保活 |
| Daemon 语言 | Node/TypeScript，pkg/bun 打成单 binary |
| 工具暴露层级 | 两层都暴露：默认 saved tools；显式开关启用 low-level explore tools |
| 调用路由 | session 抽象：`open_session` → `session_id`，后续调用都带 |
| 认证 | 配对码（首次）→ 长 token（持久）+ nonce + ts 防重放 |
| dangerous 确认 | session 创建时声明 capability scope，开工前一次性人工授权（attended）或预配 strict scope（headless） |
| 结果返回 | 流式 progress + 终态 result（MCP progress notifications） |

### 4.2 Worker 接入（首次配对 + 重连）

`aipagego-daemon` 启动时在控制台打印 6 位配对码（5 分钟内有效）。用户在扩展设置粘 ws url + 配对码：

```
扩展                    Daemon                              用户
  │                       │                                   │
  │   显示配对码 482917 (有效期 5min)                          │
  │                       │                                   │
  │   用户粘 ws://127.0.0.1:7842 + 482917 到扩展设置          │
  │ ◄─────────────────────────────────────────────────────────│
  │                       │                                   │
  │   POST /pair {code, fingerprint:{ext_hash, os, chrome}}    │
  ├──────────────────────►│                                   │
  │   200 {token: "wpk_xxx", expires_at, server_pubkey_pin}    │
  │ ◄─────────────────────│                                   │
  │                       │                                   │
  │   WS Upgrade /worker, Authorization: Bearer wpk_xxx        │
  │   X-Protocol-Version: 1                                    │
  ├──────────────────────►│                                   │
  │   HELLO {worker_id, capabilities, attended:true,           │
  │          available_tabs[], saved_tools[],                  │
  │          labels:["chrome:macos","logged-in:shop"]}          │
  ├──────────────────────►│                                   │
  │   WELCOME {server_time, heartbeat_interval_ms:20000}       │
  │ ◄─────────────────────│                                   │
  │                       │                                   │
  │   (循环) PING / PONG  │                                   │
```

要点：

- token 双向 pin：扩展 pin server 公钥指纹，server pin 扩展 fingerprint（OS + Chrome 版本 + 扩展 hash），变更需 re-pair
- 扩展在 HELLO 阶段一次性把"我能干什么"全报上去——能力清单 + tabs + saved_tools 元数据（含 hash）
- 协议版本号有两处：HTTP upgrade header `X-Protocol-Version: 1` 用于在 WS 升级前快速拒绝；每条 WS message 也带 `protocol_version` 字段。HELLO 里再次核对，不兼容立即断 + 下发"升级建议"

### 4.3 open_session（AI 端发起）

```
AI Client       MCP/REST 入口             Coordinator                  Worker
   │                  │                          │                       │
   │ open_session({                              │                       │
   │   url:"https://shop.example.com/...",   │                       │
   │   labels?:["logged-in:shop"],                │                       │
   │   capabilities:["click","fillInput",        │                       │
   │                 "httpRequest:cookied"]      │                       │
   │ })                                          │                       │
   ├─────────────────►│                          │                       │
   │                  │ session.open(req)        │                       │
   │                  ├─────────────────────────►│                       │
   │                  │  worker = registry.pick(url, labels)             │
   │                  │  attended? → 推审批弹窗等用户授权 scope            │
   │                  │  headless? → 检查 scope ⊆ worker.strict_caps     │
   │                  │  OPEN_TAB or REUSE_TAB                           │
   │                  │                          ├──────────────────────►│
   │                  │                          │ {tab_id, ready}       │
   │                  │                          │◄──────────────────────┤
   │                  │  session_id = uuid()                             │
   │                  │  state.set(session_id, {worker, tab_id, scope,   │
   │                  │                          expires_in: 30min})     │
   │                  │ ←{session_id}────────────┤                       │
   │ {session_id}     │                          │                       │
   │◄─────────────────┤                          │                       │
```

attended worker 一开 session 触发**一次**弹窗（"AI 申请使用此浏览器做 click / fillInput / httpRequest:cookied，30 分钟内不再问"），用户点同意后写 audit log。headless worker 直接走预配置 strict capability set，超出立即拒。

### 4.4 Low-level tool 调用（safe / caution / dangerous）

```
AI            MCP             Coordinator              Worker
 │             │                   │                     │
 │ tool(session_id, args)          │                     │
 ├────────────►│ callTool(...)     │                     │
 │             ├──────────────────►│                     │
 │             │   ↓ 校验：         │                     │
 │             │     1. session 存在/未过期               │
 │             │     2. tool ∈ scope                     │
 │             │     3. quota 余量                       │
 │             │   EXEC {req_id, tab_id, step:{...}}     │
 │             │                   ├────────────────────►│
 │             │                   │                     │ tab.run()
 │             │                   │     RESULT          │ (19 工具之一)
 │             │                   │◄────────────────────┤
 │             │   ←{ok, return}───┤                     │
 │             │       audit.append                       │
 │   {result}  │                   │                     │
 │◄────────────┤                   │                     │
```

dangerous 例：若 `submitForm` 不在 scope 内，coordinator 直接 `PermissionDenied`，不到 worker——不让 sidepanel 又卡一次。错误体里带 `denied_capability`，AI 才能判断"我需要扩 scope"。

### 4.5 Saved tool 调用（高阶）

```
AI                  MCP            Coordinator                  Worker
 │ list_tools(session_id)            │                          │
 ├──────────────────►│               │                          │
 │                   │ catalog.listFor(session)                 │
 │                   │  ↓ 按 session.url 过 url_pattern         │
 │                   │ ←[{id, desc, input_schema, hash, ...}]   │
 │                   │               │                          │
 │ run_tool(session_id, tool_id, input)                         │
 ├──────────────────►│ runSaved(...) │                          │
 │                   ├──────────────►│                          │
 │                   │   ↓ 从 catalog 取 step[] (含 hash)        │
 │                   │   ↓ 校验所有 step.tool ∈ scope            │
 │                   │   RUN_TOOL {tool_id, hash, input, steps[]}│
 │                   │               ├─────────────────────────►│
 │                   │               │   ↓ 校验 hash             │
 │                   │               │   ↓ 按 step[] 顺序跑      │
 │                   │               │◄ PROGRESS {idx, partial} │ × N
 │                   │ ◄ progress ───┤                          │
 │ ◄ progress ───────┤  (MCP progress)                          │
 │                   │               │◄ RESULT {ok, return}     │
 │                   │ ←{ok, return}─┤                          │
 │◄──────────────────┤               │                          │
```

**hash 校验**是供应链防御：扩展在 HELLO 时上报 saved_tools[].hash，coordinator 缓存。`RUN_TOOL` 下发 step 时带 hash，扩展执行前再算一次 hash 必须匹配——server 端被改动也跑不起来。

### 4.6 状态机

```
                    open_session
   [no session] ───────────────────► [active] ◄──┐
        ▲                                │      │ tool call
        │                                │ idle 30m
        │                                ▼      │
        │                            [expired]  │
        │                                │      │
        │                                │ tool │
        │                                │ call │
        │                                ▼      │
        │           worker reconnect  [error]   │
        │  ◄────────────────────────────┤      │
        │           close_session       │      │
        └───────────────────────────────┴──────┘
                                         │
        worker disconnect → [paused] ─── auto reconnect ──► [active]
                              │
                              └─ 5min timeout ──► [closed]
```

异常细节：

- 页面 navigate 中途 → coordinator 给 AI 推 `notifications/session_event {kind:"navigated", url}`，AI 自行决定继续还是 close_session（沿用扩展现"页面跳转"事件）
- AI 端断开 MCP（stdio EOF）→ session 标记 `orphan`，5 分钟内同 fingerprint 可恢复
- 扩展 SW 被 Chrome 杀 → 重启后用本地 token 重连，HELLO 带 `last_session_states[]`，coordinator 把对应 session 从 `paused` 恢复到 `active`
- 同一 token 两个扩展同时连 → 拒后到者（默认）；可配置改为"驱逐先到者"

## 5. 错误处理 + 安全 + 限流

### 5.1 错误分类

错误统一形状：`{code, message, retryable, retry_after_ms?, audit_id, hints?}`，MCP 端映射到 `isError: true` + 结构化 content。

| 大类 | 典型 code | retryable | AI 应对 |
|---|---|---|---|
| ProtocolError | `SessionNotFound` `SessionExpired` `InvalidArgs` `PermissionDenied` `ToolHashMismatch` | 否 | 重开 session / 申请新 scope / 报错给用户 |
| WorkerError | `WorkerDisconnected` `TabClosed` `NavigationLost` `PageScriptError` | 多数是 | retry_after 后重试；NavigationLost 等价"页面变了"需重探查 |
| CoordinatorError | `WorkerBusy` `QueueFull` `InternalError` | 是 | 退避重试 |

`PermissionDenied` 必带 `denied_capability` 字段——AI 才知道"我想做 X 但 scope 里没勾"，决定向用户申请扩 scope 还是放弃。**绝不做静默失败**。

### 5.2 威胁模型 + 缓解

| 威胁 | 缓解 |
|---|---|
| 恶意 AI 滥用 dangerous | scope 在 open_session 时由人/配置授；headless worker 走预配 strict scope；运行时再校验 |
| token 被偷 | daemon 限 loopback（OS 进程隔离 + token 双保险）；server 强 TLS + token；token 可一键 revoke；扩展定期上报指纹，异常告警 |
| 中间人 / 重放 | server 形态 TLS only；每条 WS message 带单调 nonce + ts；coordinator 缓存最近 5min nonce 防重放 |
| 恶意页面影响 content script | 沿用 MV3 isolated world，不引入新注入面 |
| AI 用 runJS 干坏事 | scope 中 `runJS` 分 `runJS:scanned`（无 eval/storage 关键词）和 `runJS:unsafe`（含）；后者只能用户在扩展 UI 勾选 |
| 同机别进程冒充 coordinator | 扩展 HELLO 时校验 server fingerprint（pair 时 pin 公钥）；不匹配立即断 |
| 凭证泄漏到 audit log | rpc-handler 写 audit 前用 `redactSecrets()` mask cookie / authorization / password / token |
| AI 套取 saved tool 实现 | list_tools 只回 metadata（描述、参数 schema、step 数、hash），不回 step 源码；run 时 step 仅在扩展执行 |

### 5.3 Audit log

```
daemon: ~/.aipagego/audit.log (append-only)
server: PG.audit_events
─────────────────────────────────────────────
ts | worker_id | session_id | ai_fingerprint |
tool | scope_used | result(ok/fail/code) |
duration_ms | args_redacted | return_size_bytes
```

AI 无权读 audit；扩展侧保留本地 audit（沿用 SessionEvent 流），供用户离线审计。

### 5.4 限流 + 滥用防护

| 维度 | 默认值 | 越界后果 |
|---|---|---|
| 单 session 并发调用 | 1（串行） | 后到者 `WorkerBusy` |
| 单 worker QPS | attended 5/s；headless 20/s | 排队 ≤2s 否则 `WorkerBusy` |
| 单 session 总步数 | 200（与现 max round 一致） | `SessionExhausted` |
| 单 session dangerous 数 | 50 | `DangerousQuotaExceeded` |
| 单 token QPS（server） | 配置 | 429 |
| 单租户日配额（server） | 配置 | 402 / 429 |

额外暴露 MCP 工具 `get_quota({session_id})` 给 AI 主动看预算余量。

## 6. 测试策略

```
                        ┌─────────────────────────┐
                        │ E2E (Playwright + 真扩展) │  ~10 场景，nightly
                        │ Claude SDK→daemon→真Chr→ │
                        │ fixture HTTP server      │
                        └─────────────┬───────────┘
                ┌─────────────────────┴────────────────────┐
                │  集成测试                                │
                │  • daemon: spawn + MCP SDK + 假 worker   │  ~30 个，PR 必跑
                │  • server: docker PG + 多假 worker       │
                └─────────────────────┬────────────────────┘
       ┌──────────────────────────────┴─────────────────────────────┐
       │  契约测试（两条硬契约 freeze 为 fixture）                     │
       │  • protocol/*.fixture.json ↔ shared/protocol schema parse    │
       │  • mcp-tools/*.fixture.json ↔ MCP SDK 转发结果               │
       └──────────────────────────────┬─────────────────────────────┘
   ┌──────────────────────────────────┴─────────────────────────────┐
   │  单元测试                                                       │
   │  shared 100% │ coordinator ~90% │ extension 现 168 + 新         │
   └────────────────────────────────────────────────────────────────┘
```

**每包测试重点**：

| Package | 主测什么 | 工具 | 不测什么 |
|---|---|---|---|
| `shared` | zod、url-pattern、static-scan、capability 集合代数 | vitest | 有状态的东西（没有） |
| `coordinator` | session 状态机、worker pick、scope 校验、dispatch | vitest + 假 WS hub + 假 worker stub | 真 WS、真 PG |
| `extension` | coordinator-client 重连/心跳/HELLO/断网恢复；配对 UI | 现有 vitest + happy-dom + 假 WS server | 真 daemon |
| `daemon` | MCP 方法路由、配对码生命周期、单 binary 启动 | spawn real daemon + MCP SDK + 假扩展 WS client | 真扩展（留 E2E） |
| `server` | REST 端点、队列调度、多 worker 分配、租户隔离 | testcontainers (PG) + 多假 worker | 真扩展 |

**契约 freeze**：`packages/shared/src/protocol/__fixtures__/*.v1.json`，提交 hook 校验"改 fixture 必须 bump `PROTOCOL_VERSION`"——coordinator 在 HELLO 阶段做版本握手，不兼容直接拒。

**E2E 场景清单**（对应 README 的手测脚本）：

| # | 场景 | 验证什么 |
|---|---|---|
| 1 | MCP 调 `open_session` + `extractText`（维基百科） | 全链路 + safe 工具自动跑 |
| 2 | 调 saved tool `run_tool("shop_v3")`（httpbin fixture） | catalog hash 校验 + progress 流式 |
| 3 | 未授权 scope 调 `submitForm` | `PermissionDenied` 非 `WorkerError` |
| 4 | 扩展 SW 被强杀 → 30s 后再调 | 重连 + session 恢复 |
| 5 | session idle 30min | `SessionExpired` |
| 6 | 同 worker 3 个 session 同时调 | 串行；并发 `WorkerBusy` |
| 7 | server 模式：1 task 同时有 attended + headless 满足 | label 优先 + 负载均衡 |
| 8 | dangerous quota 用完 | 拒绝 + audit 写入 |
| 9 | 协议版本不匹配 | HELLO 阶段断 + 升级提示 |
| 10 | tool hash 改了 | 扩展拒绝运行 + 告警写 audit |

E2E：Playwright + persistent context + 打包的真扩展载入；trace + audit log 失败时上传 artifact。

**CI**：

```
push / PR
├─ typecheck (tsc -b)
├─ unit: pnpm -r test (并行)
├─ contract: 协议 fixture roundtrip
└─ integration: pnpm test:int  (docker compose PG)

nightly / manual
└─ e2e: playwright + 真扩展 + 真 daemon (10 scenarios)
```

**不测的事**：

- 不测真 LLM 调用（已有 mock）
- 不测真实电商网站（用本地 fixture HTTP server 控 HTML）
- 不测 Chrome 升级兼容（手工 monitor + nightly E2E 兜底）

## 7. 附录

### 7.1 Capability 完整清单（v1）

按现 19 个工具的安全等级映射：

| Capability | 对应工具 | 默认级 | 备注 |
|---|---|---|---|
| `read:dom` | snapshotDOM、querySelector、querySelectorAll、extractText、extractFormState、getValue | safe | 默认全部 session 自动获得 |
| `read:image` | extractImages | safe | 同上 |
| `read:storage` | readStorage | dangerous | 单独 grant，含 cookie/local/session |
| `nav:tab` | hover、focus、scroll、waitFor | safe | 同上 |
| `interact:form` | click、fillInput、setCheckbox、selectOption | caution | open_session 时声明 |
| `submit:form` | submitForm | dangerous | 必显式 |
| `upload:file` | uploadFile | dangerous | 必显式 + 文件路径白名单 |
| `httpRequest:no-cookie` | httpRequest (没带 cookie) | caution | |
| `httpRequest:cookied` | httpRequest (带 cookie) | dangerous | |
| `runJS:scanned` | runJS（静态扫描通过） | caution | |
| `runJS:unsafe` | runJS（含 eval/storage 等关键词） | dangerous | 用户在扩展 UI 单独勾 |
| `tab:open` | listTabs、openTab、attachTab、detachTab | caution | 跨 tab 操作必带 |

### 7.2 WS 协议消息表（v1）

| 方向 | 消息 | payload 关键字段 |
|---|---|---|
| C→S | HELLO | worker_id, fingerprint, capabilities, attended, available_tabs[], saved_tools[]{id,hash,url_pattern,...}, labels[] |
| S→C | WELCOME | server_time, heartbeat_interval_ms, server_pubkey_pin |
| C→S | PING | nonce, ts |
| S→C | PONG | nonce, ts |
| S→C | OPEN_TAB | session_id, url, reuse_if_match: url_pattern? |
| C→S | TAB_READY | session_id, tab_id, current_url |
| S→C | EXEC | req_id, session_id, tab_id, step{tool, args} |
| C→S | PROGRESS | req_id, partial |
| C→S | RESULT | req_id, ok, return / error |
| C→S | SESSION_EVENT | session_id, kind:"navigated"\|"tab_closed"\|"audit", payload |
| S→C | CLOSE_SESSION | session_id |
| C→S | STATE_SNAPSHOT | last_session_states[]（断线重连用） |

全部消息一律带 `nonce`、`ts`、`protocol_version`，coordinator 5min 内 nonce 去重防重放。

### 7.3 MCP 工具表（v1）

| Tool name | 描述 | 入参 |
|---|---|---|
| `open_session` | 在 worker 池开会话 | url, labels?, capabilities[], idle_timeout_min? |
| `close_session` | 关会话 | session_id |
| `list_tools` | 列当前 session 可用 saved tools | session_id |
| `run_tool` | 跑一个 saved tool | session_id, tool_id, input |
| `get_quota` | 看额度 | session_id |
| `list_tabs` | 列当前 session 可见 tabs | session_id |
| `explore_*`（19 个） | low-level 工具，受 capability 控制 | session_id + 对应工具原 args |

`explore_*` 默认隐藏，daemon/server 配置里 `expose_low_level: true` 才出现在 `tools/list`。

### 7.4 迁移步骤（高层）

为后续 plan 留位的指引，详细分解由 writing-plans 接手：

1. **Phase 0** 工程基建：pnpm workspaces；现 src/ → packages/extension/；shared 子树独立；CI 改并行 `pnpm -r`
2. **Phase 1** Protocol + Coordinator 核心：`shared/protocol`、`shared/capability`、`coordinator` package（纯内存，可单测）
3. **Phase 2** 扩展接入：`coordinator-client.ts`、配对 UI、HELLO/EXEC 链路打通；sidepanel 路径完全不动
4. **Phase 3** Daemon：MCP stdio + WS hub loopback + 配对码；MVP 暴露 saved tools，explore tools 默认 off
5. **Phase 4** Server：REST + queue + PG + 多 worker；docker-compose；attended/headless worker label
6. **Phase 5** E2E + 文档 + 发布：Playwright 10 场景；快速上手；example 业务后端

每个 Phase 内部按 writing-plans 的 task 粒度拆。

### 7.5 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| MV3 service worker 杀进程频率随版本变化 | WS 长连接不稳 | chrome.alarms 心跳；HELLO 带 last_session_states 重连后恢复 |
| MCP 客户端实现差异（不同 IDE） | 用户体验割裂 | 严格按 MCP spec；E2E 至少覆盖 Claude Desktop + Claude Code |
| Saved tool 在不同 worker 内容不一致 | hash 校验失败、AI 困惑 | catalog 按 worker 维度聚合；list_tools 返回 `provided_by_workers: [...]`；UI 提示同步 |
| 配对码被同机其他用户偷看（共享设备） | token 泄漏 | 5min 短有效期 + 一次性消费 + 配对窗口可主动撤销；pair 时校验扩展 fingerprint |
| 业务后端把 dangerous scope 全开方便调用 | 扩散安全风险 | server 端默认配置 strict scope；放开 dangerous 需 admin 改配置 + audit 流量告警 |
| daemon 单二进制升级与扩展协议不匹配 | 用户运行混乱 | HELLO 协议版本握手 + 推升级提示；二进制内置 `--check` 自检 |
| Headless Chrome 载扩展兼容性坑 | unattended worker 起不来或不稳 | 必须用 "new headless"（Chrome 109+）+ `--load-extension`；不支持 `headless-shell`；CI/Docker 镜像锁定 Chrome 主版本；启动时自检扩展是否成功注入并把结果写 worker label |
