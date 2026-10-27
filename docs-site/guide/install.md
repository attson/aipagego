# 安装

有三种使用方式，按需选择。

## 方式 1：只用浏览器扩展（最简）

1. 前往 [Releases](https://github.com/attson/aipagego/releases/latest) 下载 `aipagego-<version>.zip` 并解压
2. 打开 `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」→ 选择解压出来的 `dist/` 目录
5. 任意页面右上角点扩展图标 → 侧边面板打开

## 方式 2：加 MCP 让 Codex / Claude Code 驱动浏览器

Codex：

```bash
npx -y @attson/aipagego-mcp --install-codex-skill
codex mcp add aipagego -- npx -y @attson/aipagego-mcp
```

第一条命令安装用户级 Codex Skill，让真实网页任务更容易主动选择 AIPageGo；它不会修改项目的
`AGENTS.md`。安装后新开 Codex 会话。Skill 被手工修改时安装器默认拒绝覆盖，确认替换才加
`--force`。

Claude Code：

```bash
claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp
```

再照方式 1 装扩展。**不需要手填端口** —— AI 第一次要操作网页时会自动弹出配对页，
点「允许」即接入；之后本机的会话都免确认，多个 Codex / Claude Code 会话也可以同时接入同一个浏览器。

详见 [MCP Bridge](/advanced/mcp-bridge) 与 [多会话配对](/advanced/pairing)。

## 方式 3：自己 build

```bash
git clone https://github.com/attson/aipagego
cd aipagego
pnpm install
pnpm build       # 产出 packages/extension/dist/
```

然后回到方式 1 步骤 2-5。

## 下一步

- [配置](/guide/config) — 填 API Key、选模型、设权限模式
- [第一条任务](/guide/first-task) — 走通 "总结此页"
- [隐私政策](/privacy) — 了解本地存储、模型请求与数据边界
- [权限说明](/permissions) — 查看每项 Chrome 权限的用途与授权时机
- [获取支持](https://github.com/attson/aipagego/issues) — 报告问题或提出建议
