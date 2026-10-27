# 隐私政策

生效日期：2026-10-23

AIPageGo 是一款本地优先的 Chromium 侧边栏扩展。它没有 AIPageGo 账号、云同步、广告或遥测服务，也不会出售用户数据。

## 处理哪些数据

- **网页内容**：只有在你发起任务时，扩展才按需要读取当前页面或你明确附加的标签页内容。
- **模型请求**：对话文本、必要的网页内容和工具结果会直接发送给你在设置中选择的 Anthropic、OpenAI 或兼容 API Endpoint。请同时阅读该服务商的隐私政策。
- **本地数据**：工具、会话、运行记录、站点规则和设置默认保存在浏览器本机。API Key 可按你的选择保存在 `chrome.storage.local`，或只保存在当前浏览器会话的 `chrome.storage.session`。
- **可选浏览器数据**：书签、浏览历史和下载能力只在使用对应功能、并由你在 Chrome 权限提示中同意后访问。
- **Coordinator / MCP**：只有在你显式配对或连接时启用。工具参数、结果和标签页元数据可能发送到你选择的本机或自托管服务；远程 chat 仍需单独开启。
- **连接器外发**：只有在你手动确认发送，或把 `persistent` connector 绑定到 Job 后，选定的 Run / JobRun / collection 结果才发送到用户配置的 Webhook 或飞书/Lark Base。外部系统由用户配置并适用其自身隐私政策。
- **连接器凭据**：公开摘要可进入 IndexedDB；secret 单独保存在 `aipagego.connectorSecrets` 的 local/session 分区，API 不提供读回。

## 不会做什么

- API Key 不写入 IndexedDB、工具导出包、商店截图或诊断日志。
- Connector secret 不进入 IndexedDB、工具分享包、运行历史、通知或日志；分享包也不包含 connector、delivery 或结果数据。
- 不收集遥测，不建立用户画像，不出售或出租用户数据。
- 不会因为授予浏览器权限而自动批准危险工具；提交表单、上传等操作仍受独立审批控制。

## 保留、删除与撤销

本地数据会保留到你在扩展中删除、清除扩展存储或卸载扩展为止。你可以在 AIPageGo 设置页撤销书签、历史和下载权限，也可以在 Chrome 的扩展详情页撤销其他权限。卸载扩展会由 Chrome 清除其本地存储。

## 数据安全

AIPageGo 只在任务需要时传输数据，并使用你配置的 HTTPS/WSS Endpoint。请不要把密钥、Cookie 或其他敏感内容发布到公开 issue。

## 联系与变更

支持与隐私问题请提交到 [GitHub Issues](https://github.com/attson/aipagego/issues)。政策发生实质变化时会在本页和发布说明中更新生效日期。

另见：[权限说明](/permissions) · [安装与本地存储](/guide/install)
