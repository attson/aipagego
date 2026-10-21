# GitHub Pages 展示站 — VitePress 中英双语站点

**状态**：草稿 · 2026-07-06 · 作者：assistant + attson

给 AIPageGo 项目做一个 GitHub Pages 展示站：既是给普通用户的产品落地页（是什么、能干啥、怎么装），也是给开发者的文档站（工具参考、Coordinator、MCP Bridge）。中英双语，中文为主。

## 1 · 背景

现状：项目介绍只有 `README.md`（12 KB 长中文），其他文档散落在 `docs/superpowers/{specs,plans}/`（30+ 份内部设计文档，非用户友好）。想装 / 用 / 集成的人只能读 README；国际访客只能读中文。

要做的：一个可以 `https://attson.github.io/aipagego/` 直达的**双入口**站点：
- 用户从首页 hero 进 → 3 分钟看懂"是什么、装到哪、发第一条 prompt"
- 开发者从顶部 nav 进 `/tools` → 20 个内置工具的 args schema + 例子；进 `/advanced` → Coordinator / MCP Bridge 集成细节

用 **VitePress** 建站，源码在 `docs-site/`，GitHub Actions 部署到 GitHub Pages。

## 2 · 非目标

- ❌ 在线 demo / playground（要真 API Key + 后端，成本 & 安全）
- ❌ Changelog 页面（GitHub releases 已经在）
- ❌ 全站搜索（VitePress 内置的 local search 可选，MVP 关掉降复杂度）
- ❌ 用户反馈 / 评论嵌入
- ❌ 完整英文翻译 —— MVP 只翻译首页 + 3 页 Guide + Tools overview 页；其它 EN 页面放"英文版即将上线"占位并 link 回中文
- ❌ 不做深度 SEO 优化（无 sitemap 手工加、无 og-image）—— VitePress 默认 meta 够用
- ❌ 站点部署不复用现有 `build-extension.yml`；单独一个 workflow
- ❌ 站点源码**不**放进 pnpm workspace（`pnpm-workspace.yaml` 不动）
- ❌ 站内不做产品截图 → 用 SVG 画产品 mockup 插图（矢量、暗色主题自适应、无需真截图）
- ❌ 不做暗色模式手动切换（VitePress 默认已 followSystem）

## 3 · 站点结构

```
/                              首页（Hero + 4 特性 + Mockup + CTA + 三行示例 prompt）
/guide/                        快速上手
  ├─ install                   chrome://extensions 加载 dist；MCP install
  ├─ config                    Provider / Endpoint / Model / API Key / 权限模式
  └─ first-task                走通"总结此页"；截图 + gif（或 SVG mockup）
/tools/                        内置工具参考（自动生成 §6）
  ├─ overview                  三 severity 分类 + 一句话表格
  ├─ inspect                   safe：snapshotDOM / querySelector* / extractText / …
  ├─ action                    caution：click / fillInput / clickByUid / …
  ├─ danger                    dangerous：submitForm / uploadFile / runJS / …
  └─ meta                      跨 tab / askUser / screenshot / bookmarks / history
/advanced/                     高阶主题（手写）
  ├─ save-as-tool              会话 → URL 模式匹配的可重放工具
  ├─ multi-tab                 一个会话多个 tab；attachTab / openTab
  ├─ coordinator               WS 协议 + 远程 EXEC + START_CHAT_SESSION
  └─ mcp-bridge                Claude Code 通过 stdio MCP 驱动浏览器
/en/{同结构}.md                英文版（MVP：首页 + install + config + first-task + tools/overview 共 5 页）
```

### 3.1 首页布局

```
┌────────────────────────────────────────────────────┐
│                                                    │
│                   AIPageGo                       │
│                                                    │
│           AI 网页助手 · 在当前 tab 上读写采          │
│                                                    │
│    一个浏览器侧边面板里的 AI 助手：能总结、翻译、    │
│    抽评论、填表、上传文件，也能被 Claude Code       │
│    通过 MCP 远程驱动。                              │
│                                                    │
│    [ 下载最新版本 ]   [ 在 GitHub 上查看 ]          │
│                                                    │
├────────────────────────────────────────────────────┤
│                                                    │
│  [ SVG mockup：sidepanel 全景 · Header + input     │
│    + 简洁模式的一行工具进展 ]                        │
│                                                    │
├────────────────────────────────────────────────────┤
│                                                    │
│  ▸ 读                    ▸ 写                      │
│  总结、翻译、抽重点、     填表、勾选、下拉、          │
│  回答本页问题             点击、提交、上传            │
│                                                    │
│  ▸ 采                    ▸ 固化                    │
│  主图/详情图/评论列表 →    任意成功对话一键存成      │
│  结构化数据               URL 模式匹配的可重放工具    │
│                                                    │
├────────────────────────────────────────────────────┤
│                                                    │
│  三行示例 prompt（代码块，无需真跑）：                │
│                                                    │
│  "总结此页"                                        │
│  "把 mushroom 和 cheese 勾上"                       │
│  "采集前 50 条评论"                                 │
│                                                    │
├────────────────────────────────────────────────────┤
│  Footer: MIT · GitHub · 版本 vX.Y.Z                │
└────────────────────────────────────────────────────┘
```

### 3.2 顶部 nav

```
[AIPageGo logo]  首页  快速上手 ▾  工具 ▾  高阶 ▾            [ 中/EN toggle ]  [ GitHub icon ]
```

## 4 · 技术栈与目录

- **VitePress** 1.x（当前稳定版）+ Vue 3 + Vite
- Node 20（与仓库现有 CI 一致）
- **不**用 pnpm workspace 收录 `docs-site/` —— 独立 `package.json`；避免 lock 污染主仓库
- 目录：

```
docs-site/
├─ .vitepress/
│  ├─ config.ts                    站点配置 + i18n locales + nav / sidebar
│  └─ theme/
│     ├─ index.ts                  extends default theme
│     └─ custom.css                brand color 覆盖
├─ index.md                        首页（用 default theme 的 hero + features frontmatter）
├─ guide/
│  ├─ install.md
│  ├─ config.md
│  └─ first-task.md
├─ tools/                          自动生成，git 追踪（方便 review diff）
│  ├─ overview.md                  gen 生成
│  ├─ inspect.md                   gen 生成
│  ├─ action.md                    gen 生成
│  ├─ danger.md                    gen 生成
│  └─ meta.md                      gen 生成
├─ advanced/
│  ├─ save-as-tool.md
│  ├─ multi-tab.md
│  ├─ coordinator.md
│  └─ mcp-bridge.md
├─ en/                             英文版（MVP 5 页；未翻译的写占位 md）
│  ├─ index.md
│  ├─ guide/{install,config,first-task}.md
│  └─ tools/overview.md
├─ public/
│  ├─ favicon.svg
│  ├─ logo.svg                     文字 wordmark
│  └─ mockups/
│     ├─ sidepanel-hero.svg        首页 hero mockup
│     ├─ compact-mode.svg          简洁模式插图（chat 视图一行进展）
│     ├─ full-mode.svg             详细模式插图（chat 视图完整 StepCard）
│     └─ approval-flow.svg         审批弹窗插图
├─ scripts/
│  ├─ gen-tools.mjs                自动生成 tools/*.md（§6）
│  └─ check-tools-gen.mjs          CI 里的 sanity：确保 gen 结果与提交一致
├─ package.json                    独立；devDep vitepress
├─ tsconfig.json                   独立（config.ts 用）
└─ README.md                       本地开发说明
```

## 5 · 关键设计决策

### 5.1 站点根路径

GitHub Pages 部署地址：`https://attson.github.io/aipagego/`

VitePress `config.ts` 里 `base: '/aipagego/'`，所有内链自动加前缀。

### 5.2 i18n 策略

VitePress 内置 `themeConfig.locales`：

- 默认 root（`/`）= 中文
- `/en/` = 英文
- 每 locale 有独立 nav + sidebar 定义

MVP 阶段 EN 只翻译 5 页；未翻译的 EN 页面显示一个约定占位块：

```md
# Config

> **English version coming soon.** [See the Chinese version →](/guide/config)
```

未翻译页仍在 EN sidebar 里，避免"路径存在但 404"。用户点了自然引导回中文。

### 5.3 Base URL / dev vs prod

- dev：`pnpm dev` 起本地 `http://localhost:5173/aipagego/`
- CI build：`pnpm build` 产出到 `docs-site/.vitepress/dist/`

## 6 · 工具参考自动生成

`scripts/gen-tools.mjs`：
- Node ESM 脚本，用 `import()` 直接 load `../packages/shared/src/llm/builtin-tool-defs.ts`（借助 `tsx` 或 `esbuild-register`；实测 VitePress 已带 tsx 依赖，可复用）
- 按 severity 分组：
  - `inspect.md` — safe 类：snapshotDOM / querySelector / querySelectorAll / extractText / extractImages / getPageInfo / getValue / extractFormState / scroll / waitFor / hover / focus / navigate / pressKey
  - `action.md` — caution 类：click / clickByUid / fillInput / fillByUid / fillForm / setCheckbox / selectOption / httpRequest（无 cookie）
  - `danger.md` — dangerous 类：submitForm / uploadFile / readStorage / writeStorage / runJS / httpRequest(withCredentials)
  - `meta.md` — 跨 tab / bookmark / history：listTabs / openTab / attachTab / detachTab / closeTab / switchToTab / searchBookmarks / searchHistory / downloadImage / askUser / screenshot / highlightElement / highlightText

- `overview.md` — 一张统计表：severity × count；一张分类速查表（每 tool 一行"工具名 · 用途摘要 · 类别"）

- 每个 `.md` 文件顶部加自动生成标记：

```md
<!-- ⚠ 自动生成 —— 修改源在 packages/shared/src/llm/builtin-tool-defs.ts；跑 `pnpm gen` 重生 -->
```

- 每个工具在页面内以固定块渲染：

```md
## takeSnapshot  🟢 safe

抓页面 accessibility snapshot：返回 [{uid, role, name, tag, text, bounds}]…

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| includeAll | boolean | ... | 否 |
| tabId | integer | ... | 否 |

**示例：**

    { "includeAll": false }

---
```

`classifyTool(name, {})` 逻辑复用（从 `packages/extension/src/sidepanel/chat/severity.ts` 里 import；用**静态默认 input**触发默认分类，与 UI 保持一致）。

### 6.1 CI 里的 gen sanity

`scripts/check-tools-gen.mjs`：跑 gen → diff 提交状态；如果生成结果与仓库里的不一致，CI 失败并提示"跑 pnpm --filter aipagego-docs gen 后再提交"。

## 7 · 部署 workflow

`.github/workflows/deploy-docs.yml`：

- 触发：
  - `push` 到 `main` 且 diff 命中 `docs-site/**` 或 `packages/shared/src/llm/builtin-tool-defs.ts`
  - `workflow_dispatch`（手动重发布）
- Permissions：`pages: write, id-token: write`
- Environment: `github-pages`
- Steps:
  1. checkout
  2. setup Node 20 + enable pnpm 8
  3. `cd docs-site && pnpm install --frozen-lockfile`
  4. `pnpm --filter aipagego-docs gen`（从 TOOL_DEFS 重生）
  5. `pnpm --filter aipagego-docs check-gen`（sanity；如果本地忘了跑 gen，CI 失败）—— 或者跳过 check 直接用刚生成的（简单）
  6. `pnpm --filter aipagego-docs build`
  7. `actions/upload-pages-artifact@v3`  path: `docs-site/.vitepress/dist`
  8. `actions/deploy-pages@v4`

**GitHub Pages 仓库设置**：Settings → Pages → Source = **GitHub Actions**（不用 gh-pages 分支）。首次上线由维护者手动去 GH 设置里切一次即可，之后 workflow 自动。

### 7.1 CI 里不跑 gen sanity 的替代方案

若认为 sanity 太严：`gen` 就是 CI 的一部分（每次 CI 都 gen），跳过 sanity；本地开发时提交的 tools/*.md 只是"离线预览"用的快照。选这个更简单，但仓库 tools/*.md 可能与源码短暂 drift。**MVP 选简单**：CI 每次 gen 前不 sanity；tools/*.md 仍加进 git 便于 review + 本地 pnpm dev 立刻可用。

## 8 · SVG Mockup 说明

首页 hero 和 guide 页里的插图用 SVG 画，风格：

- **配色**：与扩展 UI 一致 —— `#09090b`（bg zinc-950）、`#27272a`（zinc-800 border）、`#e4e4e7`（zinc-200 text）、`#059669`（emerald-600 = safe）、`#d97706`（amber-600 = caution）、`#dc2626`（red-600 = dangerous）
- **尺寸**：380 × 640 px（模拟侧边面板真实比例）
- **不画真实 tab URL / 头像**——避免误导

4 张 SVG：
- `sidepanel-hero.svg` — 全景：Header + Tab identity bar + 3 条工具进展行 + Assistant 回答 + Input 框
- `compact-mode.svg` — 简洁模式下的一行进展列表
- `full-mode.svg` — 详细模式下的完整 StepCard
- `approval-flow.svg` — 危险工具审批弹窗（args + 通过/跳过/终止按钮）

SVG 全部手写（不依赖 illustrator 之类），50-150 行/张，可 git diff。

## 9 · 内容清单（各页要点）

### 首页

frontmatter 用 VitePress `layout: home`：

```yaml
---
layout: home
hero:
  name: AIPageGo
  text: AI 网页助手
  tagline: 在当前 tab 上读、写、采
  image: /mockups/sidepanel-hero.svg
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
```

frontmatter 下方再补充 markdown：三行示例 prompt + Coordinator/MCP 一句话引流。

### /guide/install

- chrome://extensions 加载 dist 三步走
- npm 装 MCP：`claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp`
- Coordinator 可选：连 ws://127.0.0.1:8787/worker

### /guide/config

- Provider / Endpoint / Model / API Key 表格（照抄 README）
- 权限模式（safe 自动 / caution 跟随 / dangerous 白名单）说明
- 「优化模型」与「默认视图」两个新增 setting

### /guide/first-task

- 打开维基百科 → "用三个要点总结此页"
- 简洁模式下看到 `✓ 抓 DOM 结构 · 2ms` 一行进展
- 3 个要点回来 → 一步到位

### /tools/*

自动生成，见 §6。

### /advanced/save-as-tool

- 会话 → "保存为工具"→ 生成 URL 模式 `https://*.example.com/**`
- 汇总 step（让 AI 生成 runJS 汇总）—— 为什么必要
- 重放：banner 上「运行」

### /advanced/multi-tab

- @ mention 拉 tab
- `openTab` / `attachTab` / `closeTab`
- 每 tool 的 `tabId` 参数

### /advanced/coordinator

- WS 协议摘要
- EXEC 场景（远程派发工具）
- START_CHAT_SESSION 场景（远程驱动整个 chat）
- 本地 smoke: `node docs/superpowers/scripts/mini-coordinator.mjs`

### /advanced/mcp-bridge

- Claude Code 侧配置
- 可用 MCP tools 列表（`list_tabs`, `open_session`, `browser_*` × 19, `get_quota`, `close_session`）
- `pnpm -F @aipagego/mcp-server start`

## 10 · 数据流

```
维护者提交更改
    ↓
push main
    ↓ 命中 docs-site/** 或 builtin-tool-defs.ts
GitHub Actions workflow deploy-docs.yml
    ↓
checkout + install
    ↓
pnpm --filter aipagego-docs gen  ← 从 TOOL_DEFS 生成 tools/*.md
    ↓
pnpm --filter aipagego-docs build ← VitePress 打包
    ↓
upload-pages-artifact
    ↓
deploy-pages
    ↓
https://attson.github.io/aipagego/ 更新
```

## 11 · 测试

站点无单元测试（VitePress 是静态生成 + 手工内容）。CI 层面靠 build 成功验证：

- `pnpm --filter aipagego-docs gen` 不报错
- `pnpm --filter aipagego-docs build` 不报错（内链坏了 VitePress 会 warn / error）
- 本地手工 QA（`pnpm dev`）：
  - [ ] 首页三条 CTA 都能点
  - [ ] Nav 中/EN toggle 切换后 URL 前缀正确
  - [ ] 所有 sidebar 链接 200
  - [ ] tools 自动生成的 md 与 UI 里 severity 分类一致（safe/caution/dangerous 颜色）
  - [ ] SVG mockup 在浅色 / 深色模式下都能看清
  - [ ] Sitemap / robots：VitePress 默认无 sitemap，MVP 不做

## 12 · 风险

| 风险 | 缓解 |
|------|------|
| `docs-site` 独立 package.json 会有 node_modules 冗余 | 加进 `.gitignore`（`docs-site/node_modules`）；`docs-site/dist` 也 ignore |
| 从 TS 源码 import 到 gen 脚本失败（模块解析） | 用 tsx / esbuild 直接编译；package.json devDep 加 tsx；`node --loader tsx scripts/gen-tools.mjs` |
| 首次部署要在 GH 设置里手动切 Source | Spec 明写要一次性操作；README 里贴步骤 |
| GH Pages 缓存导致更新延迟 | 未知；GH 通常 <60s 生效 |
| classifyTool 依赖 severity.ts 里的运行时逻辑；gen 脚本 import extension 内部会拉一堆 chrome API 依赖 | severity.ts 本身是纯逻辑（`(name, input) => severity`）；如 import 时链上带 chrome 类型问题，gen 脚本里改为**照抄 severity 映射表**（用注释标记同步来源）；接受少量重复以换取 gen 脚本无副作用 |
| README 内容与站点 guide/config 页 drift | 站点是 README 的展开版；README 保留极简版（安装 + 一句话）+ link 到 guide；drift 靠 review 控制 |
| SVG mockup 难看 / 过时 | MVP 手工写；接受"能看"级别；后续可以换真截图 |
| tools/*.md 与源码 drift | CI 每次 gen；仓库里的 tools/*.md 只是"离线预览版"—— 也可以在 gen 脚本里加 stale check |
| workflow 触发范围过窄导致漏部署 | 除 `docs-site/**` 与 `builtin-tool-defs.ts` 之外，也允许 `workflow_dispatch` 手动触发 |

## 13 · Out of scope

- 在线 playground / 真跑 LLM
- 站点搜索
- Analytics（GA / Plausible / etc.）
- OG image / Twitter card 自定义
- 自定义域名（.com）
- Sitemap XML
- 内嵌 video demo
- 全站英文翻译（超出 5 页 MVP）
- Changelog 页面
- 版本切换器（v0.0.X 分支切换）
- 全站深色 / 浅色手动 toggle（默认跟随系统）
- 移动端优化（VitePress default 已够 mobile）
