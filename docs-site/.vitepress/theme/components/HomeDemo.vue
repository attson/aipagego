<script setup>
/**
 * Replaces the hero mockup with the live demo.
 *
 * The demo is a separate Vite build (packages/extension/demo) served from
 * public/demo, so it runs the real side panel and the real content tools
 * without dragging React into the docs build. An iframe also keeps its CSS
 * from colliding with VitePress.
 */
</script>

<template>
  <div class="home-demo">
    <iframe
      class="home-demo-frame"
      src="/aipagego/demo/index.html"
      title="AIPageGo 交互演示"
      referrerpolicy="no-referrer"
    ></iframe>
    <p class="home-demo-note">
      ↑ 真的侧边栏在真的 DOM 上工作。这是<strong>预置页面</strong>，不是在线试用 ——
      装上扩展后可以在任意网站上用。
    </p>
  </div>
</template>
