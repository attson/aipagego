# Round 4 — A 部分有价值的 3 项

**状态**：草稿 · 2026-06-14 · 作者：assistant + attson

把 [Round 3 spec §14 后续](2026-06-14-round3-aipex-feats-design.md) 里 A 部分剩下 3 个"价值 ≥ 中"的实装。Voice / i18n / ZenFS / multi-agent 跳过或单独走。

## 1 · 目标

- **G1 AI 主动截屏** —— 新增 BuiltinTool `screenshot`，AI 可以截当前 tab（可选区域）作为 vision 输入
- **G2 可视化 element capture（基础版）** —— sidepanel 一键进入"选元素"模式，用户点页面任意元素，selector 自动回填到 input 框
- **G3 External replay** —— 外站可通过 `window.postMessage({ type: "aipagego:run", prompt, steps? })` 唤起 sidepanel 接管（白名单 + 用户审阅）

## 2 · 非目标

- A1 Voice / A2 i18n / A6 ZenFS / A7 Multi-agent
- AI 截屏后做 OCR / 自动标注
- Element capture 智能选择器推断（基础版只取 CSS path）
- External replay 自动执行（一律需用户审阅）

## 3 · G1 · AI 主动截屏

### 3.1 BuiltinTool 定义

新增 `screenshot` 到 `BuiltinTool` 类型 + `TOOL_DEFS`：

```ts
{
  name: "screenshot",
  description: "截取当前 tab 的可见区域为 PNG，base64 返回。用于 vision 模型分析视觉布局 / 调试 selector。本身不会暴露给页面 JS。",
  input_schema: {
    type: "object",
    properties: {
      /** 不传 = 整个 viewport；传则截取该元素的 bounding rect（chrome.tabs.captureVisibleTab 仍是 viewport，要在 content 里 crop） */
      selector: { type: "string", description: "可选 CSS selector；不传截整个可见 viewport" },
      tabId: { type: "integer", description: "目标 tab；不传 = 主 tab" }
    }
  }
}
```

### 3.2 分类

`severity.ts SAFE` 加 `screenshot`（不写页面，只读视觉）。

### 3.3 实现路径

`screenshot` 跟 `listTabs/openTab` 一样是 control-plane 工具，在 `run-session.ts` 的"非 content-script"分支处理。

流程：
1. `chrome.tabs.captureVisibleTab(windowId, { format: "png" })` → base64 data URL
2. 截掉 `data:image/png;base64,` 前缀，纯 base64
3. 返回 `{ kind: "image", media_type: "image/png", data: "<base64>" }`

返回的对象**约定 LLM 客户端识别后注入 vision content block**：tool_result 内容是个 string，但 string 里包含 `[image:base64,...]` 占位符，下一轮把它转成 `ImagePart` 注入到 assistant→user 的 content 数组。

为了简化（避免改 message_format 协议），G1 第一版**只返回 selector 元素的截图数据**到 tool_result 文本，AI 看到一段提示："截图已成功，data: ... 请基于此截图回答"——但 base64 太长不实际。

**更合适的方案**：tool_result 是普通 JSON `{ ok: true, ms, byteLen }`，同时把截图作为 ImagePart 追加到下一条 tool_result 同伴的 user message 里。这要在 run-session 里特殊处理 screenshot 工具的结果。

#### 实装决策

在 run-session 中对 screenshot 工具走特殊路径：
- 调 `chrome.tabs.captureVisibleTab` 拿 base64
- 写 `appendStepLog` 不存 base64（太大），只存元数据 `{ byteLen }`
- 给 `results` push 一个 **包含 ImagePart 的 tool_result**：
  ```ts
  results.push({
    type: "tool_result",
    tool_use_id: tu.id,
    content: [
      { type: "text", text: "screenshot:ok" },
      { type: "image", media_type: "image/png", data: <base64> }
    ]
  });
  ```
- Anthropic 已经接受 `tool_result.content` 数组里的 image block；OpenAI 不支持图片 tool_result，需要把图片转写到下一条 user 消息（先实现 Anthropic 路径，OpenAI 路径返回降级文本）。

### 3.4 测试

- Anthropic toolResult image block 序列化 OK
- content-script 路径不走（control-plane）
- SAFE 自动通过审批

## 4 · G2 · 可视化 element capture（基础版）

### 4.1 形态

input toolbar 加一个新按钮 `🎯`（旁边的 `📎`、`@` 同行）。点击：
1. sidepanel 发消息给当前 tab content script: `{type: "aipagego.startCapture"}`
2. content script 注入一个 overlay：鼠标 hover 高亮元素（红色虚线框），点击 = 选中
3. content script 回 sidepanel: `{selector, tagName, text}`
4. sidepanel 把 `[selector]` 插入 textarea 当前光标位置

### 4.2 选择器生成（基础版）

不做智能推断。优先级：
1. 元素有 `id` → `#id`
2. 元素有唯一 `data-testid` → `[data-testid="..."]`
3. 否则生成 CSS path：从 body 往下，每一层 `tag:nth-of-type(n)`，截到目标节点

### 4.3 取消机制

- ESC 退出 capture 模式
- 点击 sidepanel 任意按钮 → 触发"取消 capture"（防止用户切走又卡住）
- 5s 内无点击自动退出（防止 UI 永久卡死）

### 4.4 测试

- selectorFor pure function：3 种优先级覆盖
- ESC / 5s timeout 退出
- content-script overlay 不干扰页面 click（overlay z-index 高 + pointer-events 控制）

## 5 · G3 · External replay

### 5.1 安全模型

- 外站 JS 通过 `window.postMessage({ source: "aipagego-replay", payload: ...}, "*")` 向 content script 发请求
- content script 接到后向 BG 转发
- BG 写入 `chrome.storage.local: aipagego.pending_replay = {sourceUrl, ts, prompt, steps?}`（30s TTL）
- BG 调 `chrome.sidePanel.open({tabId})` 唤起
- sidepanel mount 时检查 pending_replay，**总是显示审阅 modal**（不论 autoSend），用户看清来源、prompt、step count 再点接受 / 拒绝

### 5.2 接受后

- 仅有 `prompt`：等价于 cross-tab pending prompt，填 input 框，用户自己发
- 有 `steps`：直接进入 DEV JSON 模式（modal）让用户审阅 + 跑

### 5.3 协议

```ts
type ReplayMessage = {
  source: "aipagego-replay";
  payload: {
    /** 必填 prompt — 让用户知道做什么 */
    prompt: string;
    /** 可选 Tool steps 草案；提供时进入 DEV JSON 流程 */
    steps?: Step[];
    /** 可选标题，仅用于审阅 modal 显示 */
    title?: string;
  };
};
```

### 5.4 审阅 modal

`<ExternalReplayModal>`：
- 顶部：橙色"⚠ 来自外站 `<sourceUrl>`"
- 中部：title + prompt + steps 折叠预览
- 底部：`[拒绝]` `[接受]`
- ESC 默认拒绝

### 5.5 manifest

`web_accessible_resources` 已有 sidepanel；content script 监 message 即可；无需加权限。

### 5.6 测试

- payload 校验（无 prompt 拒绝）
- TTL 过期清理
- 审阅 modal accept / reject 流程

## 6 · 文件计划

**新增（8）：**
```
docs/superpowers/specs/2026-06-14-round4-aipex-feats-design.md      (this)
packages/extension/src/content/element-capture.ts                    G2
packages/extension/src/content/external-replay.ts                    G3
packages/extension/src/sidepanel/lib/selector-for.ts                 G2 (extracted utility, also runs in content-script)
packages/extension/src/sidepanel/components/external-replay-modal.tsx G3
packages/extension/src/background/external-replay-handler.ts         G3
packages/extension/src/sidepanel/hooks/use-external-replay.ts        G3
packages/extension/tests/sidepanel/lib/selector-for.test.ts          G2
```

**修改：**
- `packages/shared/src/types.ts`：BuiltinTool 加 `screenshot` (G1)
- `packages/shared/src/llm/builtin-tool-defs.ts`：加 screenshot 定义 (G1)
- `packages/shared/src/capability/tool-mapping.ts`：screenshot → `read:dom` (G1)
- `packages/extension/src/sidepanel/chat/severity.ts`：SAFE 加 screenshot (G1)
- `packages/extension/src/sidepanel/chat/run-session.ts`：screenshot 走 control-plane + 注入 image block 到 tool_result (G1)
- `packages/extension/src/sidepanel/input/input-toolbar.tsx`：加 🎯 按钮 (G2)
- `packages/extension/src/sidepanel/shell/app-shell.tsx`：startCapture 触发 + ExternalReplayModal 挂载 (G2, G3)
- `packages/extension/src/manifest.ts`：content_scripts 加 element-capture + external-replay (G2, G3)
- `packages/extension/src/background/index.ts`：监 element-capture + external-replay 转发 (G2, G3)

## 7 · State 变化

`session-store.ts`：
- 不变；capture / replay 都是 local React state

新建 `pending-replay` 概念（陪同 `pending_prompt`，复用 storage 模式）。

## 8 · 风险

| 风险 | 缓解 |
|---|---|
| screenshot base64 太大撑爆 token | 限定 < 2MB，超出降级返回错误；告诉 AI "图太大别再调" |
| element-capture overlay 拦截页面 click | overlay 占整屏 transparent + 鼠标移动只画高亮框；click 直接 dispatch 给底下元素后停止冒泡 |
| External replay 被恶意网站利用 | **总是要审阅 modal**，不论 payload 来源；用户 ESC = 拒绝 |
| External replay 与 cross-tab pending-prompt 冲突 | 两者 storage key 不同，互不干扰；优先级：先处理 replay（更高安全级别） |
| screenshot tool_result.content 数组在 OpenAI 报错 | OpenAI 路径降级为纯文本 tool_result，base64 单独提示用户切到 Anthropic |

## 9 · Out of scope

- A4 智能 selector 推断（基础版用 CSS path）
- A3 截屏区域选择（基础版只支持 viewport 和 selector 元素）
- A5 外站协议升级 v2 / 反向通信（外站只能"发请求"，sidepanel 不回传任何执行结果给外站）
