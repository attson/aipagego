# Plans Index

每份 plan 对应一份 [`../specs/`](../specs/README.md) 设计文档。Plan 是按 task 切分的实施清单（含完整代码和测试）；`superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 可以直接执行。

| # | 实施计划 | task 数 | 测试增量 | 总测试数 |
|---|---|---|---|---|
| 1 | [`2026-05-09-plan1-executable-skeleton.md`](./2026-05-09-plan1-executable-skeleton.md) | 30 | 51 | 51 |
| 2 | [`2026-05-10-plan2-ai-conversation.md`](./2026-05-10-plan2-ai-conversation.md) | 26 | +37 | 88 |
| 3 | [`2026-05-10-plan3-aipagego.md`](./2026-05-10-plan3-aipagego.md) | 29 | +46 | 134 |
| 4 | [`2026-05-10-plan4-per-tab-sessions.md`](./2026-05-10-plan4-per-tab-sessions.md) | 13 | +16 | 150 |
| 5 | [`2026-05-10-plan5-summary-step.md`](./2026-05-10-plan5-summary-step.md) | 6 | +18 | 168 |
| 6 | [`2026-05-14-multi-tab-context.md`](./2026-05-14-multi-tab-context.md) | 23 | +69 | 237 |
| 7 | [`2026-05-19-sidepanel-session-persistence.md`](./2026-05-19-sidepanel-session-persistence.md) | 12 | +43 / -5 | 288 |
| 8 | [`2026-05-11-github-actions-extension-package.md`](./2026-05-11-github-actions-extension-package.md) | 3 | 0 (CI workflow) | 288 |
| 9 | [`2026-05-12-ai-generated-tool-types.md`](./2026-05-12-ai-generated-tool-types.md) | 7 | +12 | 300 |
| 10 | [`2026-05-15-phase0-monorepo-restructure.md`](./2026-05-15-phase0-monorepo-restructure.md) | 8 | 0 (重组) | 300 |
| 11 | [`2026-05-15-phase1-protocol-coordinator-core.md`](./2026-05-15-phase1-protocol-coordinator-core.md) | 16 | +65 shared + 45 coord | 410 |
| 12 | [`2026-05-15-phase2-extension-coordinator-client.md`](./2026-05-15-phase2-extension-coordinator-client.md) | 14 | +30 | 440 |
| 13 | [`2026-05-23-raw-llm-exchange-log.md`](./2026-05-23-raw-llm-exchange-log.md) | 9 | +29 + continuation guard 3 | 472 |
| 14 | [`2026-06-04-remote-testable-chat.md`](./2026-06-04-remote-testable-chat.md) | 17 | +20 (shared) +27 (extension) | ~492 |
| 15 | [`2026-06-06-mcp-bridge.md`](./2026-06-06-mcp-bridge.md) | 7 | 0 (新包) | ~492 |
| 16 | [`2026-06-06-aipagego-rename.md`](./2026-06-06-aipagego-rename.md) | 7 | 0 (rename only) | ~492 |
| 17 | [`2026-06-07-mcp-publish.md`](./2026-06-07-mcp-publish.md) | 9 | 0 (publish only) | ~492 |
| 18 | [`2026-09-18-non-intrusive-screenshot.md`](./2026-09-18-non-intrusive-screenshot.md) | 4 | + focused MCP/CDP capture tests | current |
| 19 | [`2026-09-18-mcp-round-efficiency.md`](./2026-09-18-mcp-round-efficiency.md) | 6 | +7 focused MCP/extension tests | current |
| 20 | [`2026-09-19-local-ai-session-analyzer.md`](./2026-09-19-local-ai-session-analyzer.md) | 8 | synthetic adapter/analyzer/CLI tests | current |

各 plan 的 task 严格 TDD：写失败测试 → 实现 → 验证通过 → commit。每 task 一组 commit；plan 内的 commit 加起来构成一次完整 feature。

## 跑通某份 plan

```bash
# 阅读 plan
$EDITOR docs/superpowers/plans/2026-05-10-plan5-summary-step.md

# 选其一：
# 在当前 session 内逐 task 推进
superpowers:executing-plans

# 或派 subagent，主 context 不耗
superpowers:subagent-driven-development
```

## 不在 plan 里的修复

参见 [`../specs/README.md`](../specs/README.md) 末尾的 "不在 spec 里的细节修复" 列表，以及 `git log --oneline` 中以 `fix:` / `feat(...):` 开头的零散提交。
