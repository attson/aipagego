---
layout: home
hero:
  name: AIPageGo
  text: AI Web Assistant
  tagline: Read, write, and scrape the tab you're on — chat like a normal chatbot, AI drives the tools
  image:
    src: /mockups/sidepanel-hero-landscape.svg
    alt: AIPageGo side panel embedded in a browser
  actions:
    - theme: brand
      text: Download latest
      link: https://github.com/attson/aipagego/releases/latest
    - theme: alt
      text: Quick start →
      link: /en/guide/install
    - theme: alt
      text: View on GitHub
      link: https://github.com/attson/aipagego
features:
  - icon: 📖
    title: Read
    details: Summarize, translate, extract key points, answer questions about the page
  - icon: ✍️
    title: Write
    details: Fill forms, check boxes, select dropdowns, click, submit, upload
  - icon: 🎯
    title: Scrape
    details: Product images, detail images, comment lists → structured JSON; paginates & lazy-load-aware
  - icon: 🧊
    title: Save
    details: Freeze any successful conversation into a URL-pattern-matched replayable tool
---

<script setup>
import { withBase } from 'vitepress';
</script>

<div class="showcase">

## See it in action

<div class="showcase-grid">
  <div class="showcase-card">
    <img src="/mockups/compact-mode.svg" alt="Compact mode" />
    <h3>Compact mode</h3>
    <p>One row per tool call; click to expand. Feels like a normal chatbot.</p>
  </div>
  <div class="showcase-card">
    <img src="/mockups/full-mode.svg" alt="Full mode" />
    <h3>Full mode</h3>
    <p>Every step shows full args + output. Developer-friendly.</p>
  </div>
  <div class="showcase-card">
    <img src="/mockups/approval-flow.svg" alt="Approval flow" />
    <h3>Approval for dangerous ops</h3>
    <p>Submit form, upload file, cookied requests — all require manual approval.</p>
  </div>
</div>

## Three ways to use it

<div class="usage-grid">
  <a :href="withBase('/en/guide/install')" class="usage-card">
    <div class="usage-icon" style="background:#065f46">🧩</div>
    <h3>Chrome extension</h3>
    <p>Chat directly in the browser side panel. Load the zip; each tab gets its own session.</p>
    <span class="usage-link">Install →</span>
  </a>
  <a :href="withBase('/en/advanced/mcp-bridge')" class="usage-card">
    <div class="usage-icon" style="background:#7c2d12">🔌</div>
    <h3>MCP + Codex / Claude Code</h3>
    <p>Expose the browser as an MCP tool to your coding agent and drive real web pages.</p>
    <span class="usage-link">Configure MCP →</span>
  </a>
  <a :href="withBase('/en/advanced/coordinator')" class="usage-card">
    <div class="usage-icon" style="background:#1e3a8a">🌐</div>
    <h3>Coordinator (remote)</h3>
    <p>Dispatch tool steps from a server; batch scraping across machines or remote regression testing.</p>
    <span class="usage-link">Protocol docs →</span>
  </a>
</div>

## Get started in 3 steps

<div class="steps-grid">
  <div class="step-card">
    <div class="step-num">1</div>
    <h3>Download the zip</h3>
    <p>Grab the latest <code>aipagego-vX.Y.Z.zip</code> from <a href="https://github.com/attson/aipagego/releases/latest">GitHub Releases</a> and unzip.</p>
  </div>
  <div class="step-card">
    <div class="step-num">2</div>
    <h3>Load the extension</h3>
    <p><code>chrome://extensions</code> → Developer mode → Load unpacked → select the <code>dist/</code> folder.</p>
  </div>
  <div class="step-card">
    <div class="step-num">3</div>
    <h3>Add API key</h3>
    <p>Click the extension icon → Settings → set Provider / Model / API Key → open the side panel → send your first prompt.</p>
  </div>
</div>

</div>
