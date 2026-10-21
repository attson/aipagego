# GitHub Pages Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 VitePress 在 `docs-site/` 建一个 GitHub Pages 展示站（首页 + 快速上手 + 工具参考 + 高阶主题），中文为主 + 英文 MVP 5 页；工具参考页从 `TOOL_DEFS` 自动生成；GitHub Actions 部署到 `https://attson.github.io/aipagego/`。

**Architecture:** 独立目录 `docs-site/`（不进 pnpm workspace），VitePress 默认主题；工具参考页由 `scripts/gen-tools.mjs` 每次 build 前从 `packages/shared/src/llm/builtin-tool-defs.ts` 生成；SVG mockup 手写 4 张；部署 workflow 单独一份，触发范围仅 `docs-site/**` + `builtin-tool-defs.ts`。

**Tech Stack:** VitePress 1.x + Vue 3 + Vite；Node 20；pnpm；`tsx` 加载 TS 生成脚本；GitHub Actions `actions/deploy-pages@v4`。

## Global Constraints

- **VitePress base URL**：`base: '/aipagego/'`（GH Pages 部署地址 `https://attson.github.io/aipagego/`）
- **Node 版本**：20（与仓库现有 CI 一致）
- **pnpm 版本**：8+（与仓库现有 CI 一致）
- **`docs-site/` 独立**：**不**修改仓库根 `pnpm-workspace.yaml`；`docs-site/` 有自己的 `package.json` + lock；`docs-site/node_modules`、`docs-site/.vitepress/dist`、`docs-site/.vitepress/cache` 加入 `.gitignore`
- **i18n**：中文是 root（`/`），英文是 `/en/`。**MVP 只翻译 5 页**：`index / guide/{install,config,first-task} / tools/overview`；其它 EN 页面写占位块（§Task 2 定义模板）
- **首次上线**：仓库 owner 需**手动**去 `Settings → Pages → Source` 切换为 `GitHub Actions`（Task 6 的 README note 里写清楚）
- **工具参考自动生成**：`docs-site/tools/*.md` 由 `scripts/gen-tools.mjs` 从 `packages/shared/src/llm/builtin-tool-defs.ts` 读取生成；文件顶部固定注释 `<!-- ⚠ 自动生成 —— 修改源在 packages/shared/src/llm/builtin-tool-defs.ts；跑 pnpm gen 重生 -->`；这些 md **加进 git** 便于本地 dev 立刻可用 + review diff；CI 每次 build 前重跑 gen 覆盖
- **Severity 分类**：gen 脚本内**硬编码**一份 SAFE / CAUTION / DANGEROUS_FIXED 集合，与 `packages/extension/src/sidepanel/chat/severity.ts` 保持同步（避免脚本依赖 extension 内部）；httpRequest / runJS / navigate 用注释说明"withCredentials / 静态扫描命中 / goto 时升级为 dangerous"
- **SVG mockup 尺寸**：380 × 640 px（模拟侧边面板真实比例）；配色 `#09090b`（zinc-950 bg）/ `#27272a`（zinc-800 border）/ `#e4e4e7`（zinc-200 text）/ `#059669`（emerald safe）/ `#d97706`（amber caution）/ `#dc2626`（red dangerous）
- **不引入单元测试**：站点是静态生成 + 手工内容；CI 层面靠 `pnpm build` 成功验证（VitePress build 会把断链变 warn）
- **README 保持极简**：不移，不改；站点是 README 的展开版

---

### Task 1: VitePress bootstrap + 中英文首页

**Files:**
- Create: `docs-site/package.json`
- Create: `docs-site/.gitignore`
- Create: `docs-site/tsconfig.json`
- Create: `docs-site/.vitepress/config.ts`
- Create: `docs-site/.vitepress/theme/index.ts`
- Create: `docs-site/.vitepress/theme/custom.css`
- Create: `docs-site/index.md`（中文首页）
- Create: `docs-site/en/index.md`（英文首页）
- Create: `docs-site/README.md`（本地开发说明）
- Modify: `.gitignore`（根仓库；加 `docs-site/node_modules/`、`docs-site/.vitepress/dist/`、`docs-site/.vitepress/cache/`）

**Interfaces:**
- Consumes: 无（第一步）
- Produces:
  - VitePress 项目起得来（`pnpm dev` 能开 `http://localhost:5173/aipagego/`）
  - `config.ts` 里 `themeConfig.locales` 声明中英两个 locale；nav 里只有 `首页` / `GitHub` 两项（后面 task 逐步添加）
  - 中英文首页 md 用 VitePress hero layout；hero image 引用 `/mockups/sidepanel-hero.svg`（Task 5 才生成，本 task 里链接先留着，dev 服会显示占位图 alt）

- [ ] **Step 1: 建目录 + package.json**

Create `docs-site/package.json`：

```json
{
  "name": "aipagego-docs",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vitepress dev",
    "build": "pnpm gen && vitepress build",
    "preview": "vitepress preview",
    "gen": "tsx scripts/gen-tools.mjs"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitepress": "^1.4.0",
    "vue": "^3.5.0"
  }
}
```

Create `docs-site/.gitignore`：

```
node_modules/
.vitepress/dist/
.vitepress/cache/
```

Create `docs-site/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": [".vitepress/**/*.ts", "scripts/**/*.mjs"]
}
```

Create `docs-site/README.md`：

```md
# aipagego-docs

VitePress 站点，部署到 GitHub Pages。**独立于仓库根 pnpm workspace**。

## 本地开发

    cd docs-site
    pnpm install
    pnpm dev          # → http://localhost:5173/aipagego/

## 工具参考自动生成

    pnpm gen          # 从 packages/shared/src/llm/builtin-tool-defs.ts 读，覆盖 tools/*.md

## 生产 build

    pnpm build        # 先 gen 再 build，产物在 .vitepress/dist/

## 首次上线（一次性）

仓库 Owner 需去 `Settings → Pages → Source` 选 `GitHub Actions`；之后
`.github/workflows/deploy-docs.yml` 触发就自动部署。
```

Modify `.gitignore`（仓库根；在文件末尾追加）：

```
# docs-site VitePress
docs-site/node_modules/
docs-site/.vitepress/dist/
docs-site/.vitepress/cache/
```

（先看下现有 `.gitignore` 内容：`cat .gitignore`。如果已经含类似 `node_modules/` 的全局规则，就只加 `docs-site/.vitepress/dist/` 与 `docs-site/.vitepress/cache/`。）

- [ ] **Step 2: 配置文件 config.ts + theme**

Create `docs-site/.vitepress/config.ts`：

```ts
import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/aipagego/',
  title: 'AIPageGo',
  description: 'AI 网页助手 · 在当前 tab 上读写采',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/aipagego/favicon.svg' }],
  ],
  cleanUrls: true,
  lastUpdated: false,
  ignoreDeadLinks: false,
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [{ icon: 'github', link: 'https://github.com/attson/aipagego' }],
  },
  locales: {
    root: {
      label: '中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '首页', link: '/' },
          { text: 'GitHub', link: 'https://github.com/attson/aipagego' },
        ],
        footer: {
          message: 'MIT License',
          copyright: 'Copyright © 2026 attson',
        },
        outline: { label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/en/' },
          { text: 'GitHub', link: 'https://github.com/attson/aipagego' },
        ],
        footer: {
          message: 'MIT License',
          copyright: 'Copyright © 2026 attson',
        },
      },
    },
  },
});
```

Create `docs-site/.vitepress/theme/index.ts`：

```ts
import DefaultTheme from 'vitepress/theme';
import './custom.css';

export default DefaultTheme;
```

Create `docs-site/.vitepress/theme/custom.css`：

```css
:root {
  --vp-c-brand-1: #059669;
  --vp-c-brand-2: #10b981;
  --vp-c-brand-3: #34d399;
  --vp-c-brand-soft: rgba(16, 185, 129, 0.14);
}

.dark {
  --vp-c-brand-1: #34d399;
  --vp-c-brand-2: #10b981;
  --vp-c-brand-3: #059669;
}
```

Create empty placeholder `docs-site/public/favicon.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#059669"/>
  <text x="16" y="22" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="bold" fill="white">A</text>
</svg>
```

Create `docs-site/public/logo.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <rect width="40" height="40" rx="8" fill="#059669"/>
  <text x="20" y="27" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="bold" fill="white">A</text>
</svg>
```

- [ ] **Step 3: 中文首页**

Create `docs-site/index.md`：

```md
---
layout: home
hero:
  name: AIPageGo
  text: AI 网页助手
  tagline: 在当前 tab 上读、写、采
  image:
    src: /mockups/sidepanel-hero.svg
    alt: AIPageGo 侧边面板
  actions:
    - theme: brand
      text: 下载最新版本
      link: https://github.com/attson/aipagego/releases/latest
    - theme: alt
      text: 在 GitHub 上查看
      link: https://github.com/attson/aipagego
features:
  - title: 读
    details: 总结、翻译、抽重点、回答本页问题
  - title: 写
    details: 填表、勾选、下拉、点击、提交、上传
  - title: 采
    details: 主图 / 详情图 / 评论列表 → 结构化数据
  - title: 固化
    details: 任意成功对话一键存成 URL 模式匹配的可重放工具
---

## 三条上手 prompt

```
总结此页
```

```
把 mushroom 和 cheese 勾上
```

```
采集前 50 条评论
```

## 也能被 Claude Code 通过 MCP 驱动

    claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp

配合浏览器扩展和本地 Coordinator，Claude Code 可以在真实网页上读写采。见 [MCP Bridge](/advanced/mcp-bridge)。
```

- [ ] **Step 4: 英文首页**

Create `docs-site/en/index.md`：

```md
---
layout: home
hero:
  name: AIPageGo
  text: AI Web Assistant
  tagline: Read, write, and scrape from the tab you're on
  image:
    src: /mockups/sidepanel-hero.svg
    alt: AIPageGo side panel
  actions:
    - theme: brand
      text: Download latest
      link: https://github.com/attson/aipagego/releases/latest
    - theme: alt
      text: View on GitHub
      link: https://github.com/attson/aipagego
features:
  - title: Read
    details: Summarize, translate, extract key points, answer questions about the page
  - title: Write
    details: Fill forms, check boxes, select dropdowns, click, submit, upload
  - title: Scrape
    details: Product images, detail images, comment lists → structured data
  - title: Save
    details: Freeze any successful conversation into a URL-pattern-matched replayable tool
---

## Three prompts to get started

```
Summarize this page
```

```
Check mushroom and cheese
```

```
Scrape the first 50 comments
```

## Drive it from Claude Code via MCP

    claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp

See [MCP Bridge](/en/advanced/mcp-bridge) for details.
```

- [ ] **Step 5: 本地 dev sanity check**

```bash
cd docs-site && pnpm install 2>&1 | tail -5
```

Expected: 无 error；`vitepress` / `vue` / `tsx` 全部装上；lockfile 生成。

```bash
cd docs-site && pnpm dev 2>&1 | head -10 &
sleep 3
curl -sSf http://localhost:5173/aipagego/ | head -5
curl -sSf http://localhost:5173/aipagego/en/ | head -5
pkill -f "vitepress dev" 2>/dev/null || true
```

Expected: 中文首页与英文首页都返回 HTML；stderr 无 error。

- [ ] **Step 6: 提交**

```bash
cd /Users/attson/code/aipagego2
git add docs-site/ .gitignore
git commit -m "$(cat <<'EOF'
docs(site): bootstrap VitePress + 中英文首页

独立 docs-site/ 目录（不进 pnpm workspace）；default theme + brand
color；中英 locale；base /aipagego/。首页 hero 引用 mockups
(Task 5 生成)；socialLinks 到 GitHub。
EOF
)"
```

（`pnpm-lock.yaml` 是 docs-site 独立的；`docs-site/pnpm-lock.yaml` 存下，`docs-site/node_modules` 已 ignored。）

---

### Task 2: Guide 页 × 3 + 中英 sidebar/nav

**Files:**
- Create: `docs-site/guide/install.md`
- Create: `docs-site/guide/config.md`
- Create: `docs-site/guide/first-task.md`
- Create: `docs-site/en/guide/install.md`
- Create: `docs-site/en/guide/config.md`
- Create: `docs-site/en/guide/first-task.md`
- Modify: `docs-site/.vitepress/config.ts`（加 nav "快速上手" dropdown + sidebar）

**Interfaces:**
- Consumes: Task 1 的 config.ts 结构
- Produces:
  - 6 页 markdown 内容
  - config.ts 里中英 locale 各自的 sidebar 里加 `/guide/` group、nav 加"快速上手"下拉

- [ ] **Step 1: 中文 install**

Create `docs-site/guide/install.md`：

```md
# 安装

有三种使用方式，按需选择。

## 方式 1：只用浏览器扩展（最简）

1. 前往 [Releases](https://github.com/attson/aipagego/releases/latest) 下载 `aipagego-<version>.zip` 并解压
2. 打开 `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」→ 选择解压出来的 `dist/` 目录
5. 任意页面右上角点扩展图标 → 侧边面板打开

## 方式 2：加 MCP 让 Claude Code 驱动浏览器

```bash
claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp
```

再照方式 1 装扩展。扩展设置里 Coordinator 页填 `ws://127.0.0.1:8787/worker` → 连接。

详见 [MCP Bridge](/advanced/mcp-bridge)。

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
```

- [ ] **Step 2: 中文 config**

Create `docs-site/guide/config.md`：

```md
# 配置

打开扩展设置页（Header 里齿轮图标）。

## LLM

| 字段 | 说明 |
|---|---|
| Provider | Anthropic / OpenAI（也支持 OpenAI 兼容协议接 LiteLLM / Azure / Ollama 等） |
| Endpoint | 留空 = 默认；也可填自定义 base URL（例如 `https://api.deepseek.com/v1`） |
| Model | 下拉建议或自由输入（如 `claude-sonnet-4-6`、`gpt-4o-mini`、`deepseek-chat`） |
| API Key | 「仅本次会话保存」勾选 = 关浏览器即清；否则存 `chrome.storage.local` |
| max_tokens | 单次 LLM 响应上限（默认 4096） |
| 最大轮数 | 一次会话最多 LLM round 数（默认 20） |
| 优化模型 | 「优化提示词」按钮用的模型；留空 = 用对话模型 |
| 续作 nudge 次数 | 模型说完没调工具时再问一遍是否真完成（默认 1） |

API Key **不**会进 IndexedDB，也**不**会被「导出工具库」带走。

## 外观

- **主题**：深色 / 浅色 / 跟随系统
- **默认视图**：
  - **简洁**（推荐）— 每个工具调用一行进展提示，点行展开看细节
  - **详细** — 每步显示完整参数 / 输出

Header 上一个眼睛图标可当次会话临时切换，不写回默认。

## 权限模式

顶部工具栏切换：

- **read** — 仅 safe 工具自动跑；其他都要审阅
- **default**（默认）— safe 与 caution 自动；dangerous 每次要审
- **trust** — safe、caution、白名单里的 dangerous 自动
- **yolo** — 全部自动（危险！）

## 危险工具白名单

`trust` 模式下可以逐个勾选允许的 dangerous 工具（如 `httpRequest(withCredentials)`）。

## Coordinator（可选）

远程 WS 服务器地址；填了后扩展可被远程派发工具步。见 [Coordinator](/advanced/coordinator)。

## 下一步

- [第一条任务](/guide/first-task)
```

- [ ] **Step 3: 中文 first-task**

Create `docs-site/guide/first-task.md`：

```md
# 走通第一条任务

## 打开维基百科

任意一条维基百科条目，比如 [Chrome extensions](https://en.wikipedia.org/wiki/Browser_extension)。

## 打开侧边面板

浏览器右上角扩展图标 → 侧边面板出现，Header 显示当前 tab URL。

## 输入指令

底部输入框：

```
用三个要点总结此页
```

按 Enter 发送。

## 观察 AI 做什么

简洁模式下你会看到工具进展一行行滚动（图为示意）：

![简洁模式下的工具进展](/mockups/compact-mode.svg)

- `✓ 抓 DOM 结构 · 2ms`
- `✓ 提取文本 · 3ms`
- 然后 AI 输出三个要点

如果切成详细模式（Header 眼睛图标），能看到每个工具的完整参数：

![详细模式下的完整卡片](/mockups/full-mode.svg)

## 危险工具会弹审批

试试：

```
在页面搜索框搜 "React"
```

AI 想 `fillInput` + `submitForm`。`submitForm` 是 dangerous，会自动弹完整卡片让你审：

![审批弹窗](/mockups/approval-flow.svg)

三选一：**通过 / 跳过 / 终止**。

## 下一步

- [工具参考](/tools/overview) — 41 个内置工具的完整参数
- [保存为工具](/advanced/save-as-tool) — 把这次会话固化，下次一键跑
```

- [ ] **Step 4: 英文 3 页**

Create `docs-site/en/guide/install.md`：

```md
# Installation

Three ways to use it.

## Option 1: Browser extension only

1. Grab `aipagego-<version>.zip` from [Releases](https://github.com/attson/aipagego/releases/latest) and unzip
2. Open `chrome://extensions`
3. Turn on "Developer mode" (top-right)
4. Click "Load unpacked" → select the unzipped `dist/` directory
5. Click the extension icon on any page → side panel opens

## Option 2: Add MCP so Claude Code can drive the browser

```bash
claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp
```

Then install the extension as in Option 1. In extension Settings → Coordinator, enter `ws://127.0.0.1:8787/worker` and connect.

See [MCP Bridge](/en/advanced/mcp-bridge).

## Option 3: Build from source

```bash
git clone https://github.com/attson/aipagego
cd aipagego
pnpm install
pnpm build       # → packages/extension/dist/
```

Then back to Option 1 steps 2–5.

## Next

- [Configuration](/en/guide/config)
- [First task](/en/guide/first-task)
```

Create `docs-site/en/guide/config.md`：

```md
# Configuration

Open extension Settings (gear icon in the header).

## LLM

| Field | Description |
|---|---|
| Provider | Anthropic / OpenAI (or OpenAI-compatible: LiteLLM / Azure / Ollama, etc.) |
| Endpoint | Leave empty for default, or set a custom base URL (e.g. `https://api.deepseek.com/v1`) |
| Model | Pick from suggestions or type your own (`claude-sonnet-4-6`, `gpt-4o-mini`, ...) |
| API Key | Check "session only" to clear on browser close; otherwise stored in `chrome.storage.local` |
| max_tokens | Per-response cap (default 4096) |
| Max rounds | Max LLM rounds per session (default 20) |
| Optimizer model | Model used by the "optimize prompt" button; empty = use chat model |
| Continuation nudges | If the model stops without calling a tool, ask once more if it's really done (default 1) |

The API Key does **not** enter IndexedDB and is **not** included in tool bundle exports.

## Appearance

- **Theme**: dark / light / follow system
- **Default view**:
  - **Compact** (recommended) — one-line progress per tool call; click a row to expand
  - **Full** — each step shows full args / output

An eye icon in the header toggles per-session without writing back to default.

## Permission mode

Toggle in the top toolbar:

- **read** — only safe tools auto-run
- **default** — safe + caution auto-run; dangerous requires approval
- **trust** — safe + caution + allowlisted dangerous auto-run
- **yolo** — everything auto-runs (careful)

## Dangerous tool allowlist

In `trust` mode you can pick which dangerous tools (like `httpRequest(withCredentials)`) skip approval.

## Coordinator (optional)

Remote WS server URL. When connected the extension accepts remote tool step dispatch. See [Coordinator](/en/advanced/coordinator).

## Next

- [First task](/en/guide/first-task)
```

Create `docs-site/en/guide/first-task.md`：

```md
# Your first task

## Open a Wikipedia page

Any article, e.g. [Browser extension](https://en.wikipedia.org/wiki/Browser_extension).

## Open the side panel

Extension icon → side panel opens; header shows the current tab URL.

## Prompt

Type in the input:

```
Summarize this page in three bullets
```

Hit Enter.

## Watch the tool calls scroll

In compact mode you'll see rows tick through:

![Compact-mode tool progress](/mockups/compact-mode.svg)

- `✓ snapshotDOM · 2ms`
- `✓ extractText · 3ms`
- Then the three-bullet answer.

Switch to full mode (eye icon in header) to see each tool's full args:

![Full-mode expanded card](/mockups/full-mode.svg)

## Dangerous tools require approval

Try:

```
Search "React" in the search box
```

The AI wants `fillInput` + `submitForm`. `submitForm` is dangerous → the full card auto-expands for review:

![Approval flow](/mockups/approval-flow.svg)

Three options: **Approve / Skip / Abort**.

## Next

- [Tool reference](/en/tools/overview)
- [Save as tool](/en/advanced/save-as-tool)
```

- [ ] **Step 5: config.ts 加 nav + sidebar**

Modify `docs-site/.vitepress/config.ts`。

**A. 中文 locale 的 `themeConfig` 里替换现有 nav**（加"快速上手"下拉）：

```ts
        nav: [
          { text: '首页', link: '/' },
          {
            text: '快速上手',
            items: [
              { text: '安装', link: '/guide/install' },
              { text: '配置', link: '/guide/config' },
              { text: '第一条任务', link: '/guide/first-task' },
            ],
          },
          { text: 'GitHub', link: 'https://github.com/attson/aipagego' },
        ],
```

**B. 中文 locale 追加 `sidebar`**（放在 `nav` 之后）：

```ts
        sidebar: {
          '/guide/': [
            {
              text: '快速上手',
              items: [
                { text: '安装', link: '/guide/install' },
                { text: '配置', link: '/guide/config' },
                { text: '第一条任务', link: '/guide/first-task' },
              ],
            },
          ],
        },
```

**C. 英文 locale 的 `themeConfig` 里替换 nav**：

```ts
        nav: [
          { text: 'Home', link: '/en/' },
          {
            text: 'Guide',
            items: [
              { text: 'Install', link: '/en/guide/install' },
              { text: 'Configuration', link: '/en/guide/config' },
              { text: 'First task', link: '/en/guide/first-task' },
            ],
          },
          { text: 'GitHub', link: 'https://github.com/attson/aipagego' },
        ],
```

**D. 英文 locale 追加 sidebar**：

```ts
        sidebar: {
          '/en/guide/': [
            {
              text: 'Guide',
              items: [
                { text: 'Install', link: '/en/guide/install' },
                { text: 'Configuration', link: '/en/guide/config' },
                { text: 'First task', link: '/en/guide/first-task' },
              ],
            },
          ],
        },
```

- [ ] **Step 6: dev sanity + build 尝试**

```bash
cd docs-site && pnpm dev 2>&1 | head -5 &
sleep 3
curl -sSf http://localhost:5173/aipagego/guide/install > /dev/null
curl -sSf http://localhost:5173/aipagego/guide/config > /dev/null
curl -sSf http://localhost:5173/aipagego/guide/first-task > /dev/null
curl -sSf http://localhost:5173/aipagego/en/guide/install > /dev/null
curl -sSf http://localhost:5173/aipagego/en/guide/config > /dev/null
curl -sSf http://localhost:5173/aipagego/en/guide/first-task > /dev/null
pkill -f "vitepress dev" 2>/dev/null || true
```

Expected: 6 个 URL 全 200；无 stderr error。

（不跑 `pnpm build` —— 因为 mockup SVG 还没生成，build 会 warn 断链；Task 5 完成后才 build。）

- [ ] **Step 7: 提交**

```bash
git add docs-site/guide docs-site/en/guide docs-site/.vitepress/config.ts
git commit -m "$(cat <<'EOF'
docs(site): guide 三页 中英文 + nav/sidebar

install / config / first-task 中英各一份；EN 是完整翻译，非占位。
config.ts 加中英 locale 的 nav dropdown + sidebar group。
EOF
)"
```

---

### Task 3: Advanced 页 × 4（中）+ EN 占位 + nav/sidebar

**Files:**
- Create: `docs-site/advanced/save-as-tool.md`
- Create: `docs-site/advanced/multi-tab.md`
- Create: `docs-site/advanced/coordinator.md`
- Create: `docs-site/advanced/mcp-bridge.md`
- Create: `docs-site/en/advanced/save-as-tool.md`（占位）
- Create: `docs-site/en/advanced/multi-tab.md`（占位）
- Create: `docs-site/en/advanced/coordinator.md`（占位）
- Create: `docs-site/en/advanced/mcp-bridge.md`（占位）
- Modify: `docs-site/.vitepress/config.ts`（加 nav "高阶" dropdown + sidebar）

**Interfaces:**
- Consumes: Task 2 的 config.ts 结构
- Produces:
  - 4 页中文完整内容
  - 4 页英文占位（约定模板：`> **English version coming soon.** [See the Chinese version →](/advanced/xxx)`）
  - config.ts 加高阶 nav + sidebar（中英）

- [ ] **Step 1: 中文 save-as-tool**

Create `docs-site/advanced/save-as-tool.md`：

```md
# 保存为工具

## 什么时候用

一次成功的会话（比如"采集商品页前 50 条评论"）由几个到几十个 step 组成。手工重复很烦；保存为工具后，下次访问同 URL 会自动推荐 + 一键重放。

## 保存流程

会话结束（`✓ N 步成功执行`）后，顶部小条出现 `[保存为工具]` 按钮，点击：

- **名称**：默认 `AIPageGo 任务 YYYY-MM-DD`；改成能描述这次动作的
- **URL 模式**：默认从当前 URL 推断（`https://shop.example.com/goods.html*` → `https://*.example.com/**`）；改成合适的匹配范围
- **描述**：默认用户初始 prompt；改成简介
- **保存的 step 数**：只保存"成功执行"的 step；跳过 / 失败 / 待审的不带
- **汇总 step**：详见下一节

## 汇总 step（重要）

会话中 AI 在文本里写的"总结报告"（比如"共采集到 47 条评论"）是给你看的 markdown，**重放时无法复现**。因为重放跑的是 step，不跑 LLM 文本。

解法：点 **[让 AI 生成汇总步骤]** 按钮。LLM 会基于当前 step 数组 + 对话历史，生成一段 `runJS` 代码追加为最后一步。重放时该 step 把前面 step 的产物整合成结构化 JSON。

举例：采评论任务的汇总 step 可能是：

```js
// 汇总 step 由 LLM 生成，重放时执行
const comments = ctx.step_outputs.filter(o => Array.isArray(o?.comments));
return { total: comments.reduce((n, s) => n + s.comments.length, 0), items: comments.flatMap(s => s.comments) };
```

## 重放

- 访问命中 URL 模式的页面 → 顶部推荐条 `▶ 此页面可用 N 个工具`
- 点 **[运行]** → 跳到工具详情页 + 自动开跑
- 结果显示在 `ResultView` 里（绿框，含结构化 JSON）

## 版本

工具每次改动都 `appendVersion`：

- 失败修复（[失败修复](/advanced/save-as-tool#失败修复)）会存新版本
- 详情页可选历史版本回滚

## 失败修复

工具运行失败时，工具详情页出现 `[让 AI 修复]`。点了：

1. 跳到对话页
2. 自动预填错误上下文 + 旧 step 数组
3. 你点 `[发送]`
4. AI 分析错误并改 step
5. 成功后保存为新版本

## 导入 / 导出

工具库顶部 `[导入 JSON]`：接受单条或多条 bundle（按 id 合并，冲突跳过）。
每行 `[导出]` 导出单条 JSON。API Key 不会被导出。
```

- [ ] **Step 2: 中文 multi-tab**

Create `docs-site/advanced/multi-tab.md`：

```md
# 多 tab 会话

## 概念

一个"会话"绑定一个主 tab（Header 里显示 `Tab #142`），但可以额外挂载多个 tab 作为工作区。所有内置工具都接受可选 `tabId` 参数，指向已挂载的某个 tab。

## 挂载方式

### 方式 1：`@` 提当前 tab 列表

输入框输入 `@` → 弹出当前浏览器所有 tab 的下拉 → 选一个 → 挂载。

### 方式 2：AI 主动 `openTab`

AI 想开新页面时会调 `openTab(url)`。成功后自动挂载（`source=ai-open`），不用你二次确认。

### 方式 3：AI 主动 `attachTab`

AI 想访问已开的 tab 时调 `attachTab(tabId, reason)`。需要你审批（弹审批卡）。审批通过后挂载。

## 每 tool 用 tabId

19 个内置工具都接受 `tabId`：

- **主 tab**：`tabId` 字段整个不填（不要 0，不要 null）
- **其它已挂 tab**：`tabId` 填对应数字

例：AI 在主 tab（商品页）想查同款其它平台价格：

```json
{ "tool": "openTab", "input": { "url": "https://www.jd.com/search?q=商品名" } }
```

→ 返回 `{ tabId: 143, ... }`；自动挂载。后续：

```json
{ "tool": "querySelectorAll", "input": { "selector": ".product-price", "tabId": 143 } }
```

## 关闭挂载

- `detachTab(tabId)` — 从会话移除，但不关闭该 tab
- `closeTab(tabId)` — **只能关**已挂载的 tab（防止误关别的窗口）；关了自动解除挂载
- `switchToTab(tabId)` — 把 Chrome 前台切到该 tab（已挂载或主 tab）

## 会话 vs Tab

- 切到另一个 tab → UI 看到该 tab 的独立会话（消息、待审 step、运行状态）
- 原 tab 的 LLM 调用在后台**继续**跑，UI 不可见
- 会话按 URL 持久化到 IndexedDB（每 URL ≤20 条）→ 关 tab 不丢
- 切回同 URL → 顶部历史 drawer 可一键恢复

## 同 tab 内 navigate

- 点超链接 / SPA 路由变更 → 会话保留 + 末尾追加一条 `[页面跳转] 新 URL: ...` 的 system note
- AI 后续 step 在新 URL 上执行
```

- [ ] **Step 3: 中文 coordinator**

Create `docs-site/advanced/coordinator.md`：

```md
# Coordinator 远程控制

## 概念

Coordinator 是一个 WebSocket 服务器，扩展作为 client 连它。连上后 Coordinator 可以远程派发工具步或者驱动整个 chat session。

**opt-in 场景**：
- 从服务器批量控制多台浏览器（跨机器采集）
- Claude Code 通过本地 MCP server → 本地 Coordinator → 浏览器扩展（见 [MCP Bridge](/advanced/mcp-bridge)）
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

启动一个本地 WS server（默认 `ws://127.0.0.1:8787/worker`）。

扩展设置里 Coordinator 页填该 URL + 任意 token → 连接。连接成功后 Coordinator 里可以 REPL 派发 EXEC 命令。

## 远程驱动 chat session

**默认关闭**。在扩展 Coordinator 设置里勾「允许 coordinator 远程驱动 chat session」后，server 端可发 `START_CHAT_SESSION`，扩展会跑一个跟本地对话完全一样的 `runChatSession`（走真实 LLM），并流式回传 `CHAT_EVENT`。

也可以在 `START_CHAT_SESSION` 里塞一段 `mock_llm: { rounds: LlmStreamEvent[][] }` —— 让 server 端喂固定的 LLM 响应，用于**确定性回归测试**。

## 生产部署

参考实现 `packages/coordinator/` 是 Node + `ws` 库；你可以：
- 直接跑，或者
- 抄协议在别的 stack 里实现

只要 WS 兼容 zod schema 即可。
```

- [ ] **Step 4: 中文 mcp-bridge**

Create `docs-site/advanced/mcp-bridge.md`：

```md
# MCP Bridge — Claude Code 驱动浏览器

## 概念

MCP Bridge = stdio MCP server + 本地 Coordinator，两者打包在 `@attson/aipagego-mcp`。装了之后：

```
Claude Code ─(MCP stdio)─→ aipagego-mcp ─(WS worker)─→ Chrome 扩展 ─→ 网页
```

Claude Code 里就能调 `browser_*` 系列工具在真实网页上读、写、采。

## 安装

```bash
claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp
```

然后照常装扩展。扩展 → 设置 → Coordinator 填 `ws://127.0.0.1:8787/worker` → 连接。

可选环境变量：
- `AIPAGEGO_WS_PORT`（默认 8787）
- `AIPAGEGO_WS_TOKEN`（可选；填了扩展 side 也要填同样 token）

## Claude Code 可用的 MCP tools

| 工具 | 用途 |
|---|---|
| `list_tabs` | 列出扩展当前挂载的所有 tab |
| `open_session` | 开启一个 chat session，绑定某 tab |
| `browser_snapshotDOM` / `browser_takeSnapshot` / ... × 19 | 内置工具的 MCP 包装 |
| `get_quota` | 查询当前 session 剩余次数 |
| `close_session` | 关闭 session |

19 个 `browser_*` 与扩展内置工具一一对应，参数一致。详见 [工具参考](/tools/overview)。

## 手起 mcp-server（开发用）

```bash
pnpm -F @aipagego/mcp-server start
```

监听 `ws://127.0.0.1:8787/worker`。用于本地调试 mcp-server 逻辑，不用装 npx 包。

详见 `packages/mcp-server/README.md`。
```

- [ ] **Step 5: 4 页英文占位**

Create `docs-site/en/advanced/save-as-tool.md`：

```md
# Save as tool

> **English version coming soon.** [See the Chinese version →](/advanced/save-as-tool)
```

Create `docs-site/en/advanced/multi-tab.md`：

```md
# Multi-tab sessions

> **English version coming soon.** [See the Chinese version →](/advanced/multi-tab)
```

Create `docs-site/en/advanced/coordinator.md`：

```md
# Coordinator

> **English version coming soon.** [See the Chinese version →](/advanced/coordinator)
```

Create `docs-site/en/advanced/mcp-bridge.md`：

```md
# MCP Bridge

> **English version coming soon.** [See the Chinese version →](/advanced/mcp-bridge)
```

- [ ] **Step 6: config.ts 加 nav + sidebar**

Modify `docs-site/.vitepress/config.ts`。

**A. 中文 locale 的 nav 数组里，在 "快速上手" 之后追加**：

```ts
          {
            text: '高阶',
            items: [
              { text: '保存为工具', link: '/advanced/save-as-tool' },
              { text: '多 tab 会话', link: '/advanced/multi-tab' },
              { text: 'Coordinator', link: '/advanced/coordinator' },
              { text: 'MCP Bridge', link: '/advanced/mcp-bridge' },
            ],
          },
```

**B. 中文 locale 的 sidebar 对象里，追加 `/advanced/` key**：

```ts
          '/advanced/': [
            {
              text: '高阶',
              items: [
                { text: '保存为工具', link: '/advanced/save-as-tool' },
                { text: '多 tab 会话', link: '/advanced/multi-tab' },
                { text: 'Coordinator', link: '/advanced/coordinator' },
                { text: 'MCP Bridge', link: '/advanced/mcp-bridge' },
              ],
            },
          ],
```

**C. 英文 locale 的 nav 追加**（放在 "Guide" 之后）：

```ts
          {
            text: 'Advanced',
            items: [
              { text: 'Save as tool', link: '/en/advanced/save-as-tool' },
              { text: 'Multi-tab', link: '/en/advanced/multi-tab' },
              { text: 'Coordinator', link: '/en/advanced/coordinator' },
              { text: 'MCP Bridge', link: '/en/advanced/mcp-bridge' },
            ],
          },
```

**D. 英文 locale 的 sidebar 追加**：

```ts
          '/en/advanced/': [
            {
              text: 'Advanced',
              items: [
                { text: 'Save as tool', link: '/en/advanced/save-as-tool' },
                { text: 'Multi-tab', link: '/en/advanced/multi-tab' },
                { text: 'Coordinator', link: '/en/advanced/coordinator' },
                { text: 'MCP Bridge', link: '/en/advanced/mcp-bridge' },
              ],
            },
          ],
```

- [ ] **Step 7: dev sanity**

```bash
cd docs-site && pnpm dev 2>&1 | head -5 &
sleep 3
for p in save-as-tool multi-tab coordinator mcp-bridge; do
  curl -sSf "http://localhost:5173/aipagego/advanced/$p" > /dev/null && echo "OK zh $p" || echo "FAIL zh $p"
  curl -sSf "http://localhost:5173/aipagego/en/advanced/$p" > /dev/null && echo "OK en $p" || echo "FAIL en $p"
done
pkill -f "vitepress dev" 2>/dev/null || true
```

Expected: 8 行 `OK ...`；无 `FAIL`。

- [ ] **Step 8: 提交**

```bash
git add docs-site/advanced docs-site/en/advanced docs-site/.vitepress/config.ts
git commit -m "$(cat <<'EOF'
docs(site): advanced 四页 中文完整 + EN 占位 + nav/sidebar

save-as-tool / multi-tab / coordinator / mcp-bridge。EN 用占位模板
（link 回中文版），后续再翻。config.ts 加"高阶"nav dropdown +
sidebar group。
EOF
)"
```

---

### Task 4: 工具参考 gen 脚本 + tools/*.md × 5 + EN overview + nav/sidebar

**Files:**
- Create: `docs-site/scripts/gen-tools.mjs`
- Create: `docs-site/tools/overview.md`（gen 产出）
- Create: `docs-site/tools/inspect.md`（gen 产出）
- Create: `docs-site/tools/action.md`（gen 产出）
- Create: `docs-site/tools/danger.md`（gen 产出）
- Create: `docs-site/tools/meta.md`（gen 产出）
- Create: `docs-site/en/tools/overview.md`（手写英文摘要 + link 到 gen 的 tools 页；简版即可）
- Modify: `docs-site/.vitepress/config.ts`（加 nav "工具" dropdown + sidebar）

**Interfaces:**
- Consumes:
  - Task 1 的 package.json script `gen`
  - `packages/shared/src/llm/builtin-tool-defs.ts` 里的 `TOOL_DEFS`
- Produces:
  - `gen-tools.mjs` 一个可重复执行的脚本；跑一次覆盖 `tools/*.md`
  - 5 个中文 tools md
  - 1 个英文 overview 简版
  - config.ts 加工具 nav + sidebar

- [ ] **Step 1: 写 gen-tools.mjs**

Create `docs-site/scripts/gen-tools.mjs`：

```js
/**
 * 从 packages/shared/src/llm/builtin-tool-defs.ts 读 TOOL_DEFS，
 * 按 severity 分组生成 docs-site/tools/*.md。
 *
 * severity 分类硬编码在本文件（与 packages/extension/src/sidepanel/chat/severity.ts
 * 保持同步），避免脚本依赖 extension 内部。
 *
 * 用法：node --loader tsx docs-site/scripts/gen-tools.mjs
 * 或者：pnpm gen（package.json 里已配）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(__dirname, '..');
const TOOL_DEFS_PATH = resolve(__dirname, '../../packages/shared/src/llm/builtin-tool-defs.ts');

const { TOOL_DEFS } = await import(TOOL_DEFS_PATH);

// —— severity 分类（与 packages/extension/src/sidepanel/chat/severity.ts 同步） ——
const SAFE = new Set([
  'snapshotDOM', 'querySelector', 'querySelectorAll', 'extractText',
  'extractImages', 'scroll', 'waitFor', 'hover', 'focus', 'getValue',
  'extractFormState', 'detachTab', 'askUser', 'screenshot',
  'searchBookmarks', 'searchHistory', 'switchToTab', 'closeTab',
  'takeSnapshot', 'highlightElement', 'highlightText', 'getPageInfo',
]);
const CAUTION = new Set([
  'click', 'fillInput', 'setCheckbox', 'selectOption', 'listTabs',
  'openTab', 'attachTab', 'clickByUid', 'fillByUid', 'fillForm',
  'downloadImage', 'pressKey',
]);
const DANGEROUS_FIXED = new Set([
  'readStorage', 'submitForm', 'uploadFile', 'writeStorage',
]);
// httpRequest: caution / dangerous (withCredentials)
// runJS: caution / dangerous (static-scan hit)
// navigate: safe / caution (goto)

// —— 分类到页面的映射 ——
const CATEGORY_OF = new Map();
for (const t of TOOL_DEFS) {
  const name = t.name;
  if (name === 'httpRequest' || name === 'runJS') {
    CATEGORY_OF.set(name, 'danger');   // 有 dangerous 变体的归 danger 页
    continue;
  }
  if (SAFE.has(name) || name === 'navigate') {
    // askUser / screenshot / bookmarks / history / tab-management 走 meta 页
    if (['askUser', 'screenshot', 'searchBookmarks', 'searchHistory',
         'switchToTab', 'closeTab', 'detachTab', 'highlightElement',
         'highlightText'].includes(name)) {
      CATEGORY_OF.set(name, 'meta');
    } else {
      CATEGORY_OF.set(name, 'inspect');
    }
    continue;
  }
  if (CAUTION.has(name)) {
    if (['listTabs', 'openTab', 'attachTab', 'downloadImage'].includes(name)) {
      CATEGORY_OF.set(name, 'meta');
    } else {
      CATEGORY_OF.set(name, 'action');
    }
    continue;
  }
  if (DANGEROUS_FIXED.has(name)) {
    CATEGORY_OF.set(name, 'danger');
    continue;
  }
  // Fallback
  CATEGORY_OF.set(name, 'meta');
}

function severityOf(name) {
  if (SAFE.has(name) || name === 'navigate') return 'safe';
  if (CAUTION.has(name)) return 'caution';
  if (DANGEROUS_FIXED.has(name)) return 'dangerous';
  if (name === 'httpRequest') return 'caution / dangerous (withCredentials)';
  if (name === 'runJS') return 'caution / dangerous (静态扫描命中)';
  return 'dangerous';
}

function badgeFor(name) {
  const s = severityOf(name);
  if (s.startsWith('safe')) return '🟢 safe';
  if (s.startsWith('caution')) return '🟡 caution';
  if (s.startsWith('dangerous')) return '🔴 dangerous';
  return '⚪ ' + s;
}

// —— 渲染 markdown ——
function renderTool(t) {
  const props = t.input_schema?.properties ?? {};
  const required = new Set(t.input_schema?.required ?? []);
  const rows = Object.entries(props).map(([k, v]) => {
    const type = v?.type ?? (v?.enum ? 'enum' : 'any');
    const desc = (v?.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const req = required.has(k) ? '是' : '否';
    return `| \`${k}\` | ${type} | ${desc} | ${req} |`;
  });
  const paramsTable = rows.length
    ? `\n**参数：**\n\n| 字段 | 类型 | 说明 | 必填 |\n|---|---|---|---|\n${rows.join('\n')}\n`
    : '\n（无参数）\n';

  return [
    `## \`${t.name}\`  ${badgeFor(t.name)}`,
    '',
    t.description.trim(),
    paramsTable,
    '---',
    '',
  ].join('\n');
}

const HEADER = `<!-- ⚠ 自动生成 —— 修改源在 packages/shared/src/llm/builtin-tool-defs.ts；跑 \`pnpm gen\` 重生 -->\n\n`;

// —— 分组产出 ——
const groups = { inspect: [], action: [], danger: [], meta: [] };
for (const t of TOOL_DEFS) {
  const cat = CATEGORY_OF.get(t.name) ?? 'meta';
  groups[cat].push(t);
}

const TITLES = {
  inspect: '# 探查工具',
  action:  '# 操作工具',
  danger:  '# 危险工具',
  meta:    '# 元 / 视觉工具',
};
const INTROS = {
  inspect: '页面读取类：不修改页面、不发请求（除非 `snapshotDOM` 抓大树时性能）。默认 safe，全自动执行。\n',
  action:  '页面写入类：会改 DOM 或点击。默认 caution，跟随权限模式；trust 白名单里的 tool 自动过。\n',
  danger:  '提交表单、发带 cookie 请求、写 storage、执行含敏感 API 的 JS。默认 dangerous，每次弹审。\n',
  meta:    '跨 tab、书签、历史、下载、截图、视觉高亮、征询用户。用于任务编排。\n',
};

mkdirSync(resolve(DOCS_ROOT, 'tools'), { recursive: true });

for (const [key, tools] of Object.entries(groups)) {
  const body = [
    HEADER,
    TITLES[key],
    '',
    INTROS[key],
    ...tools.map(renderTool),
  ].join('\n');
  writeFileSync(resolve(DOCS_ROOT, `tools/${key}.md`), body);
  console.log(`wrote tools/${key}.md (${tools.length} tools)`);
}

// —— overview 页 ——
const totalByCat = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
const total = TOOL_DEFS.length;

const overviewRows = TOOL_DEFS
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((t) => {
    const cat = CATEGORY_OF.get(t.name) ?? 'meta';
    const oneLine = (t.description.split('\n')[0] ?? '').slice(0, 60);
    return `| \`${t.name}\` | ${badgeFor(t.name)} | ${cat} | ${oneLine.replace(/\|/g, '\\|')} |`;
  })
  .join('\n');

const overview = [
  HEADER,
  '# 工具参考总览',
  '',
  `共 **${total}** 个内置工具，按类别与 severity 分组：`,
  '',
  '| 类别 | 说明 | 数量 |',
  '|---|---|---|',
  `| [探查](/tools/inspect) | 页面读取 · safe | ${totalByCat.inspect} |`,
  `| [操作](/tools/action) | 页面写入 · caution | ${totalByCat.action} |`,
  `| [危险](/tools/danger) | 提交 / 发 cookie 请求 / runJS · dangerous | ${totalByCat.danger} |`,
  `| [元 / 视觉](/tools/meta) | 跨 tab / bookmark / history / 视觉 | ${totalByCat.meta} |`,
  '',
  '## Severity 说明',
  '',
  '- 🟢 **safe**：自动执行，无需审批',
  '- 🟡 **caution**：默认自动（依权限模式）；`read` 模式下要审',
  '- 🔴 **dangerous**：默认每次要审；`trust` 模式下按白名单放行；`yolo` 模式全自动（危险）',
  '',
  '## 速查表',
  '',
  '| 工具 | Severity | 类别 | 摘要 |',
  '|---|---|---|---|',
  overviewRows,
  '',
].join('\n');

writeFileSync(resolve(DOCS_ROOT, 'tools/overview.md'), overview);
console.log(`wrote tools/overview.md (${total} tools total)`);
```

- [ ] **Step 2: 跑 gen**

```bash
cd docs-site && pnpm gen 2>&1 | tail -10
```

Expected: 5 行 `wrote tools/...md (N tools)`；`tools/` 目录下 5 个 md 生成；无 error。

**Sanity check**（跑 gen 前后 tools/*.md 对比）：`git status docs-site/tools` 应该看到 5 个新文件。

- [ ] **Step 3: 英文 overview（简版）**

Create `docs-site/en/tools/overview.md`：

```md
# Tool reference (overview)

<!-- English version is a short summary; auto-generated Chinese pages have full param tables. -->

AIPageGo ships **41 built-in tools** grouped by category:

| Category | Description | Chinese page |
|---|---|---|
| Inspect | Page reads · safe | [/tools/inspect](/tools/inspect) |
| Action | Page writes · caution | [/tools/action](/tools/action) |
| Danger | Submit / cookie'd requests / runJS · dangerous | [/tools/danger](/tools/danger) |
| Meta / visual | Cross-tab / bookmarks / history / visual | [/tools/meta](/tools/meta) |

## Severity legend

- 🟢 **safe**: runs automatically, no approval needed
- 🟡 **caution**: auto-runs by default (depends on permission mode); requires approval in `read` mode
- 🔴 **dangerous**: requires approval every time by default; allowlisted per-tool in `trust` mode; auto-runs in `yolo` mode (careful)

> **Full English tool docs are coming soon.** Meanwhile, category pages linked above have Chinese descriptions and param tables auto-generated from the source code.
```

- [ ] **Step 4: config.ts 加 nav + sidebar**

Modify `docs-site/.vitepress/config.ts`。

**A. 中文 locale 的 nav 数组里，在 "高阶" 之前追加**（放中间比较符合信息层级）：

```ts
          {
            text: '工具',
            items: [
              { text: '总览', link: '/tools/overview' },
              { text: '探查（safe）', link: '/tools/inspect' },
              { text: '操作（caution）', link: '/tools/action' },
              { text: '危险（dangerous）', link: '/tools/danger' },
              { text: '元 / 视觉', link: '/tools/meta' },
            ],
          },
```

**B. 中文 locale 的 sidebar 对象里追加 `/tools/` key**：

```ts
          '/tools/': [
            {
              text: '工具参考',
              items: [
                { text: '总览', link: '/tools/overview' },
                { text: '探查（safe）', link: '/tools/inspect' },
                { text: '操作（caution）', link: '/tools/action' },
                { text: '危险（dangerous）', link: '/tools/danger' },
                { text: '元 / 视觉', link: '/tools/meta' },
              ],
            },
          ],
```

**C. 英文 locale nav 追加**（放在 "Guide" 之后 "Advanced" 之前）：

```ts
          {
            text: 'Tools',
            items: [
              { text: 'Overview', link: '/en/tools/overview' },
            ],
          },
```

**D. 英文 locale sidebar 追加**：

```ts
          '/en/tools/': [
            {
              text: 'Tool reference',
              items: [
                { text: 'Overview', link: '/en/tools/overview' },
              ],
            },
          ],
```

- [ ] **Step 5: dev sanity**

```bash
cd docs-site && pnpm dev 2>&1 | head -5 &
sleep 3
for p in overview inspect action danger meta; do
  curl -sSf "http://localhost:5173/aipagego/tools/$p" > /dev/null && echo "OK $p" || echo "FAIL $p"
done
curl -sSf "http://localhost:5173/aipagego/en/tools/overview" > /dev/null && echo "OK en overview"
pkill -f "vitepress dev" 2>/dev/null || true
```

Expected: 5 个中文 + 1 个英文 = 6 行 `OK`。

- [ ] **Step 6: 提交**

```bash
git add docs-site/scripts docs-site/tools docs-site/en/tools docs-site/.vitepress/config.ts
git commit -m "$(cat <<'EOF'
docs(site): 工具参考自动生成 + 5 页 中文 + EN overview

scripts/gen-tools.mjs 从 packages/shared/src/llm/builtin-tool-defs.ts
读 TOOL_DEFS，按 severity 与类别产出 overview/inspect/action/danger/
meta 五页；tools/*.md 加进 git 便于本地 dev + review。
EN overview 是简版，链接到中文各类别页。
nav 加"工具"下拉，sidebar 加 /tools/ 与 /en/tools/ group。
EOF
)"
```

---

### Task 5: 4 张 SVG mockup + 首页 build 通过

**Files:**
- Create: `docs-site/public/mockups/sidepanel-hero.svg`
- Create: `docs-site/public/mockups/compact-mode.svg`
- Create: `docs-site/public/mockups/full-mode.svg`
- Create: `docs-site/public/mockups/approval-flow.svg`

**Interfaces:**
- Consumes: index.md / guide/first-task.md 里已有的引用路径
- Produces: 4 张手写 SVG；无 build 断链 warn

**Rationale:** 前 4 个 task 已经引用了这些 mockup 路径，本 task 把文件填上。VitePress build 才会不 warn。

- [ ] **Step 1: sidepanel-hero.svg（全景）**

Create `docs-site/public/mockups/sidepanel-hero.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 640" font-family="ui-sans-serif, system-ui, sans-serif">
  <!-- 面板背景 -->
  <rect width="380" height="640" rx="8" fill="#09090b"/>
  <rect x="0" y="0" width="380" height="640" rx="8" fill="none" stroke="#27272a" stroke-width="1"/>

  <!-- Header -->
  <rect x="0" y="0" width="380" height="44" fill="#18181b"/>
  <text x="12" y="27" fill="#e4e4e7" font-size="13" font-weight="700">AIPageGo</text>
  <text x="86" y="27" fill="#71717a" font-size="10" font-family="ui-monospace, monospace">v0.0.43</text>
  <!-- Header icons -->
  <g fill="#71717a" transform="translate(220, 15)">
    <rect width="16" height="16" rx="3" fill="#27272a"/>
    <rect x="20" width="16" height="16" rx="3" fill="#27272a"/>
    <rect x="40" width="16" height="16" rx="3" fill="#27272a"/>
    <rect x="60" width="16" height="16" rx="3" fill="#27272a"/>
    <rect x="80" width="16" height="16" rx="3" fill="#27272a"/>
    <rect x="100" width="16" height="16" rx="3" fill="#27272a"/>
  </g>

  <!-- Tab identity bar -->
  <rect x="0" y="44" width="380" height="28" fill="#0f0f11"/>
  <circle cx="14" cy="58" r="4" fill="#10b981"/>
  <text x="26" y="62" fill="#a1a1aa" font-size="10" font-family="ui-monospace, monospace">example.com/product · Tab #142</text>

  <!-- User bubble -->
  <rect x="12" y="88" width="356" height="36" rx="6" fill="#1e3a8a" opacity="0.4"/>
  <text x="24" y="110" fill="#dbeafe" font-size="12">总结此页并抽出前 3 个要点</text>

  <!-- Assistant bubble container -->
  <rect x="12" y="140" width="356" height="200" rx="6" fill="#18181b" opacity="0.7"/>

  <!-- Compact step rows -->
  <g transform="translate(24, 158)">
    <g>
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">获取页面信息</text>
      <text x="310" y="10" fill="#71717a" font-size="10" text-anchor="end">2ms</text>
    </g>
    <g transform="translate(0, 22)">
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">抓页面快照</text>
      <text x="310" y="10" fill="#71717a" font-size="10" text-anchor="end">3ms</text>
    </g>
    <g transform="translate(0, 44)">
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">提取文本</text>
      <text x="310" y="10" fill="#71717a" font-size="10" text-anchor="end">4ms</text>
    </g>
    <g transform="translate(0, 66)">
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">找匹配元素</text>
      <text x="310" y="10" fill="#71717a" font-size="10" text-anchor="end">3ms</text>
    </g>
  </g>

  <!-- Assistant response text -->
  <text x="24" y="260" fill="#e4e4e7" font-size="11">这是一个电商产品页面，主要包含：</text>
  <text x="24" y="278" fill="#a1a1aa" font-size="11">1. 商品标题「XX 系列 · 型号 A1」</text>
  <text x="24" y="294" fill="#a1a1aa" font-size="11">2. 价格 ¥299（原价 ¥399，打折 25%）</text>
  <text x="24" y="310" fill="#a1a1aa" font-size="11">3. 用户评论 1284 条，平均 4.6 星</text>

  <!-- Input area -->
  <rect x="12" y="510" width="356" height="72" rx="6" fill="#18181b" stroke="#27272a"/>
  <text x="24" y="536" fill="#52525b" font-size="11">告诉 AI 你要做什么…</text>
  <!-- Icons + Send -->
  <g transform="translate(24, 552)">
    <rect width="42" height="20" rx="4" fill="#065f46"/>
    <text x="21" y="14" fill="#a7f3d0" font-size="10" text-anchor="middle">默认</text>
    <rect x="52" width="20" height="20" rx="3" fill="#27272a"/>
    <rect x="76" width="20" height="20" rx="3" fill="#27272a"/>
    <rect x="100" width="20" height="20" rx="3" fill="#27272a"/>
  </g>
  <rect x="336" y="552" width="24" height="20" rx="4" fill="#1d4ed8"/>
  <text x="348" y="566" fill="#ffffff" font-size="12" text-anchor="middle">↑</text>

  <!-- Footer stats -->
  <text x="12" y="616" fill="#3f3f46" font-size="9" font-family="ui-monospace, monospace">round 4/20 · in 5.2k / out 1.8k</text>
</svg>
```

- [ ] **Step 2: compact-mode.svg（简洁模式一行进展）**

Create `docs-site/public/mockups/compact-mode.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 300" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="380" height="300" rx="8" fill="#09090b"/>
  <rect x="0" y="0" width="380" height="300" rx="8" fill="none" stroke="#27272a" stroke-width="1"/>

  <!-- Bubble -->
  <rect x="12" y="20" width="356" height="200" rx="6" fill="#18181b"/>

  <!-- Summary header -->
  <text x="24" y="42" fill="#a1a1aa" font-size="11">▾ 6 步</text>

  <!-- Step rows -->
  <g transform="translate(24, 58)">
    <g>
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">获取页面信息</text>
      <text x="330" y="10" fill="#71717a" font-size="10" text-anchor="end">2ms</text>
    </g>
    <g transform="translate(0, 22)">
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">抓页面快照</text>
      <text x="330" y="10" fill="#71717a" font-size="10" text-anchor="end">3ms</text>
    </g>
    <g transform="translate(0, 44)">
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">找匹配元素</text>
      <text x="330" y="10" fill="#71717a" font-size="10" text-anchor="end">3ms</text>
    </g>
    <g transform="translate(0, 66)">
      <circle cx="6" cy="6" r="5" fill="#059669"/>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">点击元素</text>
      <text x="330" y="10" fill="#71717a" font-size="10" text-anchor="end">8ms</text>
    </g>
    <g transform="translate(0, 88)">
      <text x="0" y="10" fill="#a1a1aa" font-size="11">⟳</text>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">发请求</text>
    </g>
    <g transform="translate(0, 110)">
      <text x="0" y="10" fill="#dc2626" font-size="11">✗</text>
      <text x="18" y="10" fill="#e4e4e7" font-size="11">点击元素</text>
      <text x="130" y="10" fill="#f87171" font-size="10">uid el_102 not found</text>
    </g>
  </g>

  <!-- Assistant text -->
  <text x="24" y="200" fill="#a1a1aa" font-size="11">我已经完成 5 步，最后一步失败。</text>
</svg>
```

- [ ] **Step 3: full-mode.svg（详细模式完整卡片）**

Create `docs-site/public/mockups/full-mode.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 340" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="380" height="340" rx="8" fill="#09090b"/>
  <rect x="0" y="0" width="380" height="340" rx="8" fill="none" stroke="#27272a" stroke-width="1"/>

  <!-- Card 1 -->
  <rect x="12" y="20" width="356" height="130" rx="6" fill="#18181b" stroke="#27272a"/>
  <text x="24" y="42" fill="#a1a1aa" font-size="10">tool:</text>
  <text x="52" y="42" fill="#e4e4e7" font-size="11" font-weight="600">takeSnapshot</text>
  <rect x="150" y="30" width="42" height="16" rx="3" fill="#065f46"/>
  <text x="171" y="42" fill="#a7f3d0" font-size="9" text-anchor="middle">safe</text>
  <text x="340" y="42" fill="#71717a" font-size="10" text-anchor="end">✓ 2ms</text>

  <!-- args JSON -->
  <rect x="24" y="52" width="332" height="52" rx="4" fill="#09090b"/>
  <text x="32" y="68" fill="#a1a1aa" font-size="10" font-family="ui-monospace, monospace">{</text>
  <text x="40" y="82" fill="#e4e4e7" font-size="10" font-family="ui-monospace, monospace">"includeAll": false,</text>
  <text x="40" y="96" fill="#e4e4e7" font-size="10" font-family="ui-monospace, monospace">"tabId": 0</text>
  <text x="32" y="110" fill="#a1a1aa" font-size="10" font-family="ui-monospace, monospace">}</text>
  <text x="32" y="132" fill="#71717a" font-size="10">▸ output</text>

  <!-- Card 2 -->
  <rect x="12" y="164" width="356" height="130" rx="6" fill="#18181b" stroke="#27272a"/>
  <text x="24" y="186" fill="#a1a1aa" font-size="10">tool:</text>
  <text x="52" y="186" fill="#e4e4e7" font-size="11" font-weight="600">clickByUid</text>
  <rect x="140" y="174" width="52" height="16" rx="3" fill="#78350f"/>
  <text x="166" y="186" fill="#fed7aa" font-size="9" text-anchor="middle">caution</text>
  <text x="340" y="186" fill="#71717a" font-size="10" text-anchor="end">✓ 8ms</text>

  <rect x="24" y="196" width="332" height="52" rx="4" fill="#09090b"/>
  <text x="32" y="212" fill="#a1a1aa" font-size="10" font-family="ui-monospace, monospace">{</text>
  <text x="40" y="226" fill="#e4e4e7" font-size="10" font-family="ui-monospace, monospace">"uid": "el_47",</text>
  <text x="40" y="240" fill="#e4e4e7" font-size="10" font-family="ui-monospace, monospace">"tabId": 0</text>
  <text x="32" y="254" fill="#a1a1aa" font-size="10" font-family="ui-monospace, monospace">}</text>
  <text x="32" y="276" fill="#71717a" font-size="10">▸ output</text>

  <!-- Assistant text -->
  <text x="24" y="322" fill="#a1a1aa" font-size="11">已点击"加入购物车"按钮。</text>
</svg>
```

- [ ] **Step 4: approval-flow.svg（审批弹窗）**

Create `docs-site/public/mockups/approval-flow.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 280" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="380" height="280" rx="8" fill="#09090b"/>
  <rect x="0" y="0" width="380" height="280" rx="8" fill="none" stroke="#27272a" stroke-width="1"/>

  <!-- Dangerous card -->
  <rect x="12" y="20" width="356" height="240" rx="6" fill="#18181b" stroke="#7f1d1d" stroke-width="2"/>

  <text x="24" y="42" fill="#a1a1aa" font-size="10">tool:</text>
  <text x="52" y="42" fill="#e4e4e7" font-size="11" font-weight="600">submitForm</text>
  <rect x="140" y="30" width="66" height="16" rx="3" fill="#7f1d1d"/>
  <text x="173" y="42" fill="#fecaca" font-size="9" text-anchor="middle">dangerous</text>
  <text x="340" y="42" fill="#fde047" font-size="10" text-anchor="end">awaiting</text>

  <!-- args -->
  <rect x="24" y="52" width="332" height="72" rx="4" fill="#09090b"/>
  <text x="32" y="68" fill="#a1a1aa" font-size="10" font-family="ui-monospace, monospace">{</text>
  <text x="40" y="82" fill="#e4e4e7" font-size="10" font-family="ui-monospace, monospace">"selector": "form#register",</text>
  <text x="40" y="96" fill="#e4e4e7" font-size="10" font-family="ui-monospace, monospace">"tabId": 0</text>
  <text x="32" y="110" fill="#a1a1aa" font-size="10" font-family="ui-monospace, monospace">}</text>

  <!-- warning banner -->
  <rect x="24" y="134" width="332" height="26" rx="4" fill="#7f1d1d" opacity="0.4"/>
  <text x="32" y="152" fill="#fecaca" font-size="10">⚠ 会触发服务端动作（下单、留言等）。请确认参数无误。</text>

  <!-- action buttons -->
  <g transform="translate(24, 176)">
    <rect width="60" height="26" rx="4" fill="#065f46"/>
    <text x="30" y="18" fill="#a7f3d0" font-size="11" text-anchor="middle">✓ 通过</text>

    <rect x="68" width="60" height="26" rx="4" fill="#27272a"/>
    <text x="98" y="18" fill="#a1a1aa" font-size="11" text-anchor="middle">⊘ 跳过</text>

    <rect x="136" width="60" height="26" rx="4" fill="#7f1d1d"/>
    <text x="166" y="18" fill="#fecaca" font-size="11" text-anchor="middle">✕ 终止</text>
  </g>

  <text x="24" y="240" fill="#71717a" font-size="10">危险工具必须每次人工审阅，或在 trust 模式下加入白名单</text>
</svg>
```

- [ ] **Step 5: build 全站，确认无断链**

```bash
cd docs-site && pnpm build 2>&1 | tail -25
```

Expected: `build complete` 之类；无 `dead link` warn；无 `Error`。

如果有 warn，读输出定位（通常是某 md 引用了不存在的 md 页），修 md 里的 link 后再 build。

- [ ] **Step 6: 本地 preview 抽查**

```bash
cd docs-site && pnpm preview 2>&1 | head -5 &
sleep 2
# 首页应能加载 sidepanel-hero.svg
curl -sSf http://localhost:4173/aipagego/mockups/sidepanel-hero.svg > /dev/null && echo "OK hero.svg"
curl -sSf http://localhost:4173/aipagego/mockups/compact-mode.svg > /dev/null && echo "OK compact.svg"
curl -sSf http://localhost:4173/aipagego/mockups/full-mode.svg > /dev/null && echo "OK full.svg"
curl -sSf http://localhost:4173/aipagego/mockups/approval-flow.svg > /dev/null && echo "OK approval.svg"
pkill -f "vitepress preview" 2>/dev/null || true
```

Expected: 4 行 `OK ...svg`。

- [ ] **Step 7: 提交**

```bash
git add docs-site/public/mockups
git commit -m "$(cat <<'EOF'
docs(site): 4 张 SVG mockup — sidepanel / compact / full / approval

手写 SVG（380×640 或对应比例），与扩展 UI 配色一致（zinc-950 bg /
zinc-800 border / emerald safe / amber caution / red dangerous）。
用于首页 hero 与 guide/first-task 页。build 全站通过、无断链。
EOF
)"
```

---

### Task 6: GitHub Actions 部署 workflow + 首次上线 note

**Files:**
- Create: `.github/workflows/deploy-docs.yml`
- Modify: `docs-site/README.md`（补一节"首次上线"细化步骤）

**Interfaces:**
- Consumes:
  - `docs-site/package.json` 里的 `build` script（含 `gen`）
  - Task 1-5 已备好的完整站点
- Produces:
  - workflow：push main 且改动命中触发范围 → build → deploy
  - README 里加维护者一次性操作说明

- [ ] **Step 1: 写 workflow**

Create `.github/workflows/deploy-docs.yml`：

```yaml
name: Deploy Docs Site

on:
  push:
    branches:
      - main
    paths:
      - "docs-site/**"
      - "packages/shared/src/llm/builtin-tool-defs.ts"
      - ".github/workflows/deploy-docs.yml"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    name: Build VitePress site
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Enable pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 8
          run_install: false

      - name: Install docs-site deps
        working-directory: docs-site
        run: pnpm install --frozen-lockfile

      - name: Generate tools reference
        working-directory: docs-site
        run: pnpm gen

      - name: Build site
        working-directory: docs-site
        run: pnpm exec vitepress build

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: docs-site/.vitepress/dist

  deploy:
    name: Deploy to GitHub Pages
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
```

（**注意**：build step 用 `pnpm exec vitepress build`（不 `pnpm build`）——因为 `pnpm build` 会先跑 `gen`，而我们上一步已经手动 gen 过一次；也可以让 CI 里就跑 `pnpm build`，重复 gen 无害，但显式更清楚。）

- [ ] **Step 2: 补 README 首次上线细节**

Modify `docs-site/README.md`。**替换** "## 首次上线" 那一节为：

```md
## 首次上线（一次性 · 仓库 Owner 操作）

1. 打开 GitHub → 仓库 → Settings → Pages
2. Source 选择 **GitHub Actions**（不是 Deploy from a branch）
3. 保存
4. 触发 workflow：
   - 手动：Actions → Deploy Docs Site → Run workflow
   - 或推一个改动到 `docs-site/**` 的 commit 到 main
5. 部署完成后访问 `https://<owner>.github.io/<repo>/`

首次上线后，`.github/workflows/deploy-docs.yml` 会自动处理后续 push。
```

- [ ] **Step 3: 本地跑一遍 build 确保 workflow 里的命令能过**

```bash
cd docs-site && rm -rf .vitepress/dist && pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm gen 2>&1 | tail -5
pnpm exec vitepress build 2>&1 | tail -10
```

Expected: 每一步都成功；`.vitepress/dist/` 生成；`dist/index.html` 存在。

- [ ] **Step 4: 检查 workflow yml 语法**

```bash
# GitHub 有 yaml schema，本地无法完整校验；用 yamllint 或 python 简单 parse 一下
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-docs.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/deploy-docs.yml docs-site/README.md
git commit -m "$(cat <<'EOF'
ci(docs): GitHub Actions workflow deploy-docs.yml

Push 到 main 且改动命中 docs-site/** 或 builtin-tool-defs.ts 时
触发；跑 pnpm install / gen / vitepress build，用 actions/deploy-pages
部署到 GitHub Pages。首次上线需要仓库 Owner 手动切 Settings → Pages
→ Source = GitHub Actions（README 里写清步骤）。
EOF
)"
```

- [ ] **Step 6: 把 plan 文档一起提交**

Plan 文件本身还没进 git；跟着最后一个 task 一起 commit：

```bash
git add docs/superpowers/plans/2026-07-06-github-pages-site.md
git commit -m "docs: github-pages-site plan — 6-task 实施计划"
```

---

## Self-Review

**Spec coverage:**

| Spec 节 | 覆盖 task |
|---|---|
| §3 站点结构（首页/guide/tools/advanced） | Task 1 (首页) + Task 2 (guide) + Task 3 (advanced) + Task 4 (tools) |
| §3.1 首页 hero + features + 三行 prompt | Task 1 Step 3 |
| §3.2 顶部 nav 结构 | Task 2 Step 5 + Task 3 Step 6 + Task 4 Step 4（逐步累加） |
| §4 目录结构 + package.json + tsconfig | Task 1 Step 1-2 |
| §5.1 base URL /aipagego/ | Task 1 Step 2（config.ts 里 `base`） |
| §5.2 i18n 策略（root + /en/ + 占位模板） | Task 1 Step 2（config.ts locales）+ Task 3 Step 5（占位 EN 页）+ Task 4 Step 3（EN overview 简版） |
| §6 gen 脚本 + severity 分类 + 输出格式 | Task 4 Step 1-2 |
| §7 部署 workflow | Task 6 Step 1 |
| §7.1 CI 里不跑 sanity（选简单） | Task 6 Step 1（workflow 里没 sanity check，直接 gen 后 build） |
| §8 SVG mockup 4 张 + 配色 | Task 5 全 |
| §9 各页内容清单 | Task 2 (guide) + Task 3 (advanced) + Task 4 (tools) |
| §11 手工 QA 清单 | Task 5 Step 5-6（build + preview） + Task 6 Step 3（workflow 命令本地过） |

**Placeholder scan:** 已通读；无 TBD / TODO / 「implement later」；所有代码块可复制运行。`Task 6 Step 4` 的 python yaml 检查是可选的（如果本地没 python3 可以 skip）——但要求本身是明确指令，不是 placeholder。

**Type consistency:**
- `config.ts` 结构在 Task 1 定义（基础 locales + 空 nav），Task 2/3/4 各自追加 nav dropdown + sidebar group；每次追加的内容独立、无 rename
- `gen-tools.mjs` 一次性写完（Task 4），下游无依赖它内部的 signature
- SVG 文件路径（`/mockups/*.svg`）在 Task 1 (index.md hero) + Task 2 (first-task.md) 中被引用；Task 5 创建对应文件，路径一致
- Workflow 里用的 `pnpm exec vitepress build` 对应 Task 1 里 devDep `vitepress`，一致
- 无跨 task 的类型 / 签名漂移

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-06-github-pages-site.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每 task 派 fresh subagent + 主会话 review。6 task 相对独立、TDD 不适用（无单测）、机械 transcription 类偏多。

**2. Inline Execution** — executing-plans；当前会话跑，checkpoint 停一下。

**Which approach?**
