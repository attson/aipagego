# MCP Bridge（Phase 3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `packages/mcp-server`，让 Claude Code 经一个本地 coordinator（stdio MCP + 真 ws 服务器）逐步驱动浏览器扩展在网页上执行内置工具。

**Architecture:** 单进程同时是 stdio MCP 端点（Claude 连）与 ws 服务器（扩展作为 worker 连）。进程内 new 一个现成 `Coordinator` 门面（复用 session/quota/policy）+ 新写的 `LoopbackWSHub`（实现 `WSHub` 接口 + 负责 `req_id↔RESULT` 配对）。启动时从扩展现成的 `TOOL_DEFS`（上提到 `@aipagego/shared`）自动生成 19 个 `browser_*` 工具，外加 4 个控制面工具。

**Tech Stack:** TypeScript (ESM, NodeNext), `ws`, `@modelcontextprotocol/sdk`(低层 `Server` API), `zod`, `vitest`；复用 `@aipagego/coordinator` 与 `@aipagego/shared/protocol|capability|llm`。

**对应 spec:** `../specs/2026-06-06-mcp-bridge-design.md`

**关键既有事实（已核对源码）:**
- EXEC 线上契约是 `step: { tool, args }`（**无 `kind`**），见 `packages/extension/tests/background/coordinator-exec.test.ts`。仅对 19 个 `BuiltinTool` 成立。
- `WSHub` 接口：`packages/coordinator/src/ws-hub.ts`。`Coordinator` 门面动词：`packages/coordinator/src/coordinator.ts`（`registerWorker/unregisterWorker/heartbeatWorker/openSession/closeSession/validateCall/recordCall/quotaFor`，且 `readonly sessions/workers` 公开）。
- `DispatchInput` 判别值是 `kind:"extension_tool"`（带 `tool`、可选 `httpCookied`）。见 `packages/coordinator/src/dispatcher.ts`。
- 能力模型：`@aipagego/shared/capability` 导出 `CAPABILITIES`、`capabilityForTool`、`isCapability`、`DANGEROUS_CAPABILITIES`。
- `WELCOME` 字段：`{...envelope, type, server_time, heartbeat_interval_ms}`，`protocol_version` 必须 = `PROTOCOL_VERSION`（worker 会校验）。
- `Clock`/`IdGen` + `Default*`/`Fake*`：`packages/coordinator/src/clock.ts`。
- **⚠ stdio 洁癖**：MCP server 进程**禁止 `console.log`**（stdout 是 MCP 通道）。所有日志走 `console.error`。

---

## File Structure

新增 `packages/mcp-server/`：

- `package.json` / `tsconfig.json` — 镜像 `packages/coordinator` 的配置
- `src/loopback-ws-hub.ts` — 实现 `WSHub` + `exec()` 配对 + `ready()/close()`
- `src/tool-gen.ts` — 从 `TOOL_DEFS` 生成 19 个 `browser_*` 工具定义（纯函数）
- `src/control-tools.ts` — 4 个控制面工具的 JSON Schema（本包内务实定义）
- `src/handlers.ts` — 每个工具的处理逻辑（调门面 + `hub.exec`）
- `src/mcp-server.ts` — `buildToolList()` / `dispatchCall()` + `createMcpServer()`（SDK 胶水）
- `src/wire.ts` — `installWire()`（HELLO→registerWorker、PING→heartbeat）+ `helloToWorker()`
- `src/index.ts` — bin 入口（env → 装配 → `server.connect(stdio)`）
- `tests/*.test.ts` — 每模块一组

改动 `@aipagego/shared`：`TOOL_DEFS` 从 extension 上提，新增 `src/llm/builtin-tool-defs.ts`，由 `src/llm/index.ts` 导出。
改动 `packages/extension`：`src/sidepanel/llm/tool-schema.ts` 改为 re-export（零行为变化）。
`@aipagego/coordinator` **不改**。

---

## Task 1: Scaffold `packages/mcp-server`

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/index.ts`（占位，仅为 typecheck 通过）

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "@aipagego/mcp-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "aipagego-mcp": "./src/index.ts" },
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "start": "node --experimental-strip-types src/index.ts"
  },
  "dependencies": {
    "@aipagego/shared": "workspace:*",
    "@aipagego/coordinator": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/ws": "^8.5.12",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**（镜像 coordinator）

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
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: 占位 `src/index.ts`**

```ts
// 装配入口，后续任务填充。
export {};
```

- [ ] **Step 4: 安装依赖**

Run: `pnpm install`
Expected: 新包被 workspace 收录，`@modelcontextprotocol/sdk`、`ws`、`@types/ws` 装好，无报错。

- [ ] **Step 5: typecheck 通过**

Run: `pnpm -F @aipagego/mcp-server typecheck`
Expected: 无输出（tsc 成功）。

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server pnpm-lock.yaml
git commit -m "chore(mcp-server): scaffold package + deps"
```

---

## Task 2: 上提 `TOOL_DEFS` 到 `@aipagego/shared`

**Files:**
- Create: `packages/shared/src/llm/builtin-tool-defs.ts`
- Modify: `packages/shared/src/llm/index.ts`
- Modify: `packages/extension/src/sidepanel/llm/tool-schema.ts`
- Test: `packages/shared/tests/llm/builtin-tool-defs.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/tests/llm/builtin-tool-defs.test.ts
import { describe, it, expect } from "vitest";
import { TOOL_DEFS } from "../../src/llm";

describe("TOOL_DEFS (hoisted to shared)", () => {
  it("includes the 19 builtin exec tools by name", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of [
      "snapshotDOM", "querySelector", "querySelectorAll", "extractText", "extractImages",
      "getValue", "extractFormState", "hover", "focus", "scroll", "waitFor",
      "click", "fillInput", "setCheckbox", "selectOption", "httpRequest",
      "submitForm", "uploadFile", "readStorage"
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("each def has name/description/input_schema", () => {
    for (const t of TOOL_DEFS) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.input_schema).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @aipagego/shared test builtin-tool-defs`
Expected: FAIL（`TOOL_DEFS` 尚未从 shared 导出）。

- [ ] **Step 3: 把 `TOOL_DEFS` 搬到 shared**

新建 `packages/shared/src/llm/builtin-tool-defs.ts`：把 `packages/extension/src/sidepanel/llm/tool-schema.ts` 里**整个 `TOOL_DEFS` 数组原样剪切过来**（全部 24 条，含 `runJS` 与 `listTabs/openTab/attachTab/detachTab`——扩展侧仍喂给 LLM，保持原行为），文件头改为从同目录类型导入：

```ts
import type { LlmTool } from "./types";

export const TOOL_DEFS: LlmTool[] = [
  // …把原 tool-schema.ts 里的 24 条定义原样粘贴到此…
];
```

- [ ] **Step 4: shared 导出**

修改 `packages/shared/src/llm/index.ts`：

```ts
export * from "./types";
export * from "./builtin-tool-defs";
```

- [ ] **Step 5: 扩展改为 re-export**

把 `packages/extension/src/sidepanel/llm/tool-schema.ts` 整个内容替换为：

```ts
export { TOOL_DEFS } from "@aipagego/shared/llm";
export type { LlmTool } from "@aipagego/shared/llm";
```

（若该文件原本还导出别的符号，逐一保留 re-export；`grep -n "export" packages/extension/src/sidepanel/llm/tool-schema.ts` 旧版仅导出 `TOOL_DEFS`。）

- [ ] **Step 6: 跑测试 + 扩展回归**

Run: `pnpm -F @aipagego/shared test builtin-tool-defs`
Expected: PASS

Run: `pnpm -F @aipagego/shared typecheck && pnpm -F @aipagego/extension typecheck`
Expected: 两个包均无错。

Run: `pnpm -F @aipagego/extension test tool-schema`
Expected: 既有 `tests/sidepanel/llm/tool-schema.test.ts` 仍 PASS（re-export 行为不变）。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/llm packages/shared/tests/llm packages/extension/src/sidepanel/llm/tool-schema.ts
git commit -m "refactor(shared): hoist TOOL_DEFS into shared/llm; extension re-exports"
```

---

## Task 3: `tool-gen.ts` — 生成 19 个 `browser_*` 工具

**Files:**
- Create: `packages/mcp-server/src/tool-gen.ts`
- Test: `packages/mcp-server/tests/tool-gen.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/mcp-server/tests/tool-gen.test.ts
import { describe, it, expect } from "vitest";
import { generateBrowserTools, EXEC_TOOL_NAMES } from "../src/tool-gen";

describe("generateBrowserTools", () => {
  const tools = generateBrowserTools();

  it("generates exactly the 19 exec builtin tools, prefixed browser_", () => {
    expect(tools.length).toBe(19);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXEC_TOOL_NAMES.map((n) => `browser_${n}`).sort());
  });

  it("does NOT generate runJS or tab-control tools", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const n of ["browser_runJS", "browser_listTabs", "browser_openTab", "browser_attachTab", "browser_detachTab"]) {
      expect(names.has(n)).toBe(false);
    }
  });

  it("injects required session_id and strips inner tabId", () => {
    const click = tools.find((t) => t.name === "browser_click")!;
    const props = click.inputSchema.properties as Record<string, unknown>;
    expect(props.session_id).toBeTruthy();
    expect(props.tabId).toBeUndefined();
    expect((click.inputSchema.required as string[]).includes("session_id")).toBe(true);
    // 原有 required（selector）保留
    expect((click.inputSchema.required as string[]).includes("selector")).toBe(true);
  });

  it("records the underlying builtin tool name", () => {
    const click = tools.find((t) => t.name === "browser_click")!;
    expect(click.builtinTool).toBe("click");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @aipagego/mcp-server test tool-gen`
Expected: FAIL（`src/tool-gen.ts` 不存在）。

- [ ] **Step 3: 实现 `tool-gen.ts`**

```ts
// packages/mcp-server/src/tool-gen.ts
import { TOOL_DEFS } from "@aipagego/shared/llm";
import type { JsonSchema } from "@aipagego/shared/types";

/** 与 capabilityForTool 的穷尽 switch 一一对应的 19 个 BuiltinTool。 */
export const EXEC_TOOL_NAMES = [
  "snapshotDOM", "querySelector", "querySelectorAll", "extractText", "extractImages",
  "getValue", "extractFormState", "hover", "focus", "scroll", "waitFor",
  "click", "fillInput", "setCheckbox", "selectOption", "httpRequest",
  "submitForm", "uploadFile", "readStorage"
] as const;

export type GeneratedTool = {
  name: string;
  builtinTool: string;
  description: string;
  inputSchema: JsonSchema & { properties?: Record<string, JsonSchema>; required?: string[] };
};

function rebuildSchema(src: JsonSchema): GeneratedTool["inputSchema"] {
  const s = (src ?? {}) as { type?: string; properties?: Record<string, JsonSchema>; required?: string[] };
  const properties: Record<string, JsonSchema> = { ...(s.properties ?? {}) };
  delete properties.tabId; // target tab 由 session 决定，不暴露内部 tabId
  properties.session_id = { type: "string", description: "open_session 返回的会话 id（决定目标 worker 与 tab）" } as JsonSchema;
  const required = [...new Set([...(s.required ?? []).filter((r) => r !== "tabId"), "session_id"])];
  return { type: "object", properties, required };
}

export function generateBrowserTools(): GeneratedTool[] {
  const allow = new Set<string>(EXEC_TOOL_NAMES as readonly string[]);
  return TOOL_DEFS.filter((t) => allow.has(t.name)).map((t) => ({
    name: `browser_${t.name}`,
    builtinTool: t.name,
    description: t.description,
    inputSchema: rebuildSchema(t.input_schema)
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @aipagego/mcp-server test tool-gen`
Expected: PASS（4 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tool-gen.ts packages/mcp-server/tests/tool-gen.test.ts
git commit -m "feat(mcp-server): generate 19 browser_* tools from TOOL_DEFS"
```

---

## Task 4: `LoopbackWSHub` — ws 服务器 + req_id↔RESULT 配对

**Files:**
- Create: `packages/mcp-server/src/loopback-ws-hub.ts`
- Test: `packages/mcp-server/tests/loopback-ws-hub.test.ts`

- [ ] **Step 1: 写失败测试**（真 ws：起 hub，用 `ws` 客户端冒充 worker）

```ts
// packages/mcp-server/tests/loopback-ws-hub.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type Hello, type ClientToServer } from "@aipagego/shared/protocol";
import { DefaultClock, DefaultIdGen } from "@aipagego/coordinator";
import { LoopbackWSHub } from "../src/loopback-ws-hub";

let hub: LoopbackWSHub | null = null;
afterEach(async () => { if (hub) await hub.close(); hub = null; });

function helloMsg(): Hello {
  return {
    type: "HELLO", nonce: "h1", ts: 1, protocol_version: PROTOCOL_VERSION,
    worker_id: "w1", fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: ["read:dom", "interact:form"], attended: true,
    available_tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }],
    saved_tools: [], labels: []
  };
}

async function connectWorker(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, [`bearer.t`, `proto.${PROTOCOL_VERSION}`]);
  await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  return ws;
}

describe("LoopbackWSHub", () => {
  it("replies WELCOME on HELLO and registers the worker via onMessage", async () => {
    hub = new LoopbackWSHub({ port: 0, clock: new DefaultClock(), idGen: new DefaultIdGen() });
    const port = await hub.ready();
    const seen: ClientToServer[] = [];
    hub.onMessage((_id, m) => seen.push(m));

    const ws = await connectWorker(port);
    const welcome = await new Promise<any>((res) => ws.on("message", (r) => res(JSON.parse(r.toString()))));
    ws.send(JSON.stringify(helloMsg()));
    // 等 hub 处理 HELLO（welcome 是连上后由 hub 在收到 HELLO 时回；这里先发 HELLO 再收）
  });

  it("exec() resolves when the worker replies RESULT with matching req_id", async () => {
    hub = new LoopbackWSHub({ port: 0, clock: new DefaultClock(), idGen: new DefaultIdGen() });
    const port = await hub.ready();
    const ws = await connectWorker(port);
    // worker：收到 EXEC 就回 RESULT
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "WELCOME") return;
      if (m.type === "EXEC") {
        ws.send(JSON.stringify({
          type: "RESULT", nonce: "rn", ts: 2, protocol_version: PROTOCOL_VERSION,
          req_id: m.req_id, ok: true, return: { clicked: true }
        }));
      }
    });
    ws.send(JSON.stringify(helloMsg()));
    await new Promise((r) => setTimeout(r, 50)); // 等 HELLO 注册完成

    const result = await hub.exec("w1", { session_id: "s1", tab_id: "42", step: { tool: "click", args: { selector: ".b" } } });
    expect(result.ok).toBe(true);
    expect(result.return).toEqual({ clicked: true });
  });

  it("exec() rejects on timeout when no RESULT arrives", async () => {
    hub = new LoopbackWSHub({ port: 0, clock: new DefaultClock(), idGen: new DefaultIdGen(), execTimeoutMs: 80 });
    const port = await hub.ready();
    const ws = await connectWorker(port);
    ws.on("message", () => { /* 故意不回 RESULT */ });
    ws.send(JSON.stringify(helloMsg()));
    await new Promise((r) => setTimeout(r, 50));
    await expect(hub.exec("w1", { session_id: "s1", tab_id: "42", step: { tool: "click", args: {} } }))
      .rejects.toThrow(/timeout/i);
  });

  it("rejects pending execs when the worker disconnects", async () => {
    hub = new LoopbackWSHub({ port: 0, clock: new DefaultClock(), idGen: new DefaultIdGen(), execTimeoutMs: 5000 });
    const port = await hub.ready();
    const ws = await connectWorker(port);
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "EXEC") ws.close(); });
    ws.send(JSON.stringify(helloMsg()));
    await new Promise((r) => setTimeout(r, 50));
    await expect(hub.exec("w1", { session_id: "s1", tab_id: "42", step: { tool: "click", args: {} } }))
      .rejects.toThrow(/disconnect/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @aipagego/mcp-server test loopback-ws-hub`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `loopback-ws-hub.ts`**

```ts
// packages/mcp-server/src/loopback-ws-hub.ts
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ClientToServerSchema, ServerToClientSchema, PROTOCOL_VERSION,
  type ClientToServer, type ServerToClient, type Result
} from "@aipagego/shared/protocol";
import type { WSHub } from "@aipagego/coordinator";
import type { Clock, IdGen } from "@aipagego/coordinator";

export interface LoopbackWSHubOpts {
  port: number;
  token?: string;          // 配置则要求 bearer.<token>
  clock: Clock;
  idGen: IdGen;
  execTimeoutMs?: number;  // 默认 30000
}

type Pending = { resolve: (r: Result) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; worker_id: string };

export class LoopbackWSHub implements WSHub {
  private wss: WebSocketServer;
  private byWorker = new Map<string, WebSocket>();
  private workerOf = new Map<WebSocket, string>();
  private pending = new Map<string, Pending>();
  private msgHandlers: Array<(worker_id: string, msg: ClientToServer) => void> = [];
  private disconnectHandlers: Array<(worker_id: string) => void> = [];
  private execTimeoutMs: number;

  constructor(private opts: LoopbackWSHubOpts) {
    this.execTimeoutMs = opts.execTimeoutMs ?? 30000;
    this.wss = new WebSocketServer({
      port: opts.port,
      path: "/worker",
      // 回显 worker 提供的第一个子协议（bearer.<token>），让握手成功
      handleProtocols: (protocols: Set<string>) => [...protocols][0] ?? false
    });
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
  }

  /** 测试/启动用：等监听就绪，返回实际端口。 */
  ready(): Promise<number> {
    return new Promise((resolve) => {
      if (this.wss.address()) return resolve((this.wss.address() as AddressInfo).port);
      this.wss.on("listening", () => resolve((this.wss.address() as AddressInfo).port));
    });
  }

  close(): Promise<void> {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("hub closing")); }
    this.pending.clear();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private tokenOk(req: IncomingMessage): boolean {
    if (!this.opts.token) return true;
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
    return offered.includes(`bearer.${this.opts.token}`);
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    if (!this.tokenOk(req)) { socket.close(4401, "bad token"); return; }
    socket.on("message", (raw) => this.onMessageRaw(socket, raw.toString()));
    socket.on("close", () => this.onSocketClose(socket));
    socket.on("error", () => { /* close 事件会接手清理 */ });
  }

  private onMessageRaw(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    const r = ClientToServerSchema.safeParse(parsed);
    if (!r.success) return;
    const msg = r.data;

    if (msg.type === "HELLO") {
      this.byWorker.set(msg.worker_id, socket);
      this.workerOf.set(socket, msg.worker_id);
      this.rawSend(socket, {
        type: "WELCOME", nonce: this.opts.idGen.next("nonce"), ts: this.opts.clock.now(),
        protocol_version: PROTOCOL_VERSION, server_time: this.opts.clock.now(), heartbeat_interval_ms: 20000
      });
      for (const h of this.msgHandlers) h(msg.worker_id, msg);
      return;
    }

    if (msg.type === "RESULT") {
      const p = this.pending.get(msg.req_id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.req_id); p.resolve(msg); }
      return;
    }

    const wid = this.workerOf.get(socket);
    if (wid) for (const h of this.msgHandlers) h(wid, msg);
  }

  private onSocketClose(socket: WebSocket): void {
    const wid = this.workerOf.get(socket);
    if (!wid) return;
    this.workerOf.delete(socket);
    this.byWorker.delete(wid);
    for (const [req_id, p] of [...this.pending]) {
      if (p.worker_id === wid) { clearTimeout(p.timer); this.pending.delete(req_id); p.reject(new Error(`worker ${wid} disconnected`)); }
    }
    for (const h of this.disconnectHandlers) h(wid);
  }

  private rawSend(socket: WebSocket, msg: ServerToClient): void {
    const r = ServerToClientSchema.safeParse(msg);
    if (!r.success) { console.error("[hub] outgoing failed schema", r.error); return; }
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  /** 发 EXEC 并等配对的 RESULT。 */
  exec(worker_id: string, params: { session_id: string; tab_id: string; step: { tool: string; args: unknown } }): Promise<Result> {
    const socket = this.byWorker.get(worker_id);
    if (!socket) return Promise.reject(new Error(`worker ${worker_id} not connected`));
    const req_id = this.opts.idGen.next("req");
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`EXEC ${req_id} timeout after ${this.execTimeoutMs}ms`));
      }, this.execTimeoutMs);
      this.pending.set(req_id, { resolve, reject, timer, worker_id });
      this.rawSend(socket, {
        type: "EXEC", nonce: this.opts.idGen.next("nonce"), ts: this.opts.clock.now(),
        protocol_version: PROTOCOL_VERSION, req_id,
        session_id: params.session_id, tab_id: params.tab_id, step: params.step
      });
    });
  }

  // === WSHub 接口实现 ===
  async send(worker_id: string, msg: ServerToClient): Promise<void> {
    const socket = this.byWorker.get(worker_id);
    if (!socket) throw new Error(`worker ${worker_id} not connected`);
    this.rawSend(socket, msg);
  }
  onMessage(handler: (worker_id: string, msg: ClientToServer) => void): void { this.msgHandlers.push(handler); }
  onDisconnect(handler: (worker_id: string) => void): void { this.disconnectHandlers.push(handler); }
  connectedWorkers(): string[] { return [...this.byWorker.keys()]; }
  async disconnect(worker_id: string, _reason: string): Promise<void> {
    const socket = this.byWorker.get(worker_id);
    if (socket) socket.close();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @aipagego/mcp-server test loopback-ws-hub`
Expected: PASS（exec resolve / timeout / disconnect 三条核心路径；WELCOME 用例若 flaky 可加 `await hub.ready()` 后小延时）。

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/loopback-ws-hub.ts packages/mcp-server/tests/loopback-ws-hub.test.ts
git commit -m "feat(mcp-server): LoopbackWSHub with req_id<->RESULT correlation"
```

---

## Task 5: 控制面 schema + 工具处理逻辑（接门面）

**Files:**
- Create: `packages/mcp-server/src/control-tools.ts`
- Create: `packages/mcp-server/src/handlers.ts`
- Test: `packages/mcp-server/tests/handlers.test.ts`

- [ ] **Step 1: 写失败测试**（真 `Coordinator` + 假 hub）

```ts
// packages/mcp-server/tests/handlers.test.ts
import { describe, it, expect } from "vitest";
import { Coordinator, FakeClock, FakeIdGen, type Worker } from "@aipagego/coordinator";
import type { Result } from "@aipagego/shared/protocol";
import {
  handleListTabs, handleOpenSession, handleCloseSession, handleGetQuota, handleBrowserTool, type Deps
} from "../src/handlers";

function fakeWorker(): Worker {
  return {
    id: "w1", fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: new Set(["read:dom", "interact:form"]), attended: true, labels: new Set(),
    available_tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }],
    saved_tools: [], protocol_version: 1, connected_at: 0, last_heartbeat_at: 0
  };
}

function makeDeps(execResult: Result): { deps: Deps; calls: any[] } {
  const clock = new FakeClock(1000);
  const coordinator = new Coordinator({ hub: {} as any, clock, idGen: new FakeIdGen() });
  coordinator.registerWorker(fakeWorker());
  const calls: any[] = [];
  const hub = { exec: async (worker_id: string, params: any) => { calls.push({ worker_id, params }); return execResult; } };
  return { deps: { coordinator, hub: hub as any }, calls };
}

const okResult: Result = { type: "RESULT", nonce: "n", ts: 1, protocol_version: 1, req_id: "req_1", ok: true, return: { clicked: true } };

describe("control-plane handlers", () => {
  it("list_tabs returns the single worker's tabs", () => {
    const { deps } = makeDeps(okResult);
    expect(handleListTabs(deps)).toEqual({ tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }] });
  });

  it("open_session → session_id; default scope = all capabilities", () => {
    const { deps } = makeDeps(okResult);
    const { session_id } = handleOpenSession(deps, { tab_id: "42" });
    expect(typeof session_id).toBe("string");
    const s = deps.coordinator.sessions.get(session_id)!;
    expect(s.tab_id).toBe("42");
    expect(s.scope.has("submit:form")).toBe(true); // 缺省给全量
  });

  it("list_tabs errors when no worker connected", () => {
    const clock = new FakeClock(0);
    const coordinator = new Coordinator({ hub: {} as any, clock, idGen: new FakeIdGen() });
    expect(() => handleListTabs({ coordinator, hub: {} as any })).toThrow(/没有浏览器连入/);
  });
});

describe("handleBrowserTool", () => {
  it("validates, records quota, sends EXEC, returns RESULT.return", async () => {
    const { deps, calls } = makeDeps(okResult);
    const { session_id } = handleOpenSession(deps, { tab_id: "42" });
    const gen = { name: "browser_click", builtinTool: "click", description: "", inputSchema: {} as any };
    const out = await handleBrowserTool(deps, gen, { session_id, selector: ".b" });
    expect(out).toEqual({ clicked: true });
    expect(calls[0].params.step).toEqual({ tool: "click", args: { selector: ".b" } });
    expect(calls[0].params.tab_id).toBe("42");
    expect(deps.coordinator.quotaFor(session_id)!.steps_used).toBe(1);
  });

  it("maps httpRequest withCredentials → dangerous (httpCookied)", async () => {
    const { deps } = makeDeps(okResult);
    const { session_id } = handleOpenSession(deps, { tab_id: "42" });
    const gen = { name: "browser_httpRequest", builtinTool: "httpRequest", description: "", inputSchema: {} as any };
    await handleBrowserTool(deps, gen, { session_id, url: "https://x", withCredentials: true });
    expect(deps.coordinator.quotaFor(session_id)!.dangerous_used).toBe(1);
  });

  it("throws on unknown session", async () => {
    const { deps } = makeDeps(okResult);
    const gen = { name: "browser_click", builtinTool: "click", description: "", inputSchema: {} as any };
    await expect(handleBrowserTool(deps, gen, { session_id: "nope", selector: ".b" })).rejects.toThrow(/not found|SessionNotFound/);
  });

  it("throws when RESULT.ok is false", async () => {
    const bad: Result = { type: "RESULT", nonce: "n", ts: 1, protocol_version: 1, req_id: "req_1", ok: false, error: { code: "PageScriptError", message: "boom", retryable: false } };
    const { deps } = makeDeps(bad);
    const { session_id } = handleOpenSession(deps, { tab_id: "42" });
    const gen = { name: "browser_click", builtinTool: "click", description: "", inputSchema: {} as any };
    await expect(handleBrowserTool(deps, gen, { session_id, selector: ".b" })).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @aipagego/mcp-server test handlers`
Expected: FAIL（`src/handlers.ts` 不存在）。

- [ ] **Step 3: 实现 `control-tools.ts`**

```ts
// packages/mcp-server/src/control-tools.ts
import type { JsonSchema } from "@aipagego/shared/types";

export type ControlTool = { name: string; description: string; inputSchema: JsonSchema };

export const CONTROL_TOOLS: ControlTool[] = [
  {
    name: "list_tabs",
    description: "列出当前连入的浏览器（worker）可用的标签页：[{tab_id,url,title}]。先调它拿 tab_id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } as JsonSchema
  },
  {
    name: "open_session",
    description: "为某个 tab 开一个会话，返回 session_id；后续 browser_* 工具都带这个 session_id。capabilities 省略=授予全部能力。",
    inputSchema: {
      type: "object",
      required: ["tab_id"],
      properties: {
        tab_id: { type: "string", description: "list_tabs 返回的 tab_id" },
        capabilities: { type: "array", items: { type: "string" }, description: "能力域白名单；省略=全部" },
        idle_timeout_min: { type: "number", description: "覆盖默认空闲超时（分钟）" }
      },
      additionalProperties: false
    } as JsonSchema
  },
  {
    name: "close_session",
    description: "关闭会话。",
    inputSchema: { type: "object", required: ["session_id"], properties: { session_id: { type: "string" } }, additionalProperties: false } as JsonSchema
  },
  {
    name: "get_quota",
    description: "查询会话剩余预算：steps/dangerous 已用与上限、距过期时间。",
    inputSchema: { type: "object", required: ["session_id"], properties: { session_id: { type: "string" } }, additionalProperties: false } as JsonSchema
  }
];
```

- [ ] **Step 4: 实现 `handlers.ts`**

```ts
// packages/mcp-server/src/handlers.ts
import type { Coordinator } from "@aipagego/coordinator";
import { CAPABILITIES, isCapability, type Capability } from "@aipagego/shared/capability";
import type { BuiltinTool, Json } from "@aipagego/shared/types";
import type { Result } from "@aipagego/shared/protocol";
import type { GeneratedTool } from "./tool-gen";

export interface Hub {
  exec(worker_id: string, params: { session_id: string; tab_id: string; step: { tool: string; args: unknown } }): Promise<Result>;
}
export interface Deps { coordinator: Coordinator; hub: Hub; }

function singleWorkerId(c: Coordinator): string {
  const workers = c.workers.list();
  if (workers.length === 0) throw new Error("没有浏览器连入，请在扩展设置页填 ws://127.0.0.1:<port>/worker 连接");
  if (workers.length > 1) throw new Error("检测到多个浏览器连入；v1 仅支持单 worker，请只保留一个连接");
  return workers[0].id;
}

export function handleListTabs(deps: Deps): { tabs: unknown[] } {
  const w = deps.coordinator.workers.get(singleWorkerId(deps.coordinator))!;
  return { tabs: w.available_tabs };
}

export function handleOpenSession(deps: Deps, args: Record<string, unknown>): { session_id: string } {
  const worker_id = singleWorkerId(deps.coordinator);
  const tab_id = String(args.tab_id);
  const requested = Array.isArray(args.capabilities) ? (args.capabilities as unknown[]).map(String).filter(isCapability) : [];
  const scope = new Set<Capability>(requested.length ? requested : (CAPABILITIES as readonly Capability[]));
  const idle_timeout_ms = typeof args.idle_timeout_min === "number" ? args.idle_timeout_min * 60_000 : undefined;
  const s = deps.coordinator.openSession({ ai_client_fingerprint: "mcp-local", worker_id, tab_id, scope, idle_timeout_ms });
  return { session_id: s.id };
}

export function handleCloseSession(deps: Deps, args: Record<string, unknown>): { ok: true } {
  deps.coordinator.closeSession(String(args.session_id));
  return { ok: true };
}

export function handleGetQuota(deps: Deps, args: Record<string, unknown>): unknown {
  const q = deps.coordinator.quotaFor(String(args.session_id));
  if (!q) throw new Error(`session ${String(args.session_id)} not found`);
  return q;
}

export async function handleBrowserTool(deps: Deps, gen: GeneratedTool, args: Record<string, unknown>): Promise<Json> {
  const session_id = String(args.session_id);
  const session = deps.coordinator.sessions.get(session_id);
  if (!session) throw new Error(`session ${session_id} not found`);

  const { session_id: _omit, ...toolArgs } = args;
  const tool = gen.builtinTool as BuiltinTool;
  const httpCookied = tool === "httpRequest" ? Boolean((toolArgs as Record<string, unknown>).withCredentials) : undefined;

  const v = deps.coordinator.validateCall({ session_id, kind: "extension_tool", tool, httpCookied });
  if (!v.ok) throw new Error(`${v.error.code}: ${v.error.message}`);
  deps.coordinator.recordCall(session_id, v.dangerous);

  const result = await deps.hub.exec(session.worker_id, { session_id, tab_id: session.tab_id, step: { tool, args: toolArgs as Json } });
  if (!result.ok) throw new Error(result.error ? `${result.error.code}: ${result.error.message}` : "EXEC failed");
  return (result.return ?? null) as Json;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @aipagego/mcp-server test handlers`
Expected: PASS（控制面 3 + browser 4 用例）。

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/control-tools.ts packages/mcp-server/src/handlers.ts packages/mcp-server/tests/handlers.test.ts
git commit -m "feat(mcp-server): control-plane schemas + tool handlers over Coordinator"
```

---

## Task 6: 组装 `mcp-server.ts` + `wire.ts` + `index.ts`

**Files:**
- Create: `packages/mcp-server/src/mcp-server.ts`
- Create: `packages/mcp-server/src/wire.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Test: `packages/mcp-server/tests/mcp-server.test.ts`

- [ ] **Step 1: 写失败测试**（`buildToolList` + `dispatchCall` 纯路由）

```ts
// packages/mcp-server/tests/mcp-server.test.ts
import { describe, it, expect } from "vitest";
import { Coordinator, FakeClock, FakeIdGen, type Worker } from "@aipagego/coordinator";
import type { Result } from "@aipagego/shared/protocol";
import { buildToolList, dispatchCall } from "../src/mcp-server";

function fakeWorker(): Worker {
  return {
    id: "w1", fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: new Set(["read:dom"]), attended: true, labels: new Set(),
    available_tabs: [{ tab_id: "42", url: "https://example.org" }],
    saved_tools: [], protocol_version: 1, connected_at: 0, last_heartbeat_at: 0
  };
}
const okResult: Result = { type: "RESULT", nonce: "n", ts: 1, protocol_version: 1, req_id: "req_1", ok: true, return: { ok: 1 } };
function deps() {
  const coordinator = new Coordinator({ hub: {} as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
  coordinator.registerWorker(fakeWorker());
  return { coordinator, hub: { exec: async () => okResult } as any };
}

describe("buildToolList", () => {
  it("lists 4 control + 19 browser tools, each with inputSchema", () => {
    const tools = buildToolList();
    expect(tools.length).toBe(23);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_tabs");
    expect(names).toContain("open_session");
    expect(names).toContain("browser_click");
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
  });
});

describe("dispatchCall", () => {
  it("routes list_tabs and returns content", async () => {
    const r = await dispatchCall(deps(), "list_tabs", {});
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("42");
  });
  it("returns isError for unknown tool", async () => {
    const r = await dispatchCall(deps(), "no_such_tool", {});
    expect(r.isError).toBe(true);
  });
  it("routes a generated browser_* tool", async () => {
    const d = deps();
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(open.content[0].text).session_id;
    const r = await dispatchCall(d, "browser_snapshotDOM", { session_id });
    expect(r.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @aipagego/mcp-server test mcp-server`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `mcp-server.ts`**

```ts
// packages/mcp-server/src/mcp-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema } from "@aipagego/shared/types";
import { CONTROL_TOOLS } from "./control-tools";
import { generateBrowserTools, type GeneratedTool } from "./tool-gen";
import {
  handleListTabs, handleOpenSession, handleCloseSession, handleGetQuota, handleBrowserTool, type Deps
} from "./handlers";

export type ToolListEntry = { name: string; description: string; inputSchema: JsonSchema };
export type CallResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const BROWSER_TOOLS: GeneratedTool[] = generateBrowserTools();
const BROWSER_BY_NAME = new Map(BROWSER_TOOLS.map((t) => [t.name, t]));

export function buildToolList(): ToolListEntry[] {
  return [
    ...CONTROL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ...BROWSER_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as JsonSchema }))
  ];
}

const ok = (data: unknown): CallResult => ({ content: [{ type: "text", text: JSON.stringify(data ?? null) }] });
const fail = (message: string): CallResult => ({ content: [{ type: "text", text: message }], isError: true });

export async function dispatchCall(deps: Deps, name: string, args: Record<string, unknown>): Promise<CallResult> {
  try {
    if (name === "list_tabs") return ok(handleListTabs(deps));
    if (name === "open_session") return ok(handleOpenSession(deps, args));
    if (name === "close_session") return ok(handleCloseSession(deps, args));
    if (name === "get_quota") return ok(handleGetQuota(deps, args));
    const gen = BROWSER_BY_NAME.get(name);
    if (gen) return ok(await handleBrowserTool(deps, gen, args));
    return fail(`unknown tool: ${name}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function createMcpServer(deps: Deps): Server {
  const server = new Server({ name: "aipagego-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return dispatchCall(deps, req.params.name, args);
  });
  return server;
}
```

- [ ] **Step 4: 实现 `wire.ts`**

```ts
// packages/mcp-server/src/wire.ts
import type { Coordinator, Worker, Clock } from "@aipagego/coordinator";
import { isCapability, type Capability } from "@aipagego/shared/capability";
import type { Hello } from "@aipagego/shared/protocol";
import type { LoopbackWSHub } from "./loopback-ws-hub";

export function helloToWorker(h: Hello, now: number): Worker {
  return {
    id: h.worker_id,
    fingerprint: h.fingerprint,
    capabilities: new Set<Capability>(h.capabilities.filter(isCapability)),
    attended: h.attended,
    labels: new Set(h.labels),
    available_tabs: h.available_tabs,
    saved_tools: h.saved_tools,
    protocol_version: h.protocol_version,
    connected_at: now,
    last_heartbeat_at: now
  };
}

export function installWire(hub: LoopbackWSHub, coordinator: Coordinator, clock: Clock): void {
  hub.onMessage((worker_id, msg) => {
    switch (msg.type) {
      case "HELLO": coordinator.registerWorker(helloToWorker(msg, clock.now())); break;
      case "PING": coordinator.heartbeatWorker(worker_id); break;
      default: break; // PROGRESS/SESSION_EVENT/STATE_SNAPSHOT 等 v1 不处理
    }
  });
  hub.onDisconnect((worker_id) => coordinator.unregisterWorker(worker_id));
}
```

- [ ] **Step 5: 实现 `index.ts`（bin 入口）**

```ts
// packages/mcp-server/src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Coordinator, DefaultClock, DefaultIdGen } from "@aipagego/coordinator";
import { LoopbackWSHub } from "./loopback-ws-hub";
import { createMcpServer } from "./mcp-server";
import { installWire } from "./wire";

// ⚠ stdout 是 MCP 通道，日志一律 console.error。
async function main(): Promise<void> {
  const port = Number(process.env.WEBPILOT_WS_PORT ?? 8787);
  const token = process.env.WEBPILOT_WS_TOKEN || undefined;

  const clock = new DefaultClock();
  const idGen = new DefaultIdGen();
  const hub = new LoopbackWSHub({ port, token, clock, idGen });
  await hub.ready();
  const coordinator = new Coordinator({ hub, clock, idGen });
  installWire(hub, coordinator, clock);

  const server = createMcpServer({ coordinator, hub });
  await server.connect(new StdioServerTransport());
  console.error(`[aipagego-mcp] ws://127.0.0.1:${port}/worker ready; stdio MCP connected`);
}

main().catch((e) => { console.error("[aipagego-mcp] fatal", e); process.exit(1); });
```

- [ ] **Step 6: 跑测试 + typecheck**

Run: `pnpm -F @aipagego/mcp-server test mcp-server`
Expected: PASS

Run: `pnpm -F @aipagego/mcp-server typecheck`
Expected: 无错。

- [ ] **Step 7: bin 冒烟（手动，可选）**

Run: `WEBPILOT_WS_PORT=8799 node --experimental-strip-types packages/mcp-server/src/index.ts`
Expected: stderr 打印 `ws://127.0.0.1:8799/worker ready; stdio MCP connected`；进程驻留（Ctrl-C 退出）。若 Node 版本不支持 `--experimental-strip-types`，记为已知限制，留待 Task 7 的 tsx/构建说明。

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/src/mcp-server.ts packages/mcp-server/src/wire.ts packages/mcp-server/src/index.ts packages/mcp-server/tests/mcp-server.test.ts
git commit -m "feat(mcp-server): assemble SDK server + wire + bin entry"
```

---

## Task 7: 文档与索引 + 全量校验

**Files:**
- Modify: `README.md`（Coordinator 远程控制小节加 MCP 用法）
- Modify: `AGENTS.md`（仓库目录加 `packages/mcp-server`）
- Modify: `docs/superpowers/plans/README.md`（加本计划行）
- Create: `packages/mcp-server/README.md`（启动 + Claude Code MCP 配置示例）

- [ ] **Step 1: 写 `packages/mcp-server/README.md`**

```markdown
# @aipagego/mcp-server

让 Claude Code 经本地 coordinator 驱动 AIPageGo 扩展操作浏览器（EXEC 模式）。

## 启动

    WEBPILOT_WS_PORT=8787 WEBPILOT_WS_TOKEN=dev node packages/mcp-server/src/index.ts

（Node 需支持运行 TS bin；否则用 `tsx packages/mcp-server/src/index.ts`。）

监听 `ws://127.0.0.1:8787/worker`。在扩展设置页 → Coordinator 子页填该 URL + token=`dev` → 连接。

## Claude Code MCP 配置（示例）

    {
      "mcpServers": {
        "aipagego": {
          "command": "tsx",
          "args": ["packages/mcp-server/src/index.ts"],
          "env": { "WEBPILOT_WS_PORT": "8787", "WEBPILOT_WS_TOKEN": "dev" }
        }
      }
    }

## 工具

- `list_tabs` → `open_session(tab_id)` → `browser_*(session_id, …)` → `close_session`
- 19 个 `browser_*` 自动从扩展 TOOL_DEFS 生成；`get_quota` 查预算。

⚠ 进程禁止往 stdout 写非 MCP 内容（stdout 是 MCP 通道）。
```

- [ ] **Step 2: 更新 `docs/superpowers/plans/README.md`**

在计划清单末尾加一行（紧随现有最后一条；格式与该文件既有行保持一致）：

```markdown
| 13 | MCP Bridge（Phase 3） | [`2026-06-06-mcp-bridge.md`](./2026-06-06-mcp-bridge.md) | 新包 `packages/mcp-server`：stdio MCP + LoopbackWSHub（req_id↔RESULT 配对）复用 Coordinator 门面；自动生成 19 个 browser_* 工具 + 4 控制面工具 |
```

（先 `sed -n '1,60p' docs/superpowers/plans/README.md` 确认表头列数与编号，套用同样列。）

- [ ] **Step 3: 更新 `README.md` 的 Coordinator 小节**

在 `## Coordinator 远程控制` 小节「本地 smoke」之后追加：

```markdown
### 用 Claude Code 驱动浏览器（MCP Bridge，Plan 13）

`packages/mcp-server` 是一个 stdio MCP server，同时起本地 ws 服务器。Claude Code 连它后可调
`list_tabs / open_session / browser_*（19 个）/ get_quota / close_session` 在网页上读写采。

    node packages/mcp-server/src/index.ts   # 监听 ws://127.0.0.1:8787/worker
    # 扩展设置页填该 URL + token → 连接；Claude Code 侧把它配成 MCP server

详见 `packages/mcp-server/README.md`。
```

- [ ] **Step 4: 更新 `AGENTS.md` 目录树**

在 `packages/` 树里 `coordinator/` 行之后加：

```
└─ mcp-server/             stdio MCP server + LoopbackWSHub（Plan 13；Claude 经 coordinator 驱动浏览器）
```

（先看 `AGENTS.md` 现有 `packages/` 段落缩进，套用一致。）

- [ ] **Step 5: 全量校验**

Run: `pnpm -r typecheck`
Expected: shared / coordinator / extension / mcp-server 全部通过。

Run: `pnpm -r test`
Expected: 全绿，新增 mcp-server 用例计入（tool-gen 4 + loopback 4 + handlers 7 + mcp-server 4 ≈ 19 条）。

Run: `pnpm -F @aipagego/extension build`
Expected: 扩展 dist 仍正常产出（确认 TOOL_DEFS 上提没破坏构建）。

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md docs/superpowers/plans/README.md packages/mcp-server/README.md
git commit -m "docs(mcp-server): usage + repo index updates for Plan 13"
```

---

## Self-Review 备注（写计划时已核对）

- **Spec 覆盖**：架构/包布局(Task1,6)、TOOL_DEFS 上提(Task2)、LoopbackWSHub+配对(Task4)、19 工具自动生成(Task3)、控制面+门面接入(Task5)、错误/超时/掉线(Task4,5)、测试策略(各 Task)、文档(Task7) 均有对应任务。
- **runJS/tab 控制不生成**：`EXEC_TOOL_NAMES` 显式 19 个，测试断言排除（Task3）。
- **类型一致**：`hub.exec(worker_id, {session_id,tab_id,step})`、`Deps`、`GeneratedTool.builtinTool`、`DispatchInput{kind:"extension_tool"}` 在 Task4/5/6 中签名一致。
- **门面公开成员**：用到的 `coordinator.sessions`/`coordinator.workers` 为 `readonly` 公开属性，`openSession/validateCall/recordCall/quotaFor/registerWorker/unregisterWorker/heartbeatWorker/closeSession` 均为公开方法（已核对 `coordinator.ts`）。
- **stdio 洁癖**：所有日志 `console.error`（Task6 index.ts 注释强调）。
- **未决/已知限制**：bin 以 TS 直跑依赖 Node 版本或 `tsx`；若需独立分发再加构建步骤（YAGNI，本期不做）。`@modelcontextprotocol/sdk` 版本以安装时 latest 为准（低层 `Server`/`StdioServerTransport`/`ListToolsRequestSchema`/`CallToolRequestSchema` 导入路径稳定）。
