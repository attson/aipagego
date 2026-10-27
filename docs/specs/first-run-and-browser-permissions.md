# 首次体验与浏览器权限

## 适用范围

本规范约束扩展安装后的首次成功流程、Chrome 可选权限请求，以及这些权限与 AIPageGo 业务危险审批之间的边界。

## 首次成功

- 无已完成状态的新用户在 side panel 内依次完成模型配置、最小连接测试和当前页只读示例任务。
- 连接测试不得携带页面内容、浏览数据或工具清单；错误信息必须脱敏并给出可操作的失败分类。
- 只读示例真实进入 `runChatSession` 和工具执行链；只有任务完成后才记录 `task_completed`。受限页面可以显式跳过，但失败不能误记完成。
- API Key 只允许进入 `chrome.storage.local` 或 `chrome.storage.session`，不得进入 IDB、工具导出、商店包、日志或 background LLM 路径。
- 已完成、已跳过或已有配置的用户不被强制重新进入首次流程；设置页提供显式重新打开入口。

## 可选权限

安装时不要求 `bookmarks`、`history`、`downloads` 或 `debugger`。每次调用相关能力前都以 `chrome.permissions.contains` 为准，不假设升级或先前授权仍然有效。

| 权限 | 能力 | 请求入口 |
|---|---|---|
| `bookmarks` | 本机书签搜索与引用 | side panel 的 Bookmarks 授权按钮 |
| `history` | `searchHistory` | side panel 的权限请求卡 |
| `downloads` | `downloadImage`、`downloadSpreadsheet` | side panel 的权限请求卡 |
| `debugger` | CDP recorder 增强能力 | 对应的显式 opt-in 入口 |
| `notifications` | Job 变化、成功或最终失败提醒 | Jobs 创建/编辑表单的通知开关 |

- `chrome.permissions.request` 只能由 side panel 中的显式用户手势直接触发。
- widget 只能把待授权请求交给 side panel；Coordinator、MCP、background 和 self-heal 都不得代替用户授权。
- 用户拒绝后，原工具调用以机器可读结果返回；后续显式操作可以再次请求。授权成功后原调用最多自动重试一次。
- 设置页撤销权限后，已挂载界面必须同步失效相关缓存。书签撤销时清空已加载书签并恢复授权入口。
- 通知权限被拒绝或撤销时不得阻止 Job 执行；Jobs 表单必须将通知开关回退为关闭，不保存一个当前无法生效的隐性授权。
- requester 缺失、side panel 不可达或远程路径缺少权限时必须确定性失败，不得挂起或静默绕过。

## 与危险审批的关系

Chrome capability permission 与 AIPageGo 的 `dangerous` 工具审批是两条独立门禁：

- 获得 bookmarks/history/downloads/debugger 权限不会批准 `submitForm`、`uploadFile`、`readStorage`、带 Cookie 的 `httpRequest` 或危险 `runJS`。
- 批准 dangerous 工具也不会代替 Chrome 权限授权。
- 自动 self-heal、widget、Coordinator 和 MCP 均不得绕过任一门禁。

## 商店状态

- 自动化只能把发布材料状态证明到 `materials_ready`。
- `submitted`、`in_review`、`published` 必须分别有 Chrome Web Store 人工操作和外部证据；没有证据不得推断或自动升级状态。
- 发布包审计必须覆盖 manifest 权限、ZIP 根结构和引用资产、版本一致性、禁入文件、常见密钥模式以及商店材料完整性。

## 验证锚点

- `packages/extension/tests/sidepanel/onboarding/`
- `packages/extension/tests/permissions/optional-permissions.test.ts`
- `packages/extension/tests/sidepanel/components/permission-request-card.test.tsx`
- `packages/extension/tests/sidepanel/shell/app-shell-bookmarks.test.tsx`
- `packages/extension/tests/sidepanel/shell/app-shell-widget-permission.test.tsx`
- `packages/extension/tests/background/coordinator-exec.test.ts`
- `packages/extension/tests/store-package-audit.test.ts`
- `store-assets/smoke/2026-10-23-p0-smoke.md`

## 决策记录

### 2026-10-24 保留页面自动化 host 权限，浏览器数据权限改为按需

AIPageGo 保留核心页面读写与 URL 匹配需要的 `<all_urls>`，同时把 bookmarks、history、downloads 和 debugger 从安装权限移到能力首次使用时授权。这样不牺牲页面自动化主路径，也避免用户在安装时授予尚未使用的浏览器数据能力；若未来取消 `<all_urls>`，必须先重新设计跨站内容脚本与 URL 匹配契约。
