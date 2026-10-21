# Plan 3: AIPageGo — 网页助手定位与操作工具集 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前"AI 网页采集器"重新定位为"AIPageGo — AI 网页助手"，新增 9 个交互工具（fillInput / setCheckbox / selectOption / submitForm / hover / focus / uploadFile / getValue / extractFormState）支持读 / 写 / 采全场景任务，引入按工具名粒度的 dangerous 自动通过白名单（对话页 + 设置页双向同步），重写 system prompt 与全部用户可见文案。

**Architecture:** 完全沿用 Plan 1+2 的三入口架构。本计划只是工具集扩展 + 严重度策略增强 + 文案换皮；IDB DB_NAME 与 import 别名不变，避免数据丢失与大规模 churn。仓库目录重命名留给用户在计划完成后手动 `mv`。

**Tech Stack:** 复用 Plan 1+2 的 Vite + React + TypeScript + Tailwind + zod + idb + zustand，无新增依赖。

---

## 文件结构（Plan 3 增量）

```
aipagego2/                                  ← 仓库目录暂不动
├─ package.json                          # MOD: name → aipagego, description
├─ README.md                             # MOD: 全篇重写为"网页助手"
├─ src/
│  ├─ manifest.ts                        # MOD: name/description/title
│  ├─ background/
│  │  ├─ index.ts                        # MOD: console 前缀
│  │  ├─ rpc-handlers.ts                 # MOD: 加 http.fetchBinary case
│  │  └─ http-proxy.ts                   # MOD: 加 fetchAsBase64
│  ├─ shared/
│  │  ├─ types.ts                        # MOD: BuiltinTool union 加 9 个；
│  │  │                                          LlmSettings 加 autoApproveDangerous
│  │  └─ messages.ts                     # MOD: 加 http.fetchBinary; StepSchema 工具名扩
│  ├─ content/
│  │  ├─ index.ts                        # MOD: console 前缀
│  │  └─ tools/
│  │     ├─ index.ts                     # MOD: 注册新 9 个
│  │     ├─ fill-input.ts                # NEW
│  │     ├─ set-checkbox.ts              # NEW
│  │     ├─ select-option.ts             # NEW
│  │     ├─ submit-form.ts               # NEW
│  │     ├─ hover.ts                     # NEW
│  │     ├─ focus.ts                     # NEW
│  │     ├─ upload-file.ts               # NEW
│  │     ├─ get-value.ts                 # NEW
│  │     └─ extract-form-state.ts        # NEW
│  └─ sidepanel/
│     ├─ llm/
│     │  ├─ tool-schema.ts               # MOD: 加 9 个 LlmTool def
│     │  └─ system-prompt.ts             # MOD: 全场景重写
│     ├─ chat/
│     │  ├─ severity.ts                  # MOD: 新签名 + 9 个分类
│     │  ├─ run-session.ts               # MOD: autoApproves 新签名
│     │  └─ settings-store.ts            # MOD: 默认 autoApproveDangerous: []
│     ├─ pages/
│     │  ├─ chat-page.tsx                # MOD: 加 DangerApprovalPopover；
│     │  │                                  placeholder + empty 文案
│     │  └─ settings-page.tsx            # MOD: 加 DangerApprovalGroup
│     └─ components/
│        ├─ danger-approval-list.tsx     # NEW: 5 项复选框（共用）
│        ├─ danger-approval-popover.tsx  # NEW: 对话页折叠按钮 + List
│        ├─ danger-approval-group.tsx    # NEW: 设置页常驻 List
│        ├─ chat-view.tsx                # MOD: empty state 文案
│        └─ save-as-tool-dialog.tsx      # MOD: 默认名
└─ tests/
   ├─ content/tools/
   │  ├─ fill-input.test.ts              # NEW
   │  ├─ set-checkbox.test.ts            # NEW
   │  ├─ select-option.test.ts           # NEW
   │  ├─ submit-form.test.ts             # NEW
   │  ├─ hover.test.ts                   # NEW
   │  ├─ focus.test.ts                   # NEW
   │  ├─ upload-file.test.ts             # NEW
   │  ├─ get-value.test.ts               # NEW
   │  └─ extract-form-state.test.ts      # NEW
   └─ sidepanel/chat/
      ├─ severity.test.ts                # MOD: 加 5 case
      └─ run-session.test.ts             # MOD: 加 1 case
```

每个工具文件单一职责。`upload-file.ts` 通过 chrome.runtime.sendMessage 调 BG 的 `http.fetchBinary` 拿二进制；其余在 isolated world 直接操作 DOM。

---

## Task 1: shared 类型增量（BuiltinTool / LlmSettings）

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 把 `BuiltinTool` union 扩展为 19 个**

替换 `src/shared/types.ts` 中现有的 `BuiltinTool` 定义：

```ts
export type BuiltinTool =
  | "snapshotDOM"
  | "querySelector"
  | "querySelectorAll"
  | "extractImages"
  | "extractText"
  | "scroll"
  | "waitFor"
  | "click"
  | "httpRequest"
  | "readStorage"
  // Plan 3 additions
  | "fillInput"
  | "setCheckbox"
  | "selectOption"
  | "submitForm"
  | "hover"
  | "focus"
  | "uploadFile"
  | "getValue"
  | "extractFormState";
```

- [ ] **Step 2: `LlmSettings` 加 `autoApproveDangerous`**

把 `LlmSettings` 类型替换为：

```ts
export type LlmSettings = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  apiKeyMode: "persistent" | "session";
  maxRounds: number;
  endpoint?: string;
  /** dangerous 工具白名单。空数组 = 全部人工 */
  autoApproveDangerous: string[];
};
```

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 一些既存代码（severity / settings-store / settings-page）会因为 `autoApproveDangerous` 必填而报错；不必现在修，下面 task 会改到。但 BuiltinTool union 应该不报错（消费方都是字符串字面量）。

如果出现 BuiltinTool 相关错误，先把它修掉；`autoApproveDangerous` 引用错误暂时忽略（继续 task 推进）。

- [ ] **Step 4: 把 LlmSettings 改成可选过渡**

为了让 typecheck 在 task 链中保持绿色，临时把 `autoApproveDangerous` 改为可选：

```ts
  /** dangerous 工具白名单。空数组 = 全部人工。Plan 3 task 4 起始终使用 */
  autoApproveDangerous?: string[];
```

后续 task 4 改 settings-store 时去掉 `?`。

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): add 9 new BuiltinTool members + autoApproveDangerous setting"
```

---

## Task 2: messages.ts 加 http.fetchBinary RPC

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: 在 `RpcRequest` 数组末尾追加新 case**

打开 `src/shared/messages.ts`，找到 `RpcRequest = z.discriminatedUnion(...)` 数组中最后一项 `runs.runOneStep` 之后追加：

```ts
  z.object({
    type: z.literal("http.fetchBinary"),
    url: z.string().url()
  }),
```

注意要在数组的闭合 `]` 之前。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。BG dispatch switch 暂时不会处理这个 case，但 zod schema 编译没问题；BG dispatch 是 type-narrowed，会在 task 3 修。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat(shared): add http.fetchBinary RPC schema"
```

---

## Task 3: background/http-proxy.ts 加 fetchAsBase64 + RPC handler

**Files:**
- Modify: `src/background/http-proxy.ts`
- Modify: `src/background/rpc-handlers.ts`

- [ ] **Step 1: `http-proxy.ts` 末尾追加 `fetchAsBase64`**

```ts
// 追加到 src/background/http-proxy.ts 末尾
export async function fetchAsBase64(
  url: string
): Promise<{ base64: string; mime: string; size: number }> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const arr = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(arr.subarray(i, i + chunk)));
  }
  return {
    base64: btoa(bin),
    mime: blob.type || "application/octet-stream",
    size: arr.length
  };
}
```

注意：分块拼接是因为 `String.fromCharCode.apply` 一次性传超大数组会撑爆 stack。

- [ ] **Step 2: `rpc-handlers.ts` 加 import + case**

在 import 区追加：

```ts
import { fetchAsBase64, httpRequest } from "./http-proxy";
```

（替换原来的 `import { httpRequest } from "./http-proxy";`）

在 `dispatch` 函数 switch 末尾，`runs.runOneStep` case 之后追加：

```ts
    case "http.fetchBinary": {
      return (await fetchAsBase64(req.url)) as unknown as Json;
    }
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/background/http-proxy.ts src/background/rpc-handlers.ts
git commit -m "feat(background): add fetchAsBase64 + http.fetchBinary RPC handler"
```

---

## Task 4: settings-store 加 autoApproveDangerous

**Files:**
- Modify: `src/sidepanel/chat/settings-store.ts`
- Modify: `src/shared/types.ts`（去掉 `?`）

- [ ] **Step 1: 把 `LlmSettings.autoApproveDangerous` 改回必填**

打开 `src/shared/types.ts`，把：

```ts
  autoApproveDangerous?: string[];
```

改回：

```ts
  /** dangerous 工具白名单。空数组 = 全部人工 */
  autoApproveDangerous: string[];
```

- [ ] **Step 2: settings-store 默认值与持久化**

打开 `src/sidepanel/chat/settings-store.ts`，找到 `DEFAULTS` 常量并替换为：

```ts
const DEFAULTS: LlmSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "",
  apiKeyMode: "persistent",
  maxRounds: 20,
  autoApproveDangerous: []
};
```

不需要改其他逻辑——`load()` 用 `{ ...DEFAULTS, ...(fromLocal ?? {}) }` 已经会给老用户补默认值；`save()` 会把整个 settings 对象写回 storage。

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/sidepanel/chat/settings-store.ts
git commit -m "feat(settings): persist autoApproveDangerous allowlist"
```

---

## Task 5: severity.ts 重构 + 单测

**Files:**
- Modify: `src/sidepanel/chat/severity.ts`
- Modify: `tests/sidepanel/chat/severity.test.ts`

- [ ] **Step 1: 在测试文件末尾追加 5 个 dangerous 白名单 case**

打开 `tests/sidepanel/chat/severity.test.ts`，在 `describe("autoApproves", ...)` 块内追加：

```ts
  it("dangerous auto only when toolName in allowlist", () => {
    expect(autoApproves("dangerous", "submitForm", true, ["submitForm"])).toBe(true);
    expect(autoApproves("dangerous", "submitForm", true, [])).toBe(false);
  });

  it("dangerous allowlist independent of approveAllSafe", () => {
    expect(autoApproves("dangerous", "uploadFile", false, ["uploadFile"])).toBe(true);
    expect(autoApproves("dangerous", "uploadFile", true, [])).toBe(false);
  });

  it("dangerous allowlist applies per tool name", () => {
    expect(autoApproves("dangerous", "submitForm", true, ["uploadFile"])).toBe(false);
    expect(autoApproves("dangerous", "uploadFile", true, ["uploadFile"])).toBe(true);
  });

  it("safe ignores allowlist", () => {
    expect(autoApproves("safe", "snapshotDOM", false, [])).toBe(true);
  });

  it("caution ignores allowlist", () => {
    expect(autoApproves("caution", "fillInput", true, [])).toBe(true);
    expect(autoApproves("caution", "fillInput", false, ["fillInput"])).toBe(false);
  });
```

并把现有 `autoApproves` 调用都改成新 4 参签名（在每个老 test 里给 `toolName` 与 `[]`）：

把现有的：
```ts
expect(autoApproves("safe", true)).toBe(true);
```

改成：
```ts
expect(autoApproves("safe", "snapshotDOM", true, [])).toBe(true);
```

3 处 safe / 2 处 caution / 2 处 dangerous 都要改。

- [ ] **Step 2: 在测试文件追加 9 个新工具的 classifyTool 测试**

在 `describe("classifyTool", ...)` 里追加：

```ts
  it("safe interaction tools", () => {
    expect(classifyTool("hover", { selector: "x" })).toBe("safe");
    expect(classifyTool("focus", { selector: "x" })).toBe("safe");
    expect(classifyTool("getValue", { selector: "x" })).toBe("safe");
    expect(classifyTool("extractFormState", {})).toBe("safe");
  });

  it("caution interaction tools", () => {
    expect(classifyTool("fillInput", { selector: "x", value: "y" })).toBe("caution");
    expect(classifyTool("setCheckbox", { selector: "x", checked: true })).toBe("caution");
    expect(classifyTool("selectOption", { selector: "x", value: "y" })).toBe("caution");
  });

  it("dangerous side-effect tools", () => {
    expect(classifyTool("submitForm", {})).toBe("dangerous");
    expect(classifyTool("uploadFile", { selector: "x", url: "u" })).toBe("dangerous");
  });
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `pnpm test tests/sidepanel/chat/severity.test.ts`
Expected: FAIL（autoApproves 签名 + classifyTool 不识别新工具）。

- [ ] **Step 4: 重写 `src/sidepanel/chat/severity.ts`**

```ts
// src/sidepanel/chat/severity.ts
import { highestSeverity, runStaticScan } from "@/shared/static-scan";
import type { Json } from "@/shared/types";

export type ToolSeverity = "safe" | "caution" | "dangerous";

const SAFE = new Set([
  "snapshotDOM",
  "querySelector",
  "querySelectorAll",
  "extractText",
  "extractImages",
  "scroll",
  "waitFor",
  "hover",
  "focus",
  "getValue",
  "extractFormState"
]);

const CAUTION = new Set([
  "click",
  "fillInput",
  "setCheckbox",
  "selectOption"
]);

const DANGEROUS_FIXED = new Set([
  "readStorage",
  "submitForm",
  "uploadFile"
]);

export function classifyTool(name: string, input: Json): ToolSeverity {
  if (SAFE.has(name)) return "safe";
  if (CAUTION.has(name)) return "caution";
  if (DANGEROUS_FIXED.has(name)) return "dangerous";
  if (name === "httpRequest") {
    const withCred = isObject(input) && (input as Record<string, Json>).withCredentials === true;
    return withCred ? "dangerous" : "caution";
  }
  if (name === "runJS") {
    const source = isObject(input) ? ((input as Record<string, Json>).source as string | undefined) : undefined;
    if (!source) return "caution";
    const sev = highestSeverity(runStaticScan(source));
    if (sev === "dangerous") return "dangerous";
    return "caution";
  }
  return "dangerous";
}

export function autoApproves(
  severity: ToolSeverity,
  toolName: string,
  approveAllSafe: boolean,
  dangerousAllowlist: string[]
): boolean {
  if (severity === "safe") return true;
  if (severity === "caution") return approveAllSafe;
  if (severity === "dangerous") return dangerousAllowlist.includes(toolName);
  return false;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/sidepanel/chat/severity.test.ts`
Expected: 所有 case PASS。

- [ ] **Step 6: 类型检查**

Run: `pnpm typecheck`
Expected: 多个 callsite（chat-view、chat-page、run-session）会因签名变化报错；后续 task 会修。但本次提交先把 severity 自身改完。

如有 callsite 阻塞 typecheck，下面 task 6/7/8 会接着修复。

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/chat/severity.ts tests/sidepanel/chat/severity.test.ts
git commit -m "feat(chat): severity classifier supports new tools + per-tool allowlist"
```

---

## Task 6: run-session 适配新 autoApproves 签名 + 单测

**Files:**
- Modify: `src/sidepanel/chat/run-session.ts`
- Modify: `tests/sidepanel/chat/run-session.test.ts`

- [ ] **Step 1: run-session.ts 的 autoApproves 调用更新**

打开 `src/sidepanel/chat/run-session.ts`，找到：

```ts
      if (autoApproves(sev, args.approveAllSafe)) {
```

替换为：

```ts
      if (autoApproves(sev, tu.name, args.approveAllSafe, args.settings.autoApproveDangerous)) {
```

`args.settings.autoApproveDangerous` 已是 string[]（task 4 起为必填）。

- [ ] **Step 2: 在 run-session.test.ts 现有 4 个 test 末追加一个**

```ts
  it("dangerous tool with allowlist auto-approves", async () => {
    const client = makeClient([
      [
        { type: "tool_use_start", id: "t1", name: "submitForm" },
        { type: "tool_use_input_delta", id: "t1", partial_json: '{"selector":"form"}' },
        { type: "tool_use_end", id: "t1", input: { selector: "form" } },
        { type: "message_end" }
      ],
      [
        { type: "text_delta", text: "submitted" },
        { type: "message_end" }
      ]
    ]);
    let ran = 0;
    const runner = makeRunner(async () => {
      ran++;
      return { ok: true };
    });
    const approver = new Approver();

    const result = await runChatSession({
      client,
      runner,
      approver,
      rpc: {
        startSession: vi.fn().mockResolvedValue({ id: "r" }),
        appendStepLog: vi.fn(),
        finalizeSession: vi.fn().mockResolvedValue(null)
      },
      input: { userPrompt: "go", tabId: 1, url: "u" },
      settings: {
        provider: "anthropic",
        model: "m",
        apiKey: "k",
        apiKeyMode: "session",
        maxRounds: 5,
        autoApproveDangerous: ["submitForm"]
      },
      systemPrompt: "sys",
      tools: [],
      approveAllSafe: false
    });

    expect(result.status).toBe("done");
    expect(ran).toBe(1); // 不需要人工审批
  });
```

注意现有 4 个 test 里 settings 都缺 `autoApproveDangerous`——必须补上。把它们的 settings 对象统一加上：

```ts
settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 5, autoApproveDangerous: [] },
```

或对 maxRounds 不同的 case 保留它原值，仅追加 `autoApproveDangerous: []`。

- [ ] **Step 3: 跑测试**

Run: `pnpm test tests/sidepanel/chat/run-session.test.ts`
Expected: 5 个 test 全部 PASS。

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: chat-view / chat-page 仍报错（task 7/8 修），但 run-session 自身、severity 自身 OK。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/chat/run-session.ts tests/sidepanel/chat/run-session.test.ts
git commit -m "feat(chat): run-session uses per-tool dangerous allowlist"
```

---

## Task 7: chat-view 适配新签名

**Files:**
- Modify: `src/sidepanel/components/chat-view.tsx`

- [ ] **Step 1: 改 `chat-view.tsx` 的 `needsApproval` 函数**

找到现有的：

```ts
  function needsApproval(card: StepCardState): boolean {
    if (!card.inputReady) return false;
    return !autoApproves(classifyTool(card.name, card.input), session.approveAllSafe);
  }
```

替换为：

```ts
  function needsApproval(card: StepCardState): boolean {
    if (!card.inputReady) return false;
    return !autoApproves(
      classifyTool(card.name, card.input),
      card.name,
      session.approveAllSafe,
      settings.autoApproveDangerous
    );
  }
```

并在文件顶部 import 区追加：

```ts
import { useSettings } from "../chat/settings-store";
```

在组件内 `const session = useSession();` 后追加：

```ts
  const settings = useSettings();
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 仅剩 chat-page 还报错（task 8 修）。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/chat-view.tsx
git commit -m "feat(chat-view): consult settings.autoApproveDangerous for approval gate"
```

---

## Task 8: chat-page 适配新签名

**Files:**
- Modify: `src/sidepanel/pages/chat-page.tsx`

- [ ] **Step 1: 找到 onEvent 中没有调 autoApproves 的地方（其实 chat-page 不直接调 autoApproves，只通过 send() 把 settings 传给 run-session）**

`chat-page.tsx` 已经把整个 `settings` 对象传给 `runChatSession`，run-session 自己取 `settings.autoApproveDangerous`。所以本 task 唯一要做的是：确保 settings.autoApproveDangerous 一定是 array（避免老存储 + 新代码 race）。

打开 `src/sidepanel/pages/chat-page.tsx`，找到：

```ts
        await runChatSession({
          ...
          settings,
          ...
        });
```

替换为：

```ts
        await runChatSession({
          ...
          settings: { ...settings, autoApproveDangerous: settings.autoApproveDangerous ?? [] },
          ...
        });
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/pages/chat-page.tsx
git commit -m "feat(chat-page): defensive default for autoApproveDangerous"
```

---

## Task 9: DangerApprovalList 共享组件

**Files:**
- Create: `src/sidepanel/components/danger-approval-list.tsx`

- [ ] **Step 1: 写入文件**

```tsx
// src/sidepanel/components/danger-approval-list.tsx
import { useSettings } from "../chat/settings-store";

const ITEMS: Array<{ name: string; label: string; description: string }> = [
  {
    name: "submitForm",
    label: "submitForm",
    description: "提交表单（会触发服务端动作）"
  },
  {
    name: "uploadFile",
    label: "uploadFile",
    description: "上传文件"
  },
  {
    name: "readStorage",
    label: "readStorage",
    description: "读 localStorage / sessionStorage"
  },
  {
    name: "httpRequest",
    label: "httpRequest(带 cookie)",
    description: "带登录会话发请求（withCredentials=true 时为 dangerous）"
  },
  {
    name: "runJS",
    label: "runJS(扫描命中)",
    description: "含 cookie/eval/storage 的脚本（任何 dangerous 级别 runJS）"
  }
];

export function DangerApprovalList() {
  const settings = useSettings();
  const allowlist = settings.autoApproveDangerous ?? [];

  function toggle(name: string) {
    const next = allowlist.includes(name)
      ? allowlist.filter((n) => n !== name)
      : [...allowlist, name];
    settings.save({ autoApproveDangerous: next });
  }

  return (
    <ul className="flex flex-col gap-1 text-xs">
      {ITEMS.map((it) => (
        <li key={it.name} className="flex items-start gap-2">
          <input
            type="checkbox"
            id={`dangerous-${it.name}`}
            checked={allowlist.includes(it.name)}
            onChange={() => toggle(it.name)}
            className="mt-0.5"
          />
          <label htmlFor={`dangerous-${it.name}`} className="flex-1 cursor-pointer">
            <span className="text-zinc-200">{it.label}</span>
            <span className="text-zinc-500"> — {it.description}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function dangerousAllowlistCount(): number {
  return useSettings.getState().autoApproveDangerous?.length ?? 0;
}

export const DANGEROUS_TOTAL = ITEMS.length;
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/danger-approval-list.tsx
git commit -m "feat(sidepanel): add shared DangerApprovalList component"
```

---

## Task 10: DangerApprovalPopover（对话页折叠入口）

**Files:**
- Create: `src/sidepanel/components/danger-approval-popover.tsx`

- [ ] **Step 1: 写入文件**

```tsx
// src/sidepanel/components/danger-approval-popover.tsx
import { useEffect, useRef, useState } from "react";
import { useSettings } from "../chat/settings-store";
import { DANGEROUS_TOTAL, DangerApprovalList } from "./danger-approval-list";

export function DangerApprovalPopover() {
  const settings = useSettings();
  const count = settings.autoApproveDangerous?.length ?? 0;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={
          "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] " +
          (count > 0
            ? "bg-amber-700/40 text-amber-200"
            : "bg-zinc-800 text-zinc-400 hover:text-zinc-200")
        }
        title="dangerous 自动通过白名单"
      >
        <span>⚠</span>
        <span>
          dangerous 自动: {count}/{DANGEROUS_TOTAL}
        </span>
        <span>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-1 w-72 bg-zinc-900 border border-zinc-700 rounded p-2 z-20 shadow-xl">
          <DangerApprovalList />
          <p className="mt-2 text-[10px] text-zinc-500">
            ⚠ 勾选 = 这一类调用不再人工确认。
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/danger-approval-popover.tsx
git commit -m "feat(sidepanel): add DangerApprovalPopover for chat page"
```

---

## Task 11: DangerApprovalGroup（设置页常驻）

**Files:**
- Create: `src/sidepanel/components/danger-approval-group.tsx`

- [ ] **Step 1: 写入文件**

```tsx
// src/sidepanel/components/danger-approval-group.tsx
import { DangerApprovalList } from "./danger-approval-list";

export function DangerApprovalGroup() {
  return (
    <section className="bg-zinc-900 rounded p-3 space-y-2">
      <h3 className="text-zinc-300">自动通过策略</h3>
      <p className="text-zinc-500">
        safe 工具永远自动；caution 工具看下方 toggle；dangerous 工具按下方白名单逐项允许。
      </p>
      <div className="pt-1">
        <span className="text-zinc-400">允许自动执行的 dangerous 工具：</span>
      </div>
      <div className="pl-2 border-l-2 border-zinc-700">
        <DangerApprovalList />
      </div>
      <p className="text-[11px] text-amber-400">
        ⚠ 勾选意味着这一类调用不再人工确认。
      </p>
    </section>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/danger-approval-group.tsx
git commit -m "feat(sidepanel): add DangerApprovalGroup for settings page"
```

---

## Task 12: 集成 DangerApprovalPopover 到 chat-page

**Files:**
- Modify: `src/sidepanel/pages/chat-page.tsx`

- [ ] **Step 1: import 新组件**

在 chat-page imports 区追加：

```ts
import { DangerApprovalPopover } from "../components/danger-approval-popover";
```

- [ ] **Step 2: 替换底部 toolbar**

找到：

```tsx
        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={session.approveAllSafe}
            onChange={(e) => session.setApproveAllSafe(e.target.checked)}
          />
          自动通过 safe + caution
        </label>
```

替换为：

```tsx
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={session.approveAllSafe}
              onChange={(e) => session.setApproveAllSafe(e.target.checked)}
            />
            自动通过 caution
          </label>
          <DangerApprovalPopover />
        </div>
```

注：文案"safe + caution" 改为"caution"——safe 永远 auto，标"safe + caution"会让用户误以为 toggle 关了 safe 也要审，反而冗余。

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/pages/chat-page.tsx
git commit -m "feat(chat-page): wire DangerApprovalPopover + tweak toggle label"
```

---

## Task 13: 集成 DangerApprovalGroup 到 settings-page

**Files:**
- Modify: `src/sidepanel/pages/settings-page.tsx`

- [ ] **Step 1: import**

在 settings-page.tsx imports 区追加：

```ts
import { DangerApprovalGroup } from "../components/danger-approval-group";
```

- [ ] **Step 2: 在 LLM section 之后、备份 section 之前插入**

找到：

```tsx
      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <h3 className="text-zinc-300">备份</h3>
```

在它前面追加：

```tsx
      <DangerApprovalGroup />

```

- [ ] **Step 3: 构建确认**

Run: `pnpm build`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/pages/settings-page.tsx
git commit -m "feat(settings): show DangerApprovalGroup"
```

---

## Task 14: fillInput 工具 + 单测

**Files:**
- Create: `src/content/tools/fill-input.ts`
- Create: `tests/content/tools/fill-input.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/fill-input.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fillInput } from "@/content/tools/fill-input";

describe("fillInput", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("sets value and dispatches input + change on text input", async () => {
    document.body.innerHTML = `<input id="x" type="text" />`;
    const input = document.querySelector<HTMLInputElement>("#x")!;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    const r = await fillInput({ selector: "#x", value: "hello" });
    expect(input.value).toBe("hello");
    expect(events).toEqual(["input", "change"]);
    expect((r as Record<string, unknown>).filled).toBe(true);
  });

  it("clears existing value when clear=true (default)", async () => {
    document.body.innerHTML = `<input id="x" type="text" value="old" />`;
    await fillInput({ selector: "#x", value: "new" });
    expect(document.querySelector<HTMLInputElement>("#x")!.value).toBe("new");
  });

  it("works on textarea", async () => {
    document.body.innerHTML = `<textarea id="x"></textarea>`;
    await fillInput({ selector: "#x", value: "multi\nline" });
    expect(document.querySelector<HTMLTextAreaElement>("#x")!.value).toBe("multi\nline");
  });

  it("works on contenteditable div via textContent + input event", async () => {
    document.body.innerHTML = `<div id="x" contenteditable="true"></div>`;
    const div = document.querySelector<HTMLDivElement>("#x")!;
    const events: string[] = [];
    div.addEventListener("input", () => events.push("input"));
    await fillInput({ selector: "#x", value: "ok" });
    expect(div.textContent).toBe("ok");
    expect(events).toEqual(["input"]);
  });

  it("throws when selector misses", async () => {
    await expect(fillInput({ selector: "#missing", value: "x" })).rejects.toThrow(/selector miss/);
  });

  it("throws when target is not input/textarea/contenteditable", async () => {
    document.body.innerHTML = `<div id="x"></div>`;
    await expect(fillInput({ selector: "#x", value: "x" })).rejects.toThrow(/not an input/);
  });

  // 6 tests
  it("appends when clear=false", async () => {
    document.body.innerHTML = `<input id="x" type="text" value="old" />`;
    await fillInput({ selector: "#x", value: "+more", clear: false });
    expect(document.querySelector<HTMLInputElement>("#x")!.value).toBe("old+more");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/fill-input.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/fill-input.ts
import type { Json } from "@/shared/types";

type Args = {
  selector: string;
  value: string;
  clear?: boolean;
};

export async function fillInput(args: Json): Promise<Json> {
  const { selector, value, clear = true } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value = clear ? value : el.value + value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, kind: el.tagName.toLowerCase() };
  }

  if (el instanceof HTMLElement && el.isContentEditable) {
    el.textContent = clear ? value : (el.textContent ?? "") + value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { filled: true, kind: "contenteditable" };
  }

  throw new Error(`not an input/textarea/contenteditable: ${selector}`);
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/fill-input.test.ts`
Expected: 7 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/fill-input.ts tests/content/tools/fill-input.test.ts
git commit -m "feat(tools): fillInput for input/textarea/contenteditable"
```

---

## Task 15: setCheckbox + 单测

**Files:**
- Create: `src/content/tools/set-checkbox.ts`
- Create: `tests/content/tools/set-checkbox.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/set-checkbox.test.ts
import { describe, expect, it } from "vitest";
import { setCheckbox } from "@/content/tools/set-checkbox";

describe("setCheckbox", () => {
  it("sets checked from false to true and dispatches change", async () => {
    document.body.innerHTML = `<input id="x" type="checkbox" />`;
    const cb = document.querySelector<HTMLInputElement>("#x")!;
    let changed = 0;
    cb.addEventListener("change", () => changed++);
    const r = await setCheckbox({ selector: "#x", checked: true });
    expect(cb.checked).toBe(true);
    expect(changed).toBe(1);
    expect((r as Record<string, unknown>).checked).toBe(true);
  });

  it("noop when already in target state", async () => {
    document.body.innerHTML = `<input id="x" type="checkbox" checked />`;
    const cb = document.querySelector<HTMLInputElement>("#x")!;
    let changed = 0;
    cb.addEventListener("change", () => changed++);
    await setCheckbox({ selector: "#x", checked: true });
    expect(changed).toBe(0);
  });

  it("throws when target is not a checkbox", async () => {
    document.body.innerHTML = `<input id="x" type="text" />`;
    await expect(setCheckbox({ selector: "#x", checked: true })).rejects.toThrow(/not a checkbox/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/set-checkbox.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/set-checkbox.ts
import type { Json } from "@/shared/types";

type Args = { selector: string; checked: boolean };

export async function setCheckbox(args: Json): Promise<Json> {
  const { selector, checked } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (!(el instanceof HTMLInputElement) || el.type !== "checkbox") {
    throw new Error(`not a checkbox: ${selector}`);
  }
  if (el.checked === checked) return { checked, changed: false };
  el.checked = checked;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { checked, changed: true };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/set-checkbox.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/set-checkbox.ts tests/content/tools/set-checkbox.test.ts
git commit -m "feat(tools): setCheckbox"
```

---

## Task 16: selectOption + 单测

**Files:**
- Create: `src/content/tools/select-option.ts`
- Create: `tests/content/tools/select-option.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/select-option.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { selectOption } from "@/content/tools/select-option";

describe("selectOption", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <select id="x">
        <option value="a">Apple</option>
        <option value="b">Banana</option>
        <option value="c">Cherry</option>
      </select>
    `;
  });

  it("selects by value", async () => {
    const r = await selectOption({ selector: "#x", value: "b" });
    expect(document.querySelector<HTMLSelectElement>("#x")!.value).toBe("b");
    expect((r as Record<string, unknown>).value).toBe("b");
  });

  it("selects by label", async () => {
    await selectOption({ selector: "#x", label: "Cherry" });
    expect(document.querySelector<HTMLSelectElement>("#x")!.value).toBe("c");
  });

  it("value wins when both given", async () => {
    await selectOption({ selector: "#x", value: "a", label: "Cherry" });
    expect(document.querySelector<HTMLSelectElement>("#x")!.value).toBe("a");
  });

  it("dispatches change", async () => {
    const sel = document.querySelector<HTMLSelectElement>("#x")!;
    let changed = 0;
    sel.addEventListener("change", () => changed++);
    await selectOption({ selector: "#x", value: "b" });
    expect(changed).toBe(1);
  });

  it("throws when option not found", async () => {
    await expect(selectOption({ selector: "#x", value: "z" })).rejects.toThrow(/option not found/);
  });

  it("throws when target is not a <select>", async () => {
    document.body.innerHTML = `<input id="x" />`;
    await expect(selectOption({ selector: "#x", value: "a" })).rejects.toThrow(/not a select/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/select-option.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/select-option.ts
import type { Json } from "@/shared/types";

type Args = { selector: string; value?: string; label?: string };

export async function selectOption(args: Json): Promise<Json> {
  const { selector, value, label } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`not a select: ${selector}`);
  }
  let target: HTMLOptionElement | null = null;
  for (const opt of Array.from(el.options)) {
    if (value !== undefined && opt.value === value) {
      target = opt;
      break;
    }
  }
  if (!target && label !== undefined) {
    for (const opt of Array.from(el.options)) {
      if (opt.text === label) {
        target = opt;
        break;
      }
    }
  }
  if (!target) {
    throw new Error(`option not found: value=${value ?? "?"} label=${label ?? "?"}`);
  }
  el.value = target.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { value: target.value, label: target.text };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/select-option.test.ts`
Expected: 6 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/select-option.ts tests/content/tools/select-option.test.ts
git commit -m "feat(tools): selectOption by value or label"
```

---

## Task 17: submitForm + 单测

**Files:**
- Create: `src/content/tools/submit-form.ts`
- Create: `tests/content/tools/submit-form.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/submit-form.test.ts
import { describe, expect, it, vi } from "vitest";
import { submitForm } from "@/content/tools/submit-form";

describe("submitForm", () => {
  it("dispatches submit event on form", async () => {
    document.body.innerHTML = `<form id="f"><input name="a" /></form>`;
    const f = document.querySelector<HTMLFormElement>("#f")!;
    let submitted = false;
    f.addEventListener("submit", (e) => {
      submitted = true;
      e.preventDefault(); // 避免 happy-dom 实际 navigate
    });
    const r = await submitForm({ selector: "#f" });
    expect(submitted).toBe(true);
    expect((r as Record<string, unknown>).submitted).toBe(true);
  });

  it("falls back to form.submit() when listener does not preventDefault", async () => {
    document.body.innerHTML = `<form id="f"><input name="a" /></form>`;
    const f = document.querySelector<HTMLFormElement>("#f")!;
    const submitSpy = vi.spyOn(f, "submit").mockImplementation(() => {});
    await submitForm({ selector: "#f" });
    expect(submitSpy).toHaveBeenCalled();
  });

  it("uses default 'form' selector when not given", async () => {
    document.body.innerHTML = `<form><input name="a" /></form>`;
    const f = document.querySelector<HTMLFormElement>("form")!;
    let submitted = false;
    f.addEventListener("submit", (e) => {
      submitted = true;
      e.preventDefault();
    });
    await submitForm({});
    expect(submitted).toBe(true);
  });

  it("throws when no form", async () => {
    document.body.innerHTML = `<div></div>`;
    await expect(submitForm({})).rejects.toThrow(/form not found/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/submit-form.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/submit-form.ts
import type { Json } from "@/shared/types";

type Args = { selector?: string };

export async function submitForm(args: Json): Promise<Json> {
  const { selector = "form" } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`form not found: ${selector}`);
  if (!(el instanceof HTMLFormElement)) {
    throw new Error(`not a form: ${selector}`);
  }
  const ev = new Event("submit", { bubbles: true, cancelable: true });
  const allowed = el.dispatchEvent(ev);
  if (allowed) el.submit();
  return { submitted: true, defaultPrevented: !allowed };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/submit-form.test.ts`
Expected: 4 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/submit-form.ts tests/content/tools/submit-form.test.ts
git commit -m "feat(tools): submitForm with framework-friendly event dispatch"
```

---

## Task 18: hover + 单测

**Files:**
- Create: `src/content/tools/hover.ts`
- Create: `tests/content/tools/hover.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/hover.test.ts
import { describe, expect, it } from "vitest";
import { hover } from "@/content/tools/hover";

describe("hover", () => {
  it("dispatches mouseenter, mouseover, mousemove", async () => {
    document.body.innerHTML = `<div id="x"></div>`;
    const div = document.querySelector<HTMLDivElement>("#x")!;
    const events: string[] = [];
    for (const t of ["mouseenter", "mouseover", "mousemove"]) {
      div.addEventListener(t, () => events.push(t));
    }
    const r = await hover({ selector: "#x" });
    expect(events).toEqual(["mouseenter", "mouseover", "mousemove"]);
    expect((r as Record<string, unknown>).hovered).toBe(true);
  });

  it("throws when selector miss", async () => {
    document.body.innerHTML = "";
    await expect(hover({ selector: "#x" })).rejects.toThrow(/selector miss/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/hover.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/hover.ts
import type { Json } from "@/shared/types";

type Args = { selector: string };

export async function hover(args: Json): Promise<Json> {
  const { selector } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  for (const type of ["mouseenter", "mouseover", "mousemove"]) {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
    );
  }
  return { hovered: true };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/hover.test.ts`
Expected: 2 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/hover.ts tests/content/tools/hover.test.ts
git commit -m "feat(tools): hover dispatches mouse events"
```

---

## Task 19: focus + 单测

**Files:**
- Create: `src/content/tools/focus.ts`
- Create: `tests/content/tools/focus.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/focus.test.ts
import { describe, expect, it } from "vitest";
import { focus } from "@/content/tools/focus";

describe("focus", () => {
  it("focuses and dispatches focus event", async () => {
    document.body.innerHTML = `<input id="x" />`;
    const input = document.querySelector<HTMLInputElement>("#x")!;
    const r = await focus({ selector: "#x" });
    expect(document.activeElement).toBe(input);
    expect((r as Record<string, unknown>).focused).toBe(true);
  });

  it("throws when selector miss", async () => {
    document.body.innerHTML = "";
    await expect(focus({ selector: "#x" })).rejects.toThrow(/selector miss/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/focus.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/focus.ts
import type { Json } from "@/shared/types";

type Args = { selector: string };

export async function focus(args: Json): Promise<Json> {
  const { selector } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (el instanceof HTMLElement) {
    el.focus({ preventScroll: false });
  }
  return { focused: true };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/focus.test.ts`
Expected: 2 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/focus.ts tests/content/tools/focus.test.ts
git commit -m "feat(tools): focus calls el.focus()"
```

---

## Task 20: getValue + 单测

**Files:**
- Create: `src/content/tools/get-value.ts`
- Create: `tests/content/tools/get-value.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/get-value.test.ts
import { describe, expect, it } from "vitest";
import { getValue } from "@/content/tools/get-value";

describe("getValue", () => {
  it("reads input value", async () => {
    document.body.innerHTML = `<input id="x" value="hi" />`;
    expect(await getValue({ selector: "#x" })).toBe("hi");
  });

  it("reads textarea value", async () => {
    document.body.innerHTML = `<textarea id="x">multi\nline</textarea>`;
    expect(await getValue({ selector: "#x" })).toBe("multi\nline");
  });

  it("reads select value", async () => {
    document.body.innerHTML = `<select id="x"><option value="a"></option><option value="b" selected></option></select>`;
    expect(await getValue({ selector: "#x" })).toBe("b");
  });

  it("reads contenteditable text", async () => {
    document.body.innerHTML = `<div id="x" contenteditable="true">edit me</div>`;
    expect(await getValue({ selector: "#x" })).toBe("edit me");
  });

  it("returns null when selector miss", async () => {
    document.body.innerHTML = "";
    expect(await getValue({ selector: "#x" })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/get-value.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/get-value.ts
import type { Json } from "@/shared/types";

type Args = { selector: string };

export async function getValue(args: Json): Promise<Json> {
  const { selector } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) return null;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.value;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return el.textContent ?? "";
  }
  return null;
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/get-value.test.ts`
Expected: 5 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/get-value.ts tests/content/tools/get-value.test.ts
git commit -m "feat(tools): getValue for input/textarea/select/contenteditable"
```

---

## Task 21: extractFormState + 单测

**Files:**
- Create: `src/content/tools/extract-form-state.ts`
- Create: `tests/content/tools/extract-form-state.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/extract-form-state.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { extractFormState } from "@/content/tools/extract-form-state";

describe("extractFormState", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads named text inputs and textarea", async () => {
    document.body.innerHTML = `
      <form>
        <input name="user" value="alice" />
        <input name="email" value="a@b.com" />
        <textarea name="note">hi</textarea>
      </form>
    `;
    const r = (await extractFormState({})) as Record<string, unknown>;
    expect(r).toEqual({ user: "alice", email: "a@b.com", note: "hi" });
  });

  it("captures radio (selected value) and checkbox (boolean or array)", async () => {
    document.body.innerHTML = `
      <form>
        <input type="radio" name="g" value="m" />
        <input type="radio" name="g" value="f" checked />
        <input type="checkbox" name="terms" checked />
        <input type="checkbox" name="tag" value="a" checked />
        <input type="checkbox" name="tag" value="b" />
        <input type="checkbox" name="tag" value="c" checked />
      </form>
    `;
    const r = (await extractFormState({})) as Record<string, unknown>;
    expect(r.g).toBe("f");
    expect(r.terms).toBe(true);
    expect(r.tag).toEqual(["a", "c"]);
  });

  it("scopes to selector", async () => {
    document.body.innerHTML = `
      <form id="a"><input name="x" value="1" /></form>
      <form id="b"><input name="x" value="2" /></form>
    `;
    const r = (await extractFormState({ selector: "#b" })) as Record<string, unknown>;
    expect(r.x).toBe("2");
  });

  it("throws when form not found", async () => {
    document.body.innerHTML = `<div></div>`;
    await expect(extractFormState({ selector: "#missing" })).rejects.toThrow(/form not found/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/extract-form-state.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/extract-form-state.ts
import type { Json } from "@/shared/types";

type Args = { selector?: string };

export async function extractFormState(args: Json): Promise<Json> {
  const { selector = "form" } = (args ?? {}) as Args;
  const form = document.querySelector(selector);
  if (!form) throw new Error(`form not found: ${selector}`);
  if (!(form instanceof HTMLFormElement)) {
    throw new Error(`not a form: ${selector}`);
  }
  const out: Record<string, Json> = {};
  for (const el of Array.from(form.elements)) {
    if (
      !(el instanceof HTMLInputElement) &&
      !(el instanceof HTMLTextAreaElement) &&
      !(el instanceof HTMLSelectElement)
    ) {
      continue;
    }
    const name = el.name;
    if (!name) continue;

    if (el instanceof HTMLInputElement && el.type === "radio") {
      if (el.checked) out[name] = el.value;
      continue;
    }
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      if (el.value && el.value !== "on") {
        const prev = out[name];
        if (Array.isArray(prev)) {
          if (el.checked) prev.push(el.value);
        } else {
          out[name] = el.checked ? [el.value] : [];
        }
      } else {
        out[name] = el.checked;
      }
      continue;
    }
    out[name] = el.value;
  }
  return out as Json;
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/extract-form-state.test.ts`
Expected: 4 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/extract-form-state.ts tests/content/tools/extract-form-state.test.ts
git commit -m "feat(tools): extractFormState reads named inputs/radios/checkboxes"
```

---

## Task 22: uploadFile + 单测

**Files:**
- Create: `src/content/tools/upload-file.ts`
- Create: `tests/content/tools/upload-file.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/upload-file.test.ts
import { describe, expect, it, vi } from "vitest";
import { uploadFile } from "@/content/tools/upload-file";

function setupChromeMock(reply: { ok: boolean; data?: unknown; error?: string }) {
  const sendMessage = vi.fn().mockResolvedValue(reply);
  (globalThis as unknown as { chrome: typeof chrome }).chrome = {
    runtime: { sendMessage }
  } as unknown as typeof chrome;
  return sendMessage;
}

describe("uploadFile", () => {
  it("requests binary via BG and assigns File to input.files", async () => {
    document.body.innerHTML = `<input id="x" type="file" />`;
    const input = document.querySelector<HTMLInputElement>("#x")!;
    let changed = 0;
    input.addEventListener("change", () => changed++);

    const sendMessage = setupChromeMock({
      ok: true,
      data: { base64: btoa("hello"), mime: "text/plain", size: 5 }
    });

    const r = await uploadFile({
      selector: "#x",
      url: "https://example.com/x.txt",
      filename: "hello.txt"
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "http.fetchBinary", url: "https://example.com/x.txt" })
    );
    expect(input.files?.length).toBe(1);
    expect(input.files?.[0].name).toBe("hello.txt");
    expect(input.files?.[0].type).toBe("text/plain");
    expect(changed).toBe(1);
    expect((r as Record<string, unknown>).uploaded).toBe(true);
  });

  it("falls back filename from URL when not given", async () => {
    document.body.innerHTML = `<input id="x" type="file" />`;
    setupChromeMock({
      ok: true,
      data: { base64: btoa("a"), mime: "image/png", size: 1 }
    });
    await uploadFile({ selector: "#x", url: "https://x.com/path/to/pic.png" });
    expect(
      document.querySelector<HTMLInputElement>("#x")!.files?.[0].name
    ).toBe("pic.png");
  });

  it("throws when target is not a file input", async () => {
    document.body.innerHTML = `<input id="x" type="text" />`;
    setupChromeMock({ ok: true, data: { base64: "", mime: "", size: 0 } });
    await expect(uploadFile({ selector: "#x", url: "https://x.com/a" })).rejects.toThrow(/not a file input/);
  });

  it("throws when BG returns ok:false", async () => {
    document.body.innerHTML = `<input id="x" type="file" />`;
    setupChromeMock({ ok: false, error: "404" });
    await expect(uploadFile({ selector: "#x", url: "https://x.com/a" })).rejects.toThrow(/download failed/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/upload-file.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/content/tools/upload-file.ts
import type { Json } from "@/shared/types";

type Args = {
  selector: string;
  url: string;
  filename?: string;
  mime?: string;
};

export async function uploadFile(args: Json): Promise<Json> {
  const { selector, url, filename, mime } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (!(el instanceof HTMLInputElement) || el.type !== "file") {
    throw new Error(`not a file input: ${selector}`);
  }

  const res = (await chrome.runtime.sendMessage({
    type: "http.fetchBinary",
    url
  })) as { ok: true; data: { base64: string; mime: string; size: number } } | { ok: false; error: string };

  if (!res.ok) throw new Error(`download failed: ${res.error}`);

  const { base64, mime: serverMime } = res.data;
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const finalName = filename ?? guessName(url);
  const finalMime = mime ?? serverMime ?? "application/octet-stream";
  const file = new File([buf], finalName, { type: finalMime });

  const dt = new DataTransfer();
  dt.items.add(file);
  Object.defineProperty(el, "files", {
    value: dt.files,
    configurable: true
  });
  el.dispatchEvent(new Event("change", { bubbles: true }));

  return { uploaded: true, name: finalName, mime: finalMime, size: buf.length };
}

function guessName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || "upload";
  } catch {
    return "upload";
  }
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/upload-file.test.ts`
Expected: 4 个 test PASS。

注：`DataTransfer` 在 happy-dom 里支持；`new File` 也支持。如果某个 test 因为 happy-dom 缺少 API 失败，先确认 happy-dom 版本（package.json `^15.0.0` 该有）。

- [ ] **Step 5: Commit**

```bash
git add src/content/tools/upload-file.ts tests/content/tools/upload-file.test.ts
git commit -m "feat(tools): uploadFile via BG http.fetchBinary + File synthesis"
```

---

## Task 23: 注册 9 个新工具到 tools/index.ts

**Files:**
- Modify: `src/content/tools/index.ts`

- [ ] **Step 1: 重写 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { click } from "./click";
import { extractFormState } from "./extract-form-state";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { fillInput } from "./fill-input";
import { focus } from "./focus";
import { getValue } from "./get-value";
import { hover } from "./hover";
import { httpRequestBridge } from "./http-request";
import { querySelector, querySelectorAll } from "./query";
import { readStorage } from "./read-storage";
import { scroll } from "./scroll";
import { selectOption } from "./select-option";
import { setCheckbox } from "./set-checkbox";
import { snapshotDOM } from "./snapshot-dom";
import { submitForm } from "./submit-form";
import { uploadFile } from "./upload-file";
import { waitFor } from "./wait-for";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages,
  scroll,
  waitFor,
  click,
  readStorage,
  httpRequest: httpRequestBridge,
  fillInput,
  setCheckbox,
  selectOption,
  submitForm,
  hover,
  focus,
  uploadFile,
  getValue,
  extractFormState
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/content/tools/index.ts
git commit -m "feat(tools): register 9 new tools in registry"
```

---

## Task 24: messages.ts 的 StepSchema 工具枚举更新

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: 找到 StepSchema 中 z.enum 工具数组并扩展**

定位到：

```ts
    tool: z.enum([
      "snapshotDOM",
      "querySelector",
      "querySelectorAll",
      "extractImages",
      "extractText",
      "scroll",
      "waitFor",
      "click",
      "httpRequest",
      "readStorage"
    ]),
```

替换为：

```ts
    tool: z.enum([
      "snapshotDOM",
      "querySelector",
      "querySelectorAll",
      "extractImages",
      "extractText",
      "scroll",
      "waitFor",
      "click",
      "httpRequest",
      "readStorage",
      "fillInput",
      "setCheckbox",
      "selectOption",
      "submitForm",
      "hover",
      "focus",
      "uploadFile",
      "getValue",
      "extractFormState"
    ]),
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat(shared): extend StepSchema tool enum with 9 new tools"
```

---

## Task 25: tool-schema.ts 加 9 个 LlmTool def

**Files:**
- Modify: `src/sidepanel/llm/tool-schema.ts`

- [ ] **Step 1: 在 TOOL_DEFS 数组末尾追加**

打开 `src/sidepanel/llm/tool-schema.ts`，找到 TOOL_DEFS 的最后一项 `runJS`，在它之前（保持 runJS 在最后）追加：

```ts
  {
    name: "fillInput",
    description: "往 input/textarea/contenteditable 填值；触发 input/change 事件以兼容 React/Vue。clear=true（默认）会先清空再填。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        clear: { type: "boolean", default: true }
      },
      required: ["selector", "value"]
    }
  },
  {
    name: "setCheckbox",
    description: "设置 checkbox 勾选状态；派发 change 事件。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        checked: { type: "boolean" }
      },
      required: ["selector", "checked"]
    }
  },
  {
    name: "selectOption",
    description: "<select> 元素按 value 或 label 选项。同时给两者时优先 value。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        label: { type: "string" }
      },
      required: ["selector"]
    }
  },
  {
    name: "submitForm",
    description: "提交 <form>。会触发服务端动作（下单、留言等），需要审阅。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", default: "form" }
      }
    }
  },
  {
    name: "hover",
    description: "把鼠标悬停在元素上（触发 mouseenter / mouseover / mousemove）。",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"]
    }
  },
  {
    name: "focus",
    description: "把焦点给某元素（触发 focus / focusin）。",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"]
    }
  },
  {
    name: "uploadFile",
    description: "把后端代理拉到的文件填到 <input type=file>。某些站点会拒绝合成 File（isTrusted 校验）。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        url: { type: "string" },
        filename: { type: "string" },
        mime: { type: "string" }
      },
      required: ["selector", "url"]
    }
  },
  {
    name: "getValue",
    description: "读 input/select/textarea/contenteditable 的当前值。",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"]
    }
  },
  {
    name: "extractFormState",
    description: "把 <form> 内所有可填字段读成 {name: value} 对象（radio 取选中值；checkbox 多选取数组）。",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string", default: "form" } }
    }
  },
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/llm/tool-schema.ts
git commit -m "feat(llm): add 9 new tool definitions"
```

---

## Task 26: system-prompt.ts 重写

**Files:**
- Modify: `src/sidepanel/llm/system-prompt.ts`

- [ ] **Step 1: 重写文件**

```ts
// src/sidepanel/llm/system-prompt.ts
export function buildSystemPrompt(input: { url: string; title?: string }): string {
  return [
    "你是 AIPageGo，一个嵌入到浏览器侧边面板的 AI 网页助手。",
    "用户在浏览网页时会请你完成各种任务：",
    "",
    "1. 阅读类：总结、翻译、提取重点、回答关于本页内容的问题",
    "2. 采集类：把图片、文本、列表、评论结构化抓出来给用户",
    "3. 操作类：填写表单、点击按钮、选择下拉、提交表单、上传文件",
    "4. 多步任务：上述任意组合",
    "",
    "工具使用建议：",
    "- 拿到任务先用 snapshotDOM 看一下页面骨架；不确定时用 querySelector* /",
    "  extractText / extractFormState 探查",
    "- 操作前可先 hover/focus 把目标节点带到视野内",
    "- 表单填写：fillInput / setCheckbox / selectOption 优先；按用户描述映射",
    "  字段名，不确定就先用 extractFormState 列出可填字段",
    "- 提交类（submitForm / uploadFile / 带 cookie 的 httpRequest）会触发服务",
    "  端动作，用户可能要求你最后再做、或不要做",
    "- 仅在结构化工具不足时调用 runJS（会经过静态扫描与人工审阅）",
    "",
    "完成任务后用一段简短文本总结，并以 JSON 形式给出最终输出（结构与字段尽量",
    "稳定，方便后续重放）。",
    "",
    "注意：所有工具调用对当前用户可见，dangerous 级别（cookie/eval/withCred/",
    "storage 读取/submitForm/uploadFile）需要明确审阅。",
    "",
    `当前页面 URL: ${input.url}`,
    input.title ? `页面标题: ${input.title}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/llm/system-prompt.ts
git commit -m "feat(llm): rewrite system prompt for read/write/collect/multi-step"
```

---

## Task 27: 文案重命名（manifest / package.json / console / placeholder / save dialog）

**Files:**
- Modify: `package.json`
- Modify: `src/manifest.ts`
- Modify: `src/sidepanel/index.html`
- Modify: `src/background/index.ts`
- Modify: `src/content/index.ts`
- Modify: `src/sidepanel/pages/chat-page.tsx`
- Modify: `src/sidepanel/components/chat-view.tsx`
- Modify: `src/sidepanel/components/save-as-tool-dialog.tsx`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "aipagego",
  "private": true,
  "version": "0.0.1",
  "description": "AIPageGo — AI 网页助手（侧边面板）",
  "type": "module",
  ...
}
```

只改 `name` 与新增 `description`。其他字段不动。

- [ ] **Step 2: `src/manifest.ts`**

```ts
export default defineManifest({
  manifest_version: 3,
  name: "AIPageGo — AI 网页助手",
  description: "让 AI 帮你浏览、总结、操作网页，并把成功的对话固化为可复用工具",
  version: pkg.version,
  action: { default_title: "AIPageGo" },
  side_panel: { default_path: "src/sidepanel/index.html" },
  background: { service_worker: "src/background/index.ts", type: "module" },
  permissions: ["sidePanel", "storage", "scripting", "activeTab", "tabs", "webNavigation"],
  host_permissions: [
    "http://*/*",
    "https://*/*"
  ],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle"
    }
  ],
  web_accessible_resources: [
    { resources: ["src/sidepanel/index.html"], matches: ["<all_urls>"] }
  ]
});
```

- [ ] **Step 3: `src/sidepanel/index.html`**

把 `<title>aipagego2</title>` 改成 `<title>AIPageGo</title>`。

- [ ] **Step 4: console 前缀替换**

`src/background/index.ts` 中：

```ts
console.info("[aipagego2] service worker installed");
```

改 `[aipagego]`。同样改 `console.error("[aipagego2] sidePanel ...")`。

`src/content/index.ts` 中：

```ts
console.info("[aipagego2] content script loaded on", location.href);
```

改 `[aipagego]`。

`src/background/tab-watcher.ts` 中：

```ts
console.warn("[aipagego2] content script inject failed", e);
```

改 `[aipagego]`（如果有）。

也 grep 一遍：

Run: `grep -rn "aipagego2" src/`
确认所有 `[aipagego2]` 都改成 `[aipagego]`。允许残留的：`@/...` 别名（与 `aipagego2` 无关）、`.gitignore`（无关）、`docs/superpowers/` 下的 spec 引用（历史文档，保留）。

- [ ] **Step 5: chat-page placeholder**

打开 `src/sidepanel/pages/chat-page.tsx`，找到 textarea：

```tsx
          placeholder={"描述要采集什么…（Ctrl/⌘ + Enter 发送）"}
```

替换为：

```tsx
          placeholder={'要让 AI 做什么？例如"总结此页"/"填写注册表单"/"采集前 50 条评论"（Ctrl/⌘ + Enter 发送）'}
```

- [ ] **Step 6: chat-view 空状态文案**

打开 `src/sidepanel/components/chat-view.tsx`，找到：

```tsx
        <div className="text-zinc-500 text-xs text-center mt-8">
          描述要采集什么开始对话…
        </div>
```

替换为：

```tsx
        <div className="text-zinc-500 text-xs text-center mt-8">
          输入指令，让 AI 帮你浏览、总结、操作或采集网页…
        </div>
```

- [ ] **Step 7: save-as-tool-dialog 默认名**

打开 `src/sidepanel/components/save-as-tool-dialog.tsx`：

实际上默认名在 `chat-page.tsx` 里通过 `initialName` prop 传入。打开 `src/sidepanel/pages/chat-page.tsx`，找到：

```tsx
          initialName={
            recommendations[0]?.name ?? `采集器 ${new Date().toISOString().slice(0, 10)}`
          }
```

替换为：

```tsx
          initialName={
            recommendations[0]?.name ?? `AIPageGo 任务 ${new Date().toISOString().slice(0, 10)}`
          }
```

- [ ] **Step 8: 类型检查 + 构建确认**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0；`dist/manifest.json` `name` 字段是 `AIPageGo — AI 网页助手`。

- [ ] **Step 9: Commit**

```bash
git add package.json src/manifest.ts src/sidepanel/index.html src/background/index.ts src/content/index.ts src/sidepanel/pages/chat-page.tsx src/sidepanel/components/chat-view.tsx src/background/tab-watcher.ts
git commit -m "chore: rename aipagego2 → AIPageGo in user-facing strings"
```

---

## Task 28: README 重写

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全文替换**

```markdown
# AIPageGo — AI 网页助手

一个浏览器侧边面板里的 AI 助手，能在你正在浏览的网页上：

- **读**：总结、翻译、抽取重点、回答关于本页内容的问题
- **写**：填表、勾选、选下拉、点击按钮、提交表单、上传文件
- **采**：抓主图、详情图、评论列表等结构化数据

任意一段对话产出（无论是读、写还是采）都可以一键固化为 URL 模式匹配的可重放工具，下次打开同类页面时面板顶部 banner 推荐重放。

## 装载

```bash
pnpm install
pnpm build
```

1. `chrome://extensions` → 「开发者模式」 → 「加载已解压的扩展程序」选 `dist/`
2. 任意页面右上角点扩展图标 → 侧边面板打开

## 基本用法

1. 打开「设置」页：
   - Provider 选 Anthropic 或 OpenAI（或填自定义 endpoint 接 LiteLLM / Azure / Ollama）
   - 填入 API Key（建议先选「仅本次会话保存」）
   - 选模型；可在输入框直接填任意 model 名
   - 设置「自动通过策略」：safe 永远 auto、caution 看 toggle、dangerous 按工具白名单
2. 切到「对话」页（默认）：
   - 在底部输入要做什么。例如：
     - 「总结这篇文章三个要点」
     - 「填写注册表单：用户名 alice、邮箱 a@b.com、勾选同意条款」
     - 「把主图、详情图、前 50 条评论拿出来」
   - Ctrl/⌘ + Enter 发送
3. AI 调用工具时：
   - safe（snapshotDOM / extractText / hover / getValue 等）自动跑
   - caution（fillInput / click / setCheckbox 等）默认跟随 toggle
   - dangerous（submitForm / uploadFile / readStorage / 带 cookie 的 httpRequest / 命中扫描的 runJS）默认人工审阅，可在白名单里放行
4. 完成后顶部出现「保存为工具」按钮（点击才弹），保存到工具库
5. 下次打开同模式 URL，面板顶部 banner 推荐重放

## 失败修复

工具详情页跑工具失败时，点「让 AI 修复」会跳到对话页，预填错误上下文，点「发送」让 AI 改新版本。

## DEV 入口

「DEV: JSON」页保留粘 Tool JSON 直接跑的功能，方便调试。

## 测试

```bash
pnpm test            # 全量
pnpm test:watch
```

## 手测脚本

需要真 API Key 的端到端验证：

### 阅读类：总结
1. 打开任意维基百科条目
2. 「对话」输入「用三个要点总结此页」
3. 期望：AI 用 snapshotDOM + extractText（safe，全自动）→ 给出 3 条总结

### 操作类：填表
1. 打开 https://httpbin.org/forms/post（或任意 GitHub Issue 评论框）
2. 输入「填写：客户名 张三，电话 13800000000，比萨配料勾选 mushroom 和 cheese，配送时间 18:00」
3. 期望：AI 用 fillInput / setCheckbox（caution，需勾 toggle 才自动）；submitForm 会要审阅
4. 不点提交退出，验证表单字段确实被填好了

### 采集类
1. 打开 https://shop.example.com/goods.html?goods_id=<任一商品>
2. 输入「把主图和标题拿出来」
3. 期望：AI 用 snapshotDOM + querySelector* + extractImages 完成
4. 完成后保存为工具，重新访问验证 banner 推荐 + 一键重放
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: rewrite README for AIPageGo positioning (read/write/collect)"
```

---

## Task 29: 全量回归

**Files:** 无

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 2: 全量单元测试**

Run: `pnpm test`
Expected: 所有 test PASS。预期数：

- Plan 1+2 共 88 个
- Plan 3 新增：
  - severity.test.ts +5 (allowlist) +3 (新工具分类) = +8
  - run-session.test.ts +1 (allowlist 自动通过)
  - fill-input +7
  - set-checkbox +3
  - select-option +6
  - submit-form +4
  - hover +2
  - focus +2
  - get-value +5
  - extract-form-state +4
  - upload-file +4
  - 共 +46
- 合计 88 + 46 = **134 tests**

如果实际数与预期略不一致（test count 可能因 nested describes 计数方式微差），以 PASS / FAIL 为准。

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: 退出码 0；`dist/manifest.json` 中：
- `name` = `AIPageGo — AI 网页助手`
- `description` 含"浏览、总结、操作"
- `permissions` 含 `webNavigation`
- `host_permissions` 含 `https://*/*`

- [ ] **Step 4: 手测验证**

按 README 三个手测脚本逐一验证：

1. 总结页面：维基百科条目 → 「用三个要点总结此页」
2. 填表：httpbin.org/forms/post → 「填写客户名/电话/勾选/时间」
3. 采集：商品详情页 → 「把主图和标题拿出来」+ 保存 + 重放

如有失败记录控制台报错并修复。

- [ ] **Step 5: 收尾 commit（手测如有 fix）**

```bash
# 通常无新文件
echo "Plan 3 complete"
```

---

## 自检清单（Plan 3 完成后必须确认）

- [ ] 全量单元测试通过（约 134 个）
- [ ] 类型检查通过
- [ ] dist 装载后扩展名显示 `AIPageGo — AI 网页助手`
- [ ] 对话页 placeholder + 空状态文案是新版
- [ ] 设置页有「自动通过策略」段，含 5 个 dangerous 复选框
- [ ] 对话页底部有 ⚠ dangerous 自动 popover，与设置页双向同步
- [ ] 总结 / 填表 / 采集三个手测脚本都跑通
- [ ] 保存为工具仍只在用户点按钮时弹出（保留 Plan 2 的修正）
- [ ] 既有用户的 IDB 工具不丢（DB_NAME 仍是 "aipagego"）

完成后即可启动 Plan 4 候选（动态 host_permissions / 多模态截屏 / navigate / e2e 自动化）。
