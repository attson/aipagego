# Jobs 与网页变化监控

Jobs 把已保存的 **steps 工具固定到一个具体版本**，在 Chrome 运行且扩展启用时手动、定时或按网页局部变化执行。打开侧边栏顶部的“持续任务”即可创建和管理。

## 触发方式

- **手动**：点击“立即运行”。含 dangerous 操作时，每次都必须单独批准。
- **间隔 / 每周定时**：由一个 Chrome alarm 在后台唤醒，按本地时区计算下一次运行。
- **网页变化**：填写或圈选一个唯一 selector。第一次检查只建立 SHA-256 baseline；之后仅当该元素的规范化文本变化时运行工具。选择器缺失或匹配多个元素会暂停 Job，不会退化为整页读取或调用 LLM。

没有精确匹配的现有页面时，Job 会打开一个非激活 tab，并只在结束后关闭这个自建 tab；用户已有 tab 永远不会被 Job 关闭。被 Coordinator/MCP 会话占用的 tab 不会复用。

## 版本与安全

Job 固定创建或审核升级时选择的 `vN`。工具的 active 版本变为 `vM` 时只显示升级提示，不会自动跟随。

- safe 可自动运行。
- caution 在创建或升级时确认一次；版本或参数变化后需要重新确认。
- dangerous 或无法静态判定的工作流只能保存为手动 Job，并在每次运行时批准。

Job 不保存敏感参数。手动运行所需的敏感值只在本次执行内存中使用。Job 运行不调用自主 self-heal；请在 Workflow Studio 修复、发布新版本后再审核升级。

## connector destination

Job 最多可以绑定 5 个 `persistent`、`ready` 且 config hash 一致的连接器。绑定 destination 后安全等级至少为 caution；连接器目标或 secret 改变时，Job 会在打开或操作页面前进入 `needs_attention`，等待重新审核。

工具执行与外部 delivery 分开记录。即使发送失败，已经完成的**工具执行成功**结果仍保持成功；Job 会进入 `needs_attention` 并暂停后续自动调度。历史中的“重试发送”只重试 delivery，不会重新运行 Tool。`unknown_commit` 还需要确认可能重复。

## 历史、差异与通知

每次真实执行保存实际版本、tab 来源和最多三次 attempt，并关联普通 RunRecord。成功输出只保留最大 64 KiB 的结构化预览；相邻成功输出显示最多 100 项 JSON path 差异。完整 collection rows 不会复制进 Job 历史。

变化和最终失败通知默认开启，普通成功通知默认关闭。`notifications` 是可选权限，拒绝或撤销不会阻止 Job 运行。通知不包含 URL query、输入、页面文本或输出。

## 在线限制

本地 Job **不是云端 cron**。Chrome 关闭、扩展停用或设备离线时不会执行；恢复后，晚于计划超过 5 分钟的触发会记为 `missed`，不会补跑。

Coordinator/MCP 可让外部系统在浏览器在线且扩展已经配对时远程触发现有能力，但不能管理 connector credential 或发起 delivery，也不能让已关闭的浏览器继续运行。需要全天候执行时，应由外部在线浏览器环境负责可用性。

另见：[连接器与安全分享](/advanced/connectors-sharing)
