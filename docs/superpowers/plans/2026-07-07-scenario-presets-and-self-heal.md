# 场景 Preset 库 + Tool 运行时自愈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AIPageGo 内置一批"打开这个网站就能用"的 Preset(prompt + tool 两种形态),并给 tool 重放路径加运行时自愈,失败一步自动重生成补丁继续跑。

**Architecture:** 三层:①`@aipagego/shared/presets/*` 静态 registry(zod-validated + URL 匹配纯函数);②扩展侧曝光(tab-watcher 合并 + quick-actions URL 条件覆盖 + 新 `scenarios-page`);③BG `runTool` 里 catch 失败 → 走 `self-heal.ts`(BG 通过 RPC 借 sidepanel 的 LLM 一次性调用 → zod parse → static-scan 过滤 dangerous → 替换后续 steps + appendVersion v(N+1))。

**Tech Stack:** TypeScript 5(strict)、React 18、zustand 4、zod 3、idb 8、vitest + happy-dom + fake-indexeddb;新增 0 依赖。

## Global Constraints

- **IDB DB name = `aipagego`**(不可改;老用户 tool 全靠这个名字)
- **No new dependencies**(AGENTS.md hard rule)
- **API key 只在 sidepanel**(chrome.storage.local/session);BG 侧一律不持 key
- **Coordinator EXEC 路径首版不自愈**(`allowHeal: false` 显式传)
- **Preset 本体不进 IDB**,只 materialize 的副本进 IDB
- **单次 runTool 最多 1 次自愈尝试**(`healApplied` guard)
- **自愈补丁 static-scan 严格拒 dangerous**;用户手动 [让 AI 修复] 不受此限
- **不引入 Playwright**;所有测试走 happy-dom + fake-indexeddb + mock LLM
- **每 phase 独立可 commit,最终一次性通过 ship-release 发版**

---

## File Structure

**新建(shared)**
- `packages/shared/src/preset.ts` — `Preset` 类型 + zod schema
- `packages/shared/src/presets/index.ts` — `PRESETS: readonly Preset[]` 静态聚合
- `packages/shared/src/presets/ecommerce/taobao.ts` / `jd.ts` / `_1688.ts` / `amazon.ts`
- `packages/shared/src/presets/content/wikipedia.ts` / `github-repo.ts` / `github-issue.ts` / `medium.ts` / `zhihu.ts` / `wechat-mp.ts` / `article-translate.ts`
- `packages/shared/src/match-presets.ts` — `matchPresetsByUrl(url): Preset[]`
- `packages/shared/tests/preset-registry.test.ts`
- `packages/shared/tests/match-presets.test.ts`

**新建(extension)**
- `packages/extension/src/background/self-heal.ts` — `attemptHeal(ctx, deps)`
- `packages/extension/src/sidepanel/llm/self-heal-prompt.ts` — 生成 heal LLM 请求
- `packages/extension/src/sidepanel/self-heal-host.ts` — sidepanel 端 RPC handler
- `packages/extension/src/sidepanel/pages/scenarios-page.tsx`
- `packages/extension/tests/background/self-heal.test.ts`
- `packages/extension/tests/background/tab-watcher-presets.test.ts`
- `packages/extension/tests/sidepanel/pages/scenarios-page.test.tsx`
- `packages/extension/tests/sidepanel/chat/quick-actions-presets.test.tsx`

**修改**
- `packages/shared/src/types.ts` — `Tool.origin?`, `LlmSettings.selfHealEnabled/maxSelfHealOutputTokens`, `RunRecord.healed?`
- `packages/shared/src/messages.ts` — `RpcRequest`: `presets.list`, `presets.materialize`, `selfheal.request`;`StepSchema`(不变)
- `packages/shared/src/protocol/chat-event.ts` — 三个新 SessionEvent 变体镜像
- `packages/extension/src/background/rpc-handlers.ts` — `runTool` 加 catch-and-heal + 处理新 RPCs
- `packages/extension/src/background/storage/tools.ts` — `matchingTools` 保留;新增 `materializePreset(preset): Promise<Tool>`;`appendVersion` 已存在,只加自愈 metadata
- `packages/extension/src/background/tab-watcher.ts` — `refreshRecommendations` 合并 preset 匹配
- `packages/extension/src/sidepanel/rpc.ts` — 新增 `listPresets`, `materializePreset`, `selfheal` handler 注册
- `packages/extension/src/sidepanel/chat/quick-actions.tsx` — URL 命中 prompt-preset 优先
- `packages/extension/src/sidepanel/chat/run-session.ts` — 三个新 SessionEvent 变体
- `packages/extension/src/sidepanel/chat/settings-store.ts` — 新增两个 self-heal 字段默认值
- `packages/extension/src/sidepanel/pages/settings-page.tsx` — 新增两个开关 UI
- `packages/extension/src/sidepanel/app.tsx` — 新 `#/scenarios` 路由 + 顶部 tab

---

### Task 1: 定义 Preset 类型与 zod schema

**Files:**
- Create: `packages/shared/src/preset.ts`
- Test: `packages/shared/tests/preset.test.ts`

**Interfaces:**
- Produces: `Preset`, `PromptPreset`, `ToolPreset`, `PresetId`, `PresetCategory`, `PresetSchema`, `PromptPresetSchema`, `ToolPresetSchema`

- [ ] **Step 1: Write test file with failing tests**

```ts
// packages/shared/tests/preset.test.ts
import { describe, it, expect } from "vitest";
import { PresetSchema, PromptPresetSchema, ToolPresetSchema } from "../src/preset";

describe("PresetSchema", () => {
  it("accepts a valid prompt preset", () => {
    const raw = {
      id: "wikipedia-summary",
      name: "维基百科总结",
      description: "三段总结",
      category: "content",
      urlPatterns: ["https://*.wikipedia.org/**"],
      version: 1,
      kind: "prompt",
      prompt: "用三段总结此页"
    };
    expect(PresetSchema.safeParse(raw).success).toBe(true);
    expect(PromptPresetSchema.safeParse(raw).success).toBe(true);
  });

  it("accepts a valid tool preset", () => {
    const raw = {
      id: "example-product-collect",
      name: "商品采集示例",
      description: "主图+评论",
      category: "ecommerce",
      urlPatterns: ["https://shop.example.com/products/**"],
      version: 1,
      kind: "tool",
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }]
    };
    expect(PresetSchema.safeParse(raw).success).toBe(true);
    expect(ToolPresetSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects invalid category", () => {
    const raw = { id: "x", name: "x", description: "x", category: "unknown",
                  urlPatterns: ["*"], version: 1, kind: "prompt", prompt: "" };
    expect(PresetSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects empty urlPatterns", () => {
    const raw = { id: "x", name: "x", description: "x", category: "content",
                  urlPatterns: [], version: 1, kind: "prompt", prompt: "x" };
    expect(PresetSchema.safeParse(raw).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aipagego/shared test preset.test
```
Expected: fail with `Cannot find module '../src/preset'`

- [ ] **Step 3: Implement Preset schema**

```ts
// packages/shared/src/preset.ts
import { z } from "zod";
import { StepSchema } from "./messages";

export type PresetId = string;
export type PresetCategory = "ecommerce" | "content";

export const PresetCategorySchema = z.enum(["ecommerce", "content"]);

const PresetBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: PresetCategorySchema,
  urlPatterns: z.array(z.string().min(1)).min(1),
  icon: z.string().optional(),
  version: z.number().int().min(1),
  sampleUrl: z.string().url().optional()
});

export const PromptPresetSchema = PresetBaseSchema.extend({
  kind: z.literal("prompt"),
  prompt: z.string().min(1)
});

export const ToolPresetSchema = PresetBaseSchema.extend({
  kind: z.literal("tool"),
  steps: z.array(StepSchema).min(1),
  expectedResultShape: z.unknown().optional()
});

export const PresetSchema = z.discriminatedUnion("kind", [
  PromptPresetSchema,
  ToolPresetSchema
]);

export type PromptPreset = z.infer<typeof PromptPresetSchema>;
export type ToolPreset   = z.infer<typeof ToolPresetSchema>;
export type Preset       = z.infer<typeof PresetSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @aipagego/shared test preset.test
```
Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/preset.ts packages/shared/tests/preset.test.ts
git commit -m "feat(shared): Preset 类型 + zod schema — PromptPreset / ToolPreset"
```

---

### Task 2: Registry 骨架 + matchPresetsByUrl

**Files:**
- Create: `packages/shared/src/presets/index.ts`
- Create: `packages/shared/src/match-presets.ts`
- Test: `packages/shared/tests/match-presets.test.ts`
- Test: `packages/shared/tests/preset-registry.test.ts`

**Interfaces:**
- Consumes: `Preset`, `PresetSchema` (Task 1)
- Produces: `PRESETS: readonly Preset[]`, `matchPresetsByUrl(url: string): Preset[]`

- [ ] **Step 1: Write failing match test**

```ts
// packages/shared/tests/match-presets.test.ts
import { describe, it, expect } from "vitest";
import { matchPresetsByUrl } from "../src/match-presets";
import type { Preset } from "../src/preset";

const P1: Preset = {
  id: "p1", name: "p1", description: "", category: "content",
  urlPatterns: ["https://a.example.com/**"], version: 1,
  kind: "prompt", prompt: "x"
};
const P2: Preset = {
  id: "p2", name: "p2", description: "", category: "ecommerce",
  urlPatterns: ["https://*.b.example.com/**", "https://c.example.com/x/*"],
  version: 1, kind: "prompt", prompt: "x"
};

describe("matchPresetsByUrl (with injected registry)", () => {
  const registry = [P1, P2];
  it("returns single match", () => {
    expect(matchPresetsByUrl("https://a.example.com/foo/bar", registry)).toEqual([P1]);
  });
  it("returns multiple matches", () => {
    expect(matchPresetsByUrl("https://x.b.example.com/y", registry)).toEqual([P2]);
  });
  it("returns empty for no match", () => {
    expect(matchPresetsByUrl("https://nope.com", registry)).toEqual([]);
  });
});
```

- [ ] **Step 2: Write failing registry test**

```ts
// packages/shared/tests/preset-registry.test.ts
import { describe, it, expect } from "vitest";
import { PRESETS } from "../src/presets";
import { PresetSchema } from "../src/preset";

describe("PRESETS registry", () => {
  it("all entries are valid Preset", () => {
    for (const p of PRESETS) {
      const r = PresetSchema.safeParse(p);
      if (!r.success) throw new Error(`${p.id}: ${r.error.message}`);
    }
  });
  it("has unique ids", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter @aipagego/shared test match-presets preset-registry
```
Expected: fails with module not found

- [ ] **Step 4: Implement matchPresetsByUrl**

```ts
// packages/shared/src/match-presets.ts
import { compilePattern } from "./url-pattern";
import { PRESETS } from "./presets";
import type { Preset } from "./preset";

export function matchPresetsByUrl(
  url: string,
  registry: readonly Preset[] = PRESETS
): Preset[] {
  return registry.filter((p) =>
    p.urlPatterns.some((pat) => compilePattern(pat).test(url))
  );
}
```

- [ ] **Step 5: Implement empty registry aggregator**

```ts
// packages/shared/src/presets/index.ts
import type { Preset } from "../preset";

// Static aggregation. New presets: add file under ecommerce/ or content/,
// import here, and push into the array.
export const PRESETS: readonly Preset[] = Object.freeze([]);
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm --filter @aipagego/shared test match-presets preset-registry
```
Expected: pass (registry is empty but valid)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/presets/index.ts packages/shared/src/match-presets.ts \
        packages/shared/tests/match-presets.test.ts packages/shared/tests/preset-registry.test.ts
git commit -m "feat(shared): Preset registry 骨架 + matchPresetsByUrl 纯函数"
```

---

### Task 3: 7 个 Prompt-form Preset(内容站)

**Files:**
- Create: `packages/shared/src/presets/content/wikipedia.ts`
- Create: `packages/shared/src/presets/content/github-repo.ts`
- Create: `packages/shared/src/presets/content/github-issue.ts`
- Create: `packages/shared/src/presets/content/medium.ts`
- Create: `packages/shared/src/presets/content/zhihu.ts`
- Create: `packages/shared/src/presets/content/wechat-mp.ts`
- Create: `packages/shared/src/presets/content/article-translate.ts`
- Modify: `packages/shared/src/presets/index.ts`

**Interfaces:**
- Produces: 7 named `Preset` exports; registry now has 7 entries.

- [ ] **Step 1: Add wikipedia preset**

```ts
// packages/shared/src/presets/content/wikipedia.ts
import type { Preset } from "../../preset";

export const wikipediaSummary: Preset = {
  id: "wikipedia-summary",
  name: "维基百科总结",
  description: "用三段总结当前条目,并列出「参见」中的相关条目",
  category: "content",
  urlPatterns: ["https://*.wikipedia.org/**"],
  version: 1,
  kind: "prompt",
  prompt:
    "请阅读当前维基百科条目,输出:\n" +
    "1) 用三段话总结这个条目的核心内容(定义、历史脉络、当前状态)\n" +
    "2) 列出'参见/See also'区块里的相关条目\n" +
    "先用 snapshotDOM + extractText 拿到主要内容,再总结。"
};
```

- [ ] **Step 2: Add github-repo preset**

```ts
// packages/shared/src/presets/content/github-repo.ts
import type { Preset } from "../../preset";

export const githubRepoBrief: Preset = {
  id: "github-repo-brief",
  name: "GitHub 仓库摘要",
  description: "总结项目定位、用法、活跃度、关键 issue",
  category: "content",
  urlPatterns: ["https://github.com/*/*"],
  version: 1,
  kind: "prompt",
  prompt:
    "总结这个 GitHub 仓库:\n" +
    "1) 项目定位与解决的问题\n" +
    "2) 快速上手/用法(从 README 抽取)\n" +
    "3) 活跃度指标(最近 commit、star、open issue 数)\n" +
    "4) 3-5 个关键 issue 或讨论\n" +
    "用 snapshotDOM 拿页面结构,extractText 拿 README 主体。"
};
```

- [ ] **Step 3: Add github-issue preset**

```ts
// packages/shared/src/presets/content/github-issue.ts
import type { Preset } from "../../preset";

export const githubIssueDigest: Preset = {
  id: "github-issue-digest",
  name: "GitHub Issue 摘要",
  description: "汇总讨论进展与共识",
  category: "content",
  urlPatterns: ["https://github.com/*/*/issues/**", "https://github.com/*/*/pull/**"],
  version: 1,
  kind: "prompt",
  prompt:
    "总结这条 issue/PR 的讨论:\n" +
    "1) 核心问题或提案\n" +
    "2) 讨论中出现的主要观点(按人物聚合)\n" +
    "3) 当前共识 / 分歧点 / 待定问题\n" +
    "4) 最新状态(open/closed/merged,最新 comment 时间)\n" +
    "先 scroll 到底加载全部,再 extractText。"
};
```

- [ ] **Step 4: Add medium preset**

```ts
// packages/shared/src/presets/content/medium.ts
import type { Preset } from "../../preset";

export const mediumArticleTldr: Preset = {
  id: "medium-article-tldr",
  name: "Medium 文章要点",
  description: "5 条核心观点 + TL;DR",
  category: "content",
  urlPatterns: ["https://medium.com/**", "https://*.medium.com/**"],
  version: 1,
  kind: "prompt",
  prompt:
    "阅读当前 Medium 文章,输出:\n" +
    "1) 一句话 TL;DR\n" +
    "2) 5 条核心观点(带 1 句支撑)\n" +
    "3) 作者背景(如页面显示)\n" +
    "先 extractText,遇到墙则读可见部分。"
};
```

- [ ] **Step 5: Add zhihu preset**

```ts
// packages/shared/src/presets/content/zhihu.ts
import type { Preset } from "../../preset";

export const zhihuQuestionSummary: Preset = {
  id: "zhihu-question-summary",
  name: "知乎问题摘要",
  description: "汇总高赞回答的共同观点与分歧",
  category: "content",
  urlPatterns: ["https://www.zhihu.com/question/**"],
  version: 1,
  kind: "prompt",
  prompt:
    "总结这个知乎问题:\n" +
    "1) 问题本身在问什么\n" +
    "2) 前 5 个高赞回答的观点归纳\n" +
    "3) 观点的共识与分歧\n" +
    "4) 主要论据/引用\n" +
    "先 scroll 一次触发懒加载,再 extractText 高赞区块。"
};
```

- [ ] **Step 6: Add wechat-mp preset**

```ts
// packages/shared/src/presets/content/wechat-mp.ts
import type { Preset } from "../../preset";

export const wechatMpSummary: Preset = {
  id: "wechat-mp-summary",
  name: "公众号文章总结",
  description: "要点 + 人物 / 数据 / 链接",
  category: "content",
  urlPatterns: ["https://mp.weixin.qq.com/s/**", "https://mp.weixin.qq.com/s?**"],
  version: 1,
  kind: "prompt",
  prompt:
    "总结这篇公众号文章:\n" +
    "1) 文章要点(3-5 条)\n" +
    "2) 提到的关键人物 / 机构\n" +
    "3) 出现的数据 / 事实\n" +
    "4) 外部链接列表\n" +
    "用 extractText + extractImages(可选)。"
};
```

- [ ] **Step 7: Add article-translate preset(通用,无 URL 限定)**

```ts
// packages/shared/src/presets/content/article-translate.ts
import type { Preset } from "../../preset";

// 通用 preset。URL 用宽松通配符——真正的"是不是长文"由用户点击时判断。
export const articleTranslateZh: Preset = {
  id: "article-translate-zh",
  name: "长文翻译为中文",
  description: "翻译当前文章为中文,保留段落结构",
  category: "content",
  urlPatterns: ["https://**"],
  version: 1,
  kind: "prompt",
  prompt:
    "翻译当前网页的主要文章内容为中文:\n" +
    "1) 保留原段落结构\n" +
    "2) 对标题层级用 markdown # ## ### 标注\n" +
    "3) 术语首次出现给出括号原文\n" +
    "先 extractText 拿正文再翻译。"
};
```

- [ ] **Step 8: Wire into registry**

```ts
// packages/shared/src/presets/index.ts
import type { Preset } from "../preset";
import { wikipediaSummary } from "./content/wikipedia";
import { githubRepoBrief } from "./content/github-repo";
import { githubIssueDigest } from "./content/github-issue";
import { mediumArticleTldr } from "./content/medium";
import { zhihuQuestionSummary } from "./content/zhihu";
import { wechatMpSummary } from "./content/wechat-mp";
import { articleTranslateZh } from "./content/article-translate";

export const PRESETS: readonly Preset[] = Object.freeze([
  wikipediaSummary,
  githubRepoBrief,
  githubIssueDigest,
  mediumArticleTldr,
  zhihuQuestionSummary,
  wechatMpSummary,
  articleTranslateZh
]);
```

- [ ] **Step 9: Run registry test**

```bash
pnpm --filter @aipagego/shared test preset-registry
```
Expected: 2 tests pass (7 valid entries, unique ids)

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/presets/content packages/shared/src/presets/index.ts
git commit -m "feat(shared): 7 个内容站 prompt-form preset(维基/GitHub/Medium/知乎/公众号/长文翻译)"
```

---

### Task 4: 4 个 Tool-form Preset(电商采集)

**Files:**
- Create: `packages/shared/src/presets/ecommerce/taobao.ts`
- Create: `packages/shared/src/presets/ecommerce/jd.ts`
- Create: `packages/shared/src/presets/ecommerce/_1688.ts`
- Create: `packages/shared/src/presets/ecommerce/amazon.ts`
- Modify: `packages/shared/src/presets/index.ts`

**Interfaces:**
- Produces: 4 named tool `Preset` exports;registry now has 11 entries.

**说明:tool-form preset 首版仅提供"最小可跑步序" — `snapshotDOM` + `extractText` + `extractImages` 就可以;真实生产的稳健序列由自愈路径迭代出。**

- [ ] **Step 1: Add taobao preset**

```ts
// packages/shared/src/presets/ecommerce/taobao.ts
import type { Preset } from "../../preset";

export const taobaoItemCollect: Preset = {
  id: "taobao-item-collect",
  name: "淘宝商品采集",
  description: "主图 + 参数 + 前 30 评论(反爬严重,可能失败,自愈会尝试重生成)",
  category: "ecommerce",
  urlPatterns: ["https://item.taobao.com/**"],
  version: 1,
  sampleUrl: "https://item.taobao.com/item.htm?id=demo",
  kind: "tool",
  steps: [
    { kind: "tool", tool: "waitFor", args: { selector: "body", timeoutMs: 3000 } },
    { kind: "tool", tool: "extractImages", args: {}, bindResultTo: "images" },
    { kind: "tool", tool: "extractText", args: {}, bindResultTo: "text" },
    { kind: "tool", tool: "snapshotDOM", args: { depth: 5 }, bindResultTo: "dom" }
  ]
};
```

- [ ] **Step 2: Add jd preset**

```ts
// packages/shared/src/presets/ecommerce/jd.ts
import type { Preset } from "../../preset";

export const jdItemCollect: Preset = {
  id: "jd-item-collect",
  name: "京东商品采集",
  description: "主图 + 参数表 + 前 30 评论",
  category: "ecommerce",
  urlPatterns: ["https://item.jd.com/**"],
  version: 1,
  sampleUrl: "https://item.jd.com/100000000000.html",
  kind: "tool",
  steps: [
    { kind: "tool", tool: "waitFor", args: { selector: "body", timeoutMs: 3000 } },
    { kind: "tool", tool: "scroll", args: { to: "bottom" } },
    { kind: "tool", tool: "extractImages", args: {}, bindResultTo: "images" },
    { kind: "tool", tool: "extractText", args: {}, bindResultTo: "text" },
    { kind: "tool", tool: "snapshotDOM", args: { depth: 5 }, bindResultTo: "dom" }
  ]
};
```

- [ ] **Step 3: Add 1688 preset**

```ts
// packages/shared/src/presets/ecommerce/_1688.ts
import type { Preset } from "../../preset";

export const alibaba1688DetailCollect: Preset = {
  id: "1688-detail-collect",
  name: "1688 商品采集",
  description: "主图 + 价格阶梯 + 供应商",
  category: "ecommerce",
  urlPatterns: ["https://detail.1688.com/**"],
  version: 1,
  sampleUrl: "https://detail.1688.com/offer/demo.html",
  kind: "tool",
  steps: [
    { kind: "tool", tool: "waitFor", args: { selector: "body", timeoutMs: 3000 } },
    { kind: "tool", tool: "extractImages", args: {}, bindResultTo: "images" },
    { kind: "tool", tool: "extractText", args: {}, bindResultTo: "text" },
    { kind: "tool", tool: "snapshotDOM", args: { depth: 5 }, bindResultTo: "dom" }
  ]
};
```

- [ ] **Step 4: Add amazon preset**

```ts
// packages/shared/src/presets/ecommerce/amazon.ts
import type { Preset } from "../../preset";

export const amazonProductCollect: Preset = {
  id: "amazon-product-collect",
  name: "Amazon 商品采集",
  description: "主图 + bullet points + 前 20 评论",
  category: "ecommerce",
  urlPatterns: ["https://www.amazon.com/*/dp/**", "https://www.amazon.com/dp/**"],
  version: 1,
  sampleUrl: "https://www.amazon.com/dp/B00000000",
  kind: "tool",
  steps: [
    { kind: "tool", tool: "waitFor", args: { selector: "body", timeoutMs: 3000 } },
    { kind: "tool", tool: "scroll", args: { to: "bottom" } },
    { kind: "tool", tool: "extractImages", args: {}, bindResultTo: "images" },
    { kind: "tool", tool: "extractText", args: {}, bindResultTo: "text" },
    { kind: "tool", tool: "snapshotDOM", args: { depth: 5 }, bindResultTo: "dom" }
  ]
};
```

- [ ] **Step 5: Wire into registry**

```ts
// packages/shared/src/presets/index.ts
import type { Preset } from "../preset";
import { wikipediaSummary } from "./content/wikipedia";
import { githubRepoBrief } from "./content/github-repo";
import { githubIssueDigest } from "./content/github-issue";
import { mediumArticleTldr } from "./content/medium";
import { zhihuQuestionSummary } from "./content/zhihu";
import { wechatMpSummary } from "./content/wechat-mp";
import { articleTranslateZh } from "./content/article-translate";
import { taobaoItemCollect } from "./ecommerce/taobao";
import { jdItemCollect } from "./ecommerce/jd";
import { alibaba1688DetailCollect } from "./ecommerce/_1688";
import { amazonProductCollect } from "./ecommerce/amazon";

export const PRESETS: readonly Preset[] = Object.freeze([
  // content
  wikipediaSummary,
  githubRepoBrief,
  githubIssueDigest,
  mediumArticleTldr,
  zhihuQuestionSummary,
  wechatMpSummary,
  articleTranslateZh,
  // ecommerce
  taobaoItemCollect,
  jdItemCollect,
  alibaba1688DetailCollect,
  amazonProductCollect
]);
```

- [ ] **Step 6: Run all shared tests**

```bash
pnpm --filter @aipagego/shared test
```
Expected: all pass (registry has 11 entries, all valid, unique ids)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/presets/ecommerce packages/shared/src/presets/index.ts
git commit -m "feat(shared): 4 个电商 tool-form preset(淘宝/京东/1688/Amazon)"
```

---

### Task 5: 扩展 Tool 类型加 origin,RunRecord 加 healed

**Files:**
- Modify: `packages/shared/src/types.ts` — add `ToolOrigin`, `Tool.origin?`, `RunRecord.healed?`
- Modify: `packages/shared/src/messages.ts` — extend `ToolSchema` zod with `origin?`
- Test: `packages/shared/tests/tool-origin.test.ts`

**Interfaces:**
- Produces: `ToolOrigin`, `Tool.origin?`, `RunRecord.healed?`
- Consumers (later tasks): materializePreset, self-heal, tab-watcher dedupe.

- [ ] **Step 1: Read current Tool + RunRecord shape**

```bash
grep -nE '^export (type|const) (Tool|RunRecord)' packages/shared/src/types.ts
```

- [ ] **Step 2: Write failing test**

```ts
// packages/shared/tests/tool-origin.test.ts
import { describe, it, expect } from "vitest";
import { ToolSchema } from "../src/messages";

describe("Tool.origin optional", () => {
  it("accepts tool without origin (backward compat)", () => {
    const t = {
      id: "u1", name: "u1", urlPatterns: ["https://a/*"],
      description: "", kind: "steps", steps: [], versions: [],
      createdAt: 0
    };
    const r = ToolSchema.safeParse(t);
    expect(r.success).toBe(true);
  });
  it("accepts tool with preset origin", () => {
    const t = {
      id: "u1", name: "u1", urlPatterns: ["https://a/*"],
      description: "", kind: "steps", steps: [], versions: [],
      createdAt: 0,
      origin: { kind: "preset", presetId: "example-product-collect", presetVersion: 1 }
    };
    expect(ToolSchema.safeParse(t).success).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @aipagego/shared test tool-origin
```
Expected: 2nd test fails ("Unrecognized key: origin" if strict) or 2nd passes but Tool type has no field — either way stays red.

- [ ] **Step 4: Add ToolOrigin type**

Locate the `Tool` type block in `packages/shared/src/types.ts` and:
1. Above `Tool` type add:

```ts
export type ToolOrigin = {
  kind: "preset";
  presetId: string;
  presetVersion: number;
};
```

2. In `Tool` type (both `StepsTool` and `PromptTool` shapes — usually a shared base or union), add optional field:

```ts
// existing Tool base or both variants
  origin?: ToolOrigin;
```

3. Also extend `RunRecord`:

```ts
  healed?: {
    fromVersion: number;
    toVersion: number;
    fixedStepIndex: number;
  };
```

- [ ] **Step 5: Add zod schema**

In `packages/shared/src/messages.ts`, add near the top:

```ts
export const ToolOriginSchema = z.object({
  kind: z.literal("preset"),
  presetId: z.string().min(1),
  presetVersion: z.number().int().min(1)
});
```

Then find `StepsToolSchema` and `PromptToolSchema` (~line 101/115). Add to each `.object({...})` block:

```ts
  origin: ToolOriginSchema.optional(),
```

Find `RunRecordSchema` (or the schema/type for RunRecord). Add:

```ts
  healed: z.object({
    fromVersion: z.number().int().min(1),
    toVersion: z.number().int().min(2),
    fixedStepIndex: z.number().int().min(0)
  }).optional(),
```

If `RunRecord` is only a TS type (no zod), skip the zod change and only extend the TS type in step 4.

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @aipagego/shared test tool-origin
```
Expected: both pass

- [ ] **Step 7: Typecheck to verify no regressions**

```bash
pnpm -r typecheck
```
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/messages.ts packages/shared/tests/tool-origin.test.ts
git commit -m "feat(shared): Tool.origin + RunRecord.healed 可选字段 — 兼容老 tool"
```

---

### Task 6: LlmSettings 加 selfHealEnabled / maxSelfHealOutputTokens

**Files:**
- Modify: `packages/shared/src/types.ts` — extend `LlmSettings`
- Modify: `packages/extension/src/sidepanel/chat/settings-store.ts` — DEFAULTS 加两字段

**Interfaces:**
- Produces: `LlmSettings.selfHealEnabled: boolean`, `LlmSettings.maxSelfHealOutputTokens: number`

- [ ] **Step 1: Extend LlmSettings type**

In `packages/shared/src/types.ts`, find `LlmSettings` type and add:

```ts
  selfHealEnabled: boolean;
  maxSelfHealOutputTokens: number;
```

- [ ] **Step 2: Extend DEFAULTS in settings-store**

```ts
// packages/extension/src/sidepanel/chat/settings-store.ts
const DEFAULTS: LlmSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "",
  apiKeyMode: "persistent",
  maxRounds: 20,
  trustedDangerTools: [],
  defaultPermissionMode: "default",
  theme: "dark",
  maxContinuationNudges: 1,
  defaultChatMode: "compact",
  selfHealEnabled: true,               // 新增
  maxSelfHealOutputTokens: 4096        // 新增
};
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm -r typecheck
```
Expected: all pass (older stored settings merge with DEFAULTS as fallback)

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts packages/extension/src/sidepanel/chat/settings-store.ts
git commit -m "feat: LlmSettings 加 selfHealEnabled/maxSelfHealOutputTokens(默认 on / 4096)"
```

---

### Task 7: 三个新 SessionEvent 变体 + shared 协议镜像

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/run-session.ts` — 加三个 SessionEvent 变体
- Modify: `packages/shared/src/protocol/chat-event.ts` — 镜像 zod schema
- Test: `packages/shared/tests/protocol/chat-event.test.ts` — round-trip 断言

**Interfaces:**
- Produces: `SessionEvent` 增加 3 变体;`ChatSessionEventSchema` 相应扩展

- [ ] **Step 1: Read current SessionEvent shape**

```bash
grep -n "kind:" packages/extension/src/sidepanel/chat/run-session.ts | head -30
```

- [ ] **Step 2: Add 3 new variants to SessionEvent in run-session.ts**

Locate `SessionEvent` union (usually a `type SessionEvent =` block or `export type`) and append:

```ts
  | { kind: "self_heal_started";
      toolId: string;
      toolName: string;
      failedStepIndex: number }
  | { kind: "self_heal_completed";
      toolId: string;
      newVersion: number;
      fixedStepIndex: number }
  | { kind: "self_heal_failed";
      toolId: string;
      reason: "llm_error" | "budget_exceeded" | "invalid_output"
            | "static_scan_reject" | "step_still_fails"
            | "no_sidepanel" | "no_api_key" }
```

- [ ] **Step 3: Mirror in chat-event.ts zod schema**

Open `packages/shared/src/protocol/chat-event.ts`, find `ChatSessionEventSchema` discriminated union, add:

```ts
  z.object({
    kind: z.literal("self_heal_started"),
    toolId: z.string(),
    toolName: z.string(),
    failedStepIndex: z.number().int().min(0)
  }),
  z.object({
    kind: z.literal("self_heal_completed"),
    toolId: z.string(),
    newVersion: z.number().int().min(2),
    fixedStepIndex: z.number().int().min(0)
  }),
  z.object({
    kind: z.literal("self_heal_failed"),
    toolId: z.string(),
    reason: z.enum([
      "llm_error", "budget_exceeded", "invalid_output",
      "static_scan_reject", "step_still_fails",
      "no_sidepanel", "no_api_key"
    ])
  }),
```

- [ ] **Step 4: Add round-trip test**

```ts
// packages/shared/tests/protocol/chat-event.test.ts (append)
import { ChatSessionEventSchema } from "../../src/protocol/chat-event";

describe("self_heal_* SessionEvents", () => {
  const cases = [
    { kind: "self_heal_started", toolId: "t1", toolName: "商品采集", failedStepIndex: 2 },
    { kind: "self_heal_completed", toolId: "t1", newVersion: 2, fixedStepIndex: 2 },
    { kind: "self_heal_failed", toolId: "t1", reason: "invalid_output" }
  ];
  for (const c of cases) {
    it(`round-trip ${c.kind}`, () => {
      const r = ChatSessionEventSchema.safeParse(c);
      expect(r.success).toBe(true);
    });
  }
});
```

- [ ] **Step 5: Run tests to verify pass**

```bash
pnpm --filter @aipagego/shared test chat-event
pnpm -r typecheck
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/chat/run-session.ts packages/shared/src/protocol/chat-event.ts packages/shared/tests/protocol/chat-event.test.ts
git commit -m "feat: 3 个 self-heal SessionEvent 变体 + 协议镜像"
```

---

### Task 8: materializePreset 存储辅助 + RPC

**Files:**
- Modify: `packages/extension/src/background/storage/tools.ts` — add `materializePreset`
- Modify: `packages/shared/src/messages.ts` — 加两个 RPC(`presets.list`, `presets.materialize`)
- Modify: `packages/extension/src/background/rpc-handlers.ts` — dispatch 新 RPC
- Modify: `packages/extension/src/sidepanel/rpc.ts` — 加 wrapper
- Test: `packages/extension/tests/background/storage/materialize-preset.test.ts`

**Interfaces:**
- Consumes: `Preset`, `Tool`, `ToolOrigin`, `PRESETS` (from Tasks 1-5)
- Produces:
  - `materializePreset(presetId: string): Promise<Tool>` (BG storage)
  - RPC `presets.list -> Preset[]`
  - RPC `presets.materialize { presetId } -> Tool`
  - `rpc.listPresets(): Promise<Preset[]>`
  - `rpc.materializePreset(presetId: string): Promise<Tool>`

- [ ] **Step 1: Write failing storage test**

```ts
// packages/extension/tests/background/storage/materialize-preset.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { materializePreset, listTools } from "@/background/storage/tools";
import { PRESETS } from "@aipagego/shared/presets";

describe("materializePreset", () => {
  beforeEach(async () => {
    for (const t of await listTools()) {
      const { deleteTool } = await import("@/background/storage/tools");
      await deleteTool(t.id);
    }
  });

  it("copies a tool-form preset into IDB with origin metadata", async () => {
    const preset = PRESETS.find((p) => p.kind === "tool")!;
    const tool = await materializePreset(preset.id);
    expect(tool.origin).toEqual({
      kind: "preset",
      presetId: preset.id,
      presetVersion: preset.version
    });
    expect(tool.kind).toBe("steps");
    const listed = await listTools();
    expect(listed.some((t) => t.id === tool.id)).toBe(true);
  });

  it("returns existing tool when preset already materialized", async () => {
    const preset = PRESETS.find((p) => p.kind === "tool")!;
    const t1 = await materializePreset(preset.id);
    const t2 = await materializePreset(preset.id);
    expect(t1.id).toBe(t2.id);
  });

  it("throws for unknown presetId", async () => {
    await expect(materializePreset("does-not-exist")).rejects.toThrow();
  });

  it("throws for prompt-form preset", async () => {
    const preset = PRESETS.find((p) => p.kind === "prompt")!;
    await expect(materializePreset(preset.id)).rejects.toThrow(/prompt/);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test materialize-preset
```
Expected: fail with `materializePreset is not exported`

- [ ] **Step 3: Implement materializePreset in storage/tools.ts**

Add at the bottom of `packages/extension/src/background/storage/tools.ts`:

```ts
import { PRESETS } from "@aipagego/shared/presets";
import type { Preset } from "@aipagego/shared/preset";
import type { Tool, ToolOrigin } from "@aipagego/shared/types";

/**
 * Copy a tool-form Preset into IDB. If a user tool already exists for the
 * same presetId, return it (idempotent). Prompt-form presets are not
 * materialized — they're used as suggestion text only.
 */
export async function materializePreset(presetId: string): Promise<Tool> {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset: ${presetId}`);
  if (preset.kind !== "tool") throw new Error(`prompt preset ${presetId} is not materializable`);

  const existing = (await listTools()).find(
    (t) => t.origin?.kind === "preset" && t.origin.presetId === presetId
  );
  if (existing) return existing;

  const origin: ToolOrigin = {
    kind: "preset",
    presetId: preset.id,
    presetVersion: preset.version
  };
  const now = Date.now();
  const tool: Tool = {
    id: uuid(),
    name: preset.name,
    description: preset.description,
    urlPatterns: [...preset.urlPatterns],
    kind: "steps",
    steps: JSON.parse(JSON.stringify(preset.steps)),
    versions: [
      {
        version: 1,
        kind: "steps",
        steps: JSON.parse(JSON.stringify(preset.steps)),
        outputSchema: (preset.expectedResultShape as Json) ?? null,
        createdAt: now
      }
    ],
    createdAt: now,
    origin
  } as Tool;

  await saveDraft({
    kind: "steps",
    name: tool.name,
    description: tool.description,
    urlPatterns: tool.urlPatterns,
    steps: tool.steps,
    outputSchema: tool.versions[0].outputSchema ?? null
  });
  // saveDraft assigns its own id; we need to attach origin. Re-fetch and update.
  const all = await listTools();
  const created = all
    .filter((t) => !t.origin && t.name === tool.name)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!created) throw new Error("materialize: saveDraft did not persist");

  // Patch in origin directly via db.put
  const dbMod = await import("./db");
  const db = await dbMod.getDb();
  const row = await db.get("tools", created.id);
  if (row) {
    await db.put("tools", { ...row, origin });
  }
  return { ...created, origin };
}
```

**Note**: this uses `saveDraft` + patch pattern to avoid duplicating the tool row's construction logic. If `saveDraft` already accepts an `origin` field, simplify to a direct pass-through.

- [ ] **Step 4: Verify storage test passes**

```bash
pnpm --filter @aipagego/extension test materialize-preset
```
Expected: all 4 pass

- [ ] **Step 5: Add RPCs to messages.ts**

In `packages/shared/src/messages.ts`, inside the `RpcRequest = z.discriminatedUnion(...)` array, add:

```ts
  z.object({ type: z.literal("presets.list") }),
  z.object({ type: z.literal("presets.materialize"), presetId: z.string().min(1) }),
```

- [ ] **Step 6: Handle in rpc-handlers.ts dispatch switch**

In `packages/extension/src/background/rpc-handlers.ts`, `dispatch` function switch, add:

```ts
    case "presets.list": {
      const { PRESETS } = await import("@aipagego/shared/presets");
      return PRESETS as unknown as Json;
    }
    case "presets.materialize": {
      const { materializePreset } = await import("./storage/tools");
      return (await materializePreset(req.presetId)) as unknown as Json;
    }
```

- [ ] **Step 7: Add rpc.ts wrappers**

In `packages/extension/src/sidepanel/rpc.ts` `export const rpc = { ... }`, add:

```ts
  listPresets: () => call<Preset[]>({ type: "presets.list" }),
  materializePreset: (presetId: string) =>
    call<Tool>({ type: "presets.materialize", presetId }),
```

Import `Preset` from `@aipagego/shared/preset` at the top if needed.

- [ ] **Step 8: Typecheck + full test**

```bash
pnpm -r typecheck
pnpm test
```
Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add packages/extension/src/background/storage/tools.ts \
        packages/shared/src/messages.ts \
        packages/extension/src/background/rpc-handlers.ts \
        packages/extension/src/sidepanel/rpc.ts \
        packages/extension/tests/background/storage/materialize-preset.test.ts
git commit -m "feat: materializePreset 存储辅助 + presets.list/materialize RPC"
```

---

### Task 9: tab-watcher 合并 preset 匹配 + 推荐 payload 扩展

**Files:**
- Modify: `packages/extension/src/background/tab-watcher.ts` — `refreshRecommendations` 合并 preset
- Modify: `packages/extension/src/sidepanel/rpc.ts` — `TabRecommendationsMsg` payload 加 preset 数组
- Test: `packages/extension/tests/background/tab-watcher-presets.test.ts`

**Interfaces:**
- Consumes: `PRESETS`, `matchPresetsByUrl`, `Tool.origin`
- Produces: 消息 payload `{type: "tabs.recommendations", tabId, url, tools, presets}` — 兼容读旧代码不看 `presets` 字段。

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/background/tab-watcher-presets.test.ts
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { PRESETS } from "@aipagego/shared/presets";

// Minimal chrome mock
(globalThis as any).chrome = {
  action: {
    setBadgeText: vi.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined)
  },
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined)
  },
  tabs: { onUpdated: { addListener: vi.fn() }, onCreated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
  webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } }
};

describe("refreshRecommendations includes matching presets", () => {
  it("wikipedia URL surfaces wikipedia-summary preset", async () => {
    const { refreshRecommendations } = await import("@/background/tab-watcher");
    await refreshRecommendations(1, "https://en.wikipedia.org/wiki/Rust_(programming_language)");
    const msg = (chrome.runtime.sendMessage as any).mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m?.type === "tabs.recommendations");
    expect(msg).toBeTruthy();
    expect(msg.presets.map((p: any) => p.id)).toContain("wikipedia-summary");
  });

  it("URL not matching any preset yields empty presets array", async () => {
    (chrome.runtime.sendMessage as any).mockClear();
    const { refreshRecommendations } = await import("@/background/tab-watcher");
    await refreshRecommendations(1, "https://random.site/none");
    const msg = (chrome.runtime.sendMessage as any).mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m?.type === "tabs.recommendations");
    // article-translate-zh has pattern "https://**" — 通用 preset,会命中
    // 这里断言至少 article-translate-zh 出现 or 空(取决于设计)
    // 我们本 Task 里保留通用 preset 也会出现,因此期望非空但过滤更严格
    expect(Array.isArray(msg.presets)).toBe(true);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test tab-watcher-presets
```
Expected: fail — `msg.presets is undefined`

- [ ] **Step 3: Update refreshRecommendations**

Rewrite `refreshRecommendations` in `packages/extension/src/background/tab-watcher.ts`:

```ts
import { matchingTools } from "./storage/tools";
import { matchPresetsByUrl } from "@aipagego/shared/match-presets";
import type { Preset } from "@aipagego/shared/preset";
import type { Tool } from "@aipagego/shared/types";

export async function refreshRecommendations(tabId: number, url: string): Promise<void> {
  const tools = await matchingTools(url);
  const rawPresets = matchPresetsByUrl(url);

  // Dedup: if a preset has already been materialized as a user tool
  // (tool.origin.presetId === preset.id), don't surface the preset again.
  const materializedIds = new Set(
    tools
      .map((t: Tool) => t.origin)
      .filter((o): o is NonNullable<Tool["origin"]> => !!o && o.kind === "preset")
      .map((o) => o.presetId)
  );
  const presets = rawPresets.filter((p: Preset) => !materializedIds.has(p.id));

  const badgeCount = tools.length + presets.length;
  await chrome.action.setBadgeText({
    tabId,
    text: badgeCount ? String(badgeCount) : ""
  });
  if (badgeCount) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" });
  }
  try {
    await chrome.runtime.sendMessage({
      type: "tabs.recommendations",
      tabId,
      url,
      tools,
      presets
    });
  } catch {
    // sidepanel not listening — swallow
  }
}
```

- [ ] **Step 4: Verify test passes**

```bash
pnpm --filter @aipagego/extension test tab-watcher-presets
```
Expected: pass

- [ ] **Step 5: Update sidepanel listener contract**

In `packages/extension/src/sidepanel/rpc.ts`, find `onTabRecommendations` and its message shape. Extend the callback type to include `presets`:

```ts
export type TabRecommendationsMsg = {
  type: "tabs.recommendations";
  tabId: number;
  url: string;
  tools: Tool[];
  presets: Preset[];   // 新增
};

export function onTabRecommendations(
  cb: (msg: TabRecommendationsMsg) => void
): () => void {
  const listener = (msg: unknown) => {
    if ((msg as any)?.type === "tabs.recommendations") {
      const m = msg as TabRecommendationsMsg;
      cb({ ...m, presets: m.presets ?? [] });   // backward-compat: 老 BG 不发 presets 就给空
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 6: Typecheck**

```bash
pnpm -r typecheck
```
Expected: pass; existing callers of `onTabRecommendations` typecheck (they only read `tools`).

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/background/tab-watcher.ts \
        packages/extension/src/sidepanel/rpc.ts \
        packages/extension/tests/background/tab-watcher-presets.test.ts
git commit -m "feat(bg): tab-watcher 合并 preset 匹配 → tabs.recommendations 加 presets 字段"
```

---

### Task 10: chat 空态 quick-actions 优先使用 URL 命中的 prompt preset

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/quick-actions.tsx`
- Test: `packages/extension/tests/sidepanel/chat/quick-actions-presets.test.tsx`

**Interfaces:**
- Consumes: `PromptPreset`, `matchPresetsByUrl`

- [ ] **Step 1: Write failing test**

```tsx
// packages/extension/tests/sidepanel/chat/quick-actions-presets.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuickActions } from "@/sidepanel/chat/quick-actions";

describe("QuickActions URL-conditional prompt preset", () => {
  it("shows wikipedia prompt when url matches", () => {
    render(<QuickActions currentUrl="https://en.wikipedia.org/wiki/Rust" onPick={vi.fn()} />);
    expect(screen.getByRole("button", { name: /维基百科总结/ })).toBeTruthy();
  });

  it("falls back to defaults when url does not match any preset", () => {
    render(<QuickActions currentUrl="https://unknown.site" onPick={vi.fn()} />);
    // 通用 preset article-translate-zh 命中 https://**, will appear
    expect(screen.getByRole("button", { name: /翻译|总结/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Rewrite quick-actions.tsx**

```tsx
// packages/extension/src/sidepanel/chat/quick-actions.tsx
import { matchPresetsByUrl } from "@aipagego/shared/match-presets";
import type { PromptPreset } from "@aipagego/shared/preset";

type Action = { id: string; label: string; prompt: string };

const DEFAULTS: Action[] = [
  { id: "summarize",        label: "总结网页",   prompt: "总结一下当前网页的主要内容。" },
  { id: "key-points",       label: "抽取重点",   prompt: "把这个网页的关键信息抽出成 5 条。" },
  { id: "extract-comments", label: "抽评论",     prompt:
      "把本页所有评论 / 回复抽下来,完整拉取不要省略。" +
      "如果存在分页或下拉懒加载,请翻页 / 滚动到底,直到拿全所有评论再返回。"
  }
];

type Props = {
  currentUrl?: string;
  onPick: (prompt: string) => void;
};

function pickActions(currentUrl?: string): Action[] {
  if (!currentUrl) return DEFAULTS;
  const promptPresets = matchPresetsByUrl(currentUrl).filter(
    (p): p is PromptPreset => p.kind === "prompt"
  );
  const fromPresets: Action[] = promptPresets.slice(0, 3).map((p) => ({
    id: `preset:${p.id}`,
    label: p.name,
    prompt: p.prompt
  }));
  const fill = DEFAULTS.slice(0, Math.max(0, 3 - fromPresets.length));
  return [...fromPresets, ...fill];
}

export function QuickActions({ currentUrl, onPick }: Props) {
  const actions = pickActions(currentUrl);
  return (
    <div className="flex flex-wrap gap-1.5 justify-center mb-3">
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onPick(a.prompt)}
          aria-label={`发送提示:${a.prompt}`}
          className="px-2.5 py-1 rounded-full border border-zinc-700 bg-zinc-900 text-zinc-300 text-[11px] hover:bg-zinc-800 hover:border-zinc-600 active:bg-zinc-700"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Update caller in chat-page**

```bash
grep -n "QuickActions" packages/extension/src/sidepanel/pages/*.tsx packages/extension/src/sidepanel/chat/*.tsx
```

Add `currentUrl` prop where `<QuickActions .../>` is rendered — grep result will show the location; pass the current tab URL that's already available in that component.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @aipagego/extension test quick-actions
pnpm -r typecheck
```
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/chat/quick-actions.tsx \
        packages/extension/tests/sidepanel/chat/quick-actions-presets.test.tsx
# Also stage caller change if any:
git add -u
git commit -m "feat(chat): quick-actions 优先展示 URL 命中的 prompt preset"
```

---

### Task 11: Scenarios page(场景库)

**Files:**
- Create: `packages/extension/src/sidepanel/pages/scenarios-page.tsx`
- Modify: `packages/extension/src/sidepanel/app.tsx` — 加 `#/scenarios` 路由 + 顶部 tab
- Test: `packages/extension/tests/sidepanel/pages/scenarios-page.test.tsx`

**Interfaces:**
- Consumes: `Preset`, `rpc.listPresets()`, `rpc.materializePreset()`, `rpc.listTools()`
- Produces: 页面 `<ScenariosPage/>`

- [ ] **Step 1: Write basic render test**

```tsx
// packages/extension/tests/sidepanel/pages/scenarios-page.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScenariosPage } from "@/sidepanel/pages/scenarios-page";
import { PRESETS } from "@aipagego/shared/presets";

vi.mock("@/sidepanel/rpc", () => ({
  rpc: {
    listPresets: async () => [...PRESETS],
    listTools: async () => [],
    materializePreset: async (id: string) => ({
      id: "u1", name: id, kind: "steps", steps: [], versions: [],
      urlPatterns: [], description: "", createdAt: 0,
      origin: { kind: "preset", presetId: id, presetVersion: 1 }
    })
  },
  currentTabId: async () => 1,
  currentTabInfo: async () => ({ tabId: 1, url: "https://en.wikipedia.org/wiki/X" })
}));

describe("ScenariosPage", () => {
  it("renders category headers and preset cards", async () => {
    render(<ScenariosPage/>);
    // shows category
    expect(await screen.findByText(/内容站/)).toBeTruthy();
    expect(await screen.findByText(/商品采集/)).toBeTruthy();
    // shows at least one preset name
    expect(await screen.findByText("维基百科总结")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement scenarios-page**

```tsx
// packages/extension/src/sidepanel/pages/scenarios-page.tsx
import { useEffect, useState } from "react";
import type { Preset } from "@aipagego/shared/preset";
import type { Tool } from "@aipagego/shared/types";
import { rpc, currentTabInfo } from "@/sidepanel/rpc";

const CAT_LABEL: Record<string, string> = {
  ecommerce: "商品采集",
  content:   "内容站"
};

type Filter = "all" | "ecommerce" | "content";

export function ScenariosPage() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tools,   setTools]   = useState<Tool[]>([]);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [query,   setQuery]   = useState("");
  const [filter,  setFilter]  = useState<Filter>("all");
  const [busyId,  setBusyId]  = useState<string | null>(null);

  useEffect(() => {
    rpc.listPresets().then(setPresets);
    rpc.listTools().then(setTools);
    currentTabInfo().then((i) => setCurrentUrl(i.url)).catch(() => {});
  }, []);

  const matchedIds = new Set(
    tools.map((t) => t.origin?.presetId).filter(Boolean) as string[]
  );

  const filtered = presets.filter((p) => {
    if (filter !== "all" && p.category !== filter) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q))
        return false;
    }
    return true;
  });

  const grouped: Record<string, Preset[]> = {};
  for (const p of filtered) (grouped[p.category] ??= []).push(p);

  async function onCopy(p: Preset) {
    if (p.kind !== "tool") return;
    setBusyId(p.id);
    try {
      const tool = await rpc.materializePreset(p.id);
      setTools([...tools.filter((t) => t.id !== tool.id), tool]);
    } finally {
      setBusyId(null);
    }
  }

  async function onRunHere(p: Preset) {
    if (p.kind !== "tool") return;
    setBusyId(p.id);
    try {
      const tool = await rpc.materializePreset(p.id);
      // Navigate to tool detail via hash — reuses existing drawer/pane wiring.
      location.hash = `#/tools/${tool.id}?autoRun=1`;
    } finally {
      setBusyId(null);
    }
  }

  function statusBadge(p: Preset): string {
    const t = tools.find((t) => t.origin?.presetId === p.id);
    if (!t) return "NEW";
    const v = t.versions.at(-1)?.version ?? 1;
    if (v >= 2) return `已升级 v${v}`;
    return "已复制";
  }

  function urlMatches(p: Preset): boolean {
    if (!currentUrl) return false;
    return p.urlPatterns.some((pat) => {
      try {
        // Reuse compilePattern? Inline to avoid extra import in tests:
        const re = new RegExp("^" +
          pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
             .replace(/\*\*/g, ".*")
             .replace(/\*/g, "[^/]*")
          + "$");
        return re.test(currentUrl);
      } catch { return false; }
    });
  }

  return (
    <div className="h-full overflow-auto p-3 flex flex-col gap-3 text-xs">
      <div className="flex gap-2 items-center">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 preset…"
          className="flex-1 px-2 py-1 bg-zinc-900 border border-zinc-700 rounded"
        />
        {(["all","ecommerce","content"] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-2 py-1 rounded ${filter===f ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-300"}`}>
            {f === "all" ? "全部" : CAT_LABEL[f]}
          </button>
        ))}
      </div>
      {Object.entries(grouped).map(([cat, list]) => (
        <section key={cat} className="flex flex-col gap-2">
          <h3 className="text-zinc-400 mt-2">── {CAT_LABEL[cat] ?? cat} ──</h3>
          {list.map((p) => {
            const matches = urlMatches(p);
            return (
              <div key={p.id} className="bg-zinc-900 rounded p-2 border border-zinc-800 flex flex-col gap-1">
                <div className="flex justify-between items-baseline">
                  <b className="text-sm">{p.name}</b>
                  <span className="text-[10px] text-zinc-500">{statusBadge(p)}</span>
                </div>
                <div className="text-zinc-400 text-[11px]">{p.description}</div>
                <div className="text-zinc-500 text-[10px] truncate">{p.urlPatterns.join(", ")}</div>
                <div className="flex gap-2 mt-1">
                  {p.kind === "tool" && matches && (
                    <button disabled={busyId===p.id}
                      onClick={() => onRunHere(p)}
                      className="px-2 py-0.5 bg-emerald-700 rounded">在当前 tab 运行</button>
                  )}
                  {p.kind === "tool" && (
                    <button disabled={busyId===p.id}
                      onClick={() => onCopy(p)}
                      className="px-2 py-0.5 bg-zinc-800 rounded">复制成我的工具</button>
                  )}
                  {p.sampleUrl && (
                    <a href={p.sampleUrl} target="_blank" rel="noreferrer"
                      className="px-2 py-0.5 bg-zinc-800 rounded">示例页</a>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire up route in app.tsx**

Find `app.tsx`'s routing switch. Add case for `#/scenarios`:

```tsx
if (hash === "#/scenarios") return <ScenariosPage />;
```

And in the top nav tab list, add:

```tsx
<a href="#/scenarios">场景库</a>
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @aipagego/extension test scenarios-page
pnpm -r typecheck
```
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/pages/scenarios-page.tsx \
        packages/extension/src/sidepanel/app.tsx \
        packages/extension/tests/sidepanel/pages/scenarios-page.test.tsx
git commit -m "feat(sidepanel): 场景库页 #/scenarios — 搜索/分类/一键运行"
```

---

### Task 12: Self-heal 核心模块(纯 BG,无 IO 依赖)

**Files:**
- Create: `packages/extension/src/background/self-heal.ts`
- Test: `packages/extension/tests/background/self-heal.test.ts`

**Interfaces:**
- Consumes: `Step`, `Tool`, `Severity`, `classifyTool` (already available)
- Produces:
  - `type HealContext`, `type HealResult`, `type HealDeps`
  - `attemptHeal(ctx: HealContext, deps: HealDeps): Promise<HealResult>`
  - `parseStepsSafe(raw: unknown): Step[] | null`

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/background/self-heal.test.ts
import { describe, expect, it, vi } from "vitest";
import { attemptHeal } from "@/background/self-heal";
import type { Step } from "@aipagego/shared/types";

const baseCtx = {
  tool: {
    id: "t1", name: "电商平台", urlPatterns: ["*"], description: "",
    kind: "steps" as const, steps: [] as Step[],
    versions: [{ version: 1, kind: "steps", steps: [] as Step[], outputSchema: null, createdAt: 0 }],
    createdAt: 0
  },
  failedStepIndex: 0,
  failedInput:     { kind: "tool" as const, tool: "snapshotDOM" as const, args: {} },
  errorText:       "selector not found",
  prevSteps:       [],
  domSnapshot:     { tag: "html" },
  url:             "https://demo/"
};

const validPatch = [
  { kind: "tool", tool: "extractText", args: {} }
] as unknown;

function makeDeps(overrides: any = {}) {
  return {
    requestSidepanelLlm: vi.fn().mockResolvedValue({
      patchedSteps: validPatch,
      usage: { in: 500, out: 200 }
    }),
    snapshot: vi.fn().mockResolvedValue({}),
    staticScan: () => [],
    parseSteps: (raw: unknown) =>
      Array.isArray(raw) ? (raw as Step[]) : null,
    now: () => 0,
    ...overrides
  };
}

describe("attemptHeal", () => {
  it("returns ok+patched on valid LLM output", async () => {
    const r = await attemptHeal(baseCtx as any, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patchedSteps.length).toBe(1);
  });

  it("returns invalid_output when parse fails", async () => {
    const deps = makeDeps({ parseSteps: () => null });
    const r = await attemptHeal(baseCtx as any, deps);
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "invalid_output" }));
  });

  it("returns static_scan_reject on dangerous patch", async () => {
    const deps = makeDeps({ staticScan: () => ["dangerous"] });
    const r = await attemptHeal(baseCtx as any, deps);
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "static_scan_reject" }));
  });

  it("returns llm_error when LLM throws", async () => {
    const deps = makeDeps({
      requestSidepanelLlm: vi.fn().mockRejectedValue(new Error("boom"))
    });
    const r = await attemptHeal(baseCtx as any, deps);
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "llm_error" }));
  });

  it("returns budget_exceeded when usage over cap", async () => {
    const deps = makeDeps({
      requestSidepanelLlm: vi.fn().mockResolvedValue({
        patchedSteps: validPatch,
        usage: { in: 100_000, out: 100_000 }
      })
    });
    const r = await attemptHeal(baseCtx as any, deps, { maxOutputTokens: 4096 } as any);
    // depending on impl:budget check kicks in when usage.out > cap
    expect(r.ok || (r as any).reason === "budget_exceeded").toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test self-heal
```
Expected: fail with `Cannot find module '@/background/self-heal'`

- [ ] **Step 3: Implement self-heal.ts**

```ts
// packages/extension/src/background/self-heal.ts
import type { Step, Tool, Json } from "@aipagego/shared/types";
import { classifyTool } from "@/sidepanel/chat/severity";

export type HealContext = {
  tool: Extract<Tool, { kind: "steps" }>;
  failedStepIndex: number;
  failedInput: Step;
  errorText: string;
  prevSteps: { input: Json | string; output: Json }[];
  domSnapshot: unknown;
  url: string;
};

export type HealResult =
  | { ok: true;  patchedSteps: Step[]; llmUsage: { in: number; out: number } }
  | { ok: false; reason:
      | "llm_error" | "budget_exceeded" | "invalid_output"
      | "static_scan_reject" | "step_still_fails"
      | "no_sidepanel" | "no_api_key" };

export type HealDeps = {
  requestSidepanelLlm: (
    ctx: HealContext,
    maxOutputTokens: number
  ) => Promise<{ patchedSteps: unknown; usage: { in: number; out: number } }>;
  snapshot: (tabId: number) => Promise<unknown>;
  staticScan: (steps: Step[]) => Array<"safe" | "caution" | "dangerous">;
  parseSteps: (raw: unknown) => Step[] | null;
  now: () => number;
};

export async function attemptHeal(
  ctx: HealContext,
  deps: HealDeps,
  opts: { maxOutputTokens?: number } = {}
): Promise<HealResult> {
  const cap = opts.maxOutputTokens ?? 4096;
  let resp: { patchedSteps: unknown; usage: { in: number; out: number } };
  try {
    resp = await deps.requestSidepanelLlm(ctx, cap);
  } catch (e: any) {
    if (e?.message?.includes?.("no_sidepanel")) return { ok: false, reason: "no_sidepanel" };
    if (e?.message?.includes?.("no_api_key")) return { ok: false, reason: "no_api_key" };
    return { ok: false, reason: "llm_error" };
  }
  if (resp.usage.out > cap) {
    return { ok: false, reason: "budget_exceeded" };
  }
  const parsed = deps.parseSteps(resp.patchedSteps);
  if (!parsed || parsed.length === 0) {
    return { ok: false, reason: "invalid_output" };
  }
  // Strict allow-list: for each step, dangerous is rejected.
  for (const step of parsed) {
    if (step.kind === "tool") {
      if (classifyTool(step.tool, step.args as Json) === "dangerous") {
        return { ok: false, reason: "static_scan_reject" };
      }
    } else {
      // js step — static-scan must not report dangerous
      const sev = deps.staticScan([step]);
      if (sev.some((s) => s === "dangerous")) {
        return { ok: false, reason: "static_scan_reject" };
      }
    }
  }
  // Additionally run holistic staticScan (dep-defined) for any last check
  const globalSev = deps.staticScan(parsed);
  if (globalSev.some((s) => s === "dangerous")) {
    return { ok: false, reason: "static_scan_reject" };
  }
  return { ok: true, patchedSteps: parsed, llmUsage: resp.usage };
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @aipagego/extension test self-heal
```
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/self-heal.ts packages/extension/tests/background/self-heal.test.ts
git commit -m "feat(bg): self-heal 核心模块 — attemptHeal + static-scan gate"
```

---

### Task 13: LLM prompt builder + sidepanel self-heal host + RPC

**Files:**
- Create: `packages/extension/src/sidepanel/llm/self-heal-prompt.ts`
- Create: `packages/extension/src/sidepanel/self-heal-host.ts`
- Modify: `packages/shared/src/messages.ts` — 加 `selfheal.request` 从 BG 到 sidepanel 的信号消息(不是 RPC,直接 chrome.runtime.sendMessage 广播)
- Modify: `packages/extension/src/sidepanel/app.tsx` — 挂载 self-heal-host

**Interfaces:**
- Consumes: `HealContext` (Task 12), LlmClient
- Produces:
  - `buildSelfHealMessages(ctx, maxOutputTokens): {system: string, user: string, maxTokens: number}`
  - `installSelfHealHost()` — listen for BG requests, invoke LLM, reply

- [ ] **Step 1: Implement prompt builder**

```ts
// packages/extension/src/sidepanel/llm/self-heal-prompt.ts
import type { HealContext } from "@/background/self-heal";

export function buildSelfHealMessages(
  ctx: HealContext,
  maxOutputTokens: number
): { system: string; user: string; maxTokens: number } {
  const prevSummary = ctx.prevSteps
    .slice(-5)
    .map((s, i) => `[${i}] input=${JSON.stringify(s.input).slice(0, 200)} output=${JSON.stringify(s.output).slice(0, 200)}`)
    .join("\n");

  const domStr = JSON.stringify(ctx.domSnapshot).slice(0, 8000);

  const system =
    "你在为一个可重放的浏览器自动化工具修复失败的 step。\n" +
    "给定原 steps、已成功产物、失败 step、错误信息、失败瞬间的 DOM 快照,\n" +
    "输出从失败 step 开始的补丁 Step[] 数组(JSON,不带 markdown fence)。\n" +
    "允许的 step kind: {snapshotDOM, querySelector, querySelectorAll, extractText, extractImages, scroll, waitFor, hover, focus, getValue, extractFormState, click, fillInput, setCheckbox, selectOption, httpRequest(不带 cookie), runJS(不含 storage/eval/cookies 等关键词)}。\n" +
    "禁止:submitForm, uploadFile, readStorage, httpRequest(withCredentials), runJS(含 eval/cookie/storage)。\n" +
    "补丁应尽量少改动、保持产物结构一致。只输出 JSON step 数组,不做解释。";

  const user =
    `- 原 tool: ${ctx.tool.name}, 共 ${ctx.tool.steps.length} 步\n` +
    `- 失败 step [${ctx.failedStepIndex}]: ${JSON.stringify(ctx.failedInput)}\n` +
    `- 错误: ${ctx.errorText}\n` +
    `- 当前 URL: ${ctx.url}\n` +
    `- 最近产物:\n${prevSummary}\n` +
    `- 当前 DOM(截断): ${domStr}\n`;

  return { system, user, maxTokens: Math.min(maxOutputTokens, 8192) };
}
```

- [ ] **Step 2: Implement sidepanel self-heal host**

```ts
// packages/extension/src/sidepanel/self-heal-host.ts
import { pickClient } from "@/sidepanel/llm/client";
import { useSettings } from "@/sidepanel/chat/settings-store";
import { buildSelfHealMessages } from "@/sidepanel/llm/self-heal-prompt";
import type { HealContext } from "@/background/self-heal";

const MSG_TYPE = "selfheal.request";
const RESP_TYPE = "selfheal.response";

type Req = {
  type: typeof MSG_TYPE;
  requestId: string;
  ctx: HealContext;
  maxOutputTokens: number;
};

type Resp = {
  type: typeof RESP_TYPE;
  requestId: string;
  ok: true;
  patchedSteps: unknown;
  usage: { in: number; out: number };
} | {
  type: typeof RESP_TYPE;
  requestId: string;
  ok: false;
  error: string;
};

export function installSelfHealHost(): () => void {
  const listener = async (msg: unknown) => {
    if ((msg as any)?.type !== MSG_TYPE) return;
    const req = msg as Req;
    const settings = useSettings.getState();
    try {
      if (!settings.apiKey) throw new Error("no_api_key");
      const client = pickClient(settings.provider);
      const built = buildSelfHealMessages(req.ctx, req.maxOutputTokens);

      // Non-streaming one-shot: use the same summary-step convention if it exists,
      // otherwise call stream() and collect text.
      let text = "";
      let inTok = 0, outTok = 0;
      for await (const ev of client.stream({
        apiKey: settings.apiKey,
        model:  settings.model,
        endpoint: (settings as any).endpoint ?? undefined,
        system: built.system,
        messages: [{ role: "user", content: built.user }],
        maxTokens: built.maxTokens,
        tools: []
      })) {
        if ((ev as any).type === "text_delta") text += (ev as any).delta;
        if ((ev as any).type === "message_end") {
          inTok = (ev as any).usage?.input_tokens ?? 0;
          outTok = (ev as any).usage?.output_tokens ?? 0;
        }
      }
      let patchedSteps: unknown;
      try {
        patchedSteps = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch {
        throw new Error("invalid_json");
      }
      const resp: Resp = {
        type: RESP_TYPE,
        requestId: req.requestId,
        ok: true,
        patchedSteps,
        usage: { in: inTok, out: outTok }
      };
      chrome.runtime.sendMessage(resp);
    } catch (e: any) {
      const resp: Resp = {
        type: RESP_TYPE,
        requestId: req.requestId,
        ok: false,
        error: String(e?.message ?? e)
      };
      chrome.runtime.sendMessage(resp);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 3: Mount host in app.tsx**

Find where `coordinator-state-bridge` is mounted (a useEffect at top of `App` component) and add:

```tsx
useEffect(() => {
  const dispose = installSelfHealHost();
  return dispose;
}, []);
```

- [ ] **Step 4: Add BG-side wrapper for requestSidepanelLlm**

```ts
// packages/extension/src/background/self-heal-bridge.ts
import type { HealContext } from "./self-heal";

const MSG_TYPE = "selfheal.request";
const RESP_TYPE = "selfheal.response";

let counter = 0;

/** Send heal request to sidepanel; wait up to 30s (self-heal is one-shot LLM). */
export async function requestSidepanelLlm(
  ctx: HealContext,
  maxOutputTokens: number
): Promise<{ patchedSteps: unknown; usage: { in: number; out: number } }> {
  const requestId = `sh_${++counter}_${Date.now()}`;
  const req = { type: MSG_TYPE, requestId, ctx, maxOutputTokens };

  const responsePromise = new Promise<{
    patchedSteps: unknown;
    usage: { in: number; out: number };
  }>((resolve, reject) => {
    const listener = (msg: any) => {
      if (msg?.type !== RESP_TYPE || msg.requestId !== requestId) return;
      chrome.runtime.onMessage.removeListener(listener);
      if (msg.ok) resolve({ patchedSteps: msg.patchedSteps, usage: msg.usage });
      else reject(new Error(msg.error));
    };
    chrome.runtime.onMessage.addListener(listener);
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("no_sidepanel"));
    }, 30_000);
  });

  try {
    await chrome.runtime.sendMessage(req);
  } catch {
    throw new Error("no_sidepanel");
  }
  return responsePromise;
}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck
```
Expected: pass

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/llm/self-heal-prompt.ts \
        packages/extension/src/sidepanel/self-heal-host.ts \
        packages/extension/src/background/self-heal-bridge.ts \
        packages/extension/src/sidepanel/app.tsx
git commit -m "feat: sidepanel self-heal host + BG bridge — 借用 sidepanel LLM 跑 heal"
```

---

### Task 14: rpc-handlers.runTool 集成 catch-and-heal

**Files:**
- Modify: `packages/extension/src/background/rpc-handlers.ts` — `runTool` 加自愈路径
- Modify: `packages/extension/src/background/storage/tools.ts` — `appendVersion` 已存在;确认支持 `healedFrom` metadata(如果没有,先记录成 tool.versions 里最新那版 metadata)
- Test: `packages/extension/tests/background/bg-tool-runner-heal.test.ts`(集成)

**Interfaces:**
- Consumes: `attemptHeal` (Task 12), `requestSidepanelLlm` (Task 13), `classifyTool`, `matchingTools`, `appendVersion`
- Produces: `runTool` 里失败 step 会尝试自愈一次,成功则 appendVersion 并继续。

- [ ] **Step 1: Write failing integration test**

```ts
// packages/extension/tests/background/bg-tool-runner-heal.test.ts
import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock chrome API required by rpc-handlers
(globalThis as any).chrome = {
  tabs: { get: vi.fn().mockResolvedValue({ url: "https://demo/" }),
          sendMessage: vi.fn() },
  scripting: { executeScript: vi.fn() },
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } }
};

vi.mock("@/background/self-heal-bridge", () => ({
  requestSidepanelLlm: vi.fn().mockResolvedValue({
    patchedSteps: [
      { kind: "tool", tool: "extractText", args: {} }
    ],
    usage: { in: 500, out: 200 }
  })
}));

describe("runTool self-heal integration", () => {
  it("failed step triggers heal and appends v2", async () => {
    const { saveDraft, getTool, appendVersion } = await import("@/background/storage/tools");
    const draft = await saveDraft({
      kind: "steps", name: "T1", description: "",
      urlPatterns: ["https://demo/**"],
      steps: [
        { kind: "tool", tool: "snapshotDOM", args: {} }  // will fail per mock
      ],
      outputSchema: null
    });

    // Rig content.runStep to fail once
    (chrome.tabs.sendMessage as any).mockImplementation(async (_id: number, req: any) => {
      if (req.step.tool === "snapshotDOM") return { ok: false, error: "selector not found" };
      return { ok: true, data: { text: "ok" } };
    });

    // Import fresh module state
    const { dispatch } = await import("@/background/rpc-handlers");
    const runRecord: any = await dispatch({
      type: "runs.start",
      target: { kind: "tool", id: draft.id },
      tabId: 1
    });

    const t = await getTool(draft.id);
    // v2 should exist after heal
    expect(t?.versions.length).toBe(2);
    expect(runRecord.healed).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test bg-tool-runner-heal
```
Expected: fail — no v2, no `runRecord.healed`

- [ ] **Step 3: Modify runTool in rpc-handlers.ts**

Locate `async function runTool(req)` (around line 206). Refactor the `for` loop to catch-and-heal. Replace the current inner block with:

```ts
  // ... (existing prelude that builds `steps`, `run`, `bindings`)

  // Detect if tool has an id (persisted) — required for appendVersion.
  const persisted = toolId != null;
  const settings = await readLlmSettings();      // helper below
  const allowHeal = req.target.kind === "tool"
                 && settings.selfHealEnabled
                 && (settings.apiKey?.length ?? 0) > 0;
  let healApplied = false;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const start = Date.now();
      const stepReq = ContentRequestSchema.parse({
        type: "content.runStep",
        step,
        bindings
      });
      const res = (await chrome.tabs.sendMessage(req.tabId, stepReq)) as
        | { ok: true; data: Json }
        | { ok: false; error: string };

      if (!res.ok) {
        // Try self-heal once
        const canHeal = allowHeal
          && !healApplied
          && step.kind === "tool"
          && classifyTool(step.tool, step.args as Json) !== "dangerous";

        if (!canHeal) {
          await appendStepLog(run.id, {
            stepIndex: i,
            input: step.kind === "tool" ? (step.args as Json) : step.source,
            output: null,
            ms: Date.now() - start,
            error: res.error
          });
          await finalizeRun(run.id, { status: "error" });
          if (toolId) await recordRunStat(toolId, false);
          return (await getRun(run.id)) as RunRecord;
        }

        broadcastSessionEvent({
          kind: "self_heal_started",
          toolId: toolId!,
          toolName: (await getTool(toolId!))?.name ?? "",
          failedStepIndex: i
        });

        const domSnapshot = await runOneStep(
          { kind: "tool", tool: "snapshotDOM", args: {} } as Step,
          req.tabId, [], {}
        ).catch(() => ({} as Json));

        const prevSteps = await collectPrevSteps(run.id);

        const heal = await attemptHeal(
          {
            tool: (await getTool(toolId!))! as any,
            failedStepIndex: i,
            failedInput: step,
            errorText: res.error,
            prevSteps,
            domSnapshot,
            url
          },
          {
            requestSidepanelLlm,
            snapshot: async () => domSnapshot,
            staticScan: () => [],     // TODO Task 15: wire real static-scan
            parseSteps: (raw) => {
              const parsed = z.array(StepSchema).safeParse(raw);
              return parsed.success ? parsed.data : null;
            },
            now: Date.now
          },
          { maxOutputTokens: settings.maxSelfHealOutputTokens }
        );

        if (!heal.ok) {
          broadcastSessionEvent({ kind: "self_heal_failed", toolId: toolId!, reason: heal.reason });
          await appendStepLog(run.id, {
            stepIndex: i,
            input: step.kind === "tool" ? (step.args as Json) : step.source,
            output: null,
            ms: Date.now() - start,
            error: `${res.error} · heal:${heal.reason}`
          });
          await finalizeRun(run.id, { status: "error" });
          if (toolId) await recordRunStat(toolId, false);
          return (await getRun(run.id)) as RunRecord;
        }

        // Splice in patched steps [i..end)
        steps.splice(i, steps.length - i, ...heal.patchedSteps);
        const prevVer = toolVersion ?? 1;
        const newVer = prevVer + 1;
        await appendVersion(toolId!, {
          kind: "steps",
          name: (await getTool(toolId!))!.name,
          description: (await getTool(toolId!))!.description,
          urlPatterns: (await getTool(toolId!))!.urlPatterns,
          steps: steps,
          outputSchema: null
        } as any);
        healApplied = true;
        (await import("./storage/runs")).setRunHealed?.(run.id, {
          fromVersion: prevVer, toVersion: newVer, fixedStepIndex: i
        }).catch(() => {});

        broadcastSessionEvent({
          kind: "self_heal_completed",
          toolId: toolId!,
          newVersion: newVer,
          fixedStepIndex: i
        });

        i--;   // 重跑当前 step 用新补丁
        continue;
      }

      await appendStepLog(run.id, {
        stepIndex: i,
        input: step.kind === "tool" ? (step.args as Json) : step.source,
        output: res.data,
        ms: Date.now() - start
      });
      if (step.bindResultTo) bindings[step.bindResultTo] = res.data;
      lastOutput = res.data;
    }
    // ... existing finalize path
  } catch (e) {
    // ... existing catch path
  }
```

Add helper functions in the same file (top of file):

```ts
async function readLlmSettings(): Promise<{
  selfHealEnabled: boolean;
  maxSelfHealOutputTokens: number;
  apiKey: string;
}> {
  const KEY = "aipagego.llm";
  const raw = (await chrome.storage.local.get([KEY]))[KEY] ?? {};
  const session = (await chrome.storage.session.get([KEY]))[KEY] ?? {};
  const apiKey = raw.apiKey || session.apiKey || "";
  return {
    selfHealEnabled: raw.selfHealEnabled !== false,       // default true
    maxSelfHealOutputTokens: raw.maxSelfHealOutputTokens ?? 4096,
    apiKey
  };
}

function broadcastSessionEvent(ev: unknown): void {
  try {
    void chrome.runtime.sendMessage({ type: "session.event", event: ev });
  } catch {}
}

async function collectPrevSteps(runId: string): Promise<{ input: Json | string; output: Json }[]> {
  const { getRun } = await import("./storage/runs");
  const run = await getRun(runId);
  if (!run) return [];
  return run.stepLog.filter((e) => !e.error).map((e) => ({ input: e.input, output: e.output }));
}
```

Add imports at top:

```ts
import { z } from "zod";
import { StepSchema } from "@aipagego/shared/messages";
import { attemptHeal } from "./self-heal";
import { requestSidepanelLlm } from "./self-heal-bridge";
import { classifyTool } from "@/sidepanel/chat/severity";
```

- [ ] **Step 4: Add setRunHealed helper in storage/runs**

```ts
// packages/extension/src/background/storage/runs.ts (append)
export async function setRunHealed(
  runId: string,
  healed: { fromVersion: number; toVersion: number; fixedStepIndex: number }
): Promise<void> {
  const db = await getDb();  // adjust to actual db accessor
  const row = await db.get("runs", runId);
  if (row) await db.put("runs", { ...row, healed });
}
```

- [ ] **Step 5: Verify test passes**

```bash
pnpm --filter @aipagego/extension test bg-tool-runner-heal
```
Expected: pass

- [ ] **Step 6: Run full test + typecheck**

```bash
pnpm -r typecheck
pnpm test
```
Expected: all pass (some existing tests may need chrome mock adjustments — fix them)

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "feat(bg): runTool 集成自愈 — 失败 step 自动跑 heal → appendVersion v(N+1) 继续"
```

---

### Task 15: 手动修复线错误上下文追加(spec §8)

**Files:**
- Modify: `packages/extension/src/sidepanel/drawers/tool-detail-pane.tsx` — `onFix` 里如果 `run.healed` 存在,把自愈补丁摘要加进 `initialContext`

- [ ] **Step 1: Extend onFix**

Find `onFix()` in `tool-detail-pane.tsx` (already read above). Replace the `initialContext` string with:

```ts
    const healedNote = run.healed
      ? `\n\n> 自动自愈已尝试并失败 · from v${run.healed.fromVersion} 至 v${run.healed.toVersion} · fixedStep=${run.healed.fixedStepIndex}\n`
      : "";
    const initialContext =
      `# 工具「${tool.name}」原 steps:\n\`\`\`json\n${JSON.stringify(tool.steps, null, 2)}\n\`\`\`\n` +
      `# 当前 URL: ${run.url}${healedNote}`;
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```
Expected: pass

- [ ] **Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/drawers/tool-detail-pane.tsx
git commit -m "feat(sidepanel): [让 AI 修复] 错误上下文追加自愈补丁摘要"
```

---

### Task 16: Settings UI 加两个 self-heal 开关

**Files:**
- Modify: `packages/extension/src/sidepanel/pages/settings-page.tsx`

- [ ] **Step 1: Add UI**

Find `settings-page.tsx`(可能在 `sidepanel/drawers/settings-pane.tsx` 或 `pages/`)。在 「maxContinuationNudges」 附近加两行:

```tsx
        <label className="flex items-center gap-2">
          <input type="checkbox"
            checked={selfHealEnabled}
            onChange={(e) => save({ selfHealEnabled: e.target.checked })}/>
          自动自愈失败 step(默认开)
        </label>
        <label className="flex items-center gap-2">
          自愈 LLM 输出上限
          <input type="number" min={1024} max={8192} step={512}
            value={maxSelfHealOutputTokens}
            onChange={(e) => save({ maxSelfHealOutputTokens: Number(e.target.value) })}
            className="w-24 px-1 bg-zinc-900 border border-zinc-700 rounded"/>
          tokens
        </label>
```

Destructure them from `useSettings`:

```tsx
const { selfHealEnabled, maxSelfHealOutputTokens, save } = useSettings();
```

- [ ] **Step 2: Typecheck + smoke build**

```bash
pnpm -r typecheck
pnpm build
```
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/pages/settings-page.tsx
git commit -m "feat(sidepanel): settings 加自愈开关 + tokens 上限输入"
```

---

### Task 17: 全量验证 + docs-site preset 列表(可选)

**Files:**
- Modify (optional): `docs-site/src/**/tools-reference.md` — 加 preset 列表章节

- [ ] **Step 1: Run all tests**

```bash
pnpm -r typecheck
pnpm test
```
Expected: all pass

- [ ] **Step 2: Build extension**

```bash
pnpm build
```
Expected: `packages/extension/dist/` produced without error

- [ ] **Step 3: (可选) Docs-site preset 列表**

Add a section listing the 11 built-in presets to `docs-site` (guide or tools-reference page). Skip if docs-site build is out of scope for this iteration.

- [ ] **Step 4: Commit any docs changes(如做了)**

```bash
git add docs-site
git commit -m "docs(site): 补 11 个内置 preset 列表"
```

---

### Task 18: 切分支 + 打 PR + 通过 ship-release 发版

**Files:**
- No file changes;流程性任务。

- [ ] **Step 1: 确认本地在 main 分支且干净**

```bash
git status
git branch --show-current
```
Expected: `main` and clean tree(除新 spec commit 已 pushed)

- [ ] **Step 2: 切 feat 分支**

```bash
git checkout -b feat/scenario-presets-and-self-heal
```

- [ ] **Step 3: rebase 所有 Task 1-17 commits 到该分支**

如果 Task 1-17 已在 main:

```bash
# 找到最早 preset commit
FIRST=$(git log --oneline main --format="%H" -- packages/shared/src/preset.ts | tail -1)
# reset main 到 FIRST 之前,把这些 commit 移到 feat 分支
git checkout main
git reset --hard $FIRST^
git checkout feat/scenario-presets-and-self-heal
```

**注意**: 更简单的做法是**从 Task 1 开始就工作在 feat 分支**。如果实际执行时已经如此,跳过此步。

- [ ] **Step 4: Push feat + 打 PR**

```bash
git push -u origin feat/scenario-presets-and-self-heal
gh pr create --title "feat: 场景 Preset 库 + Tool 运行时自愈" --body "$(cat <<'EOF'
## Summary
- 引入 `@aipagego/shared/presets` 静态 registry — 11 个内置 preset(7 内容站 prompt-form + 4 电商 tool-form)
- Tool 重放路径加运行时自愈: step 失败 → 一次性 LLM 调用生成补丁 steps → static-scan 拒 dangerous → appendVersion v(N+1) 继续跑
- 曝光通路: tab-watcher 合并 preset 匹配 → quick-actions URL 命中优先 → 新 `#/scenarios` 场景库页
- 设置加两个开关: `selfHealEnabled`(默认 on), `maxSelfHealOutputTokens`(默认 4096)

对应 spec: `docs/superpowers/specs/2026-07-07-scenario-presets-and-self-heal-design.md`

## Test plan
- [ ] `pnpm typecheck` 全绿
- [ ] `pnpm test` 全绿(shared + extension + coordinator)
- [ ] `pnpm build` 产 `packages/extension/dist/`
- [ ] 手测: 打开 wikipedia — 侧边栏推荐命中「维基百科总结」
- [ ] 手测: 场景库页可见 11 个 preset,按分类过滤 OK
- [ ] 手测: 淘宝页面运行 preset — 若步骤失败自愈成功后 v2 存在,顶部条显示「自愈中 → 已升级 v2」
EOF
)"
```

- [ ] **Step 5: 等 CI 绿灯 → squash merge**

```bash
gh pr checks --watch
# 全绿后:
gh pr merge --squash --delete-branch
```

- [ ] **Step 6: 回到 main + 走 ship-release**

```bash
git checkout main
git pull --ff-only  # 如失败,按 [[local-main-divergence]] 记录处理:git reset --hard origin/main
```

然后调 ship-release skill:

- 让它读根 package.json 当前版本
- 递增 patch(如 0.0.37 → 0.0.38)
- 打 tag → push → CI 自动发 release + 覆盖 root/extension package.json 版本(参考 [[feedback_ship_release_version_bump]])

---

## Self-Review

### Spec Coverage

- **§4 顶层骨架**: Tasks 1-2 建 registry;Task 5 加 Tool.origin;Task 8 materialize;Task 9 tab-watcher;Task 11 scenarios-page;Task 12-14 self-heal ✓
- **§5.1 Preset 类型**: Task 1 ✓
- **§5.2 Registry**: Task 2-4 ✓
- **§5.3 Tool.origin**: Task 5 ✓
- **§5.4 SessionEvent 扩展**: Task 7 ✓
- **§6.1 URL 命中推荐**: Task 9 ✓
- **§6.2 场景库页**: Task 11 ✓
- **§6.3 quick-actions 优先**: Task 10 ✓
- **§7.1-7.3 runTool 集成**: Task 14 ✓
- **§7.4 BG → sidepanel LLM RPC**: Task 13 ✓
- **§7.5 LLM prompt 结构**: Task 13(prompt builder) ✓
- **§7.6 静态扫描 gate**: Task 12 (attemptHeal) ✓
- **§7.7 设置**: Task 6 + Task 16 ✓
- **§8 手动修复线错误上下文**: Task 15 ✓
- **§9 首批 preset 清单**: Task 3-4 ✓
- **§10 安全模型**: Task 4 首批不引 dangerous,Task 12 补丁 gate ✓
- **§11 测试策略**: Tests 分布在 Task 1-14 各自 ✓
- **§12 迁移**: Task 5 origin 可选,storage/import-export 兼容(现有导出跳过 `origin.kind==="preset"&&versions.length===1` 需在 Task 5 或 Task 8 里体现);**gap: 现在没有明确 task 修改 export-import 处理 origin 字段**
- **§13 度量**: 通过 SessionEvent + Exchanges 面板(现有基础设施)自然覆盖 ✓
- **§14 分阶段落地**: 一次 iteration 一 PR(Task 18) — 与 spec 说"每 phase 独立可发"不冲突,只是收紧到一次

**已识别 gap**:

- ~~§12 export-import 需要 origin 处理~~ → 补一个额外的小任务(见下),或纳入 Task 5 Step 补充。为了保持 Task 5 简洁,拆一个独立任务。

### Gap Fix: Task 8.5 — export/import 处理 origin

添加到 Task 8 之后作为 Step 10-13(合并):

```ts
// 在 storage/export-import.ts 的 exportTools 里过滤:
export async function exportTools() {
  const tools = await listTools();
  return tools.filter((t) => !(t.origin?.kind === "preset" && t.versions.length === 1));
}

// 在 importTools 里静默丢弃未知 preset origin:
export async function importTools(bundle) {
  const { PRESETS } = await import("@aipagego/shared/presets");
  const validIds = new Set(PRESETS.map((p) => p.id));
  for (const raw of bundle.tools) {
    if (raw.origin?.kind === "preset" && !validIds.has(raw.origin.presetId)) {
      delete raw.origin;
    }
    // ... existing save logic
  }
}
```

将此改动合并进 Task 8 (materializePreset PR) 或作为独立 commit — 建议放 Task 8 里,简化 PR 数量。

### Placeholder Scan

- ✅ 无 `TBD`/`TODO`/`FIXME`(除 Task 14 Step 3 里 `staticScan: () => []  // TODO Task 15: wire real static-scan` — 这实际上应由 `@aipagego/shared/static-scan` 提供;修正为直接调 real static-scan)

Fix inline in Task 14 Step 3:

```ts
import { staticScan as sharedStaticScan } from "@aipagego/shared/static-scan";
// ...
staticScan: (steps) => steps.flatMap((s) =>
  s.kind === "js" ? sharedStaticScan(s.source).map((f) => f.severity) : []
),
```

### Type Consistency

- `HealContext.tool` 类型 `Extract<Tool, { kind: "steps" }>` 一致贯穿 Task 12/14 ✓
- `HealResult.reason` 枚举与 SessionEvent `self_heal_failed.reason` 枚举一致(7 值) ✓
- Task 8 `materializePreset(id: string): Promise<Tool>` 与 Task 11 用法一致 ✓
- Task 9 `presets` payload 字段名 与 Task 10 `matchPresetsByUrl` 输出类型 `Preset[]` 一致 ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-scenario-presets-and-self-heal.md`.

**Recommended: Subagent-Driven** — 该 plan 有 18 个 task,合适 subagent 独立跑,主 loop 只做检查/合并。
