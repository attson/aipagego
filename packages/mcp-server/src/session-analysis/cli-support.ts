import { join } from "node:path";
import type { AnalysisReport, CliOptions, SessionClient, ToolEvent } from "./types";

const CLIENTS = new Set<SessionClient>(["claude", "codex"]);

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function durationMs(raw: string): number {
  const match = /^(\d+)(h|d|w)$/.exec(raw);
  if (!match) throw new Error(`Invalid --since value ${JSON.stringify(raw)}; use e.g. 24h, 7d, or 4w`);
  const amount = Number(match[1]);
  const unit = match[2] === "h" ? 60 * 60_000 : match[2] === "d" ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
  return amount * unit;
}

export function parseCliArgs(args: string[], homeDir: string, now = new Date()): CliOptions {
  let clients: SessionClient[] = ["claude", "codex"];
  let since = "30d";
  let format: CliOptions["format"] = "text";
  let claudeDir = join(homeDir, ".claude", "projects");
  let codexDir = join(homeDir, ".codex", "sessions");
  let latestSession = false;
  let help = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--latest-session") {
      latestSession = true;
      continue;
    }
    if (arg === "--clients") {
      const raw = optionValue(args, index, arg);
      index++;
      clients = raw.split(",").map((value) => value.trim()).filter(Boolean) as SessionClient[];
      if (clients.length === 0 || clients.some((client) => !CLIENTS.has(client))) {
        throw new Error(`Invalid client list ${JSON.stringify(raw)}; use claude,codex`);
      }
      clients = [...new Set(clients)];
      continue;
    }
    if (arg === "--since") {
      since = optionValue(args, index, arg);
      index++;
      continue;
    }
    if (arg === "--format") {
      const raw = optionValue(args, index, arg);
      index++;
      if (raw !== "text" && raw !== "json") throw new Error(`Invalid --format ${JSON.stringify(raw)}; use text or json`);
      format = raw;
      continue;
    }
    if (arg === "--claude-dir" || arg === "--codex-dir") {
      const raw = optionValue(args, index, arg);
      index++;
      if (arg === "--claude-dir") claudeDir = raw;
      else codexDir = raw;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const sinceMs = now.getTime() - durationMs(since);
  return { clients, sinceMs, sinceLabel: new Date(sinceMs).toISOString(), format, claudeDir, codexDir, latestSession, help };
}

export function latestSessionEvents(events: ToolEvent[]): ToolEvent[] {
  let latest: ToolEvent | undefined;
  for (const event of events) {
    if (!latest || (event.timestampMs ?? 0) > (latest.timestampMs ?? 0)) latest = event;
  }
  return latest ? events.filter((event) => event.sessionKey === latest!.sessionKey) : [];
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function renderReport(report: AnalysisReport, format: "text" | "json"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines = [
    "AIPageGo local session analysis",
    `Period: ${report.since} -> ${report.generatedAt}`,
    "",
    `Calls: ${report.summary.toolCalls} (${report.summary.exactCalls} exact, ${report.summary.derivedCalls} derived)`,
    `Sessions: ${report.summary.sessions}; model tool rounds: ${report.summary.modelToolRounds}`,
    `Known tool-round tokens: ${report.summary.toolRoundInputTokens} input / ${report.summary.toolRoundOutputTokens} output`,
    `Input split: ${report.summary.toolRoundCachedInputTokens} cached / ${report.summary.toolRoundUncachedInputTokens} uncached`,
    `Recorded result bytes: ${bytes(report.summary.resultBytes)}`,
    `Failed calls: ${report.summary.failedCalls}; recorded call time: ${(report.summary.totalCallDurationMs / 1000).toFixed(1)} s`,
    `Estimated avoidable rounds: ${report.summary.estimatedAvoidableRounds}`,
    "",
    "Clients:"
  ];
  for (const client of ["claude", "codex"] as const) {
    const stats = report.clients[client];
    lines.push(
      `  ${client}: ${stats.available ? "available" : "unavailable"}; files ${stats.filesScanned}/${stats.filesSeen}; calls ${stats.toolCalls} (${stats.exactCalls} exact, ${stats.derivedCalls} derived); malformed candidate lines ${stats.malformedLines}`
    );
  }
  lines.push("", "Top tools:");
  for (const tool of report.tools.slice(0, 15)) lines.push(`  ${tool.calls.toString().padStart(5)}  ${tool.name}`);
  lines.push("", "Opportunities:");
  if (report.findings.length === 0) lines.push("  No configured patterns found.");
  for (const finding of report.findings) {
    lines.push(
      `  ${finding.id}: ${finding.occurrences} occurrence(s), ${finding.affectedSessions} session(s), ~${finding.estimatedAvoidableRounds} avoidable round(s)`,
      `    ${finding.suggestion}`
    );
  }
  lines.push("", "Privacy: raw prompts, argument values, result bodies and session paths were not retained.");
  return lines.join("\n");
}

export const HELP_TEXT = `Usage: pnpm analyze:sessions -- [options]

Options:
  --since <duration>       Lookback such as 24h, 7d, 4w (default: 30d)
  --clients <list>         claude,codex (default: both)
  --format <text|json>     Output format (default: text)
  --latest-session        Analyze only the latest session with an AIPageGo call
  --claude-dir <path>      Override ~/.claude/projects
  --codex-dir <path>       Override ~/.codex/sessions
  -h, --help               Show this help

The analyzer is read-only and never prints raw prompts, tool arguments, tool
results, credentials, or absolute session paths.`;
