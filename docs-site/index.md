---
layout: home
hero:
  name: AIPageGo
  text: AI 网页助手
  tagline: 在当前 tab 上读、写、采 —— 像常规 chatbot 一样对话，AI 自动调工具
  actions:
    - theme: brand
      text: 下载最新版本
      link: https://github.com/attson/aipagego/releases/latest
    - theme: alt
      text: 快速上手 →
      link: /guide/install
    - theme: alt
      text: 在 GitHub 上查看
      link: https://github.com/attson/aipagego
features:
  - icon: 📖
    title: 读
    details: 总结、翻译、抽重点、回答本页问题；不看你也不知道，问一下就知道了
  - icon: ✍️
    title: 写
    details: 填表、勾选、下拉、点击、提交、上传；把重复劳动交给 AI
  - icon: 🎯
    title: 采
    details: 主图 / 详情图 / 评论列表 → 结构化 JSON；翻页与懒加载自动跟上
  - icon: 🧊
    title: 固化
    details: 任意成功对话一键存成 URL 模式匹配的可重放工具；下次访问一键跑
---

<script setup>
import { withBase } from 'vitepress';
</script>

<div class="showcase">

## 看它跑起来

<div class="showcase-grid">
  <div class="showcase-card">
    <img src="/mockups/compact-mode.svg" alt="简洁模式" />
    <h3>简洁模式</h3>
    <p>每个工具调用一行进展；点开看细节。像常规 chatbot。</p>
  </div>
  <div class="showcase-card">
    <img src="/mockups/full-mode.svg" alt="详细模式" />
    <h3>详细模式</h3>
    <p>每步完整参数 + 输出；开发者友好。</p>
  </div>
  <div class="showcase-card">
    <img src="/mockups/approval-flow.svg" alt="审批弹窗" />
    <h3>危险操作审批</h3>
    <p>提交表单、上传文件、发带 cookie 的请求都要人工过。</p>
  </div>
</div>

## 三种用法

<div class="usage-grid">
  <a :href="withBase('/guide/install')" class="usage-card">
    <div class="usage-icon" style="background:#065f46">🧩</div>
    <h3>Chrome 扩展</h3>
    <p>直接在浏览器侧边面板对话。装 zip 即用；每个 tab 独立会话。</p>
    <span class="usage-link">安装扩展 →</span>
  </a>
  <a :href="withBase('/advanced/mcp-bridge')" class="usage-card">
    <div class="usage-icon" style="background:#7c2d12">🔌</div>
    <h3>MCP + Codex / Claude Code</h3>
    <p>把浏览器作为 MCP 工具交给编码 agent；一句话让它在真实网页跑。</p>
    <span class="usage-link">配置 MCP →</span>
  </a>
  <a :href="withBase('/advanced/coordinator')" class="usage-card">
    <div class="usage-icon" style="background:#1e3a8a">🌐</div>
    <h3>Coordinator 远程</h3>
    <p>服务器批量派发工具步；跨机器采集或远程回归测试。</p>
    <span class="usage-link">协议文档 →</span>
  </a>
</div>

## 3 步开始

<div class="steps-grid">
  <div class="step-card">
    <div class="step-num">1</div>
    <h3>下载 zip</h3>
    <p>从 <a href="https://github.com/attson/aipagego/releases/latest">GitHub Releases</a> 拿最新 <code>aipagego-vX.Y.Z.zip</code>，解压。</p>
  </div>
  <div class="step-card">
    <div class="step-num">2</div>
    <h3>加载扩展</h3>
    <p><code>chrome://extensions</code> → 开发者模式 → 加载已解压的扩展 → 选 <code>dist/</code>。</p>
  </div>
  <div class="step-card">
    <div class="step-num">3</div>
    <h3>填 API Key</h3>
    <p>点扩展图标 → 设置 → 填 Provider / Model / API Key → 打开侧边面板 → 发第一条 prompt。</p>
  </div>
</div>

</div>
