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

## 首次上线（一次性 · 仓库 Owner 操作）

1. 打开 GitHub → 仓库 → Settings → Pages
2. Source 选择 **GitHub Actions**（不是 Deploy from a branch）
3. 保存
4. 触发 workflow：
   - 手动：Actions → Deploy Docs Site → Run workflow
   - 或推一个改动到 `docs-site/**` 的 commit 到 main
5. 部署完成后访问 `https://<owner>.github.io/<repo>/`

首次上线后，`.github/workflows/deploy-docs.yml` 会自动处理后续 push。
