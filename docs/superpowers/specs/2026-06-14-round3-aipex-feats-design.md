# Round 3 — 4 AIPex 后续特性 spec

**状态**：草稿 · 2026-06-14 · 作者：assistant + attson

把上次推迟的 S1 + 之前 AIPex 对比清单里的 A2 / A3 / A10 一并实装。

## 1 · 目标

- **F1 主题切换**（light / dark / system，dark 默认）—— 上次推迟，本次做
- **F2 聊天贴图**（多模态：粘贴 / 拖拽 / 选文件 → 图片进 user message）
- **F3 Bookmarks @ 入口**（@ picker 加 `Bookmarks` 类）
- **F4 Skills 协议捆绑**（写 `SKILL.md` + 通过 mcp-server 暴露）

## 2 · 非目标

- @ picker History / Skills（仍然推迟）
- AI 主动截屏给自己看（vision 单向：用户给 AI）
- Voice / i18n
- ZenFS / multi-agent

## 3 · F1 · 主题切换

### 3.1 思路

不全文件 sed 替换 `bg-zinc-XXX`。改用 **Tailwind colors via CSS variables**：在 `tailwind.config.js` 把 `zinc` palette 整组指向 CSS 变量；变量在 `[data-theme="dark"]` 和 `[data-theme="light"]` 下取不同值。

效果：所有现有 `bg-zinc-950 / text-zinc-100 / border-zinc-800` 等类**无需改动**，渲染时根据 `data-theme` 自动切色。

### 3.2 配色 mapping（RGB triplets，支持 `/40` alpha 修饰符）

| Tailwind class | dark RGB | light RGB |
|---|---|---|
| `zinc-50` | `250 250 250` | `24 24 27` |
| `zinc-100` | `244 244 245` | `39 39 42` |
| `zinc-200` | `228 228 231` | `63 63 70` |
| `zinc-300` | `212 212 216` | `82 82 91` |
| `zinc-400` | `161 161 170` | `113 113 122` |
| `zinc-500` | `113 113 122` | `161 161 170` |
| `zinc-600` | `82 82 91` | `212 212 216` |
| `zinc-700` | `63 63 70` | `228 228 231` |
| `zinc-800` | `39 39 42` | `244 244 245` |
| `zinc-900` | `24 24 27` | `255 255 255` |
| `zinc-950` | `9 9 11` | `250 250 250` |

红/蓝/绿/橙 accent 颜色不变（在两种主题下都能识别）。

### 3.3 实现

- `tailwind.config.js`：`zinc` 整组写成 `rgb(var(--c-zinc-XXX) / <alpha-value>)`
- 新建 `src/sidepanel/theme.css`：定义 `[data-theme="dark|light"]` 下的 CSS 变量
- 新建 `src/sidepanel/shell/theme-provider.tsx`：读 settings → 写 `<html data-theme="...">`；监听 `matchMedia('(prefers-color-scheme: dark)')`
- `settings-store.ts`：加 `theme: "light" | "dark" | "system"`，默认 `"dark"`
- `settings-drawer.tsx`：加 `section-appearance.tsx`（3 radio）

### 3.4 测试

- theme-provider unit：dark / light / system 状态正确写 `data-theme`
- 系统主题切换时 `system` 模式正确响应

## 4 · F2 · 聊天贴图

### 4.1 数据模型

新增 `ImagePart`：

```ts
export type ImagePart = {
  type: "image";
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** base64-encoded image, no data: prefix */
  data: string;
};

export type ChatMessage =
  | { role: "user"; content: string | Array<TextPart | ImagePart | ToolResultPart> }
  | { role: "assistant"; content: Array<TextPart | ToolUsePart> };
```

`Json` 兼容性：base64 是字符串，数据结构本身仍是 Json 兼容。

### 4.2 输入侧

- `InputBox` 加 `onImagesPicked(files: File[]) => void`
- AppShell 持有当前轮的 `stagedImages: ImagePart[]`（未发送时显示在 input 区上方一行缩略图，可 × 移除）
- 触发方式：
  - 粘贴（`paste` 事件检测 `clipboardData.items`）
  - 拖放（`drop` 事件）
  - 「📎 加图片」按钮 → file input
- 发送时：`content` = `[...stagedImages.map(i => image part), { type: "text", text: prompt }]`，并清空 stagedImages。
- 限制：每张 ≤ 5 MB；同一轮 ≤ 5 张。

### 4.3 显示侧

`message-bubble.tsx` 的 user message：
- 若 content 是字符串 → 原样渲染
- 若是数组 → 每个 ImagePart 渲染 `<img>`，每个 TextPart 渲染文本
- assistant message 不变（暂不接收返回图）

### 4.4 LLM 客户端转换

**Anthropic** 已原生支持 image block：

```ts
function toAnthropicContent(c: TextPart | ImagePart | ToolResultPart) {
  if (c.type === "image")
    return { type: "image", source: { type: "base64", media_type: c.media_type, data: c.data } };
  // text / tool_result 不变
}
```

**OpenAI** 用 `image_url`：

```ts
function toOpenAiContent(c: TextPart | ImagePart | ToolResultPart) {
  if (c.type === "image")
    return { type: "image_url", image_url: { url: `data:${c.media_type};base64,${c.data}` } };
  // text → { type: "text", text }
}
```

### 4.5 测试

- 粘贴 / 拖放 / file picker → File → base64 转换
- 序列化进 ChatMessage 正确
- Anthropic / OpenAI 客户端各自的转换函数（pure function 测试）
- 5 张限额 & 5MB 限额触发的友好提示

## 5 · F3 · Bookmarks @ 入口

### 5.1 数据源

`chrome.bookmarks.search('')` 返回所有书签（含子树）。我们简化：每次 picker 打开时调一次（≤ 几百条都行；扩展账号一般 < 1000）。

### 5.2 UI

`MentionPicker` 加第 3 个 segmented control：`Tabs | Tools | Bookmarks`。

每条渲染 `📑 <title>`，hover 出 url tooltip。键盘行为同前：左/右切类，上/下移行，Enter 选中。

### 5.3 行为

插入 `@bookmark:<title>` 文本标记到 textarea。后续可以扩为系统提示词注入 url，本次仅文本引用。

### 5.4 Manifest

加 `"bookmarks"` 权限。

### 5.5 测试

- Bookmarks 加载 & 过滤（仅含 url 的叶子节点，跳过文件夹）
- 选中插入文本

## 6 · F4 · Skills 协议捆绑

### 6.1 SKILL.md

写一份 `skill/SKILL.md`，给 Claude Code 这类 agent 一份"怎么在浏览器里干活"的剧本。内容：

- 推荐的工具使用顺序（先 snapshotDOM 探查 → 再 fillInput/click → 最后 submitForm）
- 19 个 BuiltinTool 的 schema 摘要
- 典型场景示例（采集 / 填表 / 翻页）
- 注意事项（dangerous 工具会被拦审批；用 askUser 跟用户互动）

### 6.2 mcp-server 暴露

mcp-server 已经有 `tools/list` 返回 19 个浏览器工具。再加：

- 新 MCP tool `aipagego.skill.read`：返回 `SKILL.md` 内容
- mcp-server `prompts/list`：曝光 `aipex-browser` 类似的 prompt 模板

### 6.3 测试

- `read` 返回 SKILL.md 文件内容
- prompts list 包含一个名为 `aipagego-browser` 的 prompt

## 7 · 文件计划

**新增（7）：**
```
docs/superpowers/specs/2026-06-14-round3-aipex-feats-design.md
src/sidepanel/theme.css                                      F1
src/sidepanel/shell/theme-provider.tsx                       F1
src/sidepanel/drawers/settings/section-appearance.tsx        F1
src/sidepanel/components/staged-images.tsx                   F2
skill/SKILL.md                                               F4
packages/mcp-server/src/skill-handlers.ts                    F4
```

**修改：**
- `packages/extension/tailwind.config.js`：zinc → CSS vars (F1)
- `packages/extension/src/sidepanel/main.tsx`：包 ThemeProvider (F1)
- `packages/extension/src/sidepanel/drawers/settings-drawer.tsx`：插 section-appearance (F1)
- `packages/extension/src/sidepanel/chat/settings-store.ts`：加 `theme` 字段 (F1)
- `packages/shared/src/types.ts`：加 ImagePart，ChatMessage 扩展 (F2)
- `packages/extension/src/sidepanel/llm/anthropic.ts`：image content 转换 (F2)
- `packages/extension/src/sidepanel/llm/openai.ts`：image content 转换 (F2)
- `packages/extension/src/sidepanel/input/input-box.tsx`：paste/drop/file picker (F2)
- `packages/extension/src/sidepanel/input/input-toolbar.tsx`：传递 stagedImages (F2)
- `packages/extension/src/sidepanel/components/message-bubble.tsx`：渲染图 (F2)
- `packages/extension/src/sidepanel/shell/app-shell.tsx`：stagedImages 状态 + 发送时合并 (F2)
- `packages/extension/src/sidepanel/input/mention-picker.tsx`：Bookmarks 类 (F3)
- `packages/extension/src/manifest.ts`：加 `bookmarks` 权限 (F3)
- `packages/mcp-server/src/server.ts`：注册 `skill.read` + prompts (F4)

## 8 · State 变化

`settings-store.ts`：
- 新增字段 `theme: "light" | "dark" | "system"`，默认 `"dark"`

`session-store.ts`：
- 不变（stagedImages 放 SessionData 还是局部 state？放局部—不需要跨 tab 持久化）

## 9 · 风险

| 风险 | 缓解 |
|---|---|
| zinc 全表 CSS var 替换后某些 accent 不对劲 | 仅替换 zinc，其它色不动；视觉走查 |
| 大图 base64 进 IDB 让会话存储爆 | 5 MB/张 + 5 张/轮 = ~25 MB 上限；超出报错；IDB ≤ 20 条/URL 已限 |
| 粘贴大量 HTML 误触图片 | 仅识别 `clipboardData.items.kind === "file"` 且 `type.startsWith("image/")` |
| LLM 不支持图片时给静默错 | API 报 400 → 走现有 stream_error 路径 |
| Bookmarks API 在某些 distrib 上空 | 失败时 Bookmarks tab 显示 "没有可引用的书签"，不弹错 |

## 10 · Out of scope（明确不做）

- AI 主动截屏（要 chrome.tabs.captureVisibleTab + 安装相关 host perm）
- 图片编辑 / 标注
- 历史会话恢复时图片 URL 失效的迁移
- @bookmark 注入系统 prompt
