# AI 生成两类工具：提示词工具与纯函数工具 — 设计文档

- 日期：2026-05-12
- 状态：草案，待评审
- 范围：重做「保存为工具」流程：用户先选择工具类型，再由 AI 基于完整多轮对话生成可保存的工具草稿；支持提示词工具和纯函数/固定步骤工具两类
- 前置：Plan 1-5 已落地；现有保存流程、LLM client、静态扫描、工具详情页可复用

## 1. 背景与目标

当前「保存为工具」直接保存已经执行成功的 `executedSteps`，并可让 AI 追加一个汇总 `runJS` step。这解决了“最终输出结构不稳定”的问题，但仍然偏机械：多轮用户追问、修正、范围收敛后的真实任务意图没有被总结成可复用工具。

新目标：保存时不再生硬复制对话过程，而是让 AI 总结整段多轮对话，生成两类可复用工具之一：

1. **提示词工具**：保存 AI 总结后的任务提示词。运行时回到聊天页并自动发送该提示词，让 LLM 基于当前页面重新规划和执行。
2. **纯函数工具**：保存 AI 总结后的确定性执行逻辑。优先生成单个 `runJS`，任务需要时可生成一组固定 steps。运行时不调用 LLM，直接按现有 runner 执行。

非目标：

- 不兼容旧工具数据或旧导出 bundle；读取时旧工具按无效记录处理，列表/匹配过滤掉，按 id 获取返回空。
- 不改 `DB_NAME = "aipagego"`。
- 不统计提示词工具运行次数到 `Tool.stats`；第一版只让聊天日志标注来源。
- 不做 Chrome Web Store 发布流程变化。
- 不做自动迁移、自动修复旧工具。

## 2. 产品决策

| 决策点 | 选择 |
|---|---|
| 保存入口 | 打开「保存为工具」后先选择类型 |
| 提示词工具运行方式 | 跳回聊天页并自动发送保存的 AI 总结提示词 |
| 纯函数工具形态 | 优先单个 `runJS`，必要时允许多 step |
| AI 生成范围 | 两类工具都生成 `name`、`description` 和核心内容 |
| URL 模式 | 沿用当前规则默认生成，用户可编辑，不由 AI 自动扩大 |
| 旧数据 | 不兼容，不迁移 |
| 运行统计 | 纯函数工具继续统计；提示词工具第一版不统计 |

## 3. 数据模型

`Tool` 升级为 discriminated union，`kind` 必填。

```typescript
export type StepsTool = {
  kind: "steps";
  id: string;
  name: string;
  urlPatterns: string[];
  description: string;
  steps: Step[];
  outputSchema: JsonSchema;
  createdAt: number;
  updatedAt: number;
  versions: StepsToolVersion[];
  stats: { runs: number; lastRunAt?: number; lastRunOk?: boolean };
};

export type PromptTool = {
  kind: "prompt";
  id: string;
  name: string;
  urlPatterns: string[];
  description: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  versions: PromptToolVersion[];
  stats: { runs: number; lastRunAt?: number; lastRunOk?: boolean };
};

export type Tool = StepsTool | PromptTool;
```

Version 也按类型拆开：

```typescript
export type StepsToolVersion = {
  version: number;
  kind: "steps";
  steps: Step[];
  outputSchema: JsonSchema;
  createdAt: number;
  note?: string;
};

export type PromptToolVersion = {
  version: number;
  kind: "prompt";
  prompt: string;
  createdAt: number;
  note?: string;
};
```

存储层读取工具时用新 `ToolSchema` 校验：无 `kind` 或字段不符合新结构的记录不迁移、不修复，`listTools`/`matchingTools` 过滤掉，`getTool` 返回 `undefined`。

`ToolDraftSchema` 同样拆成 `PromptToolDraftSchema | StepsToolDraftSchema`：

- `steps` 工具要求 `steps.length >= 1` 和 `outputSchema`。
- `prompt` 工具要求 `prompt` 非空。
- 旧 draft 没有 `kind` 时校验失败。

## 4. 保存 UX

保存对话框改为两段式。

### 4.1 类型选择

初始状态只要求用户选类型：

```
保存为工具

选择保存方式：

[提示词工具]
适合多轮对话沉淀、页面略有变化、需要 AI 判断的任务。
运行时会回到聊天页，由 AI 基于当前页面重新执行。

[纯函数工具]
适合字段采集、格式转换、页面结构稳定的任务。
运行时不调用 LLM，直接执行固定 steps。
```

### 4.2 AI 生成候选

选择类型后显示：

- 名称输入框（由 AI 生成后填入，可编辑）。
- URL 模式输入框（仍由 `defaultPattern(currentUrl)` 生成，可编辑）。
- 描述输入框（由 AI 生成后填入，可编辑）。
- 生成区：`让 AI 生成候选`、`取消生成`、`重新生成`。

提示词工具 ready 状态：

```
AI 已生成提示词工具
名称：商品评论采集
描述：在商品页采集主图、详情图、评论摘要并输出结构化 JSON。

▾ 提示词
你是 AIPageGo，请基于当前页面完成以下任务：...

[重新生成] [保存]
```

纯函数工具 ready 状态：

```
AI 已生成纯函数工具
名称：商品基础信息提取
描述：从当前商品页 DOM/window.rawData 提取标题、图片、价格、评论信息。

scan: caution uses-dom-query
▾ steps JSON
[
  { "kind": "js", "source": "const init = ...; return {...};" }
]

[重新生成] [保存]
```

保存按钮在 AI 生成候选前禁用，避免继续保存机械 steps。

## 5. AI 生成器

新增 `src/sidepanel/llm/tool-draft-generator.ts`，包含两个入口。它们复用现有 `LlmClient`，但要求模型返回结构化 JSON 文本。

### 5.1 通用输入

```typescript
export type ToolDraftGenerationInput = {
  client: LlmClient;
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  currentUrl: string;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
  abortSignal?: AbortSignal;
};
```

User prompt 包含：

- 当前 URL。
- 完整多轮用户/assistant 文本摘要（截断但覆盖多轮，而不是只取最后一段）。
- 已执行 steps 的类型、参数和关键输出节选。
- `lastOutput` 节选。
- 明确要求“总结任务意图，不要机械复刻对话”。

### 5.2 提示词工具生成

```typescript
export type GeneratedPromptToolDraft = {
  name: string;
  description: string;
  prompt: string;
};

export async function generatePromptToolDraft(
  input: ToolDraftGenerationInput
): Promise<GeneratedPromptToolDraft>;
```

System prompt 要求：

- 输出 JSON：`{ "name": string, "description": string, "prompt": string }`。
- `prompt` 面向未来运行，不引用“上面这段对话”。
- `prompt` 要告诉 AI 基于当前页面执行，必要时使用 AIPageGo 工具读取/操作页面。
- `prompt` 要包含期望输出结构和完成标准。
- 不包含 API key、账号密码、cookie 或其他敏感值。

校验规则：

- JSON 可解析。
- `name` 非空，长度有上限。
- `description` 非空，长度有上限。
- `prompt` 非空，长度上限 8KB。
- `prompt` 通过敏感串粗略扫描：拒绝明显 API key、Bearer token、cookie dump。

### 5.3 纯函数工具生成

```typescript
export type GeneratedStepsToolDraft = {
  name: string;
  description: string;
  steps: Step[];
};

export async function generateStepsToolDraft(
  input: ToolDraftGenerationInput
): Promise<GeneratedStepsToolDraft>;
```

System prompt 要求：

- 输出 JSON：`{ "name": string, "description": string, "steps": Step[] }`。
- 优先生成一个 `kind: "js"` 的 `runJS` 函数体：读取 `window.rawData`、DOM 或 `ctx`，返回稳定 JSON。
- 如果任务必须滚动、等待、点击或采集多段页面状态，允许生成多 step。
- 不调用 LLM，不调用扩展 API，不读取/输出敏感凭证。
- `runJS` 只返回 JSON-compatible value。

校验规则：

- JSON 可解析。
- `steps.length >= 1`。
- 每个 step 通过 `StepSchema`。
- 每个 `runJS` source 长度有上限，并运行 `runStaticScan`。
- static scan 不阻塞保存；dangerous 结果在 UI 中明确标红，用户仍可决定保存。
- `outputSchema` 从 `lastOutput` 或生成器可选 dry sample 推断；第一版继续用 `inferJsonSchema(lastOutput)`。

## 6. 运行流程

### 6.1 纯函数工具

保持现有 `ToolDetailPage -> rpc.runTool -> background -> content runner` 流程。

变更点：

- `runTool` 仅接受 `kind: "steps"` 工具。
- `ToolDetailPage` 对 `steps` 工具显示步骤定义和“在当前 tab 运行”。
- `recordRunStat` 继续只在 `steps` runner 成功/失败后更新。

### 6.2 提示词工具

提示词工具不走 background runner。

- `ToolDetailPage` 对 `prompt` 工具显示提示词预览和按钮 `在聊天中运行`。
- 点击后通过页面路由回到 `ChatPage`，传入：
  - `initialPrompt = tool.prompt`
  - `initialContext` 包含工具名、描述、URL patterns、来源说明。
  - `autoSend = true`
- `ChatPage` 支持 `autoSend`：当前 tab/session ready 后自动调用现有 `send(initialPrompt)` 一次。
- 聊天日志追加来源：`source tool: <name> (<id>)`。

`initialContext` 模板：

```markdown
# 保存的提示词工具
名称：...
描述：...

请把接下来用户消息视为一个已保存工具的任务说明。基于当前页面重新执行，
不要机械复述旧对话；如果页面结构变化，请先读取页面再判断。
```

## 7. 匹配、列表、详情与导入导出

- `matchingTools(url)` 对两类工具都按 `urlPatterns` 匹配。
- 工具列表显示类型 badge：`提示词` / `纯函数`。
- 推荐 banner 中：
  - `steps` 工具的“运行”进入详情并 autoRun。
  - `prompt` 工具的“运行”跳聊天 autoSend。
- 导出 bundle schema 升级为 `aipagego.tools/v2`；导入只接受 v2。
- 导入只接受新 schema 和新 `Tool` discriminated union。

## 8. 错误处理

保存生成阶段：

- 无 API key：显示“请先在设置页填入 API Key”。
- LLM HTTP/stream 错误：显示截断后的错误，允许重试。
- JSON 解析失败：显示“AI 返回格式无效”，保留原始片段在 details 中供调试。
- prompt/steps 校验失败：显示具体字段错误，允许重新生成。
- 生成中关闭弹窗：abort 当前请求。

运行阶段：

- `prompt` 工具缺少 prompt：详情页显示无效工具，不提供运行。
- `steps` 工具缺少 steps：详情页显示无效工具，不提供运行。
- `ChatPage autoSend` 如果 API key 缺失，复用现有错误提示。

## 9. 测试计划

单元测试：

- `ToolDraftSchema` 接受 `kind: "prompt"` 和 `kind: "steps"`，拒绝缺少 `kind` 的旧 draft。
- `generatePromptToolDraft` 解析合法 JSON；拒绝坏 JSON、空 prompt、疑似 secret。
- `generateStepsToolDraft` 解析合法 JSON；拒绝非法 step；对 runJS 触发 static scan。
- `saveDraft` 分别保存两类工具，并写入对应 version。
- `matchingTools` 对两类工具都匹配。
- export/import 只接受 `aipagego.tools/v2`。

UI 测试：

- 保存对话框先显示类型选择。
- 选择提示词工具后，生成结果填入 name/description/prompt，保存 draft 为 `kind: "prompt"`。
- 选择纯函数工具后，生成结果填入 name/description/steps，保存 draft 为 `kind: "steps"`。
- 提示词工具详情页点击“在聊天中运行”会调用路由回到 chat，并传入 autoSend prompt。
- 纯函数工具详情页仍能运行并显示 RunRecord。

手动验证：

- 多轮对话保存为提示词工具；在同类页面运行后进入聊天页并自动执行。
- 采集类对话保存为纯函数工具；在当前 tab 运行后不调用 LLM，直接返回 JSON。
- dangerous `runJS` 候选在保存 UI 中标红但不阻塞。

## 10. 实施拆分建议

1. 类型和 zod schema：引入 `PromptTool` / `StepsTool` discriminated union。
2. 存储/RPC：保存、获取、列表、匹配、导入导出改为新 schema。
3. AI 生成器：新增提示词工具和 steps 工具生成入口及测试。
4. 保存对话框：两段式 UI，接入生成器和校验。
5. 工具详情/推荐运行：按工具类型分流，提示词工具跳 ChatPage autoSend。
6. 验证：typecheck、全量测试、手动加载 `dist/`。
