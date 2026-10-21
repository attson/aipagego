# Phase 1 — Protocol & Coordinator Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec §7.1（capability 清单）、§7.2（WS 协议消息表）、§7.3（MCP tool 表）落成 `@aipagego/shared` 的三个新子树，然后建一个全内存、零 IO 的 `@aipagego/coordinator` 包实现 session/worker/dispatcher/catalog 状态机。Phase 1 结束时存在一个可单测的"调度核"，但还没有真正的 WS 网络层和扩展接入——那些留给 Phase 2/3。

**Architecture:** `shared/protocol` 用 zod 把 11 条 WS 消息建成 discriminated union；`shared/capability` 把 12 个 capability 编为枚举 + 工具到能力的映射 + scope 集合代数；`shared/mcp-tools` 把 7 个控制平面 MCP 工具的 JSON Schema 列出来 + 19 个 `explore_*` 工具用 builder 生成。`coordinator` 通过依赖注入 `WSHub` / `Clock` / `IdGen` 三个接口，把 SessionManager / WorkerRegistry / Catalog / Dispatcher 四个状态机用 `Coordinator` 类组合起来；所有 IO 通过接口，所有定时器走 Clock 抽象，单测全用假实现。

**Tech Stack:** TypeScript 5.5、zod 3、vitest 2（沿用 Phase 0 工具链）；coordinator 不引入任何运行时新依赖。

**Phase 1 范围警告：** 不创建 `packages/daemon/`、`packages/server/`；不实现真 WebSocket；不改任何扩展代码；不接入 MCP SDK。`coordinator/ws-hub.ts` 只定义接口，实现留到 Phase 3+。

---

## 文件结构总览（Phase 1 结束态）

```
packages/
├─ shared/
│  ├─ package.json                ← 改：exports 新增 ./protocol ./capability ./mcp-tools 三条
│  ├─ src/
│  │  ├─ index.ts                 ← 改：barrel 加 3 个 export *
│  │  ├─ types.ts                 (unchanged)
│  │  ├─ messages.ts              (unchanged — RPC schemas，与 protocol 不同)
│  │  ├─ static-scan.ts           (unchanged)
│  │  ├─ url-pattern.ts           (unchanged)
│  │  ├─ infer-json-schema.ts     (unchanged)
│  │  ├─ protocol/                ← 新
│  │  │  ├─ version.ts            (PROTOCOL_VERSION 等常量)
│  │  │  ├─ envelope.ts           (BaseEnvelope zod schema)
│  │  │  ├─ errors.ts             (ErrorCode enum + ErrorBody schema)
│  │  │  ├─ messages.ts           (11 个消息的 zod schema + 联合类型)
│  │  │  └─ index.ts              (barrel)
│  │  ├─ capability/              ← 新
│  │  │  ├─ catalog.ts            (CAPABILITIES 常量 + Capability type)
│  │  │  ├─ tool-mapping.ts       (BuiltinTool → required Capability)
│  │  │  ├─ algebra.ts            (subset/union/intersection on Set<Capability>)
│  │  │  └─ index.ts              (barrel)
│  │  └─ mcp-tools/               ← 新
│  │     ├─ schemas.ts            (open_session / close_session / list_tools / run_tool / get_quota / list_tabs JSON Schema)
│  │     ├─ explore-builder.ts    (探查类 explore_X 工具的 JSON Schema builder)
│  │     ├─ registry.ts           (聚合所有 MCP 工具)
│  │     └─ index.ts              (barrel)
│  └─ tests/
│     ├─ protocol/
│     │  ├─ messages.test.ts
│     │  └─ envelope.test.ts
│     ├─ capability/
│     │  ├─ algebra.test.ts
│     │  └─ tool-mapping.test.ts
│     └─ mcp-tools/
│        └─ registry.test.ts
│
└─ coordinator/                   ← 新包
   ├─ package.json
   ├─ tsconfig.json
   ├─ vitest.config.ts
   ├─ src/
   │  ├─ types.ts                 (Session / Worker / Quota / 内部 types)
   │  ├─ clock.ts                 (Clock + IdGen 接口 + DefaultClock / DefaultIdGen)
   │  ├─ ws-hub.ts                (WSHub 抽象接口)
   │  ├─ worker-registry.ts       (Worker 注册/查询)
   │  ├─ session-manager.ts       (Session 状态机)
   │  ├─ catalog.ts               (saved_tools 聚合 + url_pattern 过滤)
   │  ├─ dispatcher.ts            (scope 校验 + quota + worker pick)
   │  ├─ coordinator.ts           (Coordinator 类，组合 4 个模块)
   │  └─ index.ts
   └─ tests/
      ├─ worker-registry.test.ts
      ├─ session-manager.test.ts
      ├─ catalog.test.ts
      ├─ dispatcher.test.ts
      └─ coordinator.test.ts      (集成测试)
```

**关键设计**：

1. `shared/protocol` 的消息 schema 跟 `shared/messages.ts` 区别开：`messages.ts` 是 sidepanel↔bg↔content 的 RPC 协议，`protocol/` 是 worker↔coordinator 的 WS 协议。两者形态相似但作用域完全不同
2. `Capability` 是 string literal union（保持 JSON 友好），不用 z.enum 的 nominal type
3. coordinator 全部用纯函数 + 依赖注入：`Coordinator` 类只持有四个子状态机 + 注入的 hub/clock/idGen
4. 不引入定时器（`setTimeout` / `setInterval`）；过期检查由调用者驱动或显式触发 `tick(now)`
5. Tests 用 `FakeClock` / `FakeWSHub` / `FakeIdGen`，行为完全确定性

---

## Task 1: shared/protocol — version, envelope, errors, messages

把 11 条 WS 消息建模成 zod discriminated union。

**Files:**
- Create: `packages/shared/src/protocol/version.ts`
- Create: `packages/shared/src/protocol/envelope.ts`
- Create: `packages/shared/src/protocol/errors.ts`
- Create: `packages/shared/src/protocol/messages.ts`
- Create: `packages/shared/src/protocol/index.ts`
- Create: `packages/shared/tests/protocol/envelope.test.ts`
- Create: `packages/shared/tests/protocol/messages.test.ts`

- [ ] **Step 1: 创建 version.ts**

Create `packages/shared/src/protocol/version.ts`:

```ts
/** WS protocol semver-like integer; bump when wire-incompatible changes happen. */
export const PROTOCOL_VERSION = 1;

/** Default heartbeat interval (ms). Worker pings every N; coordinator pongs. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** Session goes "expired" after this many ms with no tool calls. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** A disconnected session can be reclaimed by the same AI client within this window. */
export const ORPHAN_RECOVERY_MS = 5 * 60 * 1000;

/** Nonce replay-protection window: coordinator caches nonces seen within this many ms. */
export const NONCE_REPLAY_WINDOW_MS = 5 * 60 * 1000;
```

- [ ] **Step 2: 创建 envelope.ts**

Create `packages/shared/src/protocol/envelope.ts`:

```ts
import { z } from "zod";

/**
 * Every WS message carries these envelope fields for transport-level concerns:
 * - nonce: single-use token to detect replay
 * - ts: client clock when the message was constructed (ms since epoch)
 * - protocol_version: PROTOCOL_VERSION at send time; mismatch aborts the connection
 */
export const EnvelopeFields = {
  nonce: z.string().min(1),
  ts: z.number().int().nonnegative(),
  protocol_version: z.number().int().positive()
} as const;

export const EnvelopeSchema = z.object(EnvelopeFields);

export type Envelope = z.infer<typeof EnvelopeSchema>;
```

- [ ] **Step 3: 创建 errors.ts**

Create `packages/shared/src/protocol/errors.ts`:

```ts
import { z } from "zod";

export const ErrorCodes = [
  // ProtocolError (request itself is broken; not retryable)
  "SessionNotFound",
  "SessionExpired",
  "InvalidArgs",
  "PermissionDenied",
  "ToolHashMismatch",
  "ProtocolVersionMismatch",
  "ReplayDetected",
  // WorkerError (browser-side failure; often retryable)
  "WorkerDisconnected",
  "TabClosed",
  "NavigationLost",
  "PageScriptError",
  // CoordinatorError (internal)
  "WorkerBusy",
  "QueueFull",
  "InternalError",
  // Quota
  "SessionExhausted",
  "DangerousQuotaExceeded"
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

export const ErrorBodySchema = z.object({
  code: z.enum(ErrorCodes),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_ms: z.number().int().nonnegative().optional(),
  audit_id: z.string().optional(),
  /** machine-readable extra context, e.g. {denied_capability: "submit:form"} */
  hints: z.record(z.unknown()).optional()
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;
```

- [ ] **Step 4: 创建 messages.ts (11 messages + discriminated union)**

Create `packages/shared/src/protocol/messages.ts`:

```ts
import { z } from "zod";
import { EnvelopeFields } from "./envelope";
import { ErrorBodySchema } from "./errors";

const StepSchema = z.object({
  tool: z.string(),
  args: z.unknown()
});

// === C → S messages ===

export const HelloSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("HELLO"),
  worker_id: z.string().min(1),
  fingerprint: z.object({
    ext_hash: z.string(),
    os: z.string(),
    chrome: z.string()
  }),
  capabilities: z.array(z.string()),
  attended: z.boolean(),
  available_tabs: z.array(
    z.object({
      tab_id: z.string(),
      url: z.string(),
      title: z.string().optional()
    })
  ),
  saved_tools: z.array(
    z.object({
      id: z.string(),
      version: z.number().int().nonnegative(),
      hash: z.string(),
      url_pattern: z.array(z.string()),
      description: z.string().optional()
    })
  ),
  labels: z.array(z.string())
});

export const PingSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("PING")
});

export const TabReadySchema = z.object({
  ...EnvelopeFields,
  type: z.literal("TAB_READY"),
  session_id: z.string(),
  tab_id: z.string(),
  current_url: z.string()
});

export const ProgressSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("PROGRESS"),
  req_id: z.string(),
  partial: z.unknown()
});

export const ResultSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("RESULT"),
  req_id: z.string(),
  ok: z.boolean(),
  return: z.unknown().optional(),
  error: ErrorBodySchema.optional()
});

export const SessionEventSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("SESSION_EVENT"),
  session_id: z.string(),
  kind: z.enum(["navigated", "tab_closed", "audit"]),
  payload: z.unknown()
});

export const StateSnapshotSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("STATE_SNAPSHOT"),
  last_session_states: z.array(
    z.object({
      session_id: z.string(),
      tab_id: z.string(),
      state: z.string()
    })
  )
});

// === S → C messages ===

export const WelcomeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("WELCOME"),
  server_time: z.number(),
  heartbeat_interval_ms: z.number().int().positive(),
  server_pubkey_pin: z.string().optional()
});

export const PongSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("PONG"),
  echo_nonce: z.string()
});

export const OpenTabSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("OPEN_TAB"),
  session_id: z.string(),
  url: z.string(),
  reuse_if_match: z.array(z.string()).optional()
});

export const ExecSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("EXEC"),
  req_id: z.string(),
  session_id: z.string(),
  tab_id: z.string(),
  step: StepSchema
});

export const CloseSessionSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("CLOSE_SESSION"),
  session_id: z.string()
});

// === Discriminated unions ===

export const ClientToServerSchema = z.discriminatedUnion("type", [
  HelloSchema,
  PingSchema,
  TabReadySchema,
  ProgressSchema,
  ResultSchema,
  SessionEventSchema,
  StateSnapshotSchema
]);

export const ServerToClientSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  PongSchema,
  OpenTabSchema,
  ExecSchema,
  CloseSessionSchema
]);

export const ProtocolMessageSchema = z.union([ClientToServerSchema, ServerToClientSchema]);

export type ClientToServer = z.infer<typeof ClientToServerSchema>;
export type ServerToClient = z.infer<typeof ServerToClientSchema>;
export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;

export type Hello = z.infer<typeof HelloSchema>;
export type Welcome = z.infer<typeof WelcomeSchema>;
export type Exec = z.infer<typeof ExecSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
```

- [ ] **Step 5: 创建 protocol/index.ts barrel**

Create `packages/shared/src/protocol/index.ts`:

```ts
export * from "./version";
export * from "./envelope";
export * from "./errors";
export * from "./messages";
```

- [ ] **Step 6: 写 envelope test**

Create `packages/shared/tests/protocol/envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EnvelopeSchema } from "../../src/protocol/envelope";

describe("EnvelopeSchema", () => {
  it("accepts valid envelope", () => {
    const r = EnvelopeSchema.safeParse({
      nonce: "abc-123",
      ts: 1234567890,
      protocol_version: 1
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty nonce", () => {
    const r = EnvelopeSchema.safeParse({
      nonce: "",
      ts: 1,
      protocol_version: 1
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative ts", () => {
    const r = EnvelopeSchema.safeParse({
      nonce: "n",
      ts: -1,
      protocol_version: 1
    });
    expect(r.success).toBe(false);
  });

  it("rejects zero protocol_version", () => {
    const r = EnvelopeSchema.safeParse({
      nonce: "n",
      ts: 1,
      protocol_version: 0
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 7: 跑 envelope test → 失败（schema 还没 export 到 barrel）**

Run: `pnpm --filter @aipagego/shared test tests/protocol/envelope.test.ts`
Expected: All 4 tests PASS (we wrote the schema in Step 2 directly; this test just exercises it).

如果失败：检查 import 路径。

- [ ] **Step 8: 写 messages test**

Create `packages/shared/tests/protocol/messages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  HelloSchema,
  ExecSchema,
  ResultSchema,
  ClientToServerSchema,
  ServerToClientSchema
} from "../../src/protocol/messages";

const envelope = { nonce: "n1", ts: 1, protocol_version: 1 };

describe("HelloSchema", () => {
  it("parses a complete HELLO", () => {
    const r = HelloSchema.safeParse({
      ...envelope,
      type: "HELLO",
      worker_id: "w1",
      fingerprint: { ext_hash: "h", os: "darwin", chrome: "120" },
      capabilities: ["read:dom"],
      attended: true,
      available_tabs: [{ tab_id: "t1", url: "https://example.com" }],
      saved_tools: [],
      labels: ["chrome:macos"]
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing worker_id", () => {
    const r = HelloSchema.safeParse({
      ...envelope,
      type: "HELLO",
      fingerprint: { ext_hash: "", os: "", chrome: "" },
      capabilities: [],
      attended: false,
      available_tabs: [],
      saved_tools: [],
      labels: []
    });
    expect(r.success).toBe(false);
  });
});

describe("ExecSchema", () => {
  it("parses an EXEC", () => {
    const r = ExecSchema.safeParse({
      ...envelope,
      type: "EXEC",
      req_id: "r1",
      session_id: "s1",
      tab_id: "t1",
      step: { tool: "snapshotDOM", args: {} }
    });
    expect(r.success).toBe(true);
  });
});

describe("ResultSchema", () => {
  it("parses ok=true result", () => {
    const r = ResultSchema.safeParse({
      ...envelope,
      type: "RESULT",
      req_id: "r1",
      ok: true,
      return: { html: "<div/>" }
    });
    expect(r.success).toBe(true);
  });

  it("parses ok=false result with error", () => {
    const r = ResultSchema.safeParse({
      ...envelope,
      type: "RESULT",
      req_id: "r1",
      ok: false,
      error: {
        code: "TabClosed",
        message: "tab gone",
        retryable: true
      }
    });
    expect(r.success).toBe(true);
  });
});

describe("ClientToServerSchema discriminated union", () => {
  it("routes HELLO to HelloSchema", () => {
    const r = ClientToServerSchema.safeParse({
      ...envelope,
      type: "HELLO",
      worker_id: "w",
      fingerprint: { ext_hash: "", os: "", chrome: "" },
      capabilities: [],
      attended: false,
      available_tabs: [],
      saved_tools: [],
      labels: []
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown type", () => {
    const r = ClientToServerSchema.safeParse({ ...envelope, type: "UNKNOWN" });
    expect(r.success).toBe(false);
  });
});

describe("ServerToClientSchema discriminated union", () => {
  it("routes OPEN_TAB", () => {
    const r = ServerToClientSchema.safeParse({
      ...envelope,
      type: "OPEN_TAB",
      session_id: "s1",
      url: "https://example.com"
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 9: 跑 messages test**

Run: `pnpm --filter @aipagego/shared test tests/protocol/messages.test.ts`
Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/protocol packages/shared/tests/protocol
git commit -m "feat(shared): add WS protocol schemas + version constants

11 message zod schemas (HELLO/WELCOME/PING/PONG/EXEC/RESULT/PROGRESS/
TAB_READY/SESSION_EVENT/STATE_SNAPSHOT/OPEN_TAB/CLOSE_SESSION) wired
into client→server and server→client discriminated unions. Envelope
fields (nonce/ts/protocol_version) and ErrorBody live in companion
files for reuse."
```

---

## Task 2: shared/capability — catalog, tool-mapping, algebra

把 spec §7.1 的 12 个 capability + 19 个 tool→capability 映射 + 集合代数都实现。

**Files:**
- Create: `packages/shared/src/capability/catalog.ts`
- Create: `packages/shared/src/capability/tool-mapping.ts`
- Create: `packages/shared/src/capability/algebra.ts`
- Create: `packages/shared/src/capability/index.ts`
- Create: `packages/shared/tests/capability/algebra.test.ts`
- Create: `packages/shared/tests/capability/tool-mapping.test.ts`

- [ ] **Step 1: 创建 catalog.ts**

Create `packages/shared/src/capability/catalog.ts`:

```ts
/**
 * Complete capability catalog from spec §7.1. Each capability is a string in
 * "category:name" form. Sets of capabilities make up a session's "scope" —
 * what tools the AI is allowed to call within that session.
 */
export const CAPABILITIES = [
  "read:dom",
  "read:image",
  "read:storage",
  "nav:tab",
  "interact:form",
  "submit:form",
  "upload:file",
  "httpRequest:no-cookie",
  "httpRequest:cookied",
  "runJS:scanned",
  "runJS:unsafe",
  "tab:open"
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities that are auto-granted on every session (safe). */
export const IMPLICIT_CAPABILITIES = new Set<Capability>([
  "read:dom",
  "read:image",
  "nav:tab"
]);

/** Capabilities that always require explicit human approval (dangerous). */
export const DANGEROUS_CAPABILITIES = new Set<Capability>([
  "read:storage",
  "submit:form",
  "upload:file",
  "httpRequest:cookied",
  "runJS:unsafe"
]);

export function isCapability(s: string): s is Capability {
  return (CAPABILITIES as readonly string[]).includes(s);
}
```

- [ ] **Step 2: 创建 tool-mapping.ts**

Create `packages/shared/src/capability/tool-mapping.ts`:

```ts
import type { BuiltinTool } from "../types";
import type { Capability } from "./catalog";

/**
 * Maps each extension built-in tool to the capability needed to call it.
 * Source of truth: spec §7.1 table. Keep in sync with shared/types.ts BuiltinTool.
 *
 * httpRequest is callable two ways (cookied / no-cookie); the caller must
 * pass `cookied: boolean` to disambiguate. Same for runJS (scanned/unsafe).
 */
export function capabilityForTool(
  tool: BuiltinTool,
  opts?: { httpCookied?: boolean; runJsUnsafe?: boolean }
): Capability {
  switch (tool) {
    case "snapshotDOM":
    case "querySelector":
    case "querySelectorAll":
    case "extractText":
    case "extractFormState":
    case "getValue":
      return "read:dom";
    case "extractImages":
      return "read:image";
    case "readStorage":
      return "read:storage";
    case "hover":
    case "focus":
    case "scroll":
    case "waitFor":
      return "nav:tab";
    case "click":
    case "fillInput":
    case "setCheckbox":
    case "selectOption":
      return "interact:form";
    case "submitForm":
      return "submit:form";
    case "uploadFile":
      return "upload:file";
    case "httpRequest":
      return opts?.httpCookied ? "httpRequest:cookied" : "httpRequest:no-cookie";
    default: {
      const _exhaustive: never = tool;
      throw new Error(`capabilityForTool: unknown tool ${_exhaustive}`);
    }
  }
}

/**
 * runJS is special — capability depends on the static-scan verdict, which is
 * decided by the caller. This helper takes the bool directly.
 */
export function capabilityForRunJs(unsafe: boolean): Capability {
  return unsafe ? "runJS:unsafe" : "runJS:scanned";
}

/**
 * Capability required for the control-plane tab operations.
 */
export const TAB_OPEN_CAPABILITY: Capability = "tab:open";
```

- [ ] **Step 3: 创建 algebra.ts**

Create `packages/shared/src/capability/algebra.ts`:

```ts
import type { Capability } from "./catalog";
import { IMPLICIT_CAPABILITIES } from "./catalog";

/** Pure-set operations over Capability sets. ReadonlySet for input safety. */

export function subset(a: ReadonlySet<Capability>, b: ReadonlySet<Capability>): boolean {
  for (const c of a) if (!b.has(c)) return false;
  return true;
}

export function union(
  a: ReadonlySet<Capability>,
  b: ReadonlySet<Capability>
): Set<Capability> {
  const out = new Set<Capability>(a);
  for (const c of b) out.add(c);
  return out;
}

export function intersection(
  a: ReadonlySet<Capability>,
  b: ReadonlySet<Capability>
): Set<Capability> {
  const out = new Set<Capability>();
  for (const c of a) if (b.has(c)) out.add(c);
  return out;
}

/**
 * Effective scope = requested scope ∪ implicit capabilities. Use this when
 * checking whether a tool call is allowed: the auto-granted (read:dom etc.)
 * capabilities don't need to be explicitly requested.
 */
export function effectiveScope(requested: ReadonlySet<Capability>): Set<Capability> {
  return union(requested, IMPLICIT_CAPABILITIES);
}

/** Does the effective scope cover the single required capability? */
export function scopeCovers(
  requested: ReadonlySet<Capability>,
  required: Capability
): boolean {
  return effectiveScope(requested).has(required);
}
```

- [ ] **Step 4: 创建 capability/index.ts barrel**

Create `packages/shared/src/capability/index.ts`:

```ts
export * from "./catalog";
export * from "./tool-mapping";
export * from "./algebra";
```

- [ ] **Step 5: 写 algebra test**

Create `packages/shared/tests/capability/algebra.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Capability } from "../../src/capability/catalog";
import {
  subset,
  union,
  intersection,
  effectiveScope,
  scopeCovers
} from "../../src/capability/algebra";

const s = (...xs: Capability[]) => new Set<Capability>(xs);

describe("subset", () => {
  it("empty set is subset of anything", () => {
    expect(subset(s(), s("read:dom"))).toBe(true);
  });
  it("equal sets are subsets", () => {
    expect(subset(s("read:dom"), s("read:dom"))).toBe(true);
  });
  it("missing element fails", () => {
    expect(subset(s("submit:form"), s("read:dom"))).toBe(false);
  });
});

describe("union", () => {
  it("combines disjoint sets", () => {
    const u = union(s("read:dom"), s("submit:form"));
    expect(u.has("read:dom")).toBe(true);
    expect(u.has("submit:form")).toBe(true);
    expect(u.size).toBe(2);
  });
  it("dedupes overlapping", () => {
    const u = union(s("read:dom"), s("read:dom"));
    expect(u.size).toBe(1);
  });
});

describe("intersection", () => {
  it("returns shared elements", () => {
    const i = intersection(s("read:dom", "submit:form"), s("submit:form", "upload:file"));
    expect(i.has("submit:form")).toBe(true);
    expect(i.size).toBe(1);
  });
});

describe("effectiveScope", () => {
  it("adds implicit safe capabilities", () => {
    const e = effectiveScope(s("submit:form"));
    expect(e.has("read:dom")).toBe(true);
    expect(e.has("read:image")).toBe(true);
    expect(e.has("nav:tab")).toBe(true);
    expect(e.has("submit:form")).toBe(true);
  });
});

describe("scopeCovers", () => {
  it("returns true for implicit capability even when not requested", () => {
    expect(scopeCovers(s(), "read:dom")).toBe(true);
  });
  it("returns true for explicitly requested capability", () => {
    expect(scopeCovers(s("submit:form"), "submit:form")).toBe(true);
  });
  it("returns false for missing dangerous capability", () => {
    expect(scopeCovers(s("interact:form"), "submit:form")).toBe(false);
  });
});
```

- [ ] **Step 6: 写 tool-mapping test**

Create `packages/shared/tests/capability/tool-mapping.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  capabilityForTool,
  capabilityForRunJs
} from "../../src/capability/tool-mapping";

describe("capabilityForTool", () => {
  it("read:dom for safe inspectors", () => {
    expect(capabilityForTool("snapshotDOM")).toBe("read:dom");
    expect(capabilityForTool("getValue")).toBe("read:dom");
    expect(capabilityForTool("extractFormState")).toBe("read:dom");
  });
  it("read:image for extractImages", () => {
    expect(capabilityForTool("extractImages")).toBe("read:image");
  });
  it("read:storage for readStorage", () => {
    expect(capabilityForTool("readStorage")).toBe("read:storage");
  });
  it("nav:tab for movement", () => {
    expect(capabilityForTool("hover")).toBe("nav:tab");
    expect(capabilityForTool("scroll")).toBe("nav:tab");
    expect(capabilityForTool("waitFor")).toBe("nav:tab");
  });
  it("interact:form for caution interactions", () => {
    expect(capabilityForTool("click")).toBe("interact:form");
    expect(capabilityForTool("fillInput")).toBe("interact:form");
    expect(capabilityForTool("setCheckbox")).toBe("interact:form");
    expect(capabilityForTool("selectOption")).toBe("interact:form");
  });
  it("submit:form for submitForm", () => {
    expect(capabilityForTool("submitForm")).toBe("submit:form");
  });
  it("upload:file for uploadFile", () => {
    expect(capabilityForTool("uploadFile")).toBe("upload:file");
  });
  it("httpRequest splits by cookied option", () => {
    expect(capabilityForTool("httpRequest", { httpCookied: false })).toBe(
      "httpRequest:no-cookie"
    );
    expect(capabilityForTool("httpRequest", { httpCookied: true })).toBe(
      "httpRequest:cookied"
    );
  });
});

describe("capabilityForRunJs", () => {
  it("runJS:scanned when scan passed", () => {
    expect(capabilityForRunJs(false)).toBe("runJS:scanned");
  });
  it("runJS:unsafe when scan failed", () => {
    expect(capabilityForRunJs(true)).toBe("runJS:unsafe");
  });
});
```

- [ ] **Step 7: 跑两个 test 文件**

Run: `pnpm --filter @aipagego/shared test tests/capability/`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/capability packages/shared/tests/capability
git commit -m "feat(shared): add capability catalog + tool mapping + algebra

12 capabilities from spec §7.1, with implicit safe set (read:dom,
read:image, nav:tab) auto-granted on every session. Tool→capability
mapping is exhaustive over BuiltinTool. Set algebra (subset/union/
intersection/effectiveScope/scopeCovers) is pure-functional, no IO."
```

---

## Task 3: shared/mcp-tools — schemas, explore-builder, registry

把 spec §7.3 的 6 个控制平面工具 + explore_* builder 实现。

**Files:**
- Create: `packages/shared/src/mcp-tools/schemas.ts`
- Create: `packages/shared/src/mcp-tools/explore-builder.ts`
- Create: `packages/shared/src/mcp-tools/registry.ts`
- Create: `packages/shared/src/mcp-tools/index.ts`
- Create: `packages/shared/tests/mcp-tools/registry.test.ts`

- [ ] **Step 1: 创建 schemas.ts**

Create `packages/shared/src/mcp-tools/schemas.ts`:

```ts
import type { JsonSchema } from "../types";

/**
 * JSON Schema for each control-plane MCP tool's input. We use plain JSON
 * Schema objects (not zod) because MCP SDK consumes them as-is.
 */

export const OPEN_SESSION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["url", "capabilities"],
  properties: {
    url: { type: "string", description: "Initial URL or URL pattern for the session's tab" },
    labels: {
      type: "array",
      items: { type: "string" },
      description: "Worker labels to prefer (e.g. 'logged-in:shop')"
    },
    capabilities: {
      type: "array",
      items: { type: "string" },
      description: "Requested capability scope (e.g. ['interact:form','submit:form'])"
    },
    idle_timeout_min: {
      type: "number",
      description: "Override default 30-minute idle timeout"
    }
  },
  additionalProperties: false
};

export const CLOSE_SESSION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["session_id"],
  properties: {
    session_id: { type: "string" }
  },
  additionalProperties: false
};

export const LIST_TOOLS_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["session_id"],
  properties: {
    session_id: { type: "string" }
  },
  additionalProperties: false
};

export const RUN_TOOL_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["session_id", "tool_id", "input"],
  properties: {
    session_id: { type: "string" },
    tool_id: { type: "string", description: "Saved tool ID returned by list_tools" },
    input: { description: "Tool-specific input (depends on the saved tool's schema)" }
  },
  additionalProperties: false
};

export const GET_QUOTA_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["session_id"],
  properties: {
    session_id: { type: "string" }
  },
  additionalProperties: false
};

export const LIST_TABS_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["session_id"],
  properties: {
    session_id: { type: "string" }
  },
  additionalProperties: false
};
```

- [ ] **Step 2: 创建 explore-builder.ts**

Create `packages/shared/src/mcp-tools/explore-builder.ts`:

```ts
import type { JsonSchema } from "../types";

/**
 * Each low-level explore_<tool> MCP tool wraps one extension built-in tool.
 * It accepts the same args as the underlying tool plus a session_id.
 *
 * inputSchema parameter is the tool's native args schema (likely from the
 * extension's tool definition). This helper just composes it with the
 * session_id wrapper.
 */
export function buildExploreInputSchema(toolArgsSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      args: toolArgsSchema
    },
    additionalProperties: false
  };
}

export function exploreToolName(builtinTool: string): string {
  return `explore_${builtinTool}`;
}
```

- [ ] **Step 3: 创建 registry.ts**

Create `packages/shared/src/mcp-tools/registry.ts`:

```ts
import type { JsonSchema } from "../types";
import {
  OPEN_SESSION_INPUT_SCHEMA,
  CLOSE_SESSION_INPUT_SCHEMA,
  LIST_TOOLS_INPUT_SCHEMA,
  RUN_TOOL_INPUT_SCHEMA,
  GET_QUOTA_INPUT_SCHEMA,
  LIST_TABS_INPUT_SCHEMA
} from "./schemas";

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export const CONTROL_PLANE_TOOLS: readonly McpToolDef[] = [
  {
    name: "open_session",
    description:
      "Open a new session: pick a worker matching url+labels, request capability scope, get a session_id for follow-up calls.",
    inputSchema: OPEN_SESSION_INPUT_SCHEMA
  },
  {
    name: "close_session",
    description: "Close an open session and release its worker assignment.",
    inputSchema: CLOSE_SESSION_INPUT_SCHEMA
  },
  {
    name: "list_tools",
    description:
      "List saved high-level tools available to this session, filtered by URL pattern matching.",
    inputSchema: LIST_TOOLS_INPUT_SCHEMA
  },
  {
    name: "run_tool",
    description:
      "Run a saved tool by id with the given input. Returns the tool's final result; progress notifications stream while it runs.",
    inputSchema: RUN_TOOL_INPUT_SCHEMA
  },
  {
    name: "get_quota",
    description:
      "Report remaining budget for the session: steps left, dangerous calls left, time to expiry.",
    inputSchema: GET_QUOTA_INPUT_SCHEMA
  },
  {
    name: "list_tabs",
    description: "List tabs currently attached to (or available within) the session.",
    inputSchema: LIST_TABS_INPUT_SCHEMA
  }
] as const;

export const CONTROL_PLANE_TOOL_NAMES = CONTROL_PLANE_TOOLS.map((t) => t.name);
```

- [ ] **Step 4: 创建 mcp-tools/index.ts barrel**

Create `packages/shared/src/mcp-tools/index.ts`:

```ts
export * from "./schemas";
export * from "./explore-builder";
export * from "./registry";
```

- [ ] **Step 5: 写 registry test**

Create `packages/shared/tests/mcp-tools/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CONTROL_PLANE_TOOLS,
  CONTROL_PLANE_TOOL_NAMES
} from "../../src/mcp-tools/registry";
import {
  buildExploreInputSchema,
  exploreToolName
} from "../../src/mcp-tools/explore-builder";

describe("CONTROL_PLANE_TOOLS", () => {
  it("has exactly 6 control-plane tools", () => {
    expect(CONTROL_PLANE_TOOLS).toHaveLength(6);
  });
  it("includes the 6 expected names", () => {
    expect(new Set(CONTROL_PLANE_TOOL_NAMES)).toEqual(
      new Set([
        "open_session",
        "close_session",
        "list_tools",
        "run_tool",
        "get_quota",
        "list_tabs"
      ])
    );
  });
  it("each tool has a non-empty description and an inputSchema", () => {
    for (const t of CONTROL_PLANE_TOOLS) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
      expect((t.inputSchema as { type?: string }).type).toBe("object");
    }
  });
});

describe("buildExploreInputSchema", () => {
  it("wraps the inner args schema under args, with required session_id", () => {
    const inner = { type: "object", properties: { selector: { type: "string" } } };
    const out = buildExploreInputSchema(inner);
    expect((out as { type: string }).type).toBe("object");
    expect((out as { required: string[] }).required).toEqual(["session_id"]);
    expect(
      ((out as { properties: { args: unknown } }).properties.args as unknown)
    ).toEqual(inner);
  });
});

describe("exploreToolName", () => {
  it("prefixes with explore_", () => {
    expect(exploreToolName("snapshotDOM")).toBe("explore_snapshotDOM");
    expect(exploreToolName("submitForm")).toBe("explore_submitForm");
  });
});
```

- [ ] **Step 6: 跑 test**

Run: `pnpm --filter @aipagego/shared test tests/mcp-tools/`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/mcp-tools packages/shared/tests/mcp-tools
git commit -m "feat(shared): add MCP tool registry + explore_* builder

6 control-plane tools (open/close_session, list_tools, run_tool,
get_quota, list_tabs) from spec §7.3 with JSON Schema input shapes.
buildExploreInputSchema + exploreToolName let consumers compose
low-level explore_<tool> MCP tools that wrap extension built-ins."
```

---

## Task 4: 更新 shared 包对外 exports

`packages/shared/package.json` 的 `exports` map 加新子路径；`packages/shared/src/index.ts` barrel 加 re-export。

**Files:**
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 修改 exports map**

Open `packages/shared/package.json`, in the `exports` field add 3 new entries — final shape:

```json
{
  "name": "@aipagego/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./messages": "./src/messages.ts",
    "./static-scan": "./src/static-scan.ts",
    "./url-pattern": "./src/url-pattern.ts",
    "./infer-json-schema": "./src/infer-json-schema.ts",
    "./protocol": "./src/protocol/index.ts",
    "./capability": "./src/capability/index.ts",
    "./mcp-tools": "./src/mcp-tools/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

Only the 3 new lines under `exports` are added — everything else unchanged.

- [ ] **Step 2: 修改 shared barrel**

Open `packages/shared/src/index.ts`. The current barrel uses `export *` across 5 modules. Add 3 more — final shape:

```ts
export * from "./types";
export * from "./messages";
export * from "./static-scan";
export * from "./url-pattern";
export * from "./infer-json-schema";
export * from "./protocol";
export * from "./capability";
export * from "./mcp-tools";
```

If `export *` causes naming collisions (e.g. both `messages.ts` and `protocol/messages.ts` export something named `XSchema`), switch the latter to a named re-export instead:

```ts
export * as Protocol from "./protocol";  // namespace import
export * as Capability from "./capability";
export * as McpTools from "./mcp-tools";
```

Run `pnpm --filter @aipagego/shared typecheck` and see if any error. If clean, prefer the simple `export *` form.

- [ ] **Step 3: 跑 typecheck**

Run: `pnpm --filter @aipagego/shared typecheck`
Expected: 0 errors.

- [ ] **Step 4: 跑全包测试**

Run: `pnpm --filter @aipagego/shared test`
Expected: all tests PASS (now includes 3 new test directories + the original 4 files).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/package.json packages/shared/src/index.ts
git commit -m "feat(shared): expose protocol/capability/mcp-tools via exports map"
```

---

## Task 5: packages/coordinator 包骨架

新建 coordinator package — 最小骨架 + zod + workspace 链接。

**Files:**
- Create: `packages/coordinator/package.json`
- Create: `packages/coordinator/tsconfig.json`
- Create: `packages/coordinator/vitest.config.ts`
- Create: `packages/coordinator/src/index.ts` (placeholder)

- [ ] **Step 1: 创建 package.json**

Create `packages/coordinator/package.json`:

```json
{
  "name": "@aipagego/coordinator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@aipagego/shared": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

Create `packages/coordinator/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src", "tests"]
}
```

Note `"types": []` (matches our Phase 0 fix for shared — no implicit `@types/node`).

- [ ] **Step 3: 创建 vitest.config.ts**

Create `packages/coordinator/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
```

- [ ] **Step 4: 创建占位 src/index.ts**

Create `packages/coordinator/src/index.ts`:

```ts
/** Placeholder. Real exports added in Tasks 6-11. */
export const COORDINATOR_PACKAGE_VERSION = "0.0.0";
```

- [ ] **Step 5: 装依赖**

Run: `pnpm install`
Expected: completes; `packages/coordinator/node_modules/@aipagego/shared` resolves (via pnpm `.pnpm` indirection).

- [ ] **Step 6: 跑 typecheck + test (empty test set OK)**

Run:
```bash
pnpm --filter @aipagego/coordinator typecheck
pnpm --filter @aipagego/coordinator test --passWithNoTests
```
Expected: typecheck 0 errors; test prints "no test files" but exits 0.

If `vitest run` errors with "No test suite found", we'll add a dummy test in Task 6 — or invoke with `--passWithNoTests` flag.

- [ ] **Step 7: Commit**

```bash
git add packages/coordinator pnpm-lock.yaml
git commit -m "feat(coordinator): add @aipagego/coordinator package scaffold"
```

---

## Task 6: coordinator types, clock, ws-hub interface

奠定 coordinator 的"基础名词"——内部类型、Clock 接口（让测试控制时间）、IdGen 接口（让测试控制 uuid）、WSHub 抽象接口。

**Files:**
- Create: `packages/coordinator/src/types.ts`
- Create: `packages/coordinator/src/clock.ts`
- Create: `packages/coordinator/src/ws-hub.ts`
- Create: `packages/coordinator/tests/clock.test.ts`

- [ ] **Step 1: 创建 types.ts**

Create `packages/coordinator/src/types.ts`:

```ts
import type { Capability } from "@aipagego/shared/capability";

/** Internal coordinator types. None of these cross the WS wire — those are in @aipagego/shared/protocol. */

export type SessionState = "active" | "expired" | "paused" | "error" | "closed" | "orphan";

export interface Session {
  id: string;
  ai_client_fingerprint: string;
  worker_id: string;
  tab_id: string;
  scope: ReadonlySet<Capability>;
  state: SessionState;
  created_at: number;
  last_activity_at: number;
  idle_timeout_ms: number;
  /** Number of tool calls (any kind) executed in this session. */
  step_count: number;
  /** Number of dangerous tool calls; capped to prevent runaway. */
  dangerous_count: number;
  /** Filled when state transitions to orphan, used for recovery window. */
  orphaned_at?: number;
  error?: { code: string; message: string };
}

export interface WorkerFingerprint {
  ext_hash: string;
  os: string;
  chrome: string;
}

export interface TabInfo {
  tab_id: string;
  url: string;
  title?: string;
}

export interface SavedToolMetadata {
  id: string;
  version: number;
  hash: string;
  url_pattern: string[];
  description?: string;
}

export interface Worker {
  id: string;
  fingerprint: WorkerFingerprint;
  /** What the worker can do. Different from session.scope (what current AI is allowed). */
  capabilities: ReadonlySet<Capability>;
  attended: boolean;
  labels: ReadonlySet<string>;
  available_tabs: TabInfo[];
  saved_tools: SavedToolMetadata[];
  protocol_version: number;
  connected_at: number;
  last_heartbeat_at: number;
}

export interface Quota {
  max_steps: number;
  steps_used: number;
  max_dangerous: number;
  dangerous_used: number;
  /** Milliseconds until the session expires (undefined if no expiry). */
  ms_until_expiry?: number;
}

export const QUOTA_DEFAULTS = {
  max_steps_per_session: 200,
  max_dangerous_per_session: 50
} as const;
```

- [ ] **Step 2: 创建 clock.ts**

Create `packages/coordinator/src/clock.ts`:

```ts
/** Pure-IO abstractions so coordinator can be exercised with FakeClock + FakeIdGen. */

export interface Clock {
  now(): number;
}

export interface IdGen {
  next(prefix?: string): string;
}

export class DefaultClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class DefaultIdGen implements IdGen {
  private counter = 0;
  next(prefix = ""): string {
    this.counter += 1;
    return `${prefix}${prefix ? "_" : ""}${Date.now().toString(36)}_${this.counter}`;
  }
}

/** For tests. Advance time by calling tick(). */
export class FakeClock implements Clock {
  constructor(private current: number = 0) {}
  now(): number {
    return this.current;
  }
  set(t: number) {
    this.current = t;
  }
  tick(ms: number) {
    this.current += ms;
  }
}

/** For tests. Yields deterministic IDs prefix_1, prefix_2, ... */
export class FakeIdGen implements IdGen {
  private counter = 0;
  next(prefix = "id"): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
  reset() {
    this.counter = 0;
  }
}
```

- [ ] **Step 3: 创建 ws-hub.ts (abstract interface only)**

Create `packages/coordinator/src/ws-hub.ts`:

```ts
import type { ClientToServer, ServerToClient } from "@aipagego/shared/protocol";

/**
 * Transport abstraction. Implementations:
 *   - LoopbackWSHub (Phase 3, daemon's local WS server)
 *   - TlsWSHub (Phase 4, server's TLS WS endpoint)
 *   - FakeWSHub (tests)
 *
 * Coordinator never touches sockets directly — it only uses this interface.
 */
export interface WSHub {
  /** Send a server→client message to a specific worker. Throws on unknown worker_id. */
  send(worker_id: string, msg: ServerToClient): Promise<void>;

  /** Register a handler invoked for each client→server message. */
  onMessage(handler: (worker_id: string, msg: ClientToServer) => void): void;

  /** Register a handler invoked when a worker's WS link drops. */
  onDisconnect(handler: (worker_id: string) => void): void;

  /** Currently connected worker ids. */
  connectedWorkers(): string[];

  /** Force-disconnect a worker (e.g. on protocol-version mismatch). */
  disconnect(worker_id: string, reason: string): Promise<void>;
}
```

- [ ] **Step 4: 写 clock test**

Create `packages/coordinator/tests/clock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeClock, FakeIdGen } from "../src/clock";

describe("FakeClock", () => {
  it("starts at 0 by default", () => {
    const c = new FakeClock();
    expect(c.now()).toBe(0);
  });
  it("tick advances time", () => {
    const c = new FakeClock(100);
    c.tick(50);
    expect(c.now()).toBe(150);
  });
  it("set jumps to exact value", () => {
    const c = new FakeClock();
    c.set(9999);
    expect(c.now()).toBe(9999);
  });
});

describe("FakeIdGen", () => {
  it("yields predictable sequence", () => {
    const g = new FakeIdGen();
    expect(g.next("session")).toBe("session_1");
    expect(g.next("session")).toBe("session_2");
    expect(g.next("req")).toBe("req_3");
  });
  it("reset goes back to 0", () => {
    const g = new FakeIdGen();
    g.next("a");
    g.next("a");
    g.reset();
    expect(g.next("a")).toBe("a_1");
  });
});
```

- [ ] **Step 5: 跑 test**

Run: `pnpm --filter @aipagego/coordinator test`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/coordinator/src packages/coordinator/tests
git commit -m "feat(coordinator): add types + Clock/IdGen/WSHub abstractions

Pure-IO interfaces so the state machines stay deterministic in tests.
FakeClock and FakeIdGen will be used by every subsequent test file."
```

---

## Task 7: coordinator/worker-registry.ts

Worker 注册中心：连接时登记，心跳时更新，断开时移除。

**Files:**
- Create: `packages/coordinator/src/worker-registry.ts`
- Create: `packages/coordinator/tests/worker-registry.test.ts`

- [ ] **Step 1: 写 worker-registry test (red first)**

Create `packages/coordinator/tests/worker-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WorkerRegistry } from "../src/worker-registry";
import { FakeClock } from "../src/clock";
import type { Worker } from "../src/types";

function makeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    fingerprint: { ext_hash: "h", os: "darwin", chrome: "120" },
    capabilities: new Set(["read:dom", "interact:form"]),
    attended: true,
    labels: new Set(),
    available_tabs: [],
    saved_tools: [],
    protocol_version: 1,
    connected_at: 0,
    last_heartbeat_at: 0,
    ...overrides
  };
}

describe("WorkerRegistry.register", () => {
  it("adds a new worker", () => {
    const clock = new FakeClock(1000);
    const r = new WorkerRegistry(clock);
    r.register(makeWorker("w1"));
    expect(r.get("w1")?.id).toBe("w1");
    expect(r.list().length).toBe(1);
  });

  it("rejects duplicate registration", () => {
    const clock = new FakeClock();
    const r = new WorkerRegistry(clock);
    r.register(makeWorker("w1"));
    expect(() => r.register(makeWorker("w1"))).toThrow(/already registered/);
  });
});

describe("WorkerRegistry.unregister", () => {
  it("removes a worker", () => {
    const clock = new FakeClock();
    const r = new WorkerRegistry(clock);
    r.register(makeWorker("w1"));
    r.unregister("w1");
    expect(r.get("w1")).toBeUndefined();
  });

  it("unregister missing worker is a no-op", () => {
    const r = new WorkerRegistry(new FakeClock());
    expect(() => r.unregister("missing")).not.toThrow();
  });
});

describe("WorkerRegistry.heartbeat", () => {
  it("updates last_heartbeat_at", () => {
    const clock = new FakeClock(1000);
    const r = new WorkerRegistry(clock);
    r.register(makeWorker("w1", { last_heartbeat_at: 1000 }));
    clock.set(2000);
    r.heartbeat("w1");
    expect(r.get("w1")?.last_heartbeat_at).toBe(2000);
  });

  it("heartbeat for missing worker is a no-op", () => {
    const r = new WorkerRegistry(new FakeClock());
    expect(() => r.heartbeat("missing")).not.toThrow();
  });
});

describe("WorkerRegistry.pickForUrl", () => {
  it("returns workers whose saved_tools cover the url", () => {
    const r = new WorkerRegistry(new FakeClock());
    r.register(
      makeWorker("w1", {
        saved_tools: [
          { id: "shop", version: 1, hash: "h", url_pattern: ["https://*.example.com/**"] }
        ]
      })
    );
    r.register(makeWorker("w2"));
    const matches = r.pickForUrl("https://shop.example.com/goods.html?id=1");
    expect(matches.map((w) => w.id)).toEqual(["w1"]);
  });

  it("returns empty when no worker matches", () => {
    const r = new WorkerRegistry(new FakeClock());
    r.register(makeWorker("w1"));
    expect(r.pickForUrl("https://example.com")).toEqual([]);
  });

  it("prefers workers with matching labels", () => {
    const r = new WorkerRegistry(new FakeClock());
    r.register(
      makeWorker("w1", {
        labels: new Set(["logged-in:shop"]),
        saved_tools: [
          { id: "shop", version: 1, hash: "h", url_pattern: ["https://*.example.com/**"] }
        ]
      })
    );
    r.register(
      makeWorker("w2", {
        saved_tools: [
          { id: "shop", version: 1, hash: "h", url_pattern: ["https://*.example.com/**"] }
        ]
      })
    );
    const matches = r.pickForUrl("https://shop.example.com/", ["logged-in:shop"]);
    expect(matches[0].id).toBe("w1");
  });
});
```

- [ ] **Step 2: 跑 test → 失败（class not defined）**

Run: `pnpm --filter @aipagego/coordinator test tests/worker-registry.test.ts`
Expected: FAIL (cannot import WorkerRegistry).

- [ ] **Step 3: 实现 worker-registry.ts**

Create `packages/coordinator/src/worker-registry.ts`:

```ts
import { matchesAny } from "@aipagego/shared/url-pattern";
import type { Clock } from "./clock";
import type { Worker } from "./types";

export class WorkerRegistry {
  private workers = new Map<string, Worker>();

  constructor(private clock: Clock) {}

  register(w: Worker): void {
    if (this.workers.has(w.id)) {
      throw new Error(`Worker ${w.id} already registered`);
    }
    this.workers.set(w.id, { ...w, connected_at: this.clock.now() });
  }

  unregister(id: string): void {
    this.workers.delete(id);
  }

  get(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  list(): Worker[] {
    return [...this.workers.values()];
  }

  heartbeat(id: string): void {
    const w = this.workers.get(id);
    if (!w) return;
    this.workers.set(id, { ...w, last_heartbeat_at: this.clock.now() });
  }

  /**
   * Pick workers whose saved_tools have any url_pattern matching the given URL.
   * When labels are provided, workers carrying any matching label sort first.
   */
  pickForUrl(url: string, preferLabels: string[] = []): Worker[] {
    const all = this.list();
    const matching = all.filter((w) =>
      w.saved_tools.some((t) => matchesAny(t.url_pattern, url))
    );
    if (preferLabels.length === 0) return matching;
    return matching.sort((a, b) => labelScore(b, preferLabels) - labelScore(a, preferLabels));
  }
}

function labelScore(w: Worker, prefer: string[]): number {
  let score = 0;
  for (const l of prefer) if (w.labels.has(l)) score += 1;
  return score;
}
```

- [ ] **Step 4: 跑 test → 应当全绿**

Run: `pnpm --filter @aipagego/coordinator test tests/worker-registry.test.ts`
Expected: all PASS.

- [ ] **Step 5: 跑全包 typecheck**

Run: `pnpm --filter @aipagego/coordinator typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/coordinator/src/worker-registry.ts packages/coordinator/tests/worker-registry.test.ts
git commit -m "feat(coordinator): worker registry with url+label matching"
```

---

## Task 8: coordinator/session-manager.ts

Session 状态机：open / close / tick (idle expiry) / pause / resume / orphan / recover。

**Files:**
- Create: `packages/coordinator/src/session-manager.ts`
- Create: `packages/coordinator/tests/session-manager.test.ts`

- [ ] **Step 1: 写 session-manager test (red first)**

Create `packages/coordinator/tests/session-manager.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SessionManager, type OpenSessionInput } from "../src/session-manager";
import { FakeClock, FakeIdGen } from "../src/clock";
import {
  SESSION_IDLE_TIMEOUT_MS,
  ORPHAN_RECOVERY_MS
} from "@aipagego/shared/protocol";

function newMgr() {
  const clock = new FakeClock(1000);
  const idGen = new FakeIdGen();
  return { mgr: new SessionManager(clock, idGen), clock, idGen };
}

const baseOpen: OpenSessionInput = {
  ai_client_fingerprint: "ai-1",
  worker_id: "w1",
  tab_id: "t1",
  scope: new Set(["interact:form"]),
  idle_timeout_ms: SESSION_IDLE_TIMEOUT_MS
};

describe("SessionManager.open", () => {
  it("creates a session in active state", () => {
    const { mgr, clock } = newMgr();
    const s = mgr.open(baseOpen);
    expect(s.id).toBe("session_1");
    expect(s.state).toBe("active");
    expect(s.created_at).toBe(clock.now());
    expect(s.last_activity_at).toBe(clock.now());
  });
});

describe("SessionManager.touch", () => {
  it("updates last_activity_at and step_count", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(5_000);
    mgr.touch(id, { dangerous: false });
    const s = mgr.get(id)!;
    expect(s.last_activity_at).toBe(clock.now());
    expect(s.step_count).toBe(1);
    expect(s.dangerous_count).toBe(0);
  });

  it("increments dangerous_count when dangerous=true", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(1);
    mgr.touch(id, { dangerous: true });
    expect(mgr.get(id)?.dangerous_count).toBe(1);
  });

  it("throws if session is not active", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.close(id);
    expect(() => mgr.touch(id, { dangerous: false })).toThrow(/not active/);
  });
});

describe("SessionManager.close", () => {
  it("transitions to closed", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.close(id);
    expect(mgr.get(id)?.state).toBe("closed");
  });
});

describe("SessionManager.tick (idle expiry)", () => {
  it("expires sessions idle longer than idle_timeout_ms", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(SESSION_IDLE_TIMEOUT_MS + 1);
    const expired = mgr.tick();
    expect(expired).toContain(id);
    expect(mgr.get(id)?.state).toBe("expired");
  });

  it("does not expire still-active sessions", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(SESSION_IDLE_TIMEOUT_MS - 1);
    mgr.tick();
    expect(mgr.get(id)?.state).toBe("active");
  });
});

describe("SessionManager.pauseByWorker / resumeByWorker", () => {
  it("pauses all sessions for a disconnected worker", () => {
    const { mgr } = newMgr();
    const a = mgr.open(baseOpen);
    const b = mgr.open({ ...baseOpen, tab_id: "t2" });
    mgr.pauseByWorker("w1");
    expect(mgr.get(a.id)?.state).toBe("paused");
    expect(mgr.get(b.id)?.state).toBe("paused");
  });

  it("resumes paused sessions when worker reconnects", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.pauseByWorker("w1");
    mgr.resumeByWorker("w1", new Set([id]));
    expect(mgr.get(id)?.state).toBe("active");
  });

  it("paused sessions not in the reconnect snapshot become error", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.pauseByWorker("w1");
    mgr.resumeByWorker("w1", new Set());
    expect(mgr.get(id)?.state).toBe("error");
  });
});

describe("SessionManager orphan flow", () => {
  it("orphan marks the session orphaned_at and disowns fingerprint", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.orphan("ai-1");
    const s = mgr.get(id)!;
    expect(s.state).toBe("orphan");
    expect(s.orphaned_at).toBe(clock.now());
  });

  it("recover within ORPHAN_RECOVERY_MS restores active", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.orphan("ai-1");
    clock.tick(ORPHAN_RECOVERY_MS - 1);
    const recovered = mgr.recover("ai-1");
    expect(recovered).toContain(id);
    expect(mgr.get(id)?.state).toBe("active");
  });

  it("recover after ORPHAN_RECOVERY_MS closes them instead", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.orphan("ai-1");
    clock.tick(ORPHAN_RECOVERY_MS + 1);
    mgr.tick(); // tick processes orphan timeout too
    expect(mgr.get(id)?.state).toBe("closed");
  });
});
```

- [ ] **Step 2: 跑 test → 失败 (SessionManager not defined)**

Run: `pnpm --filter @aipagego/coordinator test tests/session-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: 实现 session-manager.ts**

Create `packages/coordinator/src/session-manager.ts`:

```ts
import {
  SESSION_IDLE_TIMEOUT_MS,
  ORPHAN_RECOVERY_MS
} from "@aipagego/shared/protocol";
import type { Capability } from "@aipagego/shared/capability";
import type { Clock, IdGen } from "./clock";
import type { Session, SessionState } from "./types";
import { QUOTA_DEFAULTS } from "./types";

export interface OpenSessionInput {
  ai_client_fingerprint: string;
  worker_id: string;
  tab_id: string;
  scope: ReadonlySet<Capability>;
  idle_timeout_ms?: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private clock: Clock,
    private idGen: IdGen
  ) {}

  open(input: OpenSessionInput): Session {
    const id = this.idGen.next("session");
    const now = this.clock.now();
    const s: Session = {
      id,
      ai_client_fingerprint: input.ai_client_fingerprint,
      worker_id: input.worker_id,
      tab_id: input.tab_id,
      scope: input.scope,
      state: "active",
      created_at: now,
      last_activity_at: now,
      idle_timeout_ms: input.idle_timeout_ms ?? SESSION_IDLE_TIMEOUT_MS,
      step_count: 0,
      dangerous_count: 0
    };
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Record activity on a session, increment counters. Throws if not active. */
  touch(id: string, opts: { dangerous: boolean }): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    if (s.state !== "active") throw new Error(`Session ${id} not active (state=${s.state})`);
    const next: Session = {
      ...s,
      last_activity_at: this.clock.now(),
      step_count: s.step_count + 1,
      dangerous_count: s.dangerous_count + (opts.dangerous ? 1 : 0)
    };
    this.sessions.set(id, next);
  }

  close(id: string): void {
    this.transition(id, "closed");
  }

  fail(id: string, code: string, message: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.set(id, { ...s, state: "error", error: { code, message } });
  }

  /** Mark all sessions belonging to a worker as paused (worker dropped). */
  pauseByWorker(worker_id: string): string[] {
    const ids: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.worker_id === worker_id && s.state === "active") {
        this.sessions.set(s.id, { ...s, state: "paused" });
        ids.push(s.id);
      }
    }
    return ids;
  }

  /**
   * When a worker reconnects, resume sessions present in last_session_states;
   * any paused sessions NOT in the snapshot become error (worker lost them).
   */
  resumeByWorker(worker_id: string, restoredIds: Set<string>): void {
    for (const s of this.sessions.values()) {
      if (s.worker_id !== worker_id || s.state !== "paused") continue;
      if (restoredIds.has(s.id)) {
        this.sessions.set(s.id, { ...s, state: "active", last_activity_at: this.clock.now() });
      } else {
        this.sessions.set(s.id, {
          ...s,
          state: "error",
          error: { code: "WorkerDisconnected", message: "Lost during worker disconnect" }
        });
      }
    }
  }

  /** Orphan all sessions whose AI client just disconnected. */
  orphan(ai_client_fingerprint: string): string[] {
    const ids: string[] = [];
    const now = this.clock.now();
    for (const s of this.sessions.values()) {
      if (s.ai_client_fingerprint === ai_client_fingerprint && s.state === "active") {
        this.sessions.set(s.id, { ...s, state: "orphan", orphaned_at: now });
        ids.push(s.id);
      }
    }
    return ids;
  }

  /** Re-claim orphaned sessions when same AI client reconnects within window. */
  recover(ai_client_fingerprint: string): string[] {
    const ids: string[] = [];
    const now = this.clock.now();
    for (const s of this.sessions.values()) {
      if (s.state !== "orphan" || s.ai_client_fingerprint !== ai_client_fingerprint) continue;
      if (s.orphaned_at !== undefined && now - s.orphaned_at <= ORPHAN_RECOVERY_MS) {
        this.sessions.set(s.id, {
          ...s,
          state: "active",
          last_activity_at: now,
          orphaned_at: undefined
        });
        ids.push(s.id);
      }
    }
    return ids;
  }

  /**
   * Periodic housekeeping. Returns ids whose state changed.
   *   - active too long idle → expired
   *   - orphan past ORPHAN_RECOVERY_MS → closed
   */
  tick(): string[] {
    const now = this.clock.now();
    const changed: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.state === "active" && now - s.last_activity_at >= s.idle_timeout_ms) {
        this.sessions.set(s.id, { ...s, state: "expired" });
        changed.push(s.id);
      } else if (
        s.state === "orphan" &&
        s.orphaned_at !== undefined &&
        now - s.orphaned_at > ORPHAN_RECOVERY_MS
      ) {
        this.sessions.set(s.id, { ...s, state: "closed" });
        changed.push(s.id);
      }
    }
    return changed;
  }

  /** Quota snapshot for get_quota MCP tool. */
  quota(id: string) {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const now = this.clock.now();
    const ms_until_expiry = Math.max(0, s.idle_timeout_ms - (now - s.last_activity_at));
    return {
      max_steps: QUOTA_DEFAULTS.max_steps_per_session,
      steps_used: s.step_count,
      max_dangerous: QUOTA_DEFAULTS.max_dangerous_per_session,
      dangerous_used: s.dangerous_count,
      ms_until_expiry
    };
  }

  private transition(id: string, target: SessionState): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.set(id, { ...s, state: target });
  }
}
```

- [ ] **Step 4: 跑 test**

Run: `pnpm --filter @aipagego/coordinator test tests/session-manager.test.ts`
Expected: all PASS.

- [ ] **Step 5: 跑 typecheck**

Run: `pnpm --filter @aipagego/coordinator typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/coordinator/src/session-manager.ts packages/coordinator/tests/session-manager.test.ts
git commit -m "feat(coordinator): session state machine

active → expired (idle) / paused (worker drop) / orphan (AI drop) /
error / closed transitions. Recovery: paused → active when worker
reconnects with matching last_session_states; orphan → active within
5min window when AI client reconnects."
```

---

## Task 9: coordinator/catalog.ts

聚合 worker.saved_tools 成"AI 可见的工具目录"，按 url_pattern 过滤。

**Files:**
- Create: `packages/coordinator/src/catalog.ts`
- Create: `packages/coordinator/tests/catalog.test.ts`

- [ ] **Step 1: 写 catalog test**

Create `packages/coordinator/tests/catalog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog";
import { WorkerRegistry } from "../src/worker-registry";
import { FakeClock } from "../src/clock";
import type { Worker } from "../src/types";

function w(id: string, tools: { id: string; url_pattern: string[]; hash?: string }[]): Worker {
  return {
    id,
    fingerprint: { ext_hash: "", os: "", chrome: "" },
    capabilities: new Set(),
    attended: true,
    labels: new Set(),
    available_tabs: [],
    saved_tools: tools.map((t) => ({ ...t, version: 1, hash: t.hash ?? "h" })),
    protocol_version: 1,
    connected_at: 0,
    last_heartbeat_at: 0
  };
}

describe("Catalog.listFor", () => {
  it("returns tools whose url_pattern matches session url", () => {
    const reg = new WorkerRegistry(new FakeClock());
    reg.register(w("w1", [{ id: "shop_v3", url_pattern: ["https://*.example.com/**"] }]));
    reg.register(w("w2", [{ id: "tb", url_pattern: ["https://*.taobao.com/**"] }]));
    const cat = new Catalog(reg);
    const out = cat.listFor("https://shop.example.com/goods.html");
    expect(out.map((t) => t.id)).toEqual(["shop_v3"]);
  });

  it("flags conflicting hashes when two workers expose same tool_id with different hashes", () => {
    const reg = new WorkerRegistry(new FakeClock());
    reg.register(w("w1", [{ id: "shop", url_pattern: ["https://*.example.com/**"], hash: "h1" }]));
    reg.register(w("w2", [{ id: "shop", url_pattern: ["https://*.example.com/**"], hash: "h2" }]));
    const cat = new Catalog(reg);
    const out = cat.listFor("https://shop.example.com/");
    expect(out).toHaveLength(1);
    expect(out[0].conflicting_hashes).toBe(true);
    expect(out[0].provided_by_workers.sort()).toEqual(["w1", "w2"]);
  });
});

describe("Catalog.lookup", () => {
  it("returns the entry by tool_id when url matches", () => {
    const reg = new WorkerRegistry(new FakeClock());
    reg.register(w("w1", [{ id: "shop_v3", url_pattern: ["https://*.example.com/**"] }]));
    const cat = new Catalog(reg);
    const entry = cat.lookup("shop_v3", "https://shop.example.com/");
    expect(entry?.id).toBe("shop_v3");
  });

  it("returns undefined when url does not match", () => {
    const reg = new WorkerRegistry(new FakeClock());
    reg.register(w("w1", [{ id: "shop_v3", url_pattern: ["https://*.example.com/**"] }]));
    const cat = new Catalog(reg);
    expect(cat.lookup("shop_v3", "https://example.com")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑 test → 失败**

Run: `pnpm --filter @aipagego/coordinator test tests/catalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: 实现 catalog.ts**

Create `packages/coordinator/src/catalog.ts`:

```ts
import { matchesAny } from "@aipagego/shared/url-pattern";
import type { WorkerRegistry } from "./worker-registry";

export interface CatalogEntry {
  id: string;
  version: number;
  hash: string;
  url_pattern: string[];
  description?: string;
  provided_by_workers: string[];
  /** True if more than one worker exposes this id with different hashes. */
  conflicting_hashes: boolean;
}

export class Catalog {
  constructor(private registry: WorkerRegistry) {}

  /**
   * Aggregate saved_tools across all workers and return those whose url_pattern
   * matches the given URL. Entries with conflicting hashes are flagged so the
   * UI / AI client can warn before invocation.
   */
  listFor(url: string): CatalogEntry[] {
    const byId = new Map<string, CatalogEntry>();
    for (const w of this.registry.list()) {
      for (const t of w.saved_tools) {
        if (!matchesAny(t.url_pattern, url)) continue;
        const existing = byId.get(t.id);
        if (!existing) {
          byId.set(t.id, {
            id: t.id,
            version: t.version,
            hash: t.hash,
            url_pattern: t.url_pattern,
            description: t.description,
            provided_by_workers: [w.id],
            conflicting_hashes: false
          });
        } else {
          existing.provided_by_workers = [...new Set([...existing.provided_by_workers, w.id])];
          if (existing.hash !== t.hash) existing.conflicting_hashes = true;
        }
      }
    }
    return [...byId.values()];
  }

  lookup(tool_id: string, url: string): CatalogEntry | undefined {
    return this.listFor(url).find((e) => e.id === tool_id);
  }
}
```

- [ ] **Step 4: 跑 test**

Run: `pnpm --filter @aipagego/coordinator test tests/catalog.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coordinator/src/catalog.ts packages/coordinator/tests/catalog.test.ts
git commit -m "feat(coordinator): saved-tool catalog with url filtering + hash conflict detect"
```

---

## Task 10: coordinator/dispatcher.ts

校验工具调用是否允许（scope + quota），决定派给哪个 worker。

**Files:**
- Create: `packages/coordinator/src/dispatcher.ts`
- Create: `packages/coordinator/tests/dispatcher.test.ts`

- [ ] **Step 1: 写 dispatcher test**

Create `packages/coordinator/tests/dispatcher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Dispatcher, type DispatchInput } from "../src/dispatcher";
import { SessionManager } from "../src/session-manager";
import { FakeClock, FakeIdGen } from "../src/clock";
import { SESSION_IDLE_TIMEOUT_MS } from "@aipagego/shared/protocol";
import type { Capability } from "@aipagego/shared/capability";

function setup(scope: Capability[]) {
  const clock = new FakeClock(1000);
  const idGen = new FakeIdGen();
  const sessions = new SessionManager(clock, idGen);
  const { id } = sessions.open({
    ai_client_fingerprint: "ai-1",
    worker_id: "w1",
    tab_id: "t1",
    scope: new Set(scope),
    idle_timeout_ms: SESSION_IDLE_TIMEOUT_MS
  });
  const dispatcher = new Dispatcher(sessions);
  return { dispatcher, sessions, session_id: id, clock };
}

describe("Dispatcher.validate (low-level extension tool)", () => {
  it("allows snapshotDOM because read:dom is implicit", () => {
    const { dispatcher, session_id } = setup([]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(true);
  });

  it("denies submitForm when submit:form not in scope", () => {
    const { dispatcher, session_id } = setup([]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PermissionDenied");
      expect(r.error.hints?.denied_capability).toBe("submit:form");
    }
  });

  it("allows submitForm when scope includes submit:form", () => {
    const { dispatcher, session_id } = setup(["submit:form"]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(r.ok).toBe(true);
  });

  it("httpRequest cookied requires httpRequest:cookied", () => {
    const { dispatcher, session_id } = setup(["httpRequest:no-cookie"]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "httpRequest",
      httpCookied: true
    });
    expect(r.ok).toBe(false);
  });
});

describe("Dispatcher.validate (runJS)", () => {
  it("scanned runJS allowed when scope has runJS:scanned", () => {
    const { dispatcher, session_id } = setup(["runJS:scanned"]);
    const r = dispatcher.validate({
      session_id,
      kind: "runJS",
      unsafe: false
    });
    expect(r.ok).toBe(true);
  });

  it("unsafe runJS denied when only scanned in scope", () => {
    const { dispatcher, session_id } = setup(["runJS:scanned"]);
    const r = dispatcher.validate({ session_id, kind: "runJS", unsafe: true });
    expect(r.ok).toBe(false);
  });
});

describe("Dispatcher.validate (session lifecycle)", () => {
  it("rejects calls on missing session", () => {
    const { dispatcher } = setup([]);
    const r = dispatcher.validate({
      session_id: "nope",
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SessionNotFound");
  });

  it("rejects calls on expired session", () => {
    const { dispatcher, sessions, session_id, clock } = setup([]);
    clock.tick(SESSION_IDLE_TIMEOUT_MS + 1);
    sessions.tick();
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SessionExpired");
  });
});

describe("Dispatcher.validate (quota)", () => {
  it("rejects when step_count >= max_steps", () => {
    const { dispatcher, sessions, session_id } = setup([]);
    for (let i = 0; i < 200; i++) sessions.touch(session_id, { dangerous: false });
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SessionExhausted");
  });

  it("rejects dangerous when dangerous_count >= max_dangerous", () => {
    const { dispatcher, sessions, session_id } = setup(["submit:form"]);
    for (let i = 0; i < 50; i++) sessions.touch(session_id, { dangerous: true });
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DangerousQuotaExceeded");
  });
});
```

- [ ] **Step 2: 跑 test → 失败**

Run: `pnpm --filter @aipagego/coordinator test tests/dispatcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: 实现 dispatcher.ts**

Create `packages/coordinator/src/dispatcher.ts`:

```ts
import {
  capabilityForTool,
  capabilityForRunJs,
  scopeCovers,
  DANGEROUS_CAPABILITIES
} from "@aipagego/shared/capability";
import type { Capability } from "@aipagego/shared/capability";
import type { ErrorBody, ErrorCode } from "@aipagego/shared/protocol";
import type { BuiltinTool } from "@aipagego/shared/types";
import type { SessionManager } from "./session-manager";
import { QUOTA_DEFAULTS } from "./types";

export type DispatchInput =
  | {
      session_id: string;
      kind: "extension_tool";
      tool: BuiltinTool;
      httpCookied?: boolean;
    }
  | {
      session_id: string;
      kind: "runJS";
      unsafe: boolean;
    };

export type DispatchValidation =
  | { ok: true; required_capability: Capability; dangerous: boolean }
  | { ok: false; error: ErrorBody };

export class Dispatcher {
  constructor(private sessions: SessionManager) {}

  validate(input: DispatchInput): DispatchValidation {
    const session = this.sessions.get(input.session_id);
    if (!session) return fail("SessionNotFound", `Session ${input.session_id} not found`);
    if (session.state === "expired")
      return fail("SessionExpired", `Session ${input.session_id} is expired`);
    if (session.state !== "active")
      return fail("InternalError", `Session ${input.session_id} state=${session.state}`);

    const required =
      input.kind === "extension_tool"
        ? capabilityForTool(input.tool, { httpCookied: input.httpCookied })
        : capabilityForRunJs(input.unsafe);

    if (!scopeCovers(session.scope, required)) {
      return fail("PermissionDenied", `Capability ${required} not in session scope`, {
        denied_capability: required
      });
    }

    const dangerous = DANGEROUS_CAPABILITIES.has(required);
    if (session.step_count >= QUOTA_DEFAULTS.max_steps_per_session) {
      return fail("SessionExhausted", `Session reached max_steps=${QUOTA_DEFAULTS.max_steps_per_session}`);
    }
    if (dangerous && session.dangerous_count >= QUOTA_DEFAULTS.max_dangerous_per_session) {
      return fail(
        "DangerousQuotaExceeded",
        `Session exceeded max_dangerous=${QUOTA_DEFAULTS.max_dangerous_per_session}`
      );
    }

    return { ok: true, required_capability: required, dangerous };
  }
}

function fail(code: ErrorCode, message: string, hints?: Record<string, unknown>): DispatchValidation {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: code === "WorkerBusy" || code === "QueueFull" || code === "InternalError",
      hints
    }
  };
}
```

- [ ] **Step 4: 跑 test**

Run: `pnpm --filter @aipagego/coordinator test tests/dispatcher.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coordinator/src/dispatcher.ts packages/coordinator/tests/dispatcher.test.ts
git commit -m "feat(coordinator): dispatcher with scope + quota validation

Maps tool calls to required capabilities, validates against session
scope, checks step + dangerous quotas. PermissionDenied carries the
denied_capability in hints so the AI client can surface it."
```

---

## Task 11: coordinator/coordinator.ts — wiring class

把 4 个模块组合成 `Coordinator` 类，并暴露给消费者的"门面"方法。

**Files:**
- Create: `packages/coordinator/src/coordinator.ts`
- Modify: `packages/coordinator/src/index.ts`

- [ ] **Step 1: 实现 coordinator.ts**

Create `packages/coordinator/src/coordinator.ts`:

```ts
import { Catalog, type CatalogEntry } from "./catalog";
import { Dispatcher, type DispatchInput, type DispatchValidation } from "./dispatcher";
import {
  SessionManager,
  type OpenSessionInput
} from "./session-manager";
import { WorkerRegistry } from "./worker-registry";
import type { Clock, IdGen } from "./clock";
import type { WSHub } from "./ws-hub";
import type { Session, Worker, Quota } from "./types";

export interface CoordinatorDeps {
  hub: WSHub;
  clock: Clock;
  idGen: IdGen;
}

/**
 * Façade over the 4 internal state machines. Public methods are the verbs
 * the MCP server (Phase 3) and REST server (Phase 4) will both call.
 *
 * Coordinator is hub-aware: it sends OPEN_TAB / EXEC / CLOSE_SESSION messages
 * via this.hub.send(...). Reading messages back from workers is the consumer's
 * responsibility: they wire hub.onMessage(...) and call back into the
 * coordinator's handle* methods.
 */
export class Coordinator {
  readonly sessions: SessionManager;
  readonly workers: WorkerRegistry;
  readonly catalog: Catalog;
  readonly dispatcher: Dispatcher;

  constructor(private deps: CoordinatorDeps) {
    this.sessions = new SessionManager(deps.clock, deps.idGen);
    this.workers = new WorkerRegistry(deps.clock);
    this.catalog = new Catalog(this.workers);
    this.dispatcher = new Dispatcher(this.sessions);
  }

  // === Worker lifecycle ===
  registerWorker(w: Worker): void {
    this.workers.register(w);
    this.sessions.resumeByWorker(w.id, new Set(/* will be filled from STATE_SNAPSHOT later */));
  }

  unregisterWorker(id: string): void {
    this.workers.unregister(id);
    this.sessions.pauseByWorker(id);
  }

  heartbeatWorker(id: string): void {
    this.workers.heartbeat(id);
  }

  // === Session lifecycle ===
  openSession(input: OpenSessionInput): Session {
    return this.sessions.open(input);
  }

  closeSession(id: string): void {
    this.sessions.close(id);
  }

  // === Tool calls ===
  validateCall(input: DispatchInput): DispatchValidation {
    return this.dispatcher.validate(input);
  }

  /** Apply quota side-effects after a successful validation. Call before sending EXEC. */
  recordCall(session_id: string, dangerous: boolean): void {
    this.sessions.touch(session_id, { dangerous });
  }

  // === Catalog & quota ===
  listToolsForSession(session_id: string): CatalogEntry[] | undefined {
    const s = this.sessions.get(session_id);
    if (!s) return undefined;
    const worker = this.workers.get(s.worker_id);
    if (!worker) return [];
    const tabUrl = worker.available_tabs.find((t) => t.tab_id === s.tab_id)?.url ?? "";
    return this.catalog.listFor(tabUrl);
  }

  quotaFor(session_id: string): Quota | undefined {
    return this.sessions.quota(session_id);
  }

  // === Periodic housekeeping ===
  tick(): { expired_sessions: string[] } {
    const expired_sessions = this.sessions.tick();
    return { expired_sessions };
  }
}
```

- [ ] **Step 2: 修改 src/index.ts barrel**

Edit `packages/coordinator/src/index.ts` — replace entire content with:

```ts
export * from "./types";
export * from "./clock";
export * from "./ws-hub";
export * from "./worker-registry";
export * from "./session-manager";
export * from "./catalog";
export * from "./dispatcher";
export * from "./coordinator";
```

- [ ] **Step 3: 跑 typecheck**

Run: `pnpm --filter @aipagego/coordinator typecheck`
Expected: 0 errors.

- [ ] **Step 4: 跑全包 test**

Run: `pnpm --filter @aipagego/coordinator test`
Expected: all PASS (clock + worker-registry + session-manager + catalog + dispatcher tests).

- [ ] **Step 5: Commit**

```bash
git add packages/coordinator/src/coordinator.ts packages/coordinator/src/index.ts
git commit -m "feat(coordinator): Coordinator façade class wiring all 4 modules"
```

---

## Task 12: Coordinator integration test (happy path + scope denial)

端到端跑一遍 worker connect → open_session → validateCall → recordCall → close_session，覆盖 Phase 1 全部组件互通。

**Files:**
- Create: `packages/coordinator/tests/coordinator.test.ts`

- [ ] **Step 1: 写集成 test**

Create `packages/coordinator/tests/coordinator.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Coordinator } from "../src/coordinator";
import { FakeClock, FakeIdGen } from "../src/clock";
import { SESSION_IDLE_TIMEOUT_MS } from "@aipagego/shared/protocol";
import type { WSHub } from "../src/ws-hub";
import type { Worker } from "../src/types";

function fakeHub(): WSHub {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onDisconnect: vi.fn(),
    connectedWorkers: () => [],
    disconnect: vi.fn().mockResolvedValue(undefined)
  };
}

function newCoord() {
  const clock = new FakeClock(1000);
  const idGen = new FakeIdGen();
  const hub = fakeHub();
  return { coord: new Coordinator({ hub, clock, idGen }), clock, idGen, hub };
}

function makeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    fingerprint: { ext_hash: "h", os: "darwin", chrome: "120" },
    capabilities: new Set(["read:dom", "interact:form", "submit:form"]),
    attended: true,
    labels: new Set(),
    available_tabs: [{ tab_id: "t1", url: "https://shop.example.com/goods.html" }],
    saved_tools: [
      {
        id: "shop_v3",
        version: 1,
        hash: "abc",
        url_pattern: ["https://*.example.com/**"]
      }
    ],
    protocol_version: 1,
    connected_at: 0,
    last_heartbeat_at: 0,
    ...overrides
  };
}

describe("Coordinator happy path", () => {
  it("worker register → open session → list tools → call submitForm → close", () => {
    const { coord } = newCoord();
    coord.registerWorker(makeWorker("w1"));

    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set(["interact:form", "submit:form"])
    });
    expect(session.state).toBe("active");

    const tools = coord.listToolsForSession(session.id);
    expect(tools?.map((t) => t.id)).toEqual(["shop_v3"]);

    const validate = coord.validateCall({
      session_id: session.id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(validate.ok).toBe(true);

    if (validate.ok) coord.recordCall(session.id, validate.dangerous);
    expect(coord.sessions.get(session.id)?.dangerous_count).toBe(1);

    coord.closeSession(session.id);
    expect(coord.sessions.get(session.id)?.state).toBe("closed");
  });
});

describe("Coordinator denials", () => {
  it("denies submitForm when not in scope", () => {
    const { coord } = newCoord();
    coord.registerWorker(makeWorker("w1"));
    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set(["interact:form"])
    });
    const v = coord.validateCall({
      session_id: session.id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.code).toBe("PermissionDenied");
      expect(v.error.hints?.denied_capability).toBe("submit:form");
    }
  });
});

describe("Coordinator periodic tick", () => {
  it("expires idle sessions", () => {
    const { coord, clock } = newCoord();
    coord.registerWorker(makeWorker("w1"));
    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set([])
    });
    clock.tick(SESSION_IDLE_TIMEOUT_MS + 1);
    const { expired_sessions } = coord.tick();
    expect(expired_sessions).toContain(session.id);
    expect(coord.sessions.get(session.id)?.state).toBe("expired");
  });
});

describe("Coordinator worker disconnect", () => {
  it("pauses sessions when worker unregisters", () => {
    const { coord } = newCoord();
    coord.registerWorker(makeWorker("w1"));
    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set(["interact:form"])
    });
    coord.unregisterWorker("w1");
    expect(coord.sessions.get(session.id)?.state).toBe("paused");
  });
});
```

- [ ] **Step 2: 跑集成 test**

Run: `pnpm --filter @aipagego/coordinator test tests/coordinator.test.ts`
Expected: all PASS.

- [ ] **Step 3: 跑 root 全套**

Run:
```bash
pnpm typecheck
pnpm test
```
Expected:
- typecheck 0 errors across all 3 packages (shared, extension, coordinator)
- test all green — should be 242 (Phase 0) + new shared protocol/capability/mcp-tools tests + new coordinator tests; record actual total

- [ ] **Step 4: Commit**

```bash
git add packages/coordinator/tests/coordinator.test.ts
git commit -m "test(coordinator): integration tests for happy path + denials + tick + disconnect

Covers the 4 modules wired together via the Coordinator façade,
verifying worker register → open_session → list_tools → call → close,
plus PermissionDenied for missing scope, idle-timeout expiry, and
worker-disconnect pausing."
```

---

## Phase 1 收尾验证

- [ ] **Step 1: 全套绿灯**

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:
- 3 packages typecheck 0 errors
- All tests pass; total > 242 (Phase 0 baseline) since Phase 1 added ~50+ tests
- build still produces packages/extension/dist/manifest.json with version 0.0.7

- [ ] **Step 2: 验证 monorepo 结构**

```bash
ls packages/
```

Expected: `coordinator extension shared` (3 packages).

```bash
ls packages/shared/src/
```

Expected: pre-existing files + `protocol capability mcp-tools` directories.

- [ ] **Step 3: 提示后续**

Phase 2 起点 = `packages/coordinator` 的核心 + `@aipagego/shared/protocol` 完备协议。Phase 2 任务：在 `packages/extension/src/background/coordinator-client.ts` 实现 WS 客户端，并在 `packages/extension/src/sidepanel` 加配对 UI。

---

## Self-Review Checklist

- ✅ Spec §7.1 (capability 完整清单) — Task 2 实现
- ✅ Spec §7.2 (WS 协议消息表) — Task 1 实现 11 个消息 + envelope + errors
- ✅ Spec §7.3 (MCP 工具表) — Task 3 实现 6 个控制平面 + explore_* builder
- ✅ Spec §3 (coordinator/* 模块切分) — Tasks 6-11 实现 5 个模块 + 1 个 façade
- ✅ Spec §4.1 "Worker ↔ Coordinator 协议 = WebSocket" — Task 6 抽象出 WSHub 接口（实现留给 Phase 3+）
- ✅ Spec §4.6 状态机 — Task 8 实现 active/expired/paused/orphan/error/closed 全部转换
- ✅ Spec §5.4 限流 — Task 10 dispatcher 校验 step + dangerous quota
- ✅ "依赖注入" 架构断言 — Task 6 Clock/IdGen/WSHub 都是接口，Tasks 8-11 都通过构造器接受它们
- ✅ "不实现真 WS / 不接入扩展" 边界 — 整个 plan 内 `ws-hub.ts` 只有 interface，extension package 不动
- ✅ 无 TBD / TODO / "fill in"
- ✅ 类型/方法名跨 task 一致：`Capability` `Session` `Worker` `Catalog` `Dispatcher` `Coordinator` `WSHub` `Clock` `IdGen`
- ✅ 文件路径每处精确（含每个 test 文件）
- ✅ 命令带预期输出
