# Local AI Session Analyzer Design

**Status:** implemented.

## Problem

MCP inefficiencies are easiest to recognize from real agent behavior, but adding
runtime telemetry duplicates data already written by local AI clients and adds
privacy and maintenance costs. This machine has both Claude Code and Codex JSONL
histories. Their formats differ, and naive text search is inaccurate because
tool definitions are also embedded in session records.

## Goals

- Provide a read-only local CLI for Claude Code and Codex session histories.
- Parse actual tool-call events rather than matching tool names in arbitrary
  text.
- Report tool frequency, model tool rounds, result bytes and likely avoidable
  call chains.
- Never print or persist prompts, tool argument values, tool result bodies,
  credentials, or raw session paths.
- Tolerate malformed lines and unknown client versions.

## CLI

From the repository root:

```bash
pnpm analyze:sessions
pnpm analyze:sessions -- --since 7d --clients claude --format json
pnpm analyze:sessions -- --since 24h --clients codex --latest-session
```

Defaults:

- clients: `claude,codex`
- lookback: `30d`
- output: human-readable text
- roots: `~/.claude/projects` and `~/.codex/sessions`

Optional `--claude-dir` and `--codex-dir` overrides support fixtures and custom
installations. `--latest-session` keeps only the most recent session containing
an AIPageGo call. `--format json` returns the same aggregated report as
structured JSON. The CLI exits successfully when a client directory is missing
and reports that client as unavailable.

## Privacy Model

Raw lines are processed as a stream. Tool inputs are reduced immediately to:

- sorted top-level field names;
- a SHA-256 fingerprint for equality checks;
- boolean semantic signals such as `fixedWait`, `viewportProbe`,
  `emptyDiscovery`, and `enablesDiscovery`.

Tool results are reduced to byte length and error status. No cache is written in
this version. Reports contain client, aggregate counts, rule IDs, occurrence
counts, affected session counts and estimated avoidable model rounds.

## Adapters

### Claude Code

- Calls: `assistant.message.content[*].type == "tool_use"`.
- Results: `user.message.content[*].type == "tool_result"`, joined by
  `tool_use_id`.
- A single assistant record containing one or more tool uses is one model tool
  round.

### Codex

- Direct calls: `response_item.payload.type == "function_call"` or
  `custom_tool_call`, joined to their corresponding output by `call_id`.
- Nested calls made through the Codex `exec` orchestrator are identified only
  when its source contains an actual `tools.mcp__aipagego__...(` invocation.
  They are marked `confidence: "derived"`; argument values remain unavailable.
- A yielded exec cell is joined to subsequent `wait` calls until terminal
  completion. Result bytes, boolean error/pairing signals and duration are
  retained; result content and cell id are not.
- Adjacent `token_count.last_token_usage` records are attributed to the active
  call chain, splitting total input into cached and uncached input.

Both adapters normalize `mcp__aipagego__browser_screenshot` to
`browser_screenshot`. Calls unrelated to AIPageGo are ignored.

## Rules

The first rule set detects:

- `viewport_recheck_after_resize`: resize followed shortly by viewport-only
  runJS;
- `viewport_recheck_after_screenshot`: screenshot followed shortly by the same;
- `fixed_wait`: `waitFor` with only `ms` rather than a state condition;
- `discovery_round_trip`: empty discovery followed by an enabling discovery;
- `duplicate_call`: the same tool and argument fingerprint repeated nearby;
- `repeated_screenshot`: screenshots repeated nearby;
- `serial_form_fill`: two or more consecutive `fillInput` calls that could use
  `fillForm`.
- `pairing_timeout`: a legacy blocking pairing call reached timeout.
- `pairing_retry_without_state_change`: `list_tabs` repeated while pairing was
  still required.

Sequence rules inspect only AIPageGo calls within the same local session and
a small call window. They are heuristics, so the report labels them as
opportunities rather than guaranteed waste.

## Verification

- Synthetic Claude and Codex JSONL fixtures cover extraction, result joining,
  nested-call confidence, malformed lines and privacy guarantees.
- Analyzer tests cover every rule and ensure reports contain no raw values.
- CLI tests cover argument parsing and text/JSON rendering.
- Full monorepo typecheck and test remain green; MCP build includes no new
  runtime dependency.
