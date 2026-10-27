# 权限说明

AIPageGo 遵循“核心页面能力随安装提供，浏览器数据能力使用时再询问”的原则。拒绝可选权限不会影响普通网页聊天。

## 安装时权限

| 权限 | 用途 | 边界 |
|---|---|---|
| `sidePanel` | 在浏览器侧边栏展示聊天与工具界面 | 不读取网页数据 |
| `storage` | 保存设置、会话、工具和运行记录 | API Key 不进入 IndexedDB 或导出包 |
| `scripting` / `activeTab` | 在用户任务涉及的页面注入或执行工具 | 仍受站点注入策略和工具审批控制 |
| `tabs` / `tabGroups` / `webNavigation` | 识别当前标签页、多标签会话、URL 变化和会话分组 | 不代表读取浏览历史数据库 |
| `contextMenus` | 提供右键入口 | 只处理用户选择的入口动作 |
| `<all_urls>` | 在用户当前网页执行读取、填写、点击以及 URL 模式匹配 | 不在后台批量上传浏览内容；受限页不可注入 |
| `ws://127.0.0.1/*` / `ws://localhost/*` | 连接本机 Coordinator / MCP 服务 | 仅本机地址；连接和远程 chat 均由用户配置 |

## 使用时申请

| 可选权限 | 触发功能 | 拒绝后的结果 | 如何撤销 |
|---|---|---|---|
| `bookmarks` | 搜索书签、在 `@` 选择器引用书签 | 本次书签功能不执行 | 设置 → 权限，或 Chrome 扩展详情 |
| `history` | `searchHistory` 搜索浏览历史 | 本次搜索不执行 | 设置 → 权限，或 Chrome 扩展详情 |
| `downloads` | 下载图片或生成 XLSX | 本次下载不创建文件 | 设置 → 权限，或 Chrome 扩展详情 |
| `notifications` | 本地 Job 的变化、成功或最终失败通知 | Job 继续运行，只是不显示系统通知 | 设置 → 权限，或 Chrome 扩展详情 |
| `debugger` | 用户显式启用高级页面事件录制 | 自动降级到不使用 CDP 的录制后端 | Chrome 扩展详情 |

授权后只重试原操作一次；若 Chrome API 仍失败，会显示真实错误，不会循环弹窗。Coordinator/MCP 不会代用户申请权限，缺权时会返回机器可读的 `PermissionDenied`。

浏览器权限与危险操作审批相互独立。即使已有 `downloads` 等权限，危险工具仍必须满足当前会话的审批模式。

## Connector 网络访问

连接器**无需新增 Chrome 权限**：HTTPS 请求使用扩展已有的页面网络能力，不会弹出额外浏览器授权。Webhook、飞书/Lark Base 目标和凭据均由用户配置；AIPageGo 不提供公共中转服务，也不会因为保存了连接器就自动发送页面或聊天内容。

Job 通知只显示 Job 名、固定版本、终态和有界错误码/变化数，不包含 URL query、输入值、页面文本或输出。

另见：[隐私政策](/privacy) · [连接器与安全分享](/advanced/connectors-sharing) · [配置](/guide/config)
