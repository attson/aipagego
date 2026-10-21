# AI 采集器浏览器插件 — 设计文档

- 日期：2026-05-09
- 状态：草案，待评审
- 范围：单文档完整设计，对应一次实施计划周期

## 1. 背景与目标

用户在浏览商品详情等电商页面时，希望让 AI 帮忙采集主图、详情图、评论等内容。同一类页面的采集逻辑通常是稳定的 —— 一旦某次采集成功，之后只要页面没改版就可以**固化为可复用的工具**直接重放，不必每次都让 AI 重新分析。

设计目标：

- **AI 对话式触发首次采集**：用自然语言描述要采的字段，AI 按步骤完成
- **每一步可审阅**：AI 写出的代码、要点的按钮、要发的请求，执行前必须能看到
- **成功一次 = 一个工具**：采集流程被结构化记录、可保存、可重放
- **下次直接用工具**：URL 模式匹配，访问同类页面时插件自动提示可用工具
- **通用优先，不锁站点**：架构对站点无假设；可扩展到淘宝、京东、Amazon 等

非目标：

- 自动批量爬取、并发采集、定时任务（YAGNI）
- 后端服务、用户系统、跨设备云同步
- 反爬绕过、登录代理（用户用自己的浏览器 session，本身已登录）

## 2. 关键决策回顾

下列决策在头脑风暴阶段已确认，作为后续设计的硬约束：

| 决策点 | 选择 | 理由 |
|---|---|---|
| AI 角色 | 混合：优先工具调用，必要时生成 JS 片段 | 兼顾可控性与表达力 |
| LLM 接入 | 用户填 API Key，浏览器直连 | 零后端、零账号 |
| 交付形式 | 侧边面板展示 + 一键导出 JSON/CSV | 个人使用、按页处理 |
| 工具匹配 | URL 模式匹配（glob） | 简单可靠，命中后才提醒 |
| 失败恢复 | 报错 + 手动调 AI 修复，新版本与旧版本并存 | 保持人在回路 |
| 适用范围 | 任意网页，架构通用 | 站点无关的核心抽象 |
| 浏览器 | Chromium MV3（Chrome / Edge / Arc / Brave） | 主流且统一 API |
| 多步流程 | 支持（滚动、等待、点击、拦截 API） | 商品评论/详情图懒加载 |
| 图片导出 | 仅 URL 列表（含元信息） | 快、零跨域负担 |
| 安全模型 | 执行前必须人工预览危险步骤 | 避免 AI 误访 cookie/发请求 |

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│ Browser (Chromium MV3)                                      │
│                                                             │
│  ┌──────────────┐   ┌────────────────────────────────────┐  │
│  │ Side Panel   │   │ Content Script (ISOLATED world)    │  │
│  │ (chat UI)    │◄──┤  - Step Runner                     │  │
│  │  - 对话      │   │  - 内置工具桥                      │  │
│  │  - Step 流   │   │  - JS 片段 → MAIN world 注入       │  │
│  │  - 工具库    │   └────────────┬───────────────────────┘  │
│  │  - 导出      │                │ chrome.runtime           │
│  └──────┬───────┘                ▼                          │
│         │            ┌────────────────────────┐             │
│         └───────────►│ Service Worker (BG)    │             │
│                      │  - LLM 调用 (API Key)  │             │
│                      │  - 工具库 (IndexedDB)  │             │
│                      │  - URL 模式匹配        │             │
│                      │  - 跨域 httpRequest    │             │
│                      └────────────────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

三层职责：

- **Side Panel (UI)** — 唯一与用户交互的入口。聊天、Step 列表、人工审阅、工具管理、导出与导入
- **Content Script (执行)** — 在被注入页面里执行 step。Step Runner 自身住在 isolated world；任意 AI 生成的 JS 片段通过 `chrome.scripting.executeScript({ world: "MAIN" })` 注入
- **Service Worker (大脑+存储)** — 调 LLM、维护工具库、跨域 fetch 代理、监听 tab URL 变化推送可用工具

模块之间通过 typed RPC 通信（schema 定义在 `shared/messages.ts`）。

## 4. 数据模型

```typescript
// 一个工具 = URL 模式 + 有序 Step 列表 + 输出 schema
type Tool = {
  id: string;                    // uuid
  name: string;                  // 例: "商品详情页采集器"
  urlPatterns: string[];         // 例: ["https://shop.example.com/goods*.html"]
  description: string;           // AI 生成 + 用户可改
  steps: Step[];                 // 当前主线版本步骤
  outputSchema: JsonSchema;      // 例: { mainImages: string[], reviews: {...}[] }
  createdAt: number;
  updatedAt: number;
  versions: ToolVersion[];       // 历史版本快照（修复后保留旧版回滚）
  stats: { runs: number; lastRunAt?: number; lastRunOk?: boolean };
};

type ToolVersion = {
  version: number;               // 1, 2, 3 ...
  steps: Step[];
  outputSchema: JsonSchema;
  createdAt: number;
  note?: string;                 // 例: "商品评论 selector 改版后修复"
};

type Step =
  | { kind: "tool"; tool: BuiltinTool; args: Json; bindResultTo?: string }
  | { kind: "js";   source: string;     bindResultTo?: string };

// bindResultTo: 这一步结果存到上下文变量名；后续步骤的 args 里可用 ${var} 引用

type BuiltinTool =
  | "snapshotDOM"             // 给 AI 看的页面摘要（结构 + 关键文本）
  | "querySelector"            // 单个匹配
  | "querySelectorAll"         // 多个匹配
  | "extractImages"            // 抓所有 <img>，含 src/srcset/data-src
  | "extractText"              // 取文本
  | "scroll"                   // { to: "bottom"|"top"|number, max?, untilSelector? }
  | "waitFor"                  // { selector? | ms? | predicate? }
  | "click"                    // 触发某节点
  | "httpRequest"              // 后台发请求（cookie 默认 omit）
  | "readStorage";             // localStorage / sessionStorage 指定 key

// 注: LLM 在 tool-use 模式下额外暴露一个虚拟工具 `runJS({source})`，
// 它不是 BuiltinTool，而是被 session 层翻译成 Step.kind = "js" 推入 steps[]。

type RunRecord = {
  id: string;
  toolId: string;
  toolVersion: number;
  url: string;
  startedAt: number;
  finishedAt?: number;
  status: "pending-approval" | "running" | "ok" | "error" | "aborted";
  stepLog: {
    stepIndex: number;
    input: Json;
    output: Json;
    ms: number;
    error?: string;
  }[];
  output?: Json;                // 最终结果（应符合 outputSchema）
};
```

要点：

- **工具是声明式的**：URL 模式 + 一串可重放 step。不是一段大 JS
- **`bindResultTo` / `${var}`**：步骤间传递数据（例如第 1 步抓出的 reviewIds 给第 3 步 httpRequest 用）
- **`versions[]`**：AI 修复改版后保留旧版本，方便回滚和 A/B
- **`outputSchema`**：固化时由 AI 推断，方便后续导出 / webhook 字段稳定

## 5. 交互流程

### 5.1 首次采集（AI 模式）

```
用户在商品详情页 → 打开侧边面板
   │
   ▼
[侧边面板] 输入: "把主图、详情图、前 50 条评论拿出来"
   │
   ▼
[Service Worker] 调 LLM (tool-use mode)
   │   工具集: {snapshotDOM, querySelector*, extractImages, scroll,
   │           waitFor, click, httpRequest, readStorage, runJS}
   │   系统提示: 优先使用结构化工具；只在工具不够时调 runJS
   ▼
[LLM] tool_call: snapshotDOM({maxDepth: 4})
   │
   ▼ ← 侧边面板渲染:
        ┌─ Step 1: snapshotDOM (safe)        [✓ 自动通过]
        │   args: {maxDepth: 4}
        └────────────────────────────────────────────
   │   (默认 safe 工具自动通过；危险工具 / runJS 必须人工点)
   ▼
[Content Script] 执行 → 返回 DOM 摘要
   │
   ▼
[LLM] 看到摘要 → tool_call: extractImages({selectors: [...]})
   │  ... 反复多步 ...
   ▼
[LLM] 终态: 给出 final_output + 建议保存为工具
   │
   ▼
[侧边面板] 展示结果 JSON + [保存为工具] 按钮
```

关键策略：

- **safe 工具**（snapshotDOM, querySelector*, extractText, extractImages, waitFor, scroll）默认自动连续执行
- **caution / dangerous 工具**（详见 §6.2）每次都要人工点"通过"
- **runJS** 步骤侧边面板高亮源码，并把静态扫描命中的关键词标红（fetch / document.cookie / eval / chrome.* / new Function）

### 5.2 保存为工具

成功一次后弹"保存为工具"对话框：

- 名称（AI 默认填，用户可改）
- URL 模式（默认从当前 tab 提取，可改 glob）
- 步骤列表（默认折叠，可展开查看每一步）
- 输出 schema（AI 从最终输出推断，用户可改）

保存写入 IndexedDB，作为该工具的 version 1。后台监听 tab URL 变化，命中模式时给 action icon 加角标，并在面板顶部出现"▶ 运行"按钮。

### 5.3 重放（直接用工具）

```
打开匹配 URL 的页面 → 侧边面板顶部出现 "▶ 运行: 商品详情页采集器"
   │
   ▼
[Step Runner] 顺序执行 step[]
   │   - safe 步骤直接跑
   │   - risky 步骤同样人工预览（提供"全部通过"快捷按钮）
   │   - 任何步骤抛错 → 状态 error，整体停止
   ▼
[侧边面板] 输出符合 outputSchema 的 JSON / 一键导出
```

### 5.4 失败修复

工具失败时面板显示：

```
✗ Step 3 失败: querySelectorAll('.review-item') 返回 0 条
   [让 AI 修复] [手动重跑] [回滚到旧版本]
```

点"让 AI 修复" → 把当前页 snapshotDOM + 错误信息 + 旧 step 数组发给 LLM，让它产出新 steps[]。新版本作为 v2 存入 `tool.versions`，运行时优先用最新版；在工具详情页可一键回滚到任一历史版本。

## 6. 执行沙箱与安全

### 6.1 双世界注入

MV3 content script 默认在 **isolated world**：能访问页面 DOM，但拿不到页面 JS 变量、不会被页面脚本污染。**Step Runner 本身住在 isolated world**。

`runJS` 步骤里 AI 生成的代码必须能访问页面级变量（页面把数据塞在 `window.rawData`），所以通过 `chrome.scripting.executeScript({ world: "MAIN", func, args })` 注入到 MAIN world。注入函数包一层壳，参数取 step 的 `args` 和已 bind 的变量，返回值序列化为 JSON 回灌到 isolated world。

### 6.2 三类工具，三个权限等级

| 等级 | 工具 | 自动通过？ | 风险 |
|---|---|---|---|
| safe | snapshotDOM, querySelector*, extractImages, extractText, waitFor, scroll | ✓ 是 | 只读 DOM，无副作用 |
| caution | click, httpRequest（无 cookie）, runJS（静态扫描通过） | ✗ 必须确认 | 触发页面行为 / 发外网请求 |
| dangerous | httpRequest 带 cookie, readStorage, runJS（含 `fetch` / `document.cookie` / `eval` / `new Function` / `chrome.*`） | ✗ 必须确认 + 红框警告 | 可能泄漏会话 / 写动态代码 |

### 6.3 runJS 的静态扫描

注入前对源码做 AST + 正则扫描，**只是给提示，不阻断**：

- `document.cookie` / `localStorage` / `sessionStorage` → "可能读取登录信息"
- `fetch(` / `XMLHttpRequest` / `navigator.sendBeacon` → "会发网络请求"
- `eval(` / `new Function(` / `Function(` → "会执行动态代码"
- `chrome.` / `browser.` → "试图访问扩展 API"（注入到 MAIN world 时本来访问不到，仍提示）

侧边面板对命中行加底色，并把命中关键词列在 step 卡片顶部。

### 6.4 跨域 httpRequest

走 background：

- `manifest.host_permissions` 声明通用的 `http://*/*` 和 `https://*/*`
- 浏览器内置页等受限页面仍遵循 Chromium 的注入限制
- 默认 `credentials: 'omit'`；要带 cookie 必须工具创建时显式勾选并打 dangerous 标

### 6.5 时长 / 重试

每步默认超时 10s，可改；step 失败立即停止整个工具，不静默重试。

### 6.6 CSP

页面 CSP 不影响我们 —— `chrome.scripting.executeScript` 不受页面 CSP 限制。`runJS` 不需要 `unsafe-eval`。

## 7. 存储

### 7.1 位置

```
浏览器本地（单设备、单浏览器、单 profile）
│
├── IndexedDB (extension origin) — 主数据
│   └── aipagego.db
│        ├── tools     (key: id)            ← 工具主表
│        ├── versions  (index: toolId)      ← 历史版本
│        └── runs      (index: toolId)      ← 运行记录
│
└── chrome.storage.local — 设置
     ├── apiKey                              ← LLM API Key
     ├── llmProvider / llmModel
     ├── autoApproveSafe (bool)
     └── autoBackupOnSave (bool)
```

为什么 IndexedDB 而不是 `chrome.storage.local`：

- step 数组 + 历史版本 + run log 体积随时间增长，单 key 8KB 软限会撞上
- IndexedDB 在扩展里有几百 MB 配额、支持索引（按 URL pattern 反查工具）
- `chrome.storage.local` 适合"小、扁、跨上下文同步"，所以只放设置

API Key 单独放 `chrome.storage.local`：

- 不放 IndexedDB，因为下面的导出功能不能把 Key 一起带走
- 不用 `chrome.storage.sync`，避免跨设备同步密钥

### 7.2 数据范围

工具是**设备本地的**。换浏览器 / 换电脑 / 重装扩展默认会丢失。隐身模式不可见（除非显式启用，那也是另一份独立 IDB）。清理浏览器数据时如勾选"扩展数据"或"Cookie 和其他网站数据"会一并清掉。

### 7.3 导入 / 导出（容灾手段）

零后端架构下唯一的容灾方式，必须实现：

- **手动导出**：设置页 `[导出工具库.json]` → 一份 JSON 包含所有 `tools` + `versions`，**不含** API Key、**不含** run 记录
- **手动导入**：`[导入]` 按钮选 JSON，按 `id` 合并；同 id 提示覆盖 / 跳过 / 作为新工具复制
- **自动备份开关**（默认关）：保存或修复成新版本时自动下载 `<tool-name>-v<N>-<date>.json` 到下载目录

导出格式：

```json
{
  "schema": "aipagego.tools/v1",
  "exportedAt": 1715212800000,
  "tools": [ /* Tool[] without runs */ ]
}
```

## 8. 模块边界与文件结构

```
aipagego2/
├─ manifest.json
├─ package.json
├─ tsconfig.json
├─ vite.config.ts                 # vite + @crxjs/vite-plugin
│
├─ src/
│  ├─ shared/                     # 跨入口的纯函数 / 类型 / 协议
│  │  ├─ types.ts                 # Tool, Step, RunRecord, JsonSchema
│  │  ├─ messages.ts              # SidePanel ↔ BG ↔ Content RPC schema (zod)
│  │  ├─ url-pattern.ts           # glob → RegExp + 匹配
│  │  └─ static-scan.ts           # runJS 源码风险标签（纯函数，单测重点）
│  │
│  ├─ background/                 # service worker
│  │  ├─ index.ts                 # RPC 路由、tab 监听、注册 sidePanel
│  │  ├─ llm/
│  │  │  ├─ client.ts             # Anthropic / OpenAI 适配（统一接口）
│  │  │  ├─ tool-schema.ts        # 暴露给 LLM 的工具 JSON Schema
│  │  │  └─ session.ts            # 会话状态 + tool-use 循环
│  │  ├─ storage/
│  │  │  ├─ db.ts                 # IndexedDB 封装（idb 包）
│  │  │  ├─ tools.ts              # CRUD: tools / versions
│  │  │  ├─ runs.ts               # CRUD: run records
│  │  │  └─ export-import.ts      # 序列化 / 合并
│  │  ├─ http-proxy.ts            # 跨域 httpRequest 代理（含 credentials 控制）
│  │  └─ tab-watcher.ts           # tab URL 变化 → 推送可用工具
│  │
│  ├─ content/                    # content script (isolated world)
│  │  ├─ index.ts                 # 启动: 监听 BG 消息
│  │  ├─ runner.ts                # Step Runner: 顺序执行 + 变量绑定
│  │  ├─ tools/                   # 内置工具实现 (每个一个文件)
│  │  │  ├─ snapshot-dom.ts
│  │  │  ├─ query.ts
│  │  │  ├─ extract-images.ts
│  │  │  ├─ extract-text.ts
│  │  │  ├─ scroll.ts
│  │  │  ├─ wait-for.ts
│  │  │  ├─ click.ts
│  │  │  └─ read-storage.ts
│  │  └─ inject-main.ts           # chrome.scripting → MAIN world 注入 runJS
│  │
│  ├─ sidepanel/                  # 唯一 UI 入口 (React + Tailwind)
│  │  ├─ index.html
│  │  ├─ main.tsx
│  │  ├─ app.tsx                  # 路由: Chat / Tools / Runs / Settings
│  │  ├─ chat/
│  │  │  ├─ chat-view.tsx
│  │  │  ├─ message.tsx
│  │  │  └─ step-card.tsx         # 单 step 预览 + 通过/拒绝
│  │  ├─ tools/
│  │  │  ├─ tool-list.tsx
│  │  │  ├─ tool-detail.tsx       # 步骤展开、版本切换、URL 模式编辑
│  │  │  └─ save-dialog.tsx
│  │  ├─ runs/
│  │  │  └─ run-detail.tsx        # 时间线 + 每步输出 + 导出
│  │  ├─ settings/
│  │  │  ├─ api-key-form.tsx
│  │  │  └─ backup-form.tsx       # 导出 / 导入 / 自动备份开关
│  │  └─ rpc.ts                   # 调 BG 的 typed wrapper
│  │
│  └─ assets/icons/
│
├─ tests/
│  ├─ unit/                       # vitest
│  │  ├─ url-pattern.test.ts
│  │  ├─ static-scan.test.ts
│  │  └─ runner.test.ts           # 用 happy-dom 跑 step runner
│  └─ e2e/                        # playwright + extension loadExtension
│     ├─ shop-detail.spec.ts       # 录一份 商品详情页快照本地服务，跑全流程
│     └─ tool-replay.spec.ts
│
└─ docs/
   └─ superpowers/specs/
      └─ 2026-05-09-ai-collector-extension-design.md   ← 本文件
```

### 8.1 关键边界承诺

- **`shared/`** 没有 DOM、没有 chrome、没有 fetch — 纯函数纯类型，三个入口都能 import
- **`content/tools/`** 每个工具一个文件，签名统一：`(args, ctx) => Promise<Json>`，写新工具不改 runner
- **`background/llm/client.ts`** 隐藏 provider 差异，外层只看 `chat({messages, tools}) → {toolCalls | text}`
- **`sidepanel/rpc.ts`** 是唯一允许调 background 的地方，UI 组件不直接 `chrome.runtime.sendMessage`

### 8.2 测试策略

| 层级 | 工具 | 重点 |
|---|---|---|
| 单元 | vitest + happy-dom | url-pattern、static-scan、runner（mock chrome.scripting） |
| 集成 | vitest + fake-indexeddb | tools.ts / runs.ts / export-import CRUD + version 追加 |
| e2e | playwright loadExtension + 本地静态站点 | 录两个商品页面快照（详情页 + 评论翻页）作 fixture，跑 AI 模式（mock LLM 回固定 tool_calls）和重放模式 |

LLM 真接入用最便宜的 Haiku，e2e 默认 mock；冒烟跑一次真 LLM 留 manual。

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| LLM 返回非法 tool 名 / 非法 args | 回灌错误给 LLM，让它重试，限 3 次后整会话失败 |
| Step 执行抛错（DOM 找不到、超时） | 整工具立刻停在该步，状态 `error`，UI 显示 [让 AI 修复] |
| Step 用 `${var}` 引用未绑定变量 | 视为该 step 错误（同上） |
| `httpRequest` 收到 4xx/5xx | 不视作 step 错误，把状态码与 body 作为 output 返回；由 AI 决定如何处理 |
| 跨域权限被用户拒绝 | step 错误，附"打开权限"按钮 |
| 存储写失败（配额满） | 顶部红条 + [清理 run 记录] |
| 导入 JSON 校验失败（schema 不匹配） | 弹错误，列出第一个非法字段，整个导入回滚 |

## 10. 已知限制 / 后续可扩展

- 无云同步：靠手动导出/导入；后续可加可选后端（不在本次范围）
- 无定时任务：每次需用户主动打开页面（YAGNI）
- 单 profile：在不同 Chrome profile 间不共享工具
- 动态 SPA 路由变更（`history.pushState`）：tab-watcher 监听 `webNavigation.onHistoryStateUpdated` 兜住，但 SPA 内不刷新页面切详情时仍可能漏报，后续可加 content script 内的 MutationObserver

## 11. 评审与下一步

- 本文档评审通过后调用 writing-plans 技能产出实施计划
- 实施计划将按里程碑切分（最小可用骨架 → 内置工具集 → AI 会话 → 工具持久化 → 导入导出 → e2e）
