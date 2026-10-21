# Local AI Session Analyzer Implementation Plan

**Goal:** Analyze local Claude Code and Codex histories for avoidable
AIPageGo tool rounds without collecting or exposing conversation content.

**Spec:** `docs/superpowers/specs/2026-09-19-local-ai-session-analyzer-design.md`

## Tasks

- [x] Define normalized privacy-preserving event/report types.
- [x] Add failing Claude/Codex adapter tests with synthetic JSONL fixtures.
- [x] Implement streaming adapters and result joining.
- [x] Add failing analyzer rule tests.
- [x] Implement aggregation, sequence rules and report rendering.
- [x] Add CLI argument tests and repository/package scripts.
- [x] Run the analyzer against local histories and inspect only aggregates.
- [x] Run package/full typecheck, tests and builds.

## Constraints

- No dependencies.
- No raw prompt, argument, result, credential or absolute session path in output.
- Read-only access to client history directories.
- Unknown and malformed records are skipped and counted, never fatal.
- Client file layouts are treated as versioned adapters, not stable public APIs.
