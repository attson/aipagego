# Jobs 与监控

## 适用范围

本规范约束本地 Job 的固定版本执行、定时与网页变化触发、tab 生命周期、重试、历史差异、通知、connector destination 和 Jobs 工作台。

## Job 与版本

- Job 只能引用已保存的 `steps` 工具，并同时固定 `toolVersion` 和该快照的稳定 SHA-256。`activeVersion` 变化只产生 `upgradeAvailable`，不改变 Job 的执行版本。
- 创建、编辑、恢复、升级和每次执行都必须重新校验工具、版本 hash、URL pattern、参数与安全等级。工具缺失或同号版本内容变化时进入 `needs_attention`，不跟随当前 active 版本。
- 自动 Job 不允许缺失必填 sensitive 参数。手动 Job 的 sensitive 值每次运行时临时输入，不进入 Job、IDB、导出、历史或通知。
- `runs.start` 的普通工具路径仍使用 active 版本；只有显式传入 `version` 的 pinned run 使用历史快照。Job 产生的 RunRecord 必须写入 `source: "job"` 和真实版本，且禁用 autonomous self-heal。
- Job 最多绑定 5 个 persistent、ready 且 config hash 匹配的 connector destination。Connector 缺失、凭据缺失或配置变化必须在页面副作用前进入 `needs_attention`；绑定使安全等级至少 caution，并参与 acknowledgement hash。

## 触发、调度与 tab

- 支持 manual、interval/daily schedule 和 page-change。manual 没有业务 `nextRunAt`；paused 和 `needs_attention` 不参与自动调度，resume 从当前时间重算，不追赶暂停期间的触发。
- background 只维护一个 `aipagego.jobs.dispatch` alarm，指向所有 active Job、retry 和 lease 恢复中的最早时间。due Job 按时间串行执行，一个 Job 的错误不得阻断后续 Job。
- 持久 lease 关联唯一 JobRun；同一 Job 的并发 run/delete/upgrade/edit 必须拒绝。service worker 中断后将未完成 attempt 记为 `service_worker_interrupted`，并继续同一 JobRun 的有界重试。
- 默认最多 3 次 attempt，退避 1/5 分钟。重试中不发终态通知；耗尽后进入 `needs_attention`。用户暂停 retry-wait 时终止旧链并清 lease。
- 调度晚于原时间超过 5 分钟时写 `missed`，不补跑，直接计算下一周期。本地 Job 只在 Chrome 运行且扩展启用时工作；Coordinator/MCP 不是离线云执行。
- tab 复用要求目标 URL 精确相同（忽略 fragment）且未被 Coordinator/MCP 会话占用。无可复用 tab 时创建 `active:false` tab 并等待 ready；终态只关闭 Job 自建 tab，不导航或关闭用户 tab。

## 网页变化监控

- page-change 只读取用户确认的唯一 selector。结果做 Unicode NFC、合并空白与 trim 后计算 SHA-256；只持久 hash 和时间，不持久原文。
- 首次成功读取只建 baseline，不执行工具、不生成变化通知。后续相同内容只更新检查时间；变化时先保留 candidate hash，固定工具成功后才推进 baseline。
- selector 缺失、多匹配、tab 关闭、受限页面或站点注入策略不足都明确失败并进入有界重试。不扩大到 `body`、整页 DOM 或模糊匹配，不调用 LLM 或 self-heal。

## 安全与通知

- safe 可自动执行。caution 需对当前 `toolVersionHash + inputs` 在创建、编辑或升级时确认；版本或输入变化使旧确认失效。dangerous 或无法静态证明安全的工作流只能保存为 manual，每个新 JobRun 都要单独批准；批准只允许同一 JobRun 的重试链复用。
- `notifications` 为可选 Chrome 权限。拒绝或撤销不阻止 Job 运行，但界面必须回退开关并告知未启用。通知默认开启变化与最终失败，普通成功默认关闭。
- 通知只包含 Job 名、终态、固定版本、变化计数或白名单错误码，不得包含 URL query、输入、页面文本、output、Cookie 或 API key。点击通知只打开并定位 Jobs drawer，不自动重跑。
- 工具运行与 delivery 终态分离。工具成功后才创建 delivery；发送失败不回退成功 output 或 page-change baseline，但 Job 进入 `needs_attention / connector_delivery_failed`。重试只重发 delivery，不重新运行 Job；`unknown_commit` 需要额外确认可能重复。

## 历史、差异与存储

- JobRun 按 attempt 引用普通 RunRecord，不复制 stepLog。output 使用全量稳定 SHA-256 和最大 64 KiB 结构化 preview；相邻成功输出以 JSON path 记录最多 100 个 changes。失败输出不成为 diff baseline。
- 每个 Job 最多保留 200 个 JobRun，全局最多 2,000 个。删除或淘汰 JobRun 时级联删除它独占的 source=job RunRecord 和 collection result；删除 Job 不删除 Tool。
- IDB 名保持 `aipagego`，当前 DB version 为 5。v4 只新增 `jobs` 与 `job_runs`；v5 只新增 connectors/deliveries，不重写 tools、runs、chat_sessions、collection_results 或既有 Job。Legacy Job 的 `connectorBindings` 读取时默认为空数组。
- `aipagego.tools/v3` 导入导出不包含 Job、JobRun、inputs、baseline、通知设置或历史。collection Job 历史只使用 RunRecord summary，不读取完整 rows。

## 验证锚点

- `packages/shared/tests/jobs.test.ts`
- `packages/shared/tests/messages.test.ts`
- `packages/extension/tests/background/jobs-service.test.ts`
- `packages/extension/tests/background/jobs-scheduler.test.ts`
- `packages/extension/tests/background/jobs-tab-manager.test.ts`
- `packages/extension/tests/background/jobs-safety.test.ts`
- `packages/extension/tests/background/jobs-history.test.ts`
- `packages/extension/tests/background/jobs-notifications.test.ts`
- `packages/extension/tests/background/storage/jobs.test.ts`
- `packages/extension/tests/background/storage/db-v2-migration.test.ts`
- `packages/extension/tests/background/delivery-service.test.ts`
- `packages/extension/tests/background/connectors.test.ts`
- `packages/extension/tests/sidepanel/drawers/jobs-drawer.test.tsx`

## 决策记录

### 2026-10-26 Job 固定不可变工具版本

Job 在创建或显式升级时固定工具快照版本与内容 hash，不自动跟随 `activeVersion`。这以需要人工审核升级换取后台副作用可重现，避免工具发布后静默改变已运行的自动化。

### 2026-10-26 Dangerous Job 不保存永久授权

dangerous 或无法静态证明安全的 Job 禁止自动触发，manual 每个新 JobRun 都须重新批准，只在该 JobRun 的有界重试链中保留。这放弃无人值守的危险便利性，保持用户对提交、上传、带凭据请求等副作用的逐次控制。

### 2026-10-26 网页变化只使用 selector 指纹

网页变化监控只对用户确认的唯一 selector 文本建立规范化 SHA-256 baseline，不保存原文，也不在 selector 失效时改读整页或调用 LLM 修复。这以可能需要用户维护 selector 换取可预期的成本、隐私和触发语义。

### 2026-10-26 Job 保持本地且仅在浏览器在线时执行

P3 采用 MV3 background alarm 的本地调度，不引入账号、云 cron 或跨设备同步；浏览器离线期间的触发记为 missed 且不补跑。这保持了本地优先与零服务端部署，代价是不提供浏览器关闭后的执行保证，Coordinator/MCP 也不改变这个边界。
