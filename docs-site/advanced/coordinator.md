# Coordinator 远程控制

## 概念

Coordinator 是一个 WebSocket 服务器，扩展作为 client 连它。连上后 Coordinator 可以远程派发工具步或者驱动整个 chat session。

**opt-in 场景**：
- 从服务器批量控制多台浏览器（跨机器采集）
- Codex / Claude Code 通过本地 MCP server → 本地 Coordinator → 浏览器扩展（见 [MCP Bridge](/advanced/mcp-bridge)）
- 远程测试你的工具库

## 协议

Coordinator ↔ 扩展间是自定义 WS 消息，定义在 `packages/shared/src/protocol/messages.ts`（zod schemas）：

| 消息类型 | 方向 | 用途 |
|---|---|---|
| `HELLO` | client → server | 握手 + token 认证 |
| `EXEC` | server → client | 派发单个工具 step |
| `EXEC_RESULT` | client → server | 步执行结果 |
| `START_CHAT_SESSION` | server → client | 远程启动整个 chat session（需要用户在扩展里勾"允许"） |
| `CHAT_EVENT` | client → server | 流式回传会话事件 |

## 本地 smoke

仓库带一个参考实现 `packages/coordinator/`，也带一个 mini smoke 脚本：

```bash
node docs/superpowers/scripts/mini-coordinator.mjs
```

启动一个本地 WS server。注意 `@attson/aipagego-mcp` 走的是[配对流程](/advanced/pairing)，端口惰性分配、不再固定 8787；这里说的是自建 coordinator 的场景。

扩展设置里 Coordinator 页填该 URL + 任意 token → 连接。连接成功后 Coordinator 里可以 REPL 派发 EXEC 命令。

## 远程驱动 chat session

**默认关闭**。在扩展 Coordinator 设置里勾「允许 coordinator 远程驱动 chat session」后，server 端可发 `START_CHAT_SESSION`，扩展会跑一个跟本地对话完全一样的 `runChatSession`（走真实 LLM），并流式回传 `CHAT_EVENT`。

也可以在 `START_CHAT_SESSION` 里塞一段 `mock_llm: { rounds: LlmStreamEvent[][] }` —— 让 server 端喂固定的 LLM 响应，用于**确定性回归测试**。

## 生产部署

参考实现 `packages/coordinator/` 是 Node + `ws` 库；你可以：
- 直接跑，或者
- 抄协议在别的 stack 里实现

只要 WS 兼容 zod schema 即可。
