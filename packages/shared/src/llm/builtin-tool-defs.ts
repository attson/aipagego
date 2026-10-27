import type { LlmTool } from "./types";

/**
 * Shared description for the `tabId` field — used by every page-level tool.
 * Centralized so updates to the cross-tab protocol propagate everywhere.
 */
const TAB_ID_FIELD = {
  type: "integer" as const,
  description:
    "目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请）",
};

export const TOOL_DEFS: LlmTool[] = [
  {
    name: "snapshotDOM",
    description:
      "[FIRST·LEGACY] 返回页面 DOM 简化树（tag/id/classes/直接文本/children）。\n" +
      "如果你只是要找交互元素并随后操作，**优先用 takeSnapshot**（UID 稳定，clickByUid 健壮）；\n" +
      "snapshotDOM 更适合「我要分析整个页面结构」这种探查类需求。\n\n" +
      "示例：\n" +
      "- 看整页：{ }（默认 maxDepth=3）\n" +
      "- 看某区域：{ root: '.main-content', maxDepth: 5 }\n" +
      "- 看到底：{ maxDepth: 8 }",
    mcp: {
      description: "Simplified DOM tree (tag/id/classes/text/children) for analysing page structure. Prefer takeSnapshot when you intend to click or fill.",
      params: { root: "CSS selector to start from; defaults to <html>" }
    },
    input_schema: {
      type: "object",
      properties: {
        maxDepth: { type: "integer", default: 3 },
        root: { type: "string", description: "可选的 CSS 选择器；找不到时退回到 <html>" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "querySelector",
    description:
      "[FAST] 返回首个匹配元素的浅层摘要 (tag/id/classes/text/attrs)。仅探查用。\n" +
      "要后续点击或填值，配合 selector 直接传给 click / fillInput，或用 takeSnapshot 拿 UID。\n\n" +
      "示例：\n" +
      "- 找按钮：{ selector: 'button[type=submit]' }\n" +
      "- 找输入：{ selector: 'input[name=email]' }",
    mcp: { description: "Shallow summary (tag/id/classes/text/attrs) of the first element matching a CSS selector." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        root: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "querySelectorAll",
    description:
      "[FAST] 返回所有匹配元素的浅层摘要数组。\n\n" +
      "示例：\n" +
      "- 所有评论：{ selector: '.comment-item', limit: 50 }\n" +
      "- 所有链接：{ selector: 'a[href]', limit: 20 }",
    mcp: { description: "Shallow summaries of all elements matching a CSS selector." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        root: { type: "string" },
        limit: { type: "integer" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "inspectElement",
    description:
      "[FAST·READ·LAYOUT] 读取元素的运行时布局真相：computed style、viewport/document rect、可见性、祖先链与 shadow root 信息。\n" +
      "调试 display/box-sizing/position/overflow/z-index、弹窗挂载点或父级布局时优先用它，不要为这些只读信息调用 runJS。",
    mcp: {
      description: "Runtime layout truth for one element: computed style, rects, visibility, ancestor chain, shadow root. Use for display/overflow/z-index/positioning questions instead of runJS.",
      params: { selector: "CSS selector; one of selector/uid", uid: "uid from takeSnapshot/findElements; one of selector/uid", styleProperties: "CSS properties to read; defaults to common layout props" }
    },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector；与 uid 二选一" },
        uid: { type: "string", description: "takeSnapshot/findElements 返回的 uid；与 selector 二选一" },
        ancestorDepth: { type: "integer", default: 5, minimum: 0, maximum: 10 },
        styleProperties: {
          type: "array",
          items: { type: "string" },
          maxItems: 50,
          description: "要读取的 CSS 属性；省略时返回常用布局属性"
        },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "extractText",
    description:
      "[FAST·TARGETED] 提取选择器命中元素的文本。single=true 返回字符串，否则返回数组。\n" +
      "只用于明确的小范围 selector；普通网页理解/字段提取不要用 extractText({selector:'body'})，先用 createPageIndex + extractPageFields/searchPageIndex。\n\n" +
      "示例：\n" +
      "- 提取标题：{ selector: 'h1', single: true }\n" +
      "- 提取所有段落：{ selector: 'article p' }",
    mcp: { description: "Text of elements matching a small, targeted CSS selector. single=true returns a string, else an array. Do not use on body; use createPageIndex for whole pages." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        root: { type: "string" },
        single: { type: "boolean" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  // ─── Page Context Index · bounded read / extraction ─────────
  {
    name: "createPageIndex",
    description:
      "[PAGE-INDEX][FIRST·READ] 在内容脚本本地构建/刷新页面索引，返回小型页面地图、blockId、kinds、truncation 元数据。\n" +
      "用于普通网页理解、商品/文章/表格字段提取、采集前定位。不要先读取 body；先建索引，再用 extractPageFields/searchPageIndex。",
    mcp: {
      description: "Build or refresh a local page index; returns a compact page map with blockIds. Call first on any content page before extractPageFields/searchPageIndex.",
      params: { refresh: "true = rescan, ignore cache" }
    },
    input_schema: {
      type: "object",
      properties: {
        maxBlocks: { type: "integer", default: 600, description: "最多索引多少个页面块；超出返回 index_budget truncation" },
        refresh: { type: "boolean", default: false, description: "true=忽略缓存重新扫描当前页面" },
        summaryLimit: { type: "integer", default: 40, description: "返回给模型的页面地图条数" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "searchPageIndex",
    description:
      "[PAGE-INDEX] 在本地页面索引中搜索关键词/字段，返回小证据片段、blockId、complete/availableChars、truncation 元数据。\n" +
      "适合定位排名、价格、评论数、日期等证据；不要用 extractText({selector:'body'}) 来搜索大页面。",
    mcp: { description: "Search the page index for a keyword/field; returns evidence snippets with blockIds.", params: { query: "keyword or phrase" } },
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的关键词/短语" },
        fields: { type: "array", items: { type: "string" }, description: "也可给字段名数组辅助匹配" },
        limit: { type: "integer", default: 20 },
        maxBlocks: { type: "integer", default: 600 },
        refresh: { type: "boolean", default: false },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "readPageBlock",
    description:
      "[PAGE-INDEX] 按 blockId 读取局部内容；长内容按 offset/maxChars 分页，返回 hasMore、nextOffset、recommendedNext 和 truncation 日志。\n" +
      "只在 searchPageIndex/extractPageFields 证据不足或需要核对邻近上下文时使用。",
    mcp: {
      description: "Read one index block by blockId, paged via offset/maxChars. Use when search/extract evidence is insufficient.",
      params: { blockId: "blockId from createPageIndex/searchPageIndex/extractPageFields", indexId: "bind to the index that produced blockId" }
    },
    input_schema: {
      type: "object",
      properties: {
        blockId: { type: "string", description: "createPageIndex/searchPageIndex/extractPageFields 返回的稳定 blockId" },
        indexId: { type: "string", description: "可选：绑定到产生该 blockId 的索引，避免 refresh 后误读同名 blockId" },
        offset: { type: "integer", default: 0 },
        maxChars: { type: "integer", default: 4000 },
        includeNeighbors: { type: "boolean", default: false },
        tabId: TAB_ID_FIELD,
      },
      required: ["blockId"],
    },
  },
  {
    name: "extractPageFields",
    description:
      "[PAGE-INDEX][FIELD-FIRST] 通用字段候选提取：输入字段名数组，返回 value candidates、confidence、evidence、blockId、truncation。\n" +
      "适合商品信息、文章元信息、表格详情、表单字段等结构化提取；证据不足再用 readPageBlock 定向读取。",
    mcp: { description: "Extract named fields (price, author, date, …) from the page index with candidates, confidence and evidence.", params: { fields: "field names to extract" } },
    input_schema: {
      type: "object",
      properties: {
        fields: { type: "array", items: { type: "string" }, description: "用户要提取的字段名，例如 价格、排名、ASIN、作者、发布日期" },
        maxCandidatesPerField: { type: "integer", default: 4 },
        maxBlocks: { type: "integer", default: 600 },
        refresh: { type: "boolean", default: false },
        tabId: TAB_ID_FIELD,
      },
      required: ["fields"],
    },
  },
  {
    name: "extractImages",
    description:
      "[FAST] 在 root 范围内提取所有 <img> 的 src/data-src/srcset；includeBg=true 时也提取背景图。返回 [{url, via}].\n\n" +
      "示例：\n" +
      "- 全页图：{ }（默认 root=document）\n" +
      "- 商品主图：{ root: '.product-gallery' }",
    mcp: { description: "All <img> src/data-src/srcset under root; includeBg=true adds CSS background images." },
    input_schema: {
      type: "object",
      properties: {
        root: { type: "string" },
        includeBg: { type: "boolean", default: false },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "scroll",
    description:
      "[FLOW] 滚动页面。to 可为 'bottom' / 'top' / number。max 是滚动次数；untilSelector 出现时提前停。\n\n" +
      "示例：\n" +
      "- 触发懒加载：{ to: 'bottom', max: 5 }\n" +
      "- 滚到锚点：{ to: 'top' } 后用 element.scrollIntoView 也可\n" +
      "- 等待新元素：{ to: 'bottom', max: 10, untilSelector: '.item:nth-child(20)' }",
    mcp: { description: "Scroll the page. to = 'top' | 'bottom' | pixel number; max = repeat count; untilSelector stops early when it appears (lazy-load).", params: { to: "'bottom' | 'top' | number" } },
    input_schema: {
      type: "object",
      properties: {
        to: { description: "'bottom' | 'top' | number" },
        max: { type: "integer", default: 1 },
        intervalMs: { type: "integer", default: 250 },
        untilSelector: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["to"],
    },
  },
  {
    name: "waitFor",
    description:
      "[FLOW] 等待固定 ms，或等待选择器出现（带 timeoutMs 兜底）。\n\n" +
      "示例：\n" +
      "- 等 500ms：{ ms: 500 }\n" +
      "- 等元素出现：{ selector: '.lazy-loaded', timeoutMs: 8000 }",
    mcp: { description: "Wait a fixed ms, or until a selector/text appears or text disappears, with timeoutMs.", params: { text: "wait until this text appears", textGone: "wait until this text disappears" } },
    input_schema: {
      type: "object",
      properties: {
        ms: { type: "integer" },
        selector: { type: "string" },
        timeoutMs: { type: "integer", default: 5000 },
        text: { type: "string", description: "等待页面出现该文本" },
        textGone: { type: "string", description: "等待该文本消失" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "click",
    description:
      "[ACT] 点击选择器命中的元素。required=false 时找不到不报错。会经过审阅（caution）。\n" +
      "用 takeSnapshot 拿到 UID 后建议改用 clickByUid，更稳。",
    mcp: { description: "Click the element matching a CSS selector. Supports button/doubleClick/modifiers. required=false makes a missing element a no-op. Prefer clickByUid after takeSnapshot." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        required: { type: "boolean", default: true },
        doubleClick: { type: "boolean", default: false },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "httpRequest",
    description:
      "[ACT] 通过后台代理发请求。withCredentials=true 时带 cookie（dangerous，要审阅）；默认 omit。\n\n" +
      "示例：\n" +
      "- 翻评论页：{ url: 'https://x.com/api/comments?page=2', withCredentials: false }\n" +
      "- 带登录态调内部接口：{ url: '...', withCredentials: true }",
    mcp: { description: "HTTP request via the background proxy. withCredentials=true sends cookies (dangerous, reviewed); default omits them.", params: { body: "any JSON value" } },
    input_schema: {
      type: "object",
      properties: {
        method: { type: "string", default: "GET" },
        url: { type: "string" },
        headers: { type: "object" },
        body: { description: "any JSON-able value" },
        withCredentials: { type: "boolean", default: false },
        tabId: TAB_ID_FIELD,
      },
      required: ["url"],
    },
  },
  {
    name: "readStorage",
    description: "[DANGER] 读 localStorage 或 sessionStorage 指定 key。需要审阅。",
    mcp: { description: "Read one key from localStorage or sessionStorage (dangerous, reviewed)." },
    input_schema: {
      type: "object",
      properties: {
        store: { type: "string", enum: ["local", "session"] },
        key: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["store", "key"],
    },
  },
  {
    name: "fillInput",
    description:
      "[ACT] 往 input/textarea/contenteditable 填值；触发 input/change 事件兼容 React/Vue。\n" +
      "**批量填表请用 fillForm**（更高效）。\n\n" +
      "示例：\n" +
      "- 填邮箱：{ selector: 'input[name=email]', value: 'a@b.c' }\n" +
      "- 不清空直接追加：{ selector: '.editor', value: 'tail', clear: false }",
    mcp: {
      description: "Set the value of an input/textarea/contenteditable and fire input/change. Use fillForm for several fields.",
      params: { slowly: "type char by char for controlled components", submit: "press Enter afterwards" }
    },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        clear: { type: "boolean", default: true },
        slowly: {
          type: "boolean",
          default: false,
          description: "逐字符触发 keydown/keypress/input/keyup，对付受控组件",
        },
        submit: { type: "boolean", default: false, description: "填完按一次 Enter" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "setCheckbox",
    description: "[ACT] 设置 checkbox 勾选状态；派发 change 事件。",
    mcp: { description: "Set a checkbox's checked state and dispatch change." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        checked: { type: "boolean" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector", "checked"],
    },
  },
  {
    name: "selectOption",
    description: "[ACT] <select> 元素按 value 或 label 选项。同时给两者时优先 value。",
    mcp: { description: "Choose a <select> option by value or label (value wins if both given)." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        label: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "submitForm",
    description:
      "[CONFIRM·DANGER] 提交 <form>。会触发服务端动作（下单、留言等），用户必须审阅。\n" +
      "调用前建议先用 askUser 让用户最终确认。",
    mcp: { description: "Submit a <form> (dangerous: triggers server-side actions, reviewed)." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "hover",
    description: "[ACT] 把鼠标悬停在元素上（触发 mouseenter / mouseover / mousemove）。",
    mcp: { description: "Hover an element (mouseenter/mouseover/mousemove)." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "focus",
    description: "[ACT] 把焦点给某元素（触发 focus / focusin）。",
    mcp: { description: "Focus an element (focus/focusin)." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "uploadFile",
    description:
      "[CONFIRM·DANGER] 把后端代理拉到的文件填到 <input type=file>。某些站点会拒绝合成 File。",
    mcp: { description: "Fetch a URL through the proxy and put it into an <input type=file> (dangerous, reviewed). Some sites reject synthetic files." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        url: { type: "string" },
        filename: { type: "string" },
        mimeType: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector", "url"],
    },
  },
  {
    name: "getValue",
    description: "[FAST] 读 input/select/textarea/contenteditable 的当前值。",
    mcp: { description: "Current value of an input/select/textarea/contenteditable." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["selector"],
    },
  },
  {
    name: "extractFormState",
    description:
      "[FAST·USE BEFORE FILL] 把 <form> 内所有可填字段读成 {name: value} 对象（radio 取选中值；checkbox 多选取数组）。\n" +
      "填表前先调一次，能省下大量盲填。",
    mcp: { description: "All fillable fields of a <form> as {name: value}. Call before filling to avoid blind fills.", params: { form: "CSS selector of the form; defaults to the first form" } },
    input_schema: {
      type: "object",
      properties: {
        form: { type: "string", description: "可选：<form> 的 CSS selector；省略=第一个 form" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "runJS",
    description:
      "[LAST RESORT·DANGER] 在 MAIN world 注入并执行 async 函数体（receives `ctx` = bindings）。必须 return 值。\n" +
      "**仅在结构化工具不够用时使用**——会经过静态扫描与人工审阅。严格 CSP 页面需要用户预先在扩展设置中开启 CDP/debugger；读取样式、位置或祖先链请优先使用 inspectElement。",
    mcp: {
      description: "Last resort: run an async function body in the page MAIN world; must return a value. Statically scanned and reviewed. Strict-CSP pages need CDP enabled in extension settings.",
      params: { source: "async function body" }
    },
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "async function body" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 25000, default: 25000 },
        tabId: TAB_ID_FIELD,
      },
      required: ["source"],
    },
  },
  // ─── Cross-tab control plane ─────────────────────────────────
  {
    name: "listTabs",
    description:
      "[META] 列出所有窗口的可访问 tab；返回 [{tabId, windowId, url, title, attached, isCurrent}]。\n" +
      "在你需要识别 / 找新 tab 时调用。",
    mcp: { description: "List accessible tabs across windows: [{tabId, windowId, url, title, attached, isCurrent}].", params: { windowId: "restrict to one window" } },
    input_schema: {
      type: "object",
      properties: {
        windowId: { type: "integer", description: "仅返回此窗口的 tab；省略=全部窗口" },
      },
    },
  },
  {
    name: "openTab",
    description: "[META] 打开新 tab，成功后自动加入会话 attachedTabs（source=ai-open）。返回 {tabId, url, title}。",
    mcp: { description: "Open a new tab and attach it to the session. Returns {tabId, url, title}.", params: { active: "true = switch to it" } },
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        active: { type: "boolean", default: false, description: "true=切到该 tab" },
      },
      required: ["url"],
    },
  },
  {
    name: "attachTab",
    description: "[META] 请求把已打开的 tab 纳入会话 attachedTabs；未预批准时会向用户索取审批。",
    input_schema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        reason: { type: "string", description: "向用户解释为何需要访问该 tab" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "detachTab",
    description: "[META] 从会话 attachedTabs 移除 tab；不关闭该 tab。",
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  {
    name: "closeTab",
    description:
      "[META] 真正关闭一个 tab。**只能关 attachedTabs 里的 tab**（防止误关用户其它窗口）。",
    mcp: { description: "Close the session's tab." },
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  {
    name: "switchToTab",
    description: "[META] 把 Chrome 前台切到目标 tab。tabId 必须已在 attachedTabs 或当前 tab。",
    mcp: {
      description:
        "Bring the session's tab and Chrome window to the foreground. Use only when the user explicitly asks to see that tab; all other browser tools already operate on the session-bound tab without this setup step."
    },
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  // ─── User-side helpers ───────────────────────────────────────
  {
    name: "screenshot",
    description:
      "[VISION] 截当前 tab 可见区域为 PNG（自动作为 image block 注入下轮）。用于视觉调试、看图回答、核对 page-index 证据。\n" +
      "如果已有 searchPageIndex/extractPageFields 返回的 blockId/indexId，优先传 {blockId,indexId}；工具会滚动并高亮该局部区域后截图。也可传 selector。",
    mcp: {
      description: "PNG/JPEG returned as an image block. With opt-in CDP enabled, captures viewport/fullPage/selector in the background without activating or scrolling the tab; compatibility mode may temporarily activate the tab.",
      params: { blockId: "page-index blockId to frame", indexId: "indexId that produced blockId", scale: "0.1–1; smaller saves tokens" }
    },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "可选：CSS selector；截图前会滚动并高亮目标" },
        blockId: { type: "string", description: "可选：page-index 返回的 blockId，用于局部视觉证据" },
        indexId: { type: "string", description: "可选：产生 blockId 的 indexId，避免 refresh 后误读" },
        highlightMs: { type: "integer", default: 1500, description: "截图前目标高亮持续时间，250-5000ms" },
        fullPage: { type: "boolean", default: false, description: "滚动分段截图后拼接整页" },
        format: { type: "string", enum: ["png", "jpeg"], default: "png" },
        scale: { type: "number", default: 1, description: "0.1–1，缩小可省 token" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "askUser",
    description:
      "[ASK] 向用户主动征询（不是执行操作）。任务有多个候选 / 二次确认 / 缺关键信息时调用。返回 {choice} / {value} / {cancelled:true}。\n" +
      "**仅在你确实卡住时才用**——别用它做闲聊。",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "向用户展示的问题文本" },
        kind: {
          type: "string",
          enum: ["select", "confirm", "text"],
          description: "select=用户从 options 选一项；confirm=是/否；text=自由文本",
        },
        options: {
          type: "array",
          description: "kind=select 时必填，每项 {id, label, description?}",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["id", "label"],
          },
        },
      },
      required: ["prompt", "kind"],
    },
  },
  // ─── Tier 3 · bookmark / history / downloads ────────────────
  {
    name: "searchBookmarks",
    description: "[META] 搜索浏览器书签（chrome.bookmarks.search）。返回 [{id, title, url}]。\n\n示例：{ query: 'react', limit: 20 }",
    mcp: { description: "Search browser bookmarks: [{id, title, url}]." },
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "searchHistory",
    description: "[META] 搜索浏览器历史。daysBack 默认 7。返回 [{url, title, lastVisitTime, visitCount}]。",
    mcp: { description: "Search browser history (daysBack default 7): [{url, title, lastVisitTime, visitCount}]." },
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        daysBack: { type: "integer", default: 7 },
        limit: { type: "integer", default: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "downloadImage",
    description: "[ACT] 把一个 URL 下载到本地（Chrome Downloads）。返回 {downloadId, filename}。caution 级。",
    mcp: { description: "Download a URL to Chrome Downloads. Returns {downloadId, filename}.", params: { filename: "suggested file name with extension" } },
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        filename: { type: "string", description: "可选：建议的文件名（含后缀）" },
      },
      required: ["url"],
    },
  },
  {
    name: "collectStructuredData",
    description:
      "[COLLECT·REPLAY] 使用已经确认的本地采集配方运行结构化采集。返回有界 CollectionRunSummary（含 resultId 和最多 5 行预览），完整结果保存在本地，不需要 LLM。",
    mcp: {
      description: "Run a validated Collect Studio recipe locally and return its bounded summary/resultId without an LLM round-trip.",
      params: { recipe: "CollectionRecipeV1 saved by Collect Studio" }
    },
    input_schema: {
      type: "object",
      properties: {
        recipe: {
          type: "object",
          properties: {
            version: { type: "integer", enum: [1] },
            mode: { type: "string", enum: ["single", "list"] },
            itemSelector: { type: "string" },
            fields: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  selector: { type: "string" },
                  valueMode: { type: "string", enum: ["text", "href", "src", "attribute"] },
                  attribute: { type: "string" },
                  required: { type: "boolean" }
                },
                required: ["id", "name", "selector", "valueMode", "required"]
              }
            },
            pagination: { type: "object" },
            dedupeBy: { type: "array", items: { type: "string" } },
            maxRows: { type: "integer", minimum: 1, maximum: 2000 },
            maxBytes: { type: "integer", minimum: 1, maximum: 5242880 }
          },
          required: ["version", "mode", "fields", "pagination", "dedupeBy", "maxRows", "maxBytes"]
        },
        tabId: TAB_ID_FIELD
      },
      required: ["recipe"]
    }
  },
  {
    name: "downloadSpreadsheet",
    description:
      "[ACT] 生成并下载真正的 .xlsx Excel 文件（Chrome Downloads）。适合把采集/抽取结果导出为表格。" +
      "支持多个 sheet；rows 可以是二维数组，也可以是对象数组。对象数组可配 columns 控制列顺序和表头。" +
      "返回 {downloadId, filename, sheets, rows, bytes}。caution 级。",
    mcp: {
      description: "Generate and download a real .xlsx. sheets[].rows may be 2-D arrays or objects; columns orders object keys and sets headers.",
      params: { filename: "suggested name; .xlsx optional" }
    },
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "建议文件名；可不带 .xlsx 后缀" },
        sheets: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "sheet 名，最长 31 字符；非法字符会被替换" },
              columns: {
                type: "array",
                description: "对象行的列顺序和表头；二维数组行可省略",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    header: { type: "string" },
                  },
                  required: ["key"],
                },
              },
              rows: {
                type: "array",
                description:
                  "二维数组，如 [[\"标题\",\"价格\"],[\"A\",12]]；或对象数组，如 [{title:\"A\",price:12}]",
                items: {
                  oneOf: [
                    { type: "array", items: {} },
                    { type: "object" },
                  ],
                },
              },
            },
            required: ["rows"],
          },
        },
      },
      required: ["sheets"],
    },
  },
  // ─── Tier 4 · UID-based interaction + visual + batch ────────
  {
    name: "takeSnapshot",
    description:
      "[FIRST·UID] 抓取页面 accessibility snapshot：返回 [{uid, role, name, tag, text, bounds}]。\n" +
      "UID 在本次 snapshot 内稳定，后续 clickByUid / fillByUid 引用；比 selector 健壮，不怕 class 改名。\n" +
      "每次大动作前刷新一次。snapshot 默认只返回交互元素（button / link / input / textarea / select / [role] / [data-testid]）。",
    mcp: { description: "Accessibility snapshot: [{uid, role, name, tag, text, bounds}]. uids feed clickByUid/fillByUid. Refresh before each major action.", params: { includeAll: "true = every element, not just interactive" } },
    input_schema: {
      type: "object",
      properties: {
        includeAll: { type: "boolean", default: false, description: "true=全部 element；false=只 interactive（默认）" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "clickByUid",
    description: "[ACT·UID] 用 takeSnapshot 返回的 uid 点击元素。比 selector 版稳定。",
    mcp: { description: "Click an element by uid from takeSnapshot/findElements. More robust than a selector." },
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
      required: ["uid"],
    },
  },
  {
    name: "fillByUid",
    description: "[ACT·UID] 用 takeSnapshot 返回的 uid 填值（input/textarea/contenteditable）。",
    mcp: { description: "Set a value on an element by uid from takeSnapshot." },
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        value: { type: "string" },
        clear: { type: "boolean", default: true },
        tabId: TAB_ID_FIELD,
      },
      required: ["uid", "value"],
    },
  },
  {
    name: "highlightElement",
    description:
      "[VISUAL] 给页面某元素加红色虚线框（默认 3s 自动消失），让用户看清你说的是哪个。仅视觉，不改 DOM。\n" +
      "可用 selector 或 uid 任一种。",
    mcp: { description: "Draw a temporary red outline around an element (visual only)." },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        uid: { type: "string", description: "或 takeSnapshot 返回的 uid" },
        ms: { type: "integer", default: 3000 },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "highlightText",
    description: "[VISUAL] 在页面文本里高亮某段文字（黄色背景，3s 后还原）。仅找到第一次出现的位置。",
    mcp: { description: "Temporarily highlight the first occurrence of a text string (visual only)." },
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        ms: { type: "integer", default: 3000 },
        tabId: TAB_ID_FIELD,
      },
      required: ["text"],
    },
  },
  {
    name: "fillForm",
    description:
      "[BATCH·ACT] 一次性填多个字段。每项写 selector + value 或 uid + value。返回 {filled: N, failed: [{at, error}]}。\n" +
      "比循环调 fillInput 快得多，也省 round-trip。\n\n" +
      "示例：\n" +
      "{ fields: [\n" +
      "  { selector: 'input[name=name]', value: '张三' },\n" +
      "  { selector: 'input[name=phone]', value: '13800000000' },\n" +
      "  { uid: 'el_5', value: 'mushroom' }\n" +
      "] }",
    mcp: { description: "Fill several fields in one call; each item is {selector|uid, value}. Returns {filled, failed}." },
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              selector: { type: "string" },
              uid: { type: "string" },
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["fields"],
    },
  },
  // ─── Round 6 — common helpers ─────────────────────────────────
  {
    name: "navigate",
    description:
      "[ACT] 页面导航：后退 / 前进 / 重载 / 跳转。**优先**用本工具而不是 runJS('location.href = ...')。\n" +
      "示例：\n" +
      "- 后退一页：{ action: 'back' }\n" +
      "- 跳到新 URL：{ action: 'goto', url: 'https://example.com/page' }",
    mcp: { description: "Navigate: action = back | forward | reload | goto (with url). Prefer this over runJS location changes.", params: { url: "goto only; http/https/file/ftp" } },
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["back", "forward", "reload", "goto"] },
        url: { type: "string", description: "仅 action=goto 时使用；只允许 http/https/file/ftp" },
        tabId: TAB_ID_FIELD,
      },
      required: ["action"],
    },
  },
  {
    name: "getPageInfo",
    description:
      "[FAST·READ] 读当前页基本信息：URL / title / hostname / 语言 / OpenGraph meta。\n" +
      "多页对话中「我在哪个页面」的首选；比 snapshotDOM 便宜得多。",
    mcp: { description: "URL, title, hostname, language and OpenGraph meta of the current page. Cheapest 'where am I' check." },
    input_schema: {
      type: "object",
      properties: {
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "pressKey",
    description:
      "[ACT] 模拟键盘事件（keydown + 可打印字符 keypress + keyup）。\n" +
      "常用：Enter 提交无 form 的搜索框 / Escape 关 modal / Tab 切焦点。key 用 KeyboardEvent.key 值。\n" +
      "本工具**不**改 input 值——填值仍走 fillInput / fillByUid。\n" +
      "示例：\n" +
      "- 提交搜索：{ selector: 'input[name=q]', key: 'Enter' }\n" +
      "- 关 modal：{ key: 'Escape' }",
    mcp: { description: "Dispatch a key (keydown/keypress/keyup) to a selector or the active element; e.g. Enter, Escape, Tab. Does not change input values.", params: { key: "KeyboardEvent.key value" } },
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "如 'Enter' / 'Escape' / 'Tab' / 'ArrowDown' / 'a'" },
        selector: {
          type: "string",
          description: "可选；不传则派发到 document.activeElement 或 document.body",
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["key"],
    },
  },
  {
    name: "writeStorage",
    description: "[DANGER] 写 localStorage 或 sessionStorage。改站点状态，需要审阅。",
    mcp: { description: "Write one key to localStorage or sessionStorage (dangerous, reviewed).", params: { value: "string; JSON.stringify non-strings yourself" } },
    input_schema: {
      type: "object",
      properties: {
        store: { type: "string", enum: ["local", "session"] },
        key: { type: "string" },
        value: {
          type: "string",
          description: "字符串值；非字符串请自行 JSON.stringify",
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["store", "key", "value"],
    },
  },
  // ── Plan 32 — playwright parity ──────────────────────────────────────────
  {
    name: "consoleMessages",
    description:
      "[OBSERVE] 读取本页 console 日志与未捕获错误。返回里带 backend 字段：main-world 档看不到脚本注入之前的消息和浏览器级 CORS/CSP 报错，cdp 档能看到。\n" +
      "示例：只看报错 { level: 'error', limit: 50 }；增量轮询 { sinceId: 上次返回的最大 id }",
    mcp: { description: "Console output and uncaught errors of the page. Filter by level; sinceId for incremental reads.", params: { sinceId: "only messages with id greater than this" } },
    input_schema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["log", "info", "warn", "error", "debug", "trace"] },
        limit: { type: "integer", default: 100 },
        sinceId: { type: "integer", description: "只返回 id 大于此值的消息，用于增量读取" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "networkRequests",
    description:
      "[OBSERVE] 列出本页发出的网络请求摘要（method / url / status / 耗时）。默认隐藏 PerformanceObserver 观测到的静态资源，includeStatic:true 才带上。\n" +
      "要看 headers 或 body 用 networkRequestDetail。",
    mcp: { description: "Summaries of the page's network requests (method/url/status/duration). Static assets hidden unless includeStatic.", params: { urlPattern: "substring, or /regex/ with optional i flag" } },
    input_schema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "子串匹配；用 /re/ 或 /re/i 包起来则按正则" },
        method: { type: "string" },
        status: { type: "integer" },
        includeStatic: { type: "boolean", default: false },
        limit: { type: "integer", default: 50 },
        sinceId: { type: "integer" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "networkRequestDetail",
    description:
      "[OBSERVE] 读取单条请求的 headers 与 body。**dangerous**：响应头里可能有 Authorization / Set-Cookie / token。\n" +
      "main-world 档需先 recorderConfig({bodies:true}) 才会记录 body，且只记 256KB 以内的文本类响应；cdp 档直接可取。",
    mcp: {
      description: "Headers and bodies of one request from networkRequests (dangerous: may expose tokens). Bodies need recorderConfig({bodies:true}) unless CDP is on.",
      params: { id: "id from networkRequests", part: "return only this part" }
    },
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "networkRequests 返回的条目 id" },
        part: {
          type: "string",
          enum: ["request-headers", "request-body", "response-headers", "response-body"],
          description: "只取其中一部分；省略则全给",
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["id"],
    },
  },
  {
    name: "handleDialog",
    description:
      "[OBSERVE] 设定 alert / confirm / prompt 的应答策略，并返回已记录的弹窗。\n" +
      "main-world 档下弹窗是同步的，无法挂起等你决定，所以这里设的是**预先策略**：调用之后发生的弹窗按此处理。cdp 档下弹窗真挂起，本调用会立即应答当前挂起的弹窗。\n" +
      "未调用过本工具时弹窗保持原生行为（passthrough），页面表现与没装扩展一致。",
    mcp: { description: "Set the accept/dismiss policy for alert/confirm/prompt and return recorded dialogs. Pre-set policy in main-world mode; answers a pending dialog under CDP.", params: { promptText: "text for prompt dialogs" } },
    input_schema: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "true=确定，false=取消" },
        promptText: { type: "string", description: "prompt 弹窗填入的文本" },
        scope: { type: "string", enum: ["next", "all"], default: "next" },
        tabId: TAB_ID_FIELD,
      },
      required: ["accept"],
    },
  },
  {
    name: "recorderConfig",
    description:
      "[OBSERVE] 开关页面事件录制。bodies:true 打开请求/响应 body 捕获（默认关，有内存代价）；dialog:true 让弹窗走策略而不是原生行为；clear 清空缓冲。省略的字段保持原样。",
    mcp: { description: "Toggle console/network/dialog recording, arm request/response body capture, clear buffers." },
    input_schema: {
      type: "object",
      properties: {
        console: { type: "boolean" },
        network: { type: "boolean" },
        bodies: { type: "boolean" },
        dialog: { type: "boolean" },
        clear: {
          type: "array",
          items: { type: "string", enum: ["console", "network", "dialog"] },
        },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "navigateBack",
    description: "[FLOW] 后退一页。已在历史起点时返回 { ok:false, reason }，不抛错。",
    mcp: { description: "Go back one page; returns {ok:false, reason} at history start." },
    input_schema: { type: "object", properties: { tabId: TAB_ID_FIELD } },
  },
  {
    name: "navigateForward",
    description: "[FLOW] 前进一页。已在历史末尾时返回 { ok:false, reason }，不抛错。",
    mcp: { description: "Go forward one page; returns {ok:false, reason} at history end." },
    input_schema: { type: "object", properties: { tabId: TAB_ID_FIELD } },
  },
  {
    name: "resize",
    description:
      "[FLOW] 把视口调整到指定尺寸。main-world 档量取 outerWidth-innerWidth 反推浏览器边框后改窗口外框，视口精确但**用户的窗口会真的变大小**；cdp 档用 Emulation 覆盖设备尺寸，不动真实窗口。",
    mcp: { description: "Resize the viewport to width×height and return the measured actualViewport plus verified status. Do not re-measure with runJS." },
    input_schema: {
      type: "object",
      properties: {
        width: { type: "integer" },
        height: { type: "integer" },
        tabId: TAB_ID_FIELD,
      },
      required: ["width", "height"],
    },
  },
  {
    name: "drag",
    description:
      "[ACT] 把一个元素拖到另一个元素上。同时发 pointer 序列和 HTML5 DragEvent（共用一个 DataTransfer），兼容原生拖放和自定义 pointer 拖放。\n" +
      "返回 { consumed: { pointer, html5 } } 说明目标实际消费了哪一类事件——都为 false 说明这个拖放实现两条路都不吃。",
    mcp: { description: "Drag one element onto another by selector or uid. Emits pointer and HTML5 drag events; returns which the target consumed." },
    input_schema: {
      type: "object",
      properties: {
        fromSelector: { type: "string" },
        fromUid: { type: "string", description: "takeSnapshot / findElements 返回的 uid" },
        toSelector: { type: "string" },
        toUid: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "drop",
    description:
      "[ACT] 模拟从浏览器外部把文件或数据拖放到页面元素上。带 files 时等同上传（dangerous）。\n" +
      "示例：{ selector:'#dropzone', files:[{ name:'a.csv', mimeType:'text/csv', base64:'...' }] }",
    mcp: { description: "Simulate dropping external files/data onto an element. files present = upload (dangerous, reviewed).", params: { data: "MIME → string map" } },
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        uid: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              mimeType: { type: "string" },
              base64: { type: "string" },
            },
            required: ["name", "base64"],
          },
        },
        data: { type: "object", description: "MIME → 字符串，例如 { 'text/plain':'hi' }" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "findElements",
    description:
      "[READ] 按文本或正则在可交互元素里找目标，返回 uid / role / name / bounds。不需要先 createPageIndex。\n" +
      "拿到 uid 后用 clickByUid / fillByUid 操作最稳。",
    mcp: { description: "Find interactive elements by text or regex; returns uid/role/name/bounds without needing a page index.", params: { text: "case-insensitive substring", regex: "regex; alternative to text" } },
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "大小写不敏感子串" },
        regex: { type: "string", description: "与 text 二选一" },
        limit: { type: "integer", default: 20 },
        tabId: TAB_ID_FIELD,
      },
    },
  },
];
