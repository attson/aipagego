# Collect Studio 结构化采集

## 适用范围

本规范约束 Collect Studio 的配方、当前页预览、跨页运行、本地结果、导出、工具固化，以及 Coordinator / MCP 重放边界。

## 配方与执行

- `CollectionRecipeV1` 是唯一持久配方契约。列表模式必须提供 `itemSelector`；字段、去重键、分页和取值方式均通过共享 zod schema 校验。
- 硬上限为 20 个字段、100 页、2,000 行和 5 MiB。UI 限制只改善交互，schema 与 orchestrator 必须继续执行同一限制。
- 单页 recipe 最低需要 `read` 注入模式；`next`、`loadMore` 和 `infiniteScroll` 最低需要 `operate`。受限页面和低于要求的站点策略必须明确失败。
- 页面读取由 content script 完成；跨导航循环由 background orchestrator 持有固定 `tabId`。同一 tab 同时只允许一个 collection run。
- 每页遵循“抽取、全局去重、检查上限、checkpoint、再翻页”。取消或超时必须停止后续翻页，并以 `partial` 和机器可读 `stopReason` 保留已提交结果。
- `collectStructuredData` 的保存工具与 Coordinator / MCP 重放共享同一 orchestrator。远程入口产生的内部 RunRecord 必须标记 `source: "coordinator"`；Studio 和本地工具重放保持 `source: "user"`。

## 数据边界

- 完整 rows 默认只存于 `aipagego` IDB 的 `collection_results`；不得进入聊天消息、LLM 请求、工具导出包或远程 EXEC 返回。唯一外发路径是用户确认的 connector delivery，它按 `resultId` 分页读取并直接发送，不把 rows 复制进 delivery、Job 或聊天。
- `RunRecord.output`、聊天工具结果和 Coordinator / MCP 只返回 `CollectionRunSummary`：`resultId`、统计、停止原因和最多 5 行预览。
- 结果读取使用 `{resultId, offset, limit}` 与 `{rows, hasMore, nextOffset}`，不得用 prose 暗示是否截断。
- 本地最多保留最近 20 个结果且合计不超过 100 MiB。结果淘汰后保留 RunRecord metadata，并以 `result_expired` 明确失败。
- 删除拥有 collection result 的会话或 run 时级联删除结果；工具导入导出不得携带历史 rows、Cookie、tab id 或 API key。

## 交互与导出

- 工作台打开时捕获目标 tab 与 URL；预览、AI 推荐、运行和保存不得在异步回调中读取后来切换的当前 tab。
- AI 推荐必须由用户显式触发，优先以 Page Context Index 的有界证据生成草稿；输出再次经过 `CollectionRecipeSchema`，且不自动运行。
- 对话 handoff 只携带固定 tab、URL 和有界结构化样例，不从样例推断或保存 selector。
- XLSX、CSV、JSON 导出按 resultId 分块读取并保持字段顺序。CSV 必须防护公式注入；下载权限拒绝不得删除结果或重跑采集，并允许显式重试授权。
- 保存动作生成普通 `steps` 工具中的一个 `collectStructuredData` step，默认 URL pattern 限定到精确 origin，运行时使用当时目标 tab。

## 安全与失败语义

- `collectStructuredData` 为 caution 工具；分页内部只允许已确认 selector 的点击或滚动，不允许任意 JS。
- collection replay 不进入 autonomous self-heal。selector 或页面结构失效时明确失败，由用户回到工作台修改配方。
- 重放总超时上限为 600 秒；超时需要取消 orchestrator 并等待终态。迟到的读取结果可以被忽略，但不得继续触发翻页副作用。
- background 不读取 API key。除显式“AI 识别当前页”外，预览、运行、重放、导出均不调用 LLM。
- 不支持的旧客户端必须明确拒绝未知 tool，不得降级为 `runJS` 或伪造成功结果。

## 验证锚点

- `packages/shared/tests/collection.test.ts`
- `packages/extension/tests/content/collection-preview.test.ts`
- `packages/extension/tests/content/collection-pagination.test.ts`
- `packages/extension/tests/background/collection-run-rpc.test.ts`
- `packages/extension/tests/background/collection-orchestrator-next.test.ts`
- `packages/extension/tests/background/collection-orchestrator-dynamic.test.ts`
- `packages/extension/tests/background/collection-replay.test.ts`
- `packages/extension/tests/sidepanel/drawers/collect-studio-drawer.test.tsx`
- `packages/extension/tests/sidepanel/lib/collection-export.test.ts`
- `packages/extension/tests/background/delivery-service.test.ts`
- `packages/mcp-server/tests/handlers.test.ts`
- `packages/mcp-server/tests/loopback-ws-hub.test.ts`

## 决策记录

### 2026-10-24 以普通 steps 工具承载采集配方

采集固化继续使用既有 `Tool.kind = "steps"`，以单个 replayable `collectStructuredData` step 承载 `CollectionRecipeV1`，不新增第三种顶层 Tool kind。该选择让既有版本、URL 匹配、导入导出、Coordinator 和 MCP 契约保持兼容，代价是分页循环由这个后台原语封装，不能展开成通用 Step Runner 的逐步编辑界面；若未来要把循环开放给 Workflow Studio，必须另行设计可迁移的控制流契约。

### 2026-10-24 完整结果本地化，跨边界只传摘要引用

完整 rows 固定留在本地 `collection_results`，跨聊天、RunRecord output 和 EXEC 边界只传带 `resultId` 的有界 summary。该选择避免最多 5 MiB 数据污染模型上下文或远程传输，也让导出可分块恢复，代价是 result 有本地生命周期、远端调用方不能直接取得完整数据，且淘汰后只能收到 `result_expired`；改变此约定会扩大隐私、token 和协议兼容面。
