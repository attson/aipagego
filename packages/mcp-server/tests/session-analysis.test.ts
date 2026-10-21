import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeEvents } from "../src/session-analysis/analyzer";
import { parseSessionLines } from "../src/session-analysis/adapters";
import { latestSessionEvents, parseCliArgs, renderReport } from "../src/session-analysis/cli-support";
import { scanHistories } from "../src/session-analysis/scanner";
import type { ToolEvent } from "../src/session-analysis/types";

function jsonLines(records: unknown[]): AsyncIterable<string> {
  return Readable.from(records.map((record) => `${typeof record === "string" ? record : JSON.stringify(record)}\n`));
}

describe("local session adapters", () => {
  it("extracts Claude tool calls/results without retaining raw values", async () => {
    const records = [
      {
        type: "assistant",
        sessionId: "claude-session",
        timestamp: "2026-09-18T10:00:00.000Z",
        uuid: "assistant-1",
        message: {
          id: "msg-1",
          role: "assistant",
          usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 7 },
          content: [{
            type: "tool_use",
            id: "call-1",
            name: "mcp__aipagego__browser_resize",
            input: { session_id: "secret-token", width: 390, height: 844 }
          }]
        }
      },
      {
        type: "user",
        sessionId: "claude-session",
        timestamp: "2026-09-18T10:00:01.000Z",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call-1",
            content: "secret-result-body"
          }]
        }
      }
    ];

    const parsed = await parseSessionLines({
      client: "claude",
      lines: jsonLines(records),
      fallbackSessionKey: "fallback",
      sinceMs: 0
    });

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      client: "claude",
      tool: "browser_resize",
      argFields: ["height", "session_id", "width"],
      confidence: "exact",
      roundInputTokens: 150,
      roundOutputTokens: 7
    });
    expect(parsed.events[0].argHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.events[0].resultBytes).toBeGreaterThan(0);
    expect(JSON.stringify(parsed)).not.toContain("secret-token");
    expect(JSON.stringify(parsed)).not.toContain("secret-result-body");
  });

  it("extracts direct and nested Codex calls and skips malformed lines", async () => {
    const records = [
      '{"type":"response_item","payload":{"type":"function_call"',
      {
        type: "response_item",
        timestamp: "2026-09-18T10:00:00.000Z",
        payload: {
          type: "function_call",
          call_id: "direct-1",
          id: "item-1",
          name: "mcp__aipagego__browser_waitFor",
          arguments: JSON.stringify({ session_id: "secret-token", ms: 500 })
        }
      },
      {
        type: "response_item",
        timestamp: "2026-09-18T10:00:01.000Z",
        payload: {
          type: "function_call_output",
          call_id: "direct-1",
          output: "secret-output"
        }
      },
      {
        type: "response_item",
        timestamp: "2026-09-18T10:00:02.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "exec-1",
          id: "item-2",
          name: "exec",
          input: [
            "const fake = 'await tools.mcp__aipagego__browser_resize({width: 1})';",
            "// await tools.mcp__aipagego__browser_click({selector: '.x'});",
            "const a = await tools.mcp__aipagego__browser_screenshot({session_id: token}); text(a);"
          ].join("\n")
        }
      }
    ];

    const parsed = await parseSessionLines({
      client: "codex",
      lines: jsonLines(records),
      fallbackSessionKey: "codex-session",
      sinceMs: 0
    });

    expect(parsed.malformedLines).toBe(1);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({
      tool: "browser_waitFor",
      confidence: "exact",
      signals: { fixedWait: true }
    });
    expect(parsed.events[0].resultBytes).toBeGreaterThan(0);
    expect(parsed.events[1]).toMatchObject({
      tool: "browser_screenshot",
      confidence: "derived",
      argFields: []
    });
    expect(JSON.stringify(parsed)).not.toContain("secret-token");
    expect(JSON.stringify(parsed)).not.toContain("secret-output");
  });

  it("joins a yielded Codex exec cell to waits, timeout, latency and token usage", async () => {
    const records = [
      {
        type: "response_item",
        timestamp: "2026-09-18T10:00:00.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "exec-1",
          id: "item-1",
          name: "exec",
          input: "const r = await tools.mcp__aipagego__list_tabs({}); text(r);"
        }
      },
      {
        type: "response_item",
        timestamp: "2026-09-18T10:00:01.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "exec-1",
          output: "Script running with cell ID 70 Wall time 31.0 seconds Output:"
        }
      },
      {
        type: "event_msg",
        timestamp: "2026-09-18T10:00:01.100Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 80_000, cached_input_tokens: 79_000, output_tokens: 40 } }
        }
      },
      {
        type: "response_item",
        timestamp: "2026-09-18T10:00:30.000Z",
        payload: {
          type: "function_call",
          call_id: "wait-1",
          name: "wait",
          arguments: JSON.stringify({ cell_id: "70", yield_time_ms: 30_000 })
        }
      },
      {
        type: "response_item",
        timestamp: "2026-09-18T10:00:31.000Z",
        payload: {
          type: "function_call_output",
          call_id: "wait-1",
          output: "等待浏览器授权超时（90 秒）。请打开配对页 http://127.0.0.1:40901/pair 完成授权后重试。"
        }
      },
      {
        type: "event_msg",
        timestamp: "2026-09-18T10:00:31.100Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 81_000, cached_input_tokens: 80_500, output_tokens: 30 } }
        }
      }
    ];

    const parsed = await parseSessionLines({
      client: "codex",
      lines: jsonLines(records),
      fallbackSessionKey: "codex-session",
      sinceMs: 0
    });

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      tool: "list_tabs",
      confidence: "derived",
      isError: true,
      durationMs: 31_000,
      roundInputTokens: 161_000,
      roundCachedInputTokens: 159_500,
      roundOutputTokens: 70,
      signals: { pairingRequired: true, pairingTimeout: true }
    });
    expect(parsed.events[0].resultBytes).toBeGreaterThan(0);
    expect(JSON.stringify(parsed)).not.toContain("127.0.0.1");
  });

  it("records a connected pairing state without retaining its result", async () => {
    const parsed = await parseSessionLines({
      client: "codex",
      lines: jsonLines([
        {
          type: "response_item",
          timestamp: "2026-09-18T10:00:00.000Z",
          payload: {
            type: "custom_tool_call",
            call_id: "exec-1",
            id: "item-1",
            name: "exec",
            input: "const r = await tools.mcp__aipagego__pairing_status({}); text(r);"
          }
        },
        {
          type: "response_item",
          timestamp: "2026-09-18T10:00:00.100Z",
          payload: {
            type: "custom_tool_call_output",
            call_id: "exec-1",
            output: "{\"status\":\"connected\",\"tab_count\":2}"
          }
        }
      ]),
      fallbackSessionKey: "codex-session",
      sinceMs: 0
    });

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      tool: "pairing_status",
      signals: { pairingConnected: true }
    });
    expect(JSON.stringify(parsed)).not.toContain("tab_count");
  });
});

function event(
  sequence: number,
  tool: string,
  signals: ToolEvent["signals"] = {},
  argHash = `${tool}-${sequence}`
): ToolEvent {
  return {
    id: `event-${sequence}`,
    client: "claude",
    sessionKey: "session-a",
    roundKey: `round-${sequence}`,
    sequence,
    tool,
    argFields: [],
    argHash,
    confidence: "exact",
    signals
  };
}

describe("session efficiency analyzer", () => {
  it("detects redundant verification, waits, discovery, duplicates and serial fills", () => {
    const sameClickHash = "same-click";
    const events = [
      event(1, "browser_resize"),
      event(2, "browser_screenshot"),
      event(3, "browser_runJS", { viewportProbe: true }),
      event(4, "browser_waitFor", { fixedWait: true }),
      event(5, "browser_discoverTools", { emptyDiscovery: true }),
      event(6, "browser_discoverTools", { enablesDiscovery: true }),
      event(7, "browser_click", {}, sameClickHash),
      event(8, "browser_click", {}, sameClickHash),
      event(9, "browser_screenshot"),
      event(10, "browser_screenshot"),
      event(11, "browser_fillInput"),
      event(12, "browser_fillInput"),
      event(13, "browser_fillInput"),
      event(14, "list_tabs", { pairingRequired: true, pairingTimeout: true }),
      event(15, "list_tabs", { pairingRequired: true, pairingTimeout: true })
    ];

    const report = analyzeEvents(events, {
      since: "2026-08-20T00:00:00.000Z",
      generatedAt: "2026-09-19T00:00:00.000Z",
      clients: {
        claude: { available: true, filesSeen: 1, filesScanned: 1, malformedLines: 0, toolCalls: 13, exactCalls: 13, derivedCalls: 0 },
        codex: { available: false, filesSeen: 0, filesScanned: 0, malformedLines: 0, toolCalls: 0, exactCalls: 0, derivedCalls: 0 }
      }
    });
    const byId = new Map(report.findings.map((finding) => [finding.id, finding]));

    expect(byId.get("viewport_recheck_after_screenshot")?.occurrences).toBe(1);
    expect(byId.get("fixed_wait")?.occurrences).toBe(1);
    expect(byId.get("discovery_round_trip")?.occurrences).toBe(1);
    expect(byId.get("duplicate_call")?.occurrences).toBeGreaterThanOrEqual(1);
    expect(byId.get("repeated_screenshot")?.occurrences).toBe(1);
    expect(byId.get("serial_form_fill")?.estimatedAvoidableRounds).toBe(2);
    expect(byId.get("pairing_timeout")?.occurrences).toBe(2);
    expect(byId.get("pairing_retry_without_state_change")?.occurrences).toBe(1);
    expect(report.summary.estimatedAvoidableRounds).toBeGreaterThanOrEqual(9);
    expect(report.summary.toolCalls).toBe(events.length);
  });

  it("renders only aggregate data", () => {
    const report = analyzeEvents([event(1, "browser_waitFor", { fixedWait: true }, "secret-hash")], {
      since: "2026-08-20T00:00:00.000Z",
      generatedAt: "2026-09-19T00:00:00.000Z",
      clients: {
        claude: { available: true, filesSeen: 1, filesScanned: 1, malformedLines: 0, toolCalls: 1, exactCalls: 1, derivedCalls: 0 },
        codex: { available: false, filesSeen: 0, filesScanned: 0, malformedLines: 0, toolCalls: 0, exactCalls: 0, derivedCalls: 0 }
      }
    });
    const text = renderReport(report, "text");
    const json = renderReport(report, "json");
    expect(text).toContain("fixed_wait");
    expect(json).toContain('"toolCalls": 1');
    expect(text + json).not.toContain("secret-hash");
    expect(text + json).not.toContain("session-a");
  });

  it("does not call observations duplicates across a page-state boundary", () => {
    const events = [
      event(1, "browser_takeSnapshot", {}, "same-snapshot"),
      event(2, "browser_click"),
      event(3, "browser_takeSnapshot", {}, "same-snapshot"),
      event(4, "browser_screenshot", {}, "same-shot"),
      event(5, "browser_waitFor", { fixedWait: true }),
      event(6, "browser_screenshot", {}, "same-shot")
    ];
    const report = analyzeEvents(events, {
      since: "2026-08-20T00:00:00.000Z",
      generatedAt: "2026-09-19T00:00:00.000Z",
      clients: {
        claude: { available: true, filesSeen: 1, filesScanned: 1, malformedLines: 0, toolCalls: 6, exactCalls: 6, derivedCalls: 0 },
        codex: { available: false, filesSeen: 0, filesScanned: 0, malformedLines: 0, toolCalls: 0, exactCalls: 0, derivedCalls: 0 }
      }
    });
    expect(report.findings.find((finding) => finding.id === "duplicate_call")).toBeUndefined();
    expect(report.findings.find((finding) => finding.id === "repeated_screenshot")).toBeUndefined();
  });

  it("does not flag a pairing retry after an observed connected state", () => {
    const events = [
      event(1, "list_tabs", { pairingRequired: true }),
      event(2, "pairing_status", { pairingConnected: true }),
      event(3, "list_tabs", { pairingRequired: true })
    ];
    const report = analyzeEvents(events, {
      since: "2026-08-20T00:00:00.000Z",
      generatedAt: "2026-09-19T00:00:00.000Z",
      clients: {
        claude: { available: false, filesSeen: 0, filesScanned: 0, malformedLines: 0, toolCalls: 0, exactCalls: 0, derivedCalls: 0 },
        codex: { available: true, filesSeen: 1, filesScanned: 1, malformedLines: 0, toolCalls: 3, exactCalls: 0, derivedCalls: 3 }
      }
    });
    expect(report.findings.find((finding) => finding.id === "pairing_retry_without_state_change")).toBeUndefined();
  });
});

describe("session analyzer CLI", () => {
  it("uses privacy-preserving defaults", () => {
    const options = parseCliArgs([], "/home/tester", new Date("2026-09-19T00:00:00.000Z"));
    expect(options.clients).toEqual(["claude", "codex"]);
    expect(options.format).toBe("text");
    expect(options.latestSession).toBe(false);
    expect(options.sinceMs).toBe(Date.parse("2026-08-20T00:00:00.000Z"));
    expect(options.claudeDir).toBe("/home/tester/.claude/projects");
    expect(options.codexDir).toBe("/home/tester/.codex/sessions");
  });

  it("parses client, duration, format and directory overrides", () => {
    const options = parseCliArgs([
      "--clients", "claude",
      "--since", "7d",
      "--format", "json",
      "--latest-session",
      "--claude-dir", "/tmp/claude"
    ], "/home/tester", new Date("2026-09-19T00:00:00.000Z"));
    expect(options.clients).toEqual(["claude"]);
    expect(options.sinceMs).toBe(Date.parse("2026-09-12T00:00:00.000Z"));
    expect(options.format).toBe("json");
    expect(options.latestSession).toBe(true);
    expect(options.claudeDir).toBe("/tmp/claude");
  });

  it("selects the most recent session containing an AIPageGo call", () => {
    const events = [
      { ...event(1, "list_tabs"), sessionKey: "older", timestampMs: 10 },
      { ...event(2, "browser_click"), sessionKey: "newer", timestampMs: 20 },
      { ...event(3, "browser_screenshot"), sessionKey: "newer", timestampMs: 30 }
    ];
    expect(latestSessionEvents(events).map((item) => item.sessionKey)).toEqual(["newer", "newer"]);
  });

  it("rejects unknown clients and arguments", () => {
    expect(() => parseCliArgs(["--clients", "other"], "/home/tester", new Date())).toThrow(/client/i);
    expect(() => parseCliArgs(["--wat"], "/home/tester", new Date())).toThrow(/unknown argument/i);
  });

  it("ignores pnpm's forwarded argument separator", () => {
    const options = parseCliArgs(["--", "--help"], "/home/tester", new Date());
    expect(options.help).toBe(true);
  });
});

describe("session history scanner", () => {
  it("scans available clients and tolerates a missing client directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "aipagego-session-analysis-"));
    try {
      const claudeDir = join(root, "claude");
      await mkdir(claudeDir);
      await writeFile(join(claudeDir, "session.jsonl"), `${JSON.stringify({
        type: "assistant",
        sessionId: "private-session-id",
        timestamp: "2026-09-18T10:00:00.000Z",
        message: {
          id: "round-1",
          content: [{
            type: "tool_use",
            id: "call-1",
            name: "mcp__aipagego__browser_waitFor",
            input: { ms: 100, session_id: "private-token" }
          }]
        }
      })}\n`, "utf8");

      const scan = await scanHistories({
        clients: ["claude", "codex"],
        sinceMs: Date.parse("2026-09-01T00:00:00.000Z"),
        sinceLabel: "2026-09-01T00:00:00.000Z",
        format: "text",
        claudeDir,
        codexDir: join(root, "missing-codex"),
        latestSession: false,
        help: false
      });

      expect(scan.events).toHaveLength(1);
      expect(scan.clients.claude).toMatchObject({
        available: true,
        filesSeen: 1,
        filesScanned: 1,
        toolCalls: 1,
        exactCalls: 1,
        derivedCalls: 0
      });
      expect(scan.clients.codex.available).toBe(false);
      expect(JSON.stringify(scan)).not.toContain("private-token");
      expect(JSON.stringify(scan)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
