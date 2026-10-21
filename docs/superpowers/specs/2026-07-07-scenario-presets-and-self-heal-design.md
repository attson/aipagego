# 场景 Preset 库 + Tool 运行时自愈

**状态**：草稿 · 2026-07-07 · 作者：assistant + attson

给 AIPageGo 引入 **Preset 库**（内置一批「打开这个网站就能直接用」的 prompt / tool），配合 **Tool 运行时自愈**（重放时某一步失败，自动看新 DOM 让 LLM 补一版继续跑），让首次装完的用户第一次就能成功、再次运行不会因为网站小改而崩。

## 1 · 背景

现状痛点：

- **拉新**：装完扩展打开一个熟悉网页（电商平台、知乎、GitHub 等），侧边栏空白 + 3 个通用 quick-actions chip（总结 / 抽重点 / 抽评论），用户不知道"这东西能干啥"。
- **留存**：LLM 生成的 tool 存下来之后，网站小改（class 名换、DOM 结构调整）就整个失败。用户唯一的救济是工具详情页 `[让 AI 修复]` 按钮 → 手动跳对话页 → 手动发送 → 手动确认新 steps；非技术用户在这一步流失。

两个方向天然强耦合：**preset 首次失败时自动自愈 → 生成用户本地 v2** 是"让第一次就成功"最锋利的一刀。因此合并成一份 spec。

## 2 · 目标

- 新装用户在支持的网站（维基 / 知乎 / GitHub / Medium / 公众号 / 淘宝 / 京东 / 1688 / Amazon / 通用文章）中任一个，打开侧边栏零输入看到至少一条推荐。
- Tool-form preset 一键运行成功率 ≥ 90%（含自愈），无自愈基线 ~70%。
- 自愈单次调用 ≤ 1 轮 LLM + 硬上限 4096 output tokens，不产生 runaway 成本。
- 无 IDB schema 迁移；现有 tool、会话、导入导出、coordinator 路径零回归。

## 3 · 非目标

- ❌ Preset 云端刷新 / 后端 registry（首版 YAGNI；只做打包内置）
- ❌ Preset 分享 / 广场（无社区、无账号；未来议题）
- ❌ Coordinator 驱动路径的自愈（sidepanel 可能没打开、LLM key 可能不在，日志一条 skipped 即可）
- ❌ Tool-form preset 里包含 `dangerous` step（submitForm / uploadFile / 带 cookie httpRequest / 未通过静态扫描的 runJS）
- ❌ 多次自愈级联（单次运行最多 1 次自愈尝试）
- ❌ 表单填写 / 招聘 sourcing 类 preset（合规风险，未来议题）
- ❌ Preset registry i18n（首版只中文；未来可加）

## 4 · 顶层骨架

```
┌─────────────────────────────────────────────────────────────────┐
│  @aipagego/shared/presets/                                    │
│  ├─ index.ts        PRESETS: Preset[]                           │
│  ├─ ecommerce/*.ts  淘宝 / 京东 / 1688 / Amazon                      │
│  └─ content/*.ts    维基 / GitHub / Medium / 知乎 / 公众号 / …    │
└────────┬────────────────────────────────────────────────────────┘
         │ 静态 import (无 IO)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  matchPresetsByUrl(url)  —— 纯函数,复用现有 url-pattern         │
└────────┬────────────────────────────────────────────────────────┘
         ▼
┌────────────────────────┐         ┌──────────────────────────────┐
│ tab-watcher            │ 合并    │  scenarios-page             │
│ tabs.recommendations   │◀────────┤  #/scenarios (新页)         │
│ (URL 命中推荐 banner)  │         │  (可浏览、可搜索、可试用)   │
└────────┬───────────────┘         └──────────────┬───────────────┘
         │                                        │
         └──────────┬─────────────────────────────┘
                    │ 用户点「运行」
                    ▼
     ┌──────────────────────────────────────┐
     │ materializePreset(id)                │
     │  → 复制 tool-form 到 IDB,origin="preset/xxx@v1"│
     │  → 跳 tool-detail-pane 自动 run       │
     └──────────────────┬───────────────────┘
                        │
                        ▼
    ┌───────────────────────────────────────────────┐
    │ background/bg-tool-runner.runTool             │
    │                                               │
    │  for step in tool.steps:                      │
    │    try: run(step)                             │
    │    catch: attemptHeal(ctx) ──────────┐        │
    │                                       │        │
    └───────────────────────────────────────┼───────┘
                                            ▼
                    ┌────────────────────────────────────────┐
                    │ background/self-heal.ts                │
                    │  1. snapshotDOM(tab)                   │
                    │  2. sidepanel LLM (non-stream, 1 shot) │
                    │  3. zod-validate patched Step[]        │
                    │  4. static-scan reject dangerous       │
                    │  5. resume runTool with patched steps  │
                    │  6. appendVersion v(N+1) on success    │
                    └────────────────────────────────────────┘
```

关键不变量：

- **Preset 本体不进 IDB**（打包 JSON，用户不可删）
- **Tool-form preset 首次运行时 materialize 一份到 IDB**，之后作为用户 tool 走完全相同的重放路径（这样自愈天然复用现有基础设施，不用为 preset 建第二条运行路径）
- **自愈产物只落用户 IDB，不污染 preset 定义**
- **BG 的 self-heal 不持有 LLM client**，通过一个新 RPC 让 sidepanel 帮跑 LLM（复用现有 API key 位置）
- **单次 runTool 最多 1 次自愈**（防递归 + 防 token 爆炸）
- **静态扫描永不阻塞用户，但阻塞自愈补丁**（用户主动放行 vs LLM 自主生成，信任等级不同）

## 5 · 数据模型

### 5.1 Preset 类型（新增，`packages/shared/src/preset.ts`）

```ts
export type PresetId = string;               // 稳定 slug,如 "amazon-product-collect"
export type PresetCategory = "ecommerce" | "content";

export type PresetBase = {
  id: PresetId;
  name: string;                              // 中文展示名
  description: string;                       // 一句话
  category: PresetCategory;
  urlPatterns: string[];                     // glob,复用 url-pattern.ts
  icon?: string;                             // lucide 图标名
  version: number;                           // preset 内容版本(内容变时 +1)
  sampleUrl?: string;                        // 场景库"导航到示例页"用
};

export type PromptPreset = PresetBase & {
  kind: "prompt";
  prompt: string;                            // 塞入输入框的完整 prompt
};

export type ToolPreset = PresetBase & {
  kind: "tool";
  steps: Step[];                             // 完整 step 序列
  expectedResultShape?: JsonSchema;          // 产物结构断言(可选)
};

export type Preset = PromptPreset | ToolPreset;
```

### 5.2 Registry 存放

- `packages/shared/src/presets/index.ts` — `export const PRESETS: readonly Preset[]`
- 按场景分目录：`presets/ecommerce/amazon.ts` / `presets/content/wikipedia.ts` / …
- 每文件 export 单个 `Preset`
- `index.ts` 静态聚合（无 dynamic import）
- 单测通过 zod schema + 唯一 id 检查

### 5.3 `Tool.origin`（扩展现有 `Tool` 类型）

```ts
export type ToolOrigin =
  | { kind: "preset"; presetId: PresetId; presetVersion: number };

export type Tool = /* 现有字段 */ & {
  origin?: ToolOrigin;    // 可选:老 tool 无此字段完全兼容
};
```

- 无 DB migration；读取时缺字段就是 undefined，走"用户手工保存"分支
- Preset materialize 出的 tool 带 `origin.kind === "preset"`
- 自愈产物 append 到该 tool 的 `versions[]`，`origin` 不变
- 导出工具库时：`origin.kind === "preset" && versions.length === 1` 的 tool 跳过（避免"导个 zip 出去里面全是空 preset 副本"）

### 5.4 SessionEvent 扩展（`packages/extension/src/sidepanel/chat/run-session.ts`）

三个新变体（同时按 AGENTS.md "Add a new tool-use turn event" 流程镜像到 `packages/shared/src/protocol/chat-event.ts`）：

```ts
| { kind: "self_heal_started";   toolId: string; toolName: string; failedStepIndex: number }
| { kind: "self_heal_completed"; toolId: string; newVersion: number; fixedStepIndex: number }
| { kind: "self_heal_failed";    toolId: string; reason: "llm_error" | "budget_exceeded" | "invalid_output" | "step_still_fails" | "no_sidepanel" | "no_api_key" }
```

sidepanel 消费显示"自愈中 → 自愈成功 v(N+1)" 状态条。

## 6 · 曝光路径

### 6.1 通路一：URL 命中推荐（复用 `tabs.recommendations`）

改造 `packages/extension/src/background/tab-watcher.ts`：

```ts
async function computeRecommendations(url: string): Promise<Recommendation[]> {
  const userTools = await matchUserToolsByUrl(url);
  const presets   = matchPresetsByUrl(url);
  return dedupe(
    [
      ...userTools.map(toolToRec),
      ...presets.map(presetToRec),
    ],
    r => r.presetId ?? r.toolId
  );
}
```

- 去重键：如果 preset 已经 materialize 成用户 tool，`tool.origin.presetId` 与 preset `id` 匹配时跳过 preset 条目
- `Recommendation` payload 加 `origin?: ToolOrigin` 让 banner 显示"内置场景 · NEW"角标
- 点击 preset banner：
  - `prompt-form` → 把 prompt 塞进输入框（不 send）
  - `tool-form` → materializePreset(id) → 跳 tool-detail-pane 自动 run

### 6.2 通路二：场景库页（新页）

新增 `packages/extension/src/sidepanel/pages/scenarios-page.tsx`，`app.tsx` 加路由 `#/scenarios`。顶部 tab 从 `聊天 / 工具 / 设置` 变为 `聊天 / 工具 / 场景库 / 设置`。

页面结构：

```
[搜索框: 按名称/描述 filter]
[分类切换 chip: 全部 · 商品采集 · 内容站]

── 商品采集 ────────────────────────
[卡片] icon Amazon 商品采集
       支持 www.amazon.com/**
       [在当前 tab 运行] [复制成我的工具] [查看示例页]

...

── 内容站 ────────────────────────
...
```

单卡片主按钮：

- 当前 tab URL 命中：`[在当前 tab 运行]` = materialize + jump tool-detail-pane
- 未命中且有 `sampleUrl`：`[导航到示例页]` = `chrome.tabs.create({url: sampleUrl})`
- `[复制成我的工具]` = 只 materialize，不跑

状态角标：
- 无副本 → 「NEW」
- 有副本 v1 → 「已复制」
- 有副本 v2+ → 「已升级 v(N)」

### 6.3 通路三：Prompt-form 优先充填 quick-actions

`sidepanel/chat/quick-actions.tsx` 改造：

- 命中当前 URL 的 `PromptPreset` 优先展示（最多 3 条）
- 不足 3 条用现有默认 3 条（总结 / 抽重点 / 抽评论）补齐
- 空态无变化（仍然只在会话空时显示）

## 7 · 自愈自动线

### 7.1 触发点（唯一插桩点）

`packages/extension/src/background/bg-tool-runner.ts` 的 `runTool(id, tabId, opts)`。**Tool 重放的两条路径都汇聚这里**：

1. 用户手动运行（tool-detail-pane → `rpc.runTool`）
2. AI agent loop tool_use（`run-session` → `rpc.runTool`）

因此只在 `runTool` 内部改一处即可覆盖两路径。

### 7.2 新增 `background/self-heal.ts`

```ts
export type HealContext = {
  tool: Extract<Tool, { kind: "steps" }>;
  failedStepIndex: number;
  failedInput: Step;
  errorText: string;
  prevSteps: { input: Step; output: unknown }[];   // 已成功步的产物快照
  domSnapshot: unknown;                            // 失败瞬间 snapshotDOM 结果
  url: string;
};

export type HealResult =
  | { ok: true;  patchedSteps: Step[]; llmUsage: { in: number; out: number } }
  | { ok: false; reason: "llm_error" | "budget_exceeded" | "invalid_output" | "static_scan_reject" | "step_still_fails" | "no_sidepanel" | "no_api_key" };

export type HealDeps = {
  requestSidepanelLlm: (ctx: HealContext, maxOutputTokens: number) => Promise<{ patchedSteps: unknown; usage: { in: number; out: number } }>;
  snapshot:            (tabId: number) => Promise<unknown>;
  staticScan:          (steps: Step[]) => Severity[];
  parseSteps:          (raw: unknown) => Step[] | null;      // zod parse StepSchema[]
  now:                 () => number;
};

export async function attemptHeal(ctx: HealContext, deps: HealDeps): Promise<HealResult> { … }
```

### 7.3 `runTool` 集成

```ts
async function runTool(toolId, tabId, opts = { allowHeal: true }) {
  const tool = await getTool(toolId);
  if (tool.kind !== "steps") return runPromptTool(tool);

  const record = newRunRecord(tool, tabId);
  let healApplied = false;

  for (let i = 0; i < tool.steps.length; i++) {
    try {
      record.stepLog[i] = await runOneStep(tool.steps[i], ctx);
    } catch (e) {
      const canHeal = opts.allowHeal
        && !healApplied
        && await selfHealAvailable()   // enabled + sidepanel connected + hasKey
        && classifyTool(tool.steps[i].tool) !== "dangerous";  // 用 severity 分类,不是 step.kind

      if (canHeal) {
        emitSessionEvent({ kind: "self_heal_started", toolId,
                          toolName: tool.name, failedStepIndex: i });
      }

      if (!canHeal) {
        record.status = "error";
        return record;
      }

      const heal = await attemptHeal({
        tool, failedStepIndex: i, failedInput: tool.steps[i],
        errorText: String(e), prevSteps: record.stepLog.slice(0, i),
        domSnapshot: await snapshotDOM(tabId), url: record.url,
      }, deps);

      if (!heal.ok) {
        emitSessionEvent({ kind: "self_heal_failed", toolId, reason: heal.reason });
        record.status = "error";
        return record;
      }

      const prevVersion = tool.versions.at(-1).version;
      const newVersion  = prevVersion + 1;

      // 补丁替换 [i..end)
      tool.steps.splice(i, tool.steps.length - i, ...heal.patchedSteps);
      await appendVersion(toolId, tool.steps, {
        healedFrom: prevVersion,
        fixedStepIndex: i,
      });
      record.healed = { fromVersion: prevVersion, toVersion: newVersion, fixedStepIndex: i };
      emitSessionEvent({ kind: "self_heal_completed", toolId,
                        newVersion, fixedStepIndex: i });
      healApplied = true;
      i--;   // 从当前 index 继续,循环 i++ 抵消回原位
    }
  }

  return record;
}
```

### 7.4 BG → sidepanel 借 LLM

BG 不能持 API key（现有约定：key 只在 sidepanel + chrome.storage.session/local）。因此：

- 新增 RPC：`RpcRequest.selfhealRequest`（BG → sidepanel）
- sidepanel 侧新增 handler `packages/extension/src/sidepanel/self-heal-host.ts`：拿 `HealContext` + `maxOutputTokens`，用 `sidepanel/llm/summary-step.ts` 同款**一次性非流式**调用（可复用其 truncate + response 解析），返回 `patchedSteps`（未 parse 的 unknown）+ usage
- BG 侧 `attemptHeal.deps.requestSidepanelLlm` 就是包 `chrome.runtime.sendMessage` 的 wrapper
- 500ms 超时 → `reason: "no_sidepanel"`（复用现有 coordinator-state-bridge 的 ping/pong 模式）

**Coordinator 驱动的 BG 会话**（`coordinator-chat.ts`）：`selfHealAvailable()` 返回 false（sidepanel 未必打开），走"失败 + 记 event 结束"路径。日志：`session_event: self_heal_failed { reason: "no_sidepanel" }`。

### 7.5 LLM Prompt 结构

（在 `packages/extension/src/sidepanel/llm/self-heal-prompt.ts`）

```
System:
你在为一个可重放的浏览器自动化工具修复"失败的 step"。
给定原 steps、已成功产物、失败 step、错误信息、失败瞬间的 DOM 快照,
输出从失败 step 开始的补丁 Step[] 数组(JSON,不带 markdown fence)。
只能使用以下 step kinds: {safe + caution 白名单}
禁止使用: submitForm / uploadFile / readStorage / httpRequest(withCredentials) / runJS(未过静态扫描)
补丁应尽量少改动、保持产物结构一致。

User:
- 原 tool: {name}, 共 {n} 步
- 已成功 [0..i-1] 产物摘要(截断到 2k tokens)
- 失败 step [i]: {json}
- 错误: {error}
- 当前 URL: {url}
- 当前 DOM(walkTree, depth≤6, textNode 截断): {snapshot}

请只输出 JSON step 数组,不做解释。
```

响应用 `StepSchema.array().safeParse` 校验。失败 → `reason: "invalid_output"`。

### 7.6 静态扫描 gate

补丁通过 `parseSteps` 后，`deps.staticScan(patched)` 逐步检查：

- 任一 step 是 dangerous 分类 → `reason: "static_scan_reject"`
- 任一 runJS 触发 static-scan 高严重级 → 同上

用户对话式手动修复不受此限制（复用现有链路），但**自动生成必须收紧**——LLM 自主决定的补丁不能引入用户没主动放行的高危操作。

### 7.7 设置（`settings-page.tsx`）

- `selfHealEnabled: boolean`（默认 `true`）
- `maxSelfHealOutputTokens: number`（默认 `4096`，可调 1024–8192）
- 关闭时：runTool 保持 v0.0.37 及之前的行为（失败就报错 + `[让 AI 修复]` 按钮），零回归。

## 8 · 手动修复线（保留）

`tool-detail-pane.tsx` 的 `[让 AI 修复]` 逻辑一字不动。差别只在：如果 `RunRecord.healed` 存在但 `status: "error"`（自愈跑了后续步又失败），错误上下文会自动追加：

```
> 自动自愈已尝试并失败:reason=step_still_fails
> 自愈补丁: {json}
> 请基于对话继续深度修复。
```

让对话式修复有充分上下文，避免用户重新解释一遍失败。

## 9 · 首批 Preset 清单

### Content-form（prompt，7 条）

| id | 名称 | URL pattern | prompt 摘要 |
|---|---|---|---|
| `wikipedia-summary` | 维基百科总结 | `https://*.wikipedia.org/**` | 三段总结 + 参见 |
| `github-repo-brief` | GitHub Repo 摘要 | `https://github.com/*/*` | 项目定位/用法/活跃度/关键 issue |
| `medium-article-tldr` | Medium 文章要点 | `https://medium.com/**`, `https://*.medium.com/**` | 5 条核心观点 + TL;DR |
| `zhihu-question-summary` | 知乎问题摘要 | `https://www.zhihu.com/question/**` | 高赞回答共同观点与分歧 |
| `wechat-mp-summary` | 公众号文章总结 | `https://mp.weixin.qq.com/s/**` | 要点 + 人物/数据/链接 |
| `article-translate-zh` | 长文翻译 | 通用（无 URL 限定，靠 `<article>/<main>` DOM 触发） | 翻译为中文,保留段落 |
| `github-issue-digest` | GitHub Issue 摘要 | `https://github.com/*/*/issues/**` | 讨论进展与共识 |

### Ecommerce-form（tool，4 条）

| id | 名称 | URL pattern | 主要产物 | 是否需登录 |
|---|---|---|---|---|
| `taobao-item-collect`  | 淘宝商品采集   | `https://item.taobao.com/**` | 主图 + 参数 + 前 30 评论 | 否 |
| `jd-item-collect`      | 京东商品采集   | `https://item.jd.com/**` | 主图 + 参数表 + 前 30 评论 | 否 |
| `1688-detail-collect`  | 1688 商品采集  | `https://detail.1688.com/**` | 主图 + 价格阶梯 + 供应商 | 否 |
| `amazon-product-collect` | Amazon 商品采集 | `https://www.amazon.com/*/dp/**` | 主图 + 参数 + 前 20 评论 | 否 |

每个 tool-form preset 附：

- 5-10 个 step 的稳定序列（`snapshotDOM` → 探查 `window.rawData`/详情接口 → `httpRequest`/`querySelectorAll` → 汇总）
- `tests/fixtures/presets/<id>-snapshot.json` 冻结的 DOM 快照
- `expectedResultShape` JsonSchema

**淘宝/京东/Amazon 反爬风险**：首版把 preset 稳定序列做到"能拿到什么算什么"（不做重试爆刷），失败走自愈；文档明示可能失败。若一个月内实测成功率 < 40% 从场景库里下架，改推同类友好站。

## 10 · 安全模型

### 10.1 首批不引入 dangerous

Tool-form preset 首批全部限定：

- **允许**：所有 safe 集合 + `httpRequest`(无 cookie) + `click`/`fillInput`/`setCheckbox`/`selectOption` + `runJS`(过静态扫描)
- **禁止**：`submitForm` / `uploadFile` / `readStorage` / `httpRequest`(withCredentials) / `runJS`(未过静态扫描)

### 10.2 自愈补丁的 gate

自愈生成的补丁走**同一层 static-scan**，且严格：**只允许 safe + caution**。补丁里若出现 dangerous → 拒绝，`reason: "static_scan_reject"`，回退到失败态。

理由：用户对话式手动修复是"用户主动放行"，自动生成是"LLM 自主决定"，信任等级不同。

### 10.3 API key 与隐私

- BG 不持 key，通过 sidepanel RPC 借 LLM
- Preset registry 静态打包，无 telemetry
- `Tool.origin.presetId` 只是本地 IDB 里的字符串，不上报任何地方

## 11 · 测试策略

### 11.1 `@aipagego/shared`

- `tests/preset-registry.test.ts`：所有 `PRESETS` 通过 `PresetSchema`(zod) 校验；id 唯一；URL pattern 编译成功；tool-form 的 `steps` 通过 `StepSchema.array()`。
- `tests/preset-match.test.ts`：`matchPresetsByUrl`——单命中/多命中/未命中/dedup。

### 11.2 `@aipagego/extension` 新增

- `tests/background/self-heal.test.ts`：
  - Mock `requestSidepanelLlm` 返回合法补丁 → `runTool` 完成 + appendVersion + `session_event: self_heal_completed`
  - Mock 返回 dangerous 补丁 → `reason: "static_scan_reject"`
  - Mock 抛错 → `reason: "llm_error"`
  - 超预算 → `reason: "budget_exceeded"`
  - 补丁跑了继续失败 → `reason: "step_still_fails"`
  - 已经自愈过一次再失败 → 直接失败（`healApplied=true`），不再尝试
- `tests/background/tab-watcher-presets.test.ts`：命中 preset + 用户 tool 合并去重
- `tests/sidepanel/pages/scenarios-page.test.tsx`：渲染分类 / 过滤 / materialize 一个 preset 走完全流
- `tests/sidepanel/chat/quick-actions-presets.test.tsx`：URL 命中的 prompt preset 覆盖默认 3 条
- `tests/background/bg-tool-runner-heal.test.ts`：端到端在 fake-indexeddb 上跑：加个 tool → 强制 step 抛错 → 走 heal → verify IDB 里 appendVersion

### 11.3 Fixture

- `tests/fixtures/presets/<id>-snapshot.json`：真实站点 DOM 冻结的一份快照。用来在 CI 里跑 preset steps 拿到 mock 输出，验证 `expectedResultShape` 断言。
- Fixture 会随网站漂移过期——这个成本本身就在推动"自愈是唯一可持续解"，接受。

### 11.4 不引入 Playwright

沿用现有约定；所有测试仍走 happy-dom + fake-indexeddb + mock LLM。

## 12 · 迁移 & 兼容

- 无 IDB schema 迁移
- `Tool.origin` 可选字段，读时 undefined 走"手工保存"分支
- 导出：跳过 `origin.kind==="preset" && versions.length===1` 的 tool
- 导入：现有导入不变；如果导入的 tool 带 `origin.presetId` 且该 preset 存在，静默保留 origin；不存在则清空 origin 字段
- Coordinator EXEC 路径：`allowHeal: false` 显式传（保守；首版不给远程带自愈能力）

## 13 · 度量 & 观测

在 sidepanel 会话事件流里可读到：

- `self_heal_started/completed/failed`（含 reason、newVersion）
- `RunRecord.healed`（含 fromVersion/toVersion/fixedStepIndex）
- 会话「Exchanges N [查看]」面板里能看到自愈的 LLM 请求/响应（复用 recording-client）

**不上报任何服务器**——所有度量本地可看即可。

## 14 · 分阶段落地

Plan 会拆成 5 个可独立发的 phase：

1. **Phase 1** — Preset 类型 + registry 骨架（无 preset 内容）+ zod schema + 单测。1 PR。
2. **Phase 2** — 首批 preset 内容（7 prompt + 5 tool）+ fixture + shared 侧单测。1 PR。
3. **Phase 3** — 曝光：tab-watcher 合并、quick-actions 覆盖、scenarios-page 页。1 PR，含 UI 单测。
4. **Phase 4** — Self-heal runtime：`self-heal.ts` + `bg-tool-runner` 集成 + sidepanel LLM RPC + 设置开关。1 PR，含 heal 单测。
5. **Phase 5** — 场景库页 polish + 「已升级 vN」角标 + 文档 site 补 preset 列表。1 PR。

每 phase 结束都可通过 ship-release 打 tag 发版；一定程度实现"实验中拿反馈"的节奏。

## 15 · 未来议题（写在这里免得混进 spec）

- Preset 远程 refresh（方案 B 保留）
- Preset 广场 / 用户提交
- Coordinator 路径的自愈
- 表单填写 / 招聘 sourcing 类
- i18n（英文 preset 版本）
- 反爬网站（淘宝/京东/Amazon）如果实测太差，改用"轻量抓要点"策略
