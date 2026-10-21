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
