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
          {
            text: '快速上手',
            items: [
              { text: '安装', link: '/guide/install' },
              { text: '配置', link: '/guide/config' },
              { text: '第一条任务', link: '/guide/first-task' },
            ],
          },
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
          {
            text: '高阶',
            items: [
              { text: '保存为工具', link: '/advanced/save-as-tool' },
              { text: '多 tab 会话', link: '/advanced/multi-tab' },
              { text: 'Coordinator', link: '/advanced/coordinator' },
              { text: 'MCP Bridge', link: '/advanced/mcp-bridge' },
              { text: '多会话配对', link: '/advanced/pairing' },
              { text: '页面事件录制', link: '/advanced/recorder' },
            ],
          },
          { text: 'GitHub', link: 'https://github.com/attson/aipagego' },
        ],
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
          '/advanced/': [
            {
              text: '高阶',
              items: [
                { text: '保存为工具', link: '/advanced/save-as-tool' },
                { text: '多 tab 会话', link: '/advanced/multi-tab' },
                { text: 'Coordinator', link: '/advanced/coordinator' },
                { text: 'MCP Bridge', link: '/advanced/mcp-bridge' },
                { text: '多会话配对', link: '/advanced/pairing' },
                { text: '页面事件录制', link: '/advanced/recorder' },
              ],
            },
          ],
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
        },
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
          {
            text: 'Guide',
            items: [
              { text: 'Install', link: '/en/guide/install' },
              { text: 'Configuration', link: '/en/guide/config' },
              { text: 'First task', link: '/en/guide/first-task' },
            ],
          },
          {
            text: 'Tools',
            items: [
              { text: 'Overview', link: '/en/tools/overview' },
            ],
          },
          {
            text: 'Advanced',
            items: [
              { text: 'Save as tool', link: '/en/advanced/save-as-tool' },
              { text: 'Multi-tab', link: '/en/advanced/multi-tab' },
              { text: 'Coordinator', link: '/en/advanced/coordinator' },
              { text: 'MCP Bridge', link: '/en/advanced/mcp-bridge' },
            ],
          },
          { text: 'GitHub', link: 'https://github.com/attson/aipagego' },
        ],
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
          '/en/tools/': [
            {
              text: 'Tool reference',
              items: [
                { text: 'Overview', link: '/en/tools/overview' },
              ],
            },
          ],
        },
        footer: {
          message: 'MIT License',
          copyright: 'Copyright © 2026 attson',
        },
      },
    },
  },
});
