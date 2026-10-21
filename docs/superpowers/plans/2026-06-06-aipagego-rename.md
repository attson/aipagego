# aipagego Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全仓 `AIPageGo`/`aipagego` → `AIPageGo`/`aipagego` 改名。涉及包 scope、源码 import、品牌名、GitHub 仓库名、`DB_NAME`、所有文档（含历史 specs/plans）。Chrome 扩展 `"key"` 保留，不做老 IndexedDB 数据迁移。

**Architecture:** sed 三步严格顺序（`@aipagego/` → `AIPageGo` → `aipagego`）批量改源码与文档，然后手工收尾几个上下文敏感的点（`DB_NAME` 字符串值、`pnpm-lock.yaml` 重生），用 `pnpm -r typecheck/test`、`extension build` 和漏网扫描锚定无回归。一个 PR、squash-merge 进 main、合后再做 GitHub 仓库 rename + git remote 更新、bump v0.0.18 + tag + Release CI。

**Tech Stack:** sed (BSD/darwin variant `-i ''`), pnpm workspaces, vitest, vite, GitHub Actions, gh CLI。

**对应 spec:** `../specs/2026-06-06-aipagego-rename-design.md`

**关键既有事实（已核对）:**
- 当前主分支头 `52ca6c0 chore: release v0.0.17`，root `package.json` version `0.0.17`。
- 现有源码层 `@aipagego/` 出现 ~451 行（含 docs），`AIPageGo` ~74 行，`aipagego` ~145 文件。
- `packages/extension/src/background/storage/db.ts` 有 `const DB_NAME = "aipagego";`。**sed 不会改 `"aipagego"` 字面值**——需手工把它改为 `"aipagego"`（spec §1 决策）。
- `packages/extension/manifest.json` 顶层 `"key"` 是 base64，**不含 `aipagego` 子串**，sed 不应触及。Verify 时显式断言这一行 unchanged。
- macOS sed 必须 `-i ''`（darwin 24.6 环境）。

---

## File Structure

本 plan 不新建源代码文件。改动分布：

- **机械替换**：所有含 `@aipagego/` / `AIPageGo` / `aipagego` 的 `.ts/.tsx/.json/.md/.yml/.mjs` 文件（约 100+ 个）
- **手工编辑**：
  - `packages/extension/src/background/storage/db.ts` —— `DB_NAME` 字面值
  - `pnpm-lock.yaml` —— 删除重生（`pnpm install`）
- **plan 索引**：`docs/superpowers/plans/README.md` 加本 plan 的索引行
- **不创建/不改动**：
  - 任何源代码逻辑、测试断言（只跟字符串字面量绑定的测试如果挂，再单独修）
  - 历史 commit message（git rewrite 不做）
  - 扩展 `"key"` 字段、`chrome.storage` key

---

## Task 1: 切分支 + sed dry-run

**Files:** 无（只是 dry-run 量级评估）

- [ ] **Step 1: 切分支**

```bash
cd /Users/attson/code/aipagego2
git checkout main
git pull --ff-only
git checkout -b feat/aipagego-rename
git status   # 必须 clean
```

- [ ] **Step 2: Dry-run 三步看体量**

不真改文件，只统计每步会命中的文件数和行数。

```bash
echo "=== step 1: @aipagego/ ==="
grep -rIl '@aipagego/' --exclude-dir={node_modules,dist,.git} . | wc -l
grep -rIn '@aipagego/' --exclude-dir={node_modules,dist,.git} . | wc -l

echo "=== step 2: AIPageGo ==="
grep -rIl 'AIPageGo' --exclude-dir={node_modules,dist,.git} . | wc -l
grep -rIn 'AIPageGo' --exclude-dir={node_modules,dist,.git} . | wc -l

echo "=== step 3: aipagego (lowercase, will include leftover after step 1/2) ==="
grep -rIl 'aipagego' --exclude-dir={node_modules,dist,.git} . | wc -l
grep -rIn 'aipagego' --exclude-dir={node_modules,dist,.git} . | wc -l
```

Expected: 每行非零（基线：step1 ~451 行，step2 ~74 行，step3 ~145 文件），无报错。

- [ ] **Step 3: Manifest `"key"` 基线（断言用）**

记下 `"key"` 字段值，sed 之后要核对未变。

```bash
grep '"key"' packages/extension/manifest.json | head -1 | md5
```

Expected: 一行 md5 字符串。把这串 md5 记下，后续 verify 用。

- [ ] **Step 4: 不 commit**

dry-run 阶段无文件修改。直接进 Task 2。

---

## Task 2: 跑 sed 三步 + commit

**Files:**
- Modify: 所有命中 `@aipagego/` / `AIPageGo` / `aipagego` 的 `.ts/.tsx/.json/.md/.yml/.mjs` 文件

- [ ] **Step 1: Step 1 sed — `@aipagego/` → `@aipagego/`**

⚠️ 顺序非常重要。先做最具体的命名空间替换。

```bash
cd /Users/attson/code/aipagego2
grep -rIl '@aipagego/' --exclude-dir={node_modules,dist,.git} . \
  | xargs sed -i '' 's|@aipagego/|@aipagego/|g'
```

Expected: 无报错。

- [ ] **Step 2: Verify Step 1**

```bash
echo "remaining @aipagego/ (expect 0):"
grep -rIn '@aipagego/' --exclude-dir={node_modules,dist,.git} . | wc -l
```

Expected: 0

- [ ] **Step 3: Step 2 sed — `AIPageGo` → `AIPageGo`**

```bash
grep -rIl 'AIPageGo' --exclude-dir={node_modules,dist,.git} . \
  | xargs sed -i '' 's|AIPageGo|AIPageGo|g'
```

Expected: 无报错。

- [ ] **Step 4: Verify Step 2**

```bash
echo "remaining AIPageGo (expect 0):"
grep -rIn 'AIPageGo' --exclude-dir={node_modules,dist,.git} . | wc -l

echo "AtAIPageGo or similar double-prefix? (expect 0):"
grep -rIn 'AtAIPageGo\|AtAtaipagego' --exclude-dir={node_modules,dist,.git} . | wc -l
```

Expected: 第一条 0，第二条 0。

- [ ] **Step 5: Step 3 sed — 所有小写 `aipagego` → `aipagego`**

```bash
grep -rIl 'aipagego' --exclude-dir={node_modules,dist,.git} . \
  | xargs sed -i '' 's|aipagego|aipagego|g'
```

Expected: 无报错。

- [ ] **Step 6: Verify Step 3**

```bash
echo "remaining bare aipagego (expect 0):"
grep -rIn 'aipagego' --exclude-dir={node_modules,dist,.git} . | wc -l

echo "ataaipagego or ataipagego double-prefix? (expect 0):"
grep -rIn 'ataipagego' --exclude-dir={node_modules,dist,.git} . | wc -l
```

Expected: 两条都 0。如果出 `ataipagego`，**停下来**——意味着 sed 命中了 `aipagego` 子串（不应该），需要排查。

- [ ] **Step 7: Manifest `"key"` 基线核对**

```bash
echo "current manifest key md5:"
grep '"key"' packages/extension/manifest.json | head -1 | md5
echo "expected: (Task 1 Step 3 记下的 md5)"
```

Expected: 与 Task 1 Step 3 的 md5 完全一致。如不一致，**停下来排查**——意味着某条 sed 命中了 base64 key（极不应该）。

- [ ] **Step 8: Commit**

```bash
git add -A
git status --short | head -20    # 眼瞰一下大概文件分布
git commit -m "refactor: rename @aipagego/ → @aipagego/, AIPageGo → AIPageGo, aipagego → aipagego (sed pass)"
```

---

## Task 3: 手工收尾 1 — `DB_NAME`

**Files:**
- Modify: `packages/extension/src/background/storage/db.ts`

- [ ] **Step 1: 看现状**

```bash
grep -n 'DB_NAME' packages/extension/src/background/storage/db.ts
```

Expected: 类似 `const DB_NAME = "aipagego";`（sed 未碰，因 `"aipagego"` 不含 aipagego）。

- [ ] **Step 2: 改 DB_NAME**

把 `const DB_NAME = "aipagego";` 改为 `const DB_NAME = "aipagego";`。

注意：这是字符串值的改动，**不要**改类型名 `aipagegoDB` 之类（如果有的话——`aipagegoDB` 是历史类型名，不属于本 rename 范围；spec §1 只说 brand+package rename，不动数据库类型名以减小 diff 面积）。

```bash
# 验证只有 DB_NAME 这一行变了
git diff packages/extension/src/background/storage/db.ts
```

Expected: diff 只有 `const DB_NAME = "aipagego";` → `const DB_NAME = "aipagego";` 一行。

- [ ] **Step 3: 核对关键文件**（眼瞰）

```bash
echo "=== root package.json name ==="
grep '"name"' package.json | head -1
echo "=== extension manifest name ==="
grep '"name"' packages/extension/manifest.json | head -1
echo "=== mcp-server package.json name ==="
grep '"name"' packages/mcp-server/package.json | head -1
echo "=== README top ==="
head -1 README.md
```

Expected：
- root: `"name": "aipagego-monorepo"`
- manifest: `"name": "AIPageGo — AI 网页助手"`
- mcp-server: `"name": "@aipagego/mcp-server"`
- README: `# AIPageGo — AI 网页助手`

如有任何一条不符，回头查 sed 漏网（理论上不应该）。

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/background/storage/db.ts
git commit -m "refactor(extension): DB_NAME aipagego → aipagego (no migration)"
```

---

## Task 4: 重生 `pnpm-lock.yaml`

**Files:**
- Modify: `pnpm-lock.yaml`（删除后重生）

- [ ] **Step 1: 删除 lockfile**

```bash
rm pnpm-lock.yaml
```

- [ ] **Step 2: 重新 install**

```bash
pnpm install 2>&1 | tail -20
```

Expected: 无 unresolved error，正常完成。`Done in N` 类似的尾行。

- [ ] **Step 3: 核对 lockfile 不再含旧 scope**

```bash
grep -n '@aipagego/' pnpm-lock.yaml | head -3
```

Expected: 空输出。

- [ ] **Step 4: Commit**

```bash
git add pnpm-lock.yaml
git commit -m "chore: regenerate pnpm-lock.yaml after scope rename"
```

---

## Task 5: 全量验收（typecheck / test / build / 漏网扫描）

**Files:** 无新增；任何回归在此修复。

- [ ] **Step 1: typecheck**

```bash
pnpm -r typecheck 2>&1 | tail -20
```

Expected: 4 包（shared / coordinator / extension / mcp-server）全部通过，零错误。如有错误，绝大概率是 sed 没改全的 import，按错误信息定位 + 补改。

- [ ] **Step 2: test**

```bash
pnpm -r test 2>&1 | tail -10
```

Expected: 全绿（基线 519 测试：shared 103 / coordinator 45 / extension 346 / mcp-server 25）。如有 fail，可能是某条测试期望了 `"aipagego"` 字面量、被 sed 自动改成 `"aipagego"` 但又有别的地方期望了原值——排查并对齐。

- [ ] **Step 3: extension build**

```bash
pnpm -F @aipagego/extension build 2>&1 | tail -10
```

Expected: vite 正常产出 `packages/extension/dist/`，无错。

- [ ] **Step 4: 漏网扫描**

```bash
grep -rIn '@aipagego/\|AIPageGo\|aipagego' \
  --exclude-dir={node_modules,dist,.git} . \
  | grep -v 'aipagego\|AIPageGo'
```

Expected: 空输出。如有命中，停下来逐条修——可能是 sed 漏掉的扩展名（如 `.toml`）或 base64 类被 `-I` 跳过的纯二进制实际是被识别成文本的。

- [ ] **Step 5: 如有回归，修复 + 加 commit；否则跳过**

如果上面任何一步挂了，定向修复后再跑一遍直到全绿。每个 fix 一个 `fix: ...` 短 commit。

如果全过，无需 commit。

---

## Task 6: 加 plan 索引行

**Files:**
- Modify: `docs/superpowers/plans/README.md`

- [ ] **Step 1: 看现状**

```bash
sed -n '1,30p' docs/superpowers/plans/README.md
```

注意列结构（看现有最末行的格式）。

- [ ] **Step 2: 加本 plan 一行**

在表的末尾（紧跟最后一条 plan 后）加一行；列数与现有 row 一致。例（具体列对齐到现有表头）：

```markdown
| 14 | 项目改名 aipagego | [`2026-06-06-aipagego-rename.md`](./2026-06-06-aipagego-rename.md) | 7 tasks | 0 (rename only) | ~0 净 |
```

如果现有索引表列定义不同（比如「关键产出」一列），改用：

```markdown
| 14 | 项目改名 aipagego | [`2026-06-06-aipagego-rename.md`](./2026-06-06-aipagego-rename.md) | 全仓 sed 三步替换 aipagego→aipagego；DB_NAME 改名不迁移；GitHub 仓库 rename + bump v0.0.18 |
```

**Step 1 看现状时确定真实列结构再写。**

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/README.md
git commit -m "docs(plan): add Plan 14 — aipagego rename index row"
```

---

## Task 7: 手测扩展 + PR + 合 main + 仓库 rename + tag

**Files:** 无源码 / 文档新改动；这是上线流程。

- [ ] **Step 1: 手测扩展**

1. 打开 Chrome → `chrome://extensions`
2. 找到本地加载的 dev 扩展（指向 `packages/extension/dist/`），点 reload
3. **核对显示名**：扩展卡片标题应显示 **AIPageGo — AI 网页助手**
4. 点扩展图标 → 打开 sidepanel
5. DevTools → Application → IndexedDB：看到新建的 `aipagego` 库；旧 `aipagego` 库仍存在但不被读
6. 在任意网页输入「总结此页」→ 应该照常工作

Expected: 全部 ok。

任何一项 fail，记为 BLOCKED 并报告。

- [ ] **Step 2: Push 分支**

```bash
git push -u origin feat/aipagego-rename
```

- [ ] **Step 3: 开 PR**

```bash
gh pr create --base main --head feat/aipagego-rename \
  --title "refactor: rename project to aipagego (Plan 14)" \
  --body "$(cat <<'EOF'
## Summary

全仓品牌改名 AIPageGo → AIPageGo / aipagego → aipagego，对应 spec [`2026-06-06-aipagego-rename-design.md`](docs/superpowers/specs/2026-06-06-aipagego-rename-design.md)。

- 包 scope `@aipagego/*` → `@aipagego/*`、4 个 package.json name 同步
- 扩展显示名 `AIPageGo — AI 网页助手` → `AIPageGo — AI 网页助手`
- README/AGENTS/历史 specs/plans 全部 sed 替换
- `DB_NAME aipagego → aipagego`，不迁移老 IndexedDB 数据
- Chrome 扩展 `"key"` 保留（扩展 ID 不变）

## Test Plan

- [x] `pnpm -r typecheck` 全绿
- [x] `pnpm -r test` 519 测试全绿（零回归）
- [x] `pnpm -F @aipagego/extension build` 正常出 dist
- [x] 漏网扫描 `grep -rIn '@aipagego/\\|AIPageGo\\|aipagego'` 空输出
- [x] 手测：Chrome 扩展显示「AIPageGo — AI 网页助手」、sidepanel 正常工作、IndexedDB 新建 `aipagego` 库

合入后：
- [ ] GitHub 仓库 rename `attson/aipagego` → `attson/aipagego`（Web Settings）
- [ ] 本地 `git remote set-url origin git@github.com:attson/aipagego.git`
- [ ] Bump root package.json 到 0.0.18 + `chore: release v0.0.18` commit
- [ ] Tag `v0.0.18` 触发 Release workflow，产物应为 `aipagego-0.0.18.zip`
EOF
)"
```

记下 PR URL。

- [ ] **Step 4: 等 CI 通过 + squash-merge**

等 PR 上的「Typecheck, Test, Build, and Package」workflow 跑完且全绿。

```bash
gh pr checks <PR_NUM>
# 全 pass 后：
gh pr merge <PR_NUM> --squash --delete-branch
git checkout main
git pull --ff-only
git log --oneline -3
```

- [ ] **Step 5: GitHub 仓库 rename**

打开浏览器 → https://github.com/attson/aipagego/settings → 在 Repository name 处把 `aipagego` 改为 `aipagego` → 点 "Rename"。

GitHub 立刻将旧名永久 redirect 到新名。

- [ ] **Step 6: 本地 git remote**

```bash
git remote set-url origin git@github.com:attson/aipagego.git
git remote -v   # 验证显示新地址
git pull --ff-only   # 测试连通
```

Expected: pull 走新 URL 成功。

- [ ] **Step 7: Bump version + commit + push**

```bash
# 把 root package.json 的 "version": "0.0.17" 改为 "0.0.18"
sed -i '' 's|"version": "0.0.17"|"version": "0.0.18"|' package.json
git add package.json
git commit -m "chore: release v0.0.18"
git push origin main
```

- [ ] **Step 8: Tag + push tag**

```bash
git tag v0.0.18
git push origin v0.0.18
```

- [ ] **Step 9: 监控 Release workflow**

```bash
sleep 5
gh run list --limit 3 --json status,conclusion,name,headBranch,headSha,event,createdAt,url \
  --jq '.[] | "\(.status) \(.conclusion // "-") \(.name) [\(.event)] \(.headBranch) \(.headSha[0:7]) \(.url)"'
```

找到 `[push] v0.0.18` 那条 run，等到 `completed success`。

- [ ] **Step 10: 验证 Release 资产文件名**

```bash
gh release view v0.0.18 --json url,tagName,assets --jq '.url, .assets[].name'
```

Expected: URL 类似 https://github.com/attson/aipagego/releases/tag/v0.0.18；asset 名应为 `aipagego-0.0.18.zip`（非 `aipagego-`，因 sed 已改了 CI 里 build 命令引用的文件名）。

如果 asset 名仍为 `aipagego-0.0.18.zip`，说明 CI 里有未被 sed 命中的拼接（比如 `WEBPILOT-${{ version }}.zip` 大小写另类）。**记下来下一份 distribution plan 一并清掉**——不阻塞本次 release。

---

## Self-Review（已对照 spec 检查）

- **Spec §1 范围决策**：每条对应 Task — package/import (T2)、品牌驼峰 (T2)、npm 包名（下一份 plan，不在本期）、GitHub 仓库 (T7)、扩展 key 保留（T2/T7 verify 不变）、DB_NAME (T3)、历史 docs 替换 (T2)、不迁移数据（已知接受）、commit history 不动（默认）、版本 v0.0.18 (T7)。✓
- **Spec §2.1 sed 三步顺序**：T2 严格按 `@aipagego/` → `AIPageGo` → `aipagego`。✓
- **Spec §2.2 手工收尾**：DB_NAME (T3)、pnpm-lock 重生 (T4)、root/manifest/README 核对 (T3 Step 3)。✓
- **Spec §2.3 验收**：T5 全列。✓
- **Spec §2.4 手测**：T7 Step 1。✓
- **Spec §3 仓库 rename**：T7 Step 5–6，合 main 之后。✓
- **Spec §4 发版**：T7 Step 7–10。✓
- **Spec §5 风险**：sed 误改用 manifest key md5 (T1 Step 3 + T2 Step 7) + 漏网扫描 (T5) + ataipagego 双前缀检测 (T2 Step 6) 三层防护。pnpm-lock unresolved 在 T4 Step 2 暴露。回滚是 git revert merge commit，T7 不阻塞。

**类型一致性**：本 plan 不引入新类型/函数。所有引用名（DB_NAME / `@aipagego/extension` / `AIPageGo — AI 网页助手` / `v0.0.18`）在多 Task 中一致。

**占位扫描**：无 TBD/TODO/"similar to"。每 sed 命令完整、每 git commit message 写定。

**已知接受的灰区**：
- T6 Step 2 让实现者根据真实 README 列结构二选一格式——这是真实模糊（plan README 当前格式我没在最近 message 里 capture），由实现者 Step 1 查后定。
- T7 Step 10 如果 release asset 名仍为 `aipagego-` 不阻塞本期 release——延入下一份 plan。
