# Specs Index

按时间顺序的设计文档清单。每份 spec 对应 `../plans/` 下同名实施计划。

| # | 主题 | 文件 | 关键产出 |
|---|---|---|---|
| 1 | AI 网页采集器（初版） | [`2026-05-09-ai-collector-extension-design.md`](./2026-05-09-ai-collector-extension-design.md) | MV3 三入口架构、Tool/Step/RunRecord 数据模型、IDB 存储、9 个内置工具、URL pattern 匹配 |
| 2 | AI 对话与工具固化 | [`2026-05-10-plan2-design.md`](./2026-05-10-plan2-design.md) | 流式 Anthropic+OpenAI 适配层、tool-use 会话循环、step 卡片人工审阅、runJS 静态扫描、tab-watcher 推荐 |
| 3 | AIPageGo 重定位 | [`2026-05-10-plan3-design.md`](./2026-05-10-plan3-design.md) | 9 个交互工具（fillInput / submitForm / uploadFile 等）、按工具名粒度的 dangerous 自动通过白名单、产品名 aipagego2→AIPageGo |
| 4 | Per-Tab 会话 | [`2026-05-10-plan4-per-tab-sessions-design.md`](./2026-05-10-plan4-per-tab-sessions-design.md) | sessionsByTab 切片、currentTabId、closedSessions 5min 临时区、tab-tracker、闭包捕获 tabId 防 race |
| 5 | AI 生成汇总 step | [`2026-05-10-plan5-summary-step-design.md`](./2026-05-10-plan5-summary-step-design.md) | 保存对话框增 [让 AI 生成汇总步骤]；一次性非流式 LLM call 产出 runJS source；append 为最后一步使重放产物结构稳定 |
| 6 | AI 生成两类工具 | [`2026-05-12-ai-generated-tool-types-design.md`](./2026-05-12-ai-generated-tool-types-design.md) | 保存为工具先选提示词/纯函数；AI 总结多轮对话生成 name/description/prompt 或 steps；提示词工具运行时跳聊天自动发送 |
| 7 | 多 tab 上下文 | [`2026-05-14-multi-tab-context-design.md`](./2026-05-14-multi-tab-context-design.md) | 一个会话内 `attachedTabs` 集合 + 三种信任入口（@ / openTab / attachTab）；现有 19 工具加可选 `tabId`；新增 listTabs/openTab/attachTab/detachTab 控制面；跨窗口、URL 变更显式追踪 |
| 8 | 侧边面板会话持久化与多会话历史 | [`2026-05-19-sidepanel-session-persistence-design.md`](./2026-05-19-sidepanel-session-persistence-design.md) | IDB `chat_sessions` store；按 tabId 主 URL 副；同 tab 多 archived 历史 + 新建会话；URL banner 与历史 drawer 替代 5 分钟内存 closedSessions；每 URL ≤20 + cascade 删 runs |
| 9 | GitHub Actions 打包 | [`2026-05-11-github-actions-extension-package-design.md`](./2026-05-11-github-actions-extension-package-design.md) | `build-extension.yml`：push/PR/手动跑 typecheck+test+build 并上传 `aipagego-<version>.zip`；推 `v*` tag 自动创建 GitHub Release；版本号从 tag 注入到 manifest |
| 10 | Remote Coordinator（Phase 1+2） | [`2026-05-15-remote-coordinator-design.md`](./2026-05-15-remote-coordinator-design.md) | WS 协议（zod envelope + 14 消息）+ coordinator core（worker registry / session manager / dispatcher / catalog hash）；扩展端 `CoordinatorClient` 单实例 + chrome.alarms 心跳 + 重连退避；HELLO/WELCOME/EXEC/RESULT 端到端跑通；ws subprotocol `bearer.<token>` |
| 11 | Raw LLM Exchange Log + Continuation Guard | [`2026-05-23-raw-llm-exchange-log-design.md`](./2026-05-23-raw-llm-exchange-log-design.md) | recording-client.ts 包 LlmClient 抓 request/response（屏蔽 apiKey），独立查看面板按 round 浏览；同期落地 continuation guard：text-only turn 不再直接 done，按 `maxContinuationNudges` 询问是否补完（v0.0.15 修复 nudge 死循环：改成 session-total 上限） |
| 12 | Remote-Testable Chat Session | [`2026-06-04-remote-testable-chat-design.md`](./2026-06-04-remote-testable-chat-design.md) | 在 Phase 2 coordinator 之上加 `START_CHAT_SESSION` / `ABORT_SESSION` / `READ_SIDEPANEL_STATE` / `CHAT_EVENT` / `SIDEPANEL_STATE_REPLY`；BG 端 `CoordinatorChatHost` 用 `MockLlmClient` + `BackgroundToolRunner` 跑同一个 `runChatSession()`；默认关闭的 `allow_remote_chat` opt-in；RunRecord 加 `source:"user" \| "coordinator"` 标签；sidepanel chat 路径零改动 |
| 13 | MCP Bridge（Phase 3） | [`2026-06-06-mcp-bridge-design.md`](./2026-06-06-mcp-bridge-design.md) | 新包 `packages/mcp-server`：stdio MCP server + `LoopbackWSHub`（真 ws + req_id↔RESULT 配对）复用 Coordinator 门面；启动时从 `TOOL_DEFS`（上提到 shared）自动生成 19 个 `browser_*` 工具 + 4 个控制面工具（list_tabs/open_session/close_session/get_quota）；本地单人 EXEC 模式，让 Claude Code 经 coordinator 驱动浏览器 |
| 14 | 项目改名 aipagego | [`2026-06-06-aipagego-rename-design.md`](./2026-06-06-aipagego-rename-design.md) | 全仓 `AIPageGo`/`aipagego` → `AIPageGo`/`aipagego`：包 scope、内部 import、品牌名、GitHub 仓库名、`DB_NAME`、历史 specs/plans 全替换；扩展 `"key"` 与 chrome.storage 保留；不做老数据迁移（dev 阶段唯一用户）；sed 三步顺序 + 手工收尾 + 漏网扫描；为下一份 plan（npm publish `@attson/aipagego-mcp`）铺路 |
| 15 | 发布 @attson/aipagego-mcp 到 npm | [`2026-06-07-mcp-publish-design.md`](./2026-06-07-mcp-publish-design.md) | mcp-server 包改名 `@attson/aipagego-mcp`、private:false、Apache-2.0；tsup 打 single-file ESM bundle（含 shebang，内联 workspace deps，external `ws/sdk/zod`）；新 workflow `publish-mcp-server.yml` on v* tag → 注入 tag 版本后 `npm publish --provenance`；env var `WEBPILOT_*` → `AIPAGEGO_*` 硬切换；根 README 加一行装小节；首发 v0.0.19 |
| 16 | 侧边面板 UI 重构（AIPex 风格） | [`2026-06-13-aipex-ui-refactor-design.md`](./2026-06-13-aipex-ui-refactor-design.md) | Chat 主体从多标签导航改造为 AIPex 风格 shell：紧凑气泡、隐藏工具细节的默认 compact 模式、drawer 承载工具库/设置/场景库；`app-shell.tsx` 取代 `app.tsx`；权限模式 pill、顶部会话状态条 |
| 17 | 短中期 UX Round 3 | [`2026-06-14-round3-aipex-feats-design.md`](./2026-06-14-round3-aipex-feats-design.md) | 会话内 intervention 中断、顶部权限模式 pill（read/default/trust/yolo）、@ mention picker、input 上方 tab 快切；`intervention-store.ts` + `permission-mode-pill.tsx` |
| 18 | 短中期 UX Round 4 | [`2026-06-14-round4-aipex-feats-design.md`](./2026-06-14-round4-aipex-feats-design.md) | 保存工具 dialog 精简、tools drawer per-row [详情][导出][删除]、`ResultView` 上移，配套 lucide 图标迁移准备 |
| 19 | LLM 策略升级 + 11 个新工具（Round 5） | [`2026-06-14-round5-llm-strat-design.md`](./2026-06-14-round5-llm-strat-design.md) | 4 tier 分层：Tier 1 控制面（closeTab/switchToTab/searchBookmarks/searchHistory/downloadImage）、Tier 2 视觉辅助（screenshot/askUser）、Tier 3 UID-based 稳态（takeSnapshot/clickByUid/fillByUid）、Tier 4 视觉标注（highlightElement/highlightText/fillForm）；system prompt 提示 tier 选择 |
| 20 | 通用工具 Round 6 | [`2026-06-15-round6-common-tools-design.md`](./2026-06-15-round6-common-tools-design.md) | 补齐 4 个高频工具 `navigate` / `getPageInfo` / `pressKey` / `writeStorage`；`writeStorage` 归 dangerous、其余 caution |
| 21 | 短中期 feats（batch） | [`2026-06-14-short-mid-feats-design.md`](./2026-06-14-short-mid-feats-design.md) | 一批 UX 补丁的集合 spec：诊断包导出、扩展 header 版本号、rpc.call 防御性 null 检查、theme wire-up 修 zinc CSS-var 等 |
| 22 | lucide-react 图标迁移 | [`2026-06-15-lucide-icons-design.md`](./2026-06-15-lucide-icons-design.md) | 9 处 emoji/文字-glyph UI icon → lucide-react；无新 dep（lucide 已在 UI 组件中）；避免 emoji 在跨平台/夜间模式下的渲染差异 |
| 23 | Quick Actions 空态 chip | [`2026-06-15-quick-actions-design.md`](./2026-06-15-quick-actions-design.md) | 会话空态 3 个 chip（总结/抽重点/抽评论）；点击填入 prompt；后被 Plan 27 的 URL-conditional preset 扩展 |
| 24 | 简洁 / 详细模式切换 | [`2026-07-02-conversation-mode-design.md`](./2026-07-02-conversation-mode-design.md) | ChatView 简洁模式（默认）：每工具一行进展 + 图标 + 中文别名 + 耗时；详细模式保留原 StepCard；`defaultChatMode` in settings；session 生命周期内可临时切换 |
| 25 | Prompt Optimize Button | [`2026-07-02-prompt-optimize-button-design.md`](./2026-07-02-prompt-optimize-button-design.md) | 输入框内一键 LLM 改写草稿：把用户口语转成结构化 prompt；非流式一次性 call；预览页可 accept/discard |
| 26 | GitHub Pages 展示站 | [`2026-07-06-github-pages-site-design.md`](./2026-07-06-github-pages-site-design.md) | 新目录 `docs-site/`：VitePress + 中英双语（zh-CN 主，en 覆盖 overview）；首页 / Guide / 工具参考 / 高阶 章节；`deploy-docs.yml` 自动发到 `gh-pages`；工具参考从 `TOOL_DEFS` 生成 |
| 27 | 场景 Preset 库 + Tool 运行时自愈（v0.0.45） | [`2026-07-07-scenario-presets-and-self-heal-design.md`](./2026-07-07-scenario-presets-and-self-heal-design.md) | 11 个内置 preset（7 内容站 prompt-form + 4 电商 tool-form）；tab-watcher 合并 preset 匹配 + 场景库 drawer + quick-actions URL 命中优先；`Tool.origin`（可选溯源）+ `RunRecord.healed`；`background/self-heal.ts`（DI，纯函数）+ sidepanel LLM 借用 RPC（BG 不持 key）；`rpc-handlers.runTool` catch-and-heal → static-scan 拒 dangerous 补丁 → `appendVersion` v(N+1) → `[自愈]` 系统气泡；单次运行最多 1 次自愈；coordinator EXEC 路径明确关闭自愈 |
| 28 | 页内浮窗对话入口 | [`2026-07-08-inpage-chat-widget-design.md`](./2026-07-08-inpage-chat-widget-design.md) | Shadow DOM FAB + mini chat panel；widget 与 sidepanel 共享 `sessionsByTab`；dangerous 操作交接到 sidepanel；每站隐藏与全局开关；不替代 sidepanel 的工具库/设置/诊断 |
| 29 | Widget Round 2（v0.0.52） | [`2026-07-10-widget-r2-11-feats-design.md`](./2026-07-10-widget-r2-11-feats-design.md) | 页内浮窗补齐 stop、sticky status、error banner、preset/quick-actions 空态、图片附件、权限 pill、保存入口、历史、resize、元素圈选；保持 runChatSession / Approver / 自愈协议不变 |
| 30 | 通用页面上下文索引（v0.0.53） | [`2026-07-23-page-context-index-design.md`](./2026-07-23-page-context-index-design.md) | 新增 `createPageIndex` / `searchPageIndex` / `readPageBlock` / `extractPageFields` 通用工具；content script 本地构建页面块索引，LLM 只取小证据片段；避免 `extractText(body)` 和大 DOM 进入上下文；同版补充 targeted screenshot 视觉证据、`.xlsx` 导出、图片消息渲染修复 |
| 31 | 会话上下文滚动压缩 | [`2026-07-23-session-context-compaction-design.md`](./2026-07-23-session-context-compaction-design.md) | 跨用户发送传递 prior `initialMessages`；超预算时旧消息压成 `[上下文记忆]`，近期消息原样保留；旧图片/base64/截图只留占位符和引用；当前 staged 图片通过 `userContent` 真正发给模型；上下文策略支持 auto/conservative/large/huge/custom；设置页改左侧分类 tab，含 MCP 配置说明 |
| 32 | MCP 对标 playwright-ext | [`2026-08-17-mcp-playwright-parity-design.md`](./2026-08-17-mcp-playwright-parity-design.md) | 新增 `page-recorder` 子系统（MAIN-world 常驻录制器默认 + `chrome.debugger` opt-in，失败自动降级并回报 `backend`/`degradedReason`）；11 个新 builtin（console/network/dialog/drag/drop/resize/navigateBack/Forward/findElements/recorderConfig）+ 4 个现有工具补参数；MCP 由 19 个白名单改为全量 block-list（53 个 `browser_*`）+ image `CallResult` + `AIPAGEGO_MCP_TOOLS=full\|parity`；HELLO 加 `supported_tools` 做版本协商；catalog 加 `read:console` / `read:network` / `read:network-body` |
| 33 | 多会话配对与连接池 | [`2026-08-18-multi-session-pairing-design.md`](./2026-08-18-multi-session-pairing-design.md) | 惰性绑端口（真需要浏览器时才绑，ephemeral + lastPort 复用）；server 自带 `/pair` 配对页 + 扩展注入 shadow DOM 浮层做批准（页面只做载体不做授权）；安装级身份 `~/.aipagego/identity.json`，`sessionId`/cwd 仅作展示；扩展 `CoordinatorPool` 支持 N 条连接；重连三层兜底（close code 4000 / 失败上限转 dormant / 唤醒条件），并修掉 15s alarm 架空指数退避的缺陷；新增 `SESSION_OPENED`(S→C) 与 `TABS_UPDATE`(C→S)，`list_tabs` 不再是连接时的快照且带 `busy`/`mine`/`busy_label`（仅警示不拦截） |
| 34 | 站点嵌入式 demo | [`2026-08-18-embedded-demo-design.md`](./2026-08-18-embedded-demo-design.md) | 首页 iframe 嵌一个可运行 demo：mock 商品页在外层文档、**真侧边栏**在嵌套 iframe（避免 takeSnapshot 扫到面板自身，也更贴近真实的双文档结构）、harness 扮演 service worker；复用已有的 `MockLlmClient` 与 `runChatSession` 的 DI 面；chrome shim 覆盖 storage/runtime/tabs；工具调用桥接到**真实 `callTool`** 对 mock 页面 DOM 操作；独立 vite.demo.config 产出到 `docs-site/public/demo/` |
| 35 | URL 注入策略 | [`2026-08-19-url-injection-policy-design.md`](./2026-08-19-url-injection-policy-design.md) | 默认与逐 hostname 的禁用/只读/操作/诊断注入级别；网页助手独立继承；惰性 bootstrap 与按需 MAIN-world recorder；配对错误状态分流 |
| 36 | 会话标签分组 | [`2026-08-20-session-tab-groups-design.md`](./2026-08-20-session-tab-groups-design.md) | 按逻辑 session id 和 window 创建原生 Chrome tab group；区分侧栏/MCP/远程来源；结束后恢复原分组；用户手动移出后不拉回；MV3 session 状态恢复 |
| 37 | 无干扰 MCP 截图 | [`2026-09-18-non-intrusive-screenshot-design.md`](./2026-09-18-non-intrusive-screenshot-design.md) | `switchToTab` 退出默认 core；CDP `Page.captureScreenshot` 后台截图；visible-tab 兼容回退不覆盖用户中途切 tab |
| 38 | MCP 调用轮次优化 | [`2026-09-18-mcp-round-efficiency-design.md`](./2026-09-18-mcp-round-efficiency-design.md) | screenshot 保留元数据；resize 返回实测 viewport；discoverTools 可直接按组启用；定义 opt-in trace 后续方向 |
| 39 | 本地 AI 会话效率分析 | [`2026-09-19-local-ai-session-analyzer-design.md`](./2026-09-19-local-ai-session-analyzer-design.md) | 只读扫描 Claude/Codex JSONL；脱敏聚合 AIPageGo 调用；识别重复验证、固定等待与可合并步骤 |

## 不在 spec 里的细节修复

以下是 spec 之外的运维/UX 修复（commit history 可查），未来如需追溯设计上下文请直接看 commit message：

- `chore: rename aipagego2 → AIPageGo` — Plan 3 文案换皮（IDB DB_NAME `"aipagego"` 保留）
- `fix(background): retry sendMessage with backoff after content-script inject` — @crxjs ESM loader 异步注册 listener
- `fix(background): auto-inject content script on missing receiver` — MV3 已开 tab 不会自动注入
- `fix(sidepanel-rpc): retry sendMessage on SW wake-up race` — 4 次 backoff 重试
- `fix(background): surface runJS errors instead of silently nulling output` — 用 `{__ok, value | error}` 包裹 MAIN-world 注入
- `fix(chat-page): capture tabId in send() closure for fresh-card lookups` — Plan 4 race 修补
- `feat(settings): expose maxTokens setting` — 长任务避免响应被截断
- `feat(status-bar): always show token usage` — 永不消失（done 绿、error 红、live 跳动）
- `feat(sidepanel): persistent chat session + bubble-style UI` — 切 nav 不丢；user/assistant 双气泡
- `feat(sidepanel): banner 运行 jumps to tool-detail with autoRun` — 不再丢弃 RunRecord
- `feat(tools): description actually used` — system prompt 把已保存工具喂给 AI
- `feat: add page context indexing and exports` — v0.0.53：page-index 落地、`downloadSpreadsheet` 真 `.xlsx`、targeted screenshot、图片用户消息渲染修复

## 工作流约定

每份 spec 由 `superpowers:brainstorming` 技能产出（见根目录 [`AGENTS.md`](../../../AGENTS.md)）：

```
brainstorming  →  spec (本目录)  →  writing-plans  →  plan (../plans/)  →  executing-plans
```

新增 spec 命名：`YYYY-MM-DD-<topic>-design.md`（建议带 plan 编号或主题关键词）。
