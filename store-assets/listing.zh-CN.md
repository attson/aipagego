# Chrome Web Store 文案（简体中文）

## 名称

AIPageGo — AI 网页助手

## 简短说明

在当前网页与 AI 对话：总结、填写、采集，并把成功流程固化为可重放工具。

## 单一用途

AIPageGo 的单一用途是在用户明确发起任务时，让其选择的 AI 模型读取、操作或采集当前网页，并将成功步骤保存为可复用的本地工具。

## 完整说明

AIPageGo 运行在 Chromium 侧边栏中。你可以像使用聊天助手一样要求它总结文章、翻译内容、抽取商品或列表数据、填写表单、点击页面，或者在多个标签页之间完成任务。

成功的对话可以“固化”为 URL 模式匹配的工具，下次在相似页面直接重放，无需再次让模型规划。页面读取优先使用结构化 Page Context Index；危险操作需要独立审批。

主要能力：

- 阅读：总结、翻译、问答和结构化抽取。
- 操作：填写、选择、点击、提交和上传，并展示每一步状态。
- 采集：列表、图片、评论和表格，支持 JSON/XLSX 输出。
- 复用：把成功流程保存为本地可重放工具。
- 开发者模式：可选 MCP / Coordinator 配对，用 Codex 或 Claude Code 驱动真实浏览器。

AIPageGo 不提供云账号、遥测或托管模型。你自行选择 Anthropic、OpenAI 或兼容 Endpoint，API Key 保存在本机或当前浏览器会话。

## 链接

- 隐私政策：https://attson.github.io/aipagego/privacy
- 权限说明：https://attson.github.io/aipagego/permissions
- 支持：https://github.com/attson/aipagego/issues
- 项目主页：https://attson.github.io/aipagego/

## 权限理由摘要

核心页面权限用于用户当前网页的读取、操作、多标签会话和 URL 匹配。`bookmarks`、`history`、`downloads` 与 `debugger` 均为可选权限，只在对应功能首次使用时询问；拒绝不会影响普通网页聊天。
