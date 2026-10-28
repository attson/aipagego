# 连接器与安全分享

AIPageGo 可以把已经生成的本地结果发送到用户配置的外部系统，也可以把工具定义分享给其他 AIPageGo 安装。两条流程都必须由用户显式发起；仅仅创建连接器不会自动外发聊天或页面内容。

## Connector 类型

- **Webhook**：只接受 HTTPS。正式发送固定 envelope，禁用 Cookie，拒绝 redirect，并限制单次 payload 为 5 MiB。连接测试只发送 synthetic payload，不发送真实页面或结果数据。
- **飞书/Lark Base**：使用 App ID / App Secret 获取的 token 只留在内存；测试只读取 metadata，不新增记录。object rows 按 field mapping 写入，最多每批 500 行，失败后从 checkpoint 继续。

连接器有两种 credential mode：

- `persistent`：凭据保存在本机独立的 `chrome.storage.local` secret 区，可绑定自动 Job。
- `session`：凭据只保存在 `chrome.storage.session`；浏览器重启后连接器显示 `needs_credentials`，不能绑定自动 Job，重新输入后可手动发送。

列表和详情只显示名称、类型、目标摘要、配置状态与凭据是否已配置，不回显完整 URL path/query、Header 名和值、App Secret 或 access token。

## 数据外发与发送历史

在「连接与安全分享」中选择一个 Run、JobRun 或 collection `resultId`，确认目标后创建 delivery。完整 collection 由 `resultId` 分块读取，不复制进 delivery、Job 或聊天；delivery 只保存 source ref、状态、计数和 checkpoint。

Webhook 使用固定 envelope 和幂等键。Base 发送保留 `sentCount` / `nextOffset`，因此 partial 可继续。网络在提交后断开、无法确认外部是否已接收时，状态为 `unknown_commit`：AIPageGo 不会静默重发，必须由用户确认“可能重复”后才能重试。重试只重发 delivery，不重新运行网页 Tool 或 Job。

## Job destination

Job 最多绑定 5 个 `persistent`、`ready` 且 config hash 一致的 connector destination。绑定会让安全等级至少为 caution，并需要一次确认。

工具运行成功和外部发送是两个状态：发送失败不会把已经成功的工具结果改成失败，但 Job 会进入 `needs_attention` 并暂停后续自动调度。修改连接器目标或 secret 会改变 config hash；Job 必须重新审核，且在打开或操作页面前就被阻断。

## 安全工具包

默认分享格式是 `aipagego.tool-package/v1`：

- steps 工具只包含当前 active snapshot，并重编号为 v1；prompt 工具只包含当前 prompt。
- stats 重置，移除 preset origin；不包含 Job、connector、credential、运行历史、结果、inputs 或本机信任状态。
- 导出前扫描 literal Authorization/Cookie/API key/token/private key、URL userinfo 和敏感 query。命中时整包拒绝，错误只包含规则与位置，不回显值。

导入 v2、v3 或 `tool-package/v1` 均采用两阶段流程：

1. `preview` 在 background 只读解析文件，重新计算 `digest`，展示 hosts、所有版本的 capabilities / severity、dangerous step、secret finding、ID 冲突和依赖 Job 数。
2. 用户为冲突逐项选择 copy / skip / overwrite，并显式确认 dangerous 或动态 prompt。
3. commit 再次 parse、扫描和审查；文件 `digest` 变化则以 `import_digest_changed` 拒绝。未知工具、无效 workflow 与 secret 逐项拒绝。

overwrite 若改变 Job 固定版本的 hash，会立即把相关 Job 标为 `needs_attention / tool_version_changed`。导入本身不运行工具，也不跳过以后运行时的正常审批。

## 本地与远程边界

Connector CRUD、凭据和 delivery 发送只在 sidepanel/background 本地入口提供。Content widget、Coordinator 与 MCP 没有 connector secret/read/send 工具；它们原有的 EXEC、chat 与 collection summary 能力保持不变。

另见：[Jobs 与监控](/advanced/jobs) · [隐私政策](/privacy) · [权限说明](/permissions)
