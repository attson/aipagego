# Connector 与安全分享

## 适用范围

本规范约束 Webhook、飞书/Lark Base connector 的公开配置与凭据、结果 delivery、Job destination、工具安全包及两阶段导入，并定义 sidepanel 与 Coordinator/MCP 的边界。

## Connector 与凭据

- 首发 connector kind 只有 `webhook` 与 `feishu_base`。Webhook 必须使用 HTTPS、cookie omit、redirect reject、固定 envelope/幂等键和 5 MiB 上限；测试只发送 synthetic payload。Base 测试只读 metadata，写入按显式 field mapping 和最多 500 行 batch checkpoint。
- IDB `connectors` 只保存名称、kind、脱敏公开摘要、credential mode/configured、状态和稳定 `configHash`。完整 URL path/query、Header 名和值、App ID/Secret、access token 不进入 IDB，也不通过 get/list API 回显。
- Secret 只允许写入 `aipagego.connectorSecrets`，按 `chrome.storage.local` 的 persistent 分区和 `chrome.storage.session` 的 session 分区保存。persistent 可绑定自动 Job；session 重启后进入 `needs_credentials`，只能重新输入后手动使用。
- Connector CRUD/test/send 只允许 sidepanel/background 本地入口。Content widget、Coordinator、MCP、LLM 和 self-heal 不得读取、替换或发送 connector secret。

## Delivery 与重试

- Delivery 只持久化 connector/config hash、Run/JobRun/collection source ref、状态、attempt、计数和 checkpoint，不复制 payload、页面内容、response body 或完整 collection rows。
- Run/JobRun 读取有界结果；collection 通过 `resultId` 分页读取。手动 retry 只重发 delivery，不重新运行 Tool/Job。source 淘汰后明确 `connector_source_expired`。
- Base partial 保留 `sentCount/nextOffset`。提交后断线且无法判断外部状态时进入 `unknown_commit`，未经用户确认可能重复不得重发。
- 每 connector 最多保留 200 条 delivery，全局最多 2,000 条。淘汰只删 delivery metadata，不删 RunRecord、JobRun 或 collection result。
- 错误、历史和通知只允许 connector 名、kind、状态、HTTP status 与白名单错误码；禁止 URL path/query、Header、secret、payload 和外部 response body。

## Job destination

- Job 最多绑定 5 个 persistent、ready 且 `connectorConfigHash` 匹配的 connector。绑定使安全等级至少 caution，并进入 acknowledgement hash。
- 工具与 delivery 终态分离：工具成功后为每个 destination 创建 delivery；发送失败不回退工具结果或 page-change baseline，但 Job 进入 `needs_attention / connector_delivery_failed` 并暂停后续自动调度。
- Connector 缺失、凭据缺失或 config hash 改变必须在打开/操作页面前阻断。删除仍被 Job 引用的 connector 以 `connector_in_use` 拒绝，不静默解绑。

## 分享包与两阶段导入

- `aipagego.tool-package/v1` 只包含所选工具的 active snapshot：steps 重编号为 v1，prompt 只含当前 prompt；stats 重置并移除 origin。Job、connector、credential、delivery、Run/JobRun、结果、inputs 和本机信任状态不得进入包。
- v3 backup 和安全包导出都扫描 literal credential。扫描覆盖敏感 key、Authorization/Cookie、常见 token/private key、URL userinfo、敏感 query 和 sensitive parameter default；finding 只返回规则与位置，不回显值。
- v2、v3 与 package/v1 导入必须先 `tools.import.preview`，再携带同一 bundle digest 调 `tools.import.commit`。旧 `tools.import` 固定返回 `import_preview_required`。
- Preview 只读展示所有版本的 host/capability/severity、dangerous step、secret、兼容错误、ID 冲突和依赖 Job。Commit 重复 parse/scan/audit/digest；invalid/unknown/secret 逐项拒绝，dangerous 或动态 prompt 需要显式确认。
- 冲突默认 copy，可逐项 skip/overwrite。Overwrite 在 tools+jobs 同一 IDB transaction 内写入，并将固定版本 hash 不符的 Job 标为 `needs_attention / tool_version_changed`，保留尚未处理的 delivery lease。
- 导入不执行工具，也不持久化危险批准；未来运行继续走原审批门禁。

## 存储与兼容

- IDB 名保持 `aipagego`，当前 DB version 为 5。v5 只新增 `connectors` 和 `connector_deliveries` store/index；v1–v4 既有 store/data 不重写。
- Legacy Job 的 `connectorBindings` 读取时默认为空数组，正常编辑时才 canonical 写回。`aipagego.tools/v2/v3` 保持可导入，但 UI 不允许绕过 preview/commit。
- Connector 不新增 Chrome permission；外部 endpoint 完全由用户配置。Coordinator/MCP 协议、EXEC/chat 和 collection summary 不新增 connector CRUD/secret/send 入口。

## 验证锚点

- `packages/shared/tests/connectors.test.ts`
- `packages/shared/tests/tool-package.test.ts`
- `packages/shared/tests/jobs.test.ts`
- `packages/extension/tests/background/connectors.test.ts`
- `packages/extension/tests/background/delivery-service.test.ts`
- `packages/extension/tests/background/feishu-base-connector.test.ts`
- `packages/extension/tests/background/tool-share-export.test.ts`
- `packages/extension/tests/background/tool-import-review.test.ts`
- `packages/extension/tests/background/storage/db-v2-migration.test.ts`
- `packages/extension/tests/sidepanel/drawers/connectors-drawer.test.tsx`
- `packages/extension/tests/sidepanel/drawers/tool-packages-pane.test.tsx`
- `packages/extension/tests/p4-docs-compatibility.test.ts`
- `packages/mcp-server/tests/tool-gen.test.ts`

## 决策记录

### 2026-10-27 Connector 公开配置与 write-only secret 分区

Connector 的可展示配置与凭据分开：公开摘要进 IDB，secret 只进 local/session 专用存储且 API 不读回。该选择牺牲编辑时回填凭据的便利，换取工具分享、备份、日志和远程入口无法顺带带出外部系统凭据。

### 2026-10-27 Delivery 引用本地结果且重试不重跑网页工具

Delivery 只保存 source ref 和 checkpoint，发送重试从既有结果恢复，不重新运行 Tool 或 Job。这样避免外部网络失败重复网页副作用，代价是 source 有独立生命周期，淘汰后只能明确失败并要求用户重新产生结果。

### 2026-10-27 分享采用 active-only 包与 digest 两阶段导入

分享包只携带 active snapshot 并在导入前后复核 digest、secret 和能力，区别于保留完整历史的本地 v3 backup。该选择放弃分享历史版本的完整性，换取收件人审查内容与最终落库内容一致，并避免未展示历史能力或凭据被夹带。
