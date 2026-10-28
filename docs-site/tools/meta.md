<!-- ⚠ 自动生成 —— 修改源在 packages/shared/src/llm/builtin-tool-defs.ts；跑 `pnpm gen` 重生 -->


# 元 / 视觉工具

跨 tab、书签、历史、下载、截图、视觉高亮、征询用户。用于任务编排。

## `inspectElement`  🔴 dangerous

[FAST·READ·LAYOUT] 读取元素的运行时布局真相：computed style、viewport/document rect、可见性、祖先链与 shadow root 信息。
调试 display/box-sizing/position/overflow/z-index、弹窗挂载点或父级布局时优先用它，不要为这些只读信息调用 runJS。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `selector` | string | CSS selector；与 uid 二选一 | 否 |
| `uid` | string | takeSnapshot/findElements 返回的 uid；与 selector 二选一 | 否 |
| `ancestorDepth` | integer |  | 否 |
| `styleProperties` | array | 要读取的 CSS 属性；省略时返回常用布局属性 | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `createPageIndex`  🔴 dangerous

[PAGE-INDEX][FIRST·READ] 在内容脚本本地构建/刷新页面索引，返回小型页面地图、blockId、kinds、truncation 元数据。
用于普通网页理解、商品/文章/表格字段提取、采集前定位。不要先读取 body；先建索引，再用 extractPageFields/searchPageIndex。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `maxBlocks` | integer | 最多索引多少个页面块；超出返回 index_budget truncation | 否 |
| `refresh` | boolean | true=忽略缓存重新扫描当前页面 | 否 |
| `summaryLimit` | integer | 返回给模型的页面地图条数 | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `searchPageIndex`  🔴 dangerous

[PAGE-INDEX] 在本地页面索引中搜索关键词/字段，返回小证据片段、blockId、complete/availableChars、truncation 元数据。
适合定位排名、价格、评论数、日期等证据；不要用 extractText({selector:'body'}) 来搜索大页面。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `query` | string | 要搜索的关键词/短语 | 否 |
| `fields` | array | 也可给字段名数组辅助匹配 | 否 |
| `limit` | integer |  | 否 |
| `maxBlocks` | integer |  | 否 |
| `refresh` | boolean |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `readPageBlock`  🔴 dangerous

[PAGE-INDEX] 按 blockId 读取局部内容；长内容按 offset/maxChars 分页，返回 hasMore、nextOffset、recommendedNext 和 truncation 日志。
只在 searchPageIndex/extractPageFields 证据不足或需要核对邻近上下文时使用。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `blockId` | string | createPageIndex/searchPageIndex/extractPageFields 返回的稳定 blockId | 是 |
| `indexId` | string | 可选：绑定到产生该 blockId 的索引，避免 refresh 后误读同名 blockId | 否 |
| `offset` | integer |  | 否 |
| `maxChars` | integer |  | 否 |
| `includeNeighbors` | boolean |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `extractPageFields`  🔴 dangerous

[PAGE-INDEX][FIELD-FIRST] 通用字段候选提取：输入字段名数组，返回 value candidates、confidence、evidence、blockId、truncation。
适合商品信息、文章元信息、表格详情、表单字段等结构化提取；证据不足再用 readPageBlock 定向读取。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `fields` | array | 用户要提取的字段名，例如 价格、排名、ASIN、作者、发布日期 | 是 |
| `maxCandidatesPerField` | integer |  | 否 |
| `maxBlocks` | integer |  | 否 |
| `refresh` | boolean |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `listTabs`  🟡 caution

[META] 列出所有窗口的可访问 tab；返回 [{tabId, windowId, url, title, attached, isCurrent}]。
在你需要识别 / 找新 tab 时调用。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `windowId` | integer | 仅返回此窗口的 tab；省略=全部窗口 | 否 |

---

## `openTab`  🟡 caution

[META] 打开新 tab，成功后自动加入会话 attachedTabs（source=ai-open）。返回 {tabId, url, title}。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `url` | string |  | 是 |
| `active` | boolean | true=切到该 tab | 否 |

---

## `attachTab`  🟡 caution

[META] 请求把已打开的 tab 纳入会话 attachedTabs；未预批准时会向用户索取审批。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `tabId` | integer |  | 是 |
| `reason` | string | 向用户解释为何需要访问该 tab | 否 |

---

## `detachTab`  🟢 safe

[META] 从会话 attachedTabs 移除 tab；不关闭该 tab。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `tabId` | integer |  | 是 |

---

## `closeTab`  🟢 safe

[META] 真正关闭一个 tab。**只能关 attachedTabs 里的 tab**（防止误关用户其它窗口）。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `tabId` | integer |  | 是 |

---

## `switchToTab`  🟢 safe

[META] 把 Chrome 前台切到目标 tab。tabId 必须已在 attachedTabs 或当前 tab。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `tabId` | integer |  | 是 |

---

## `screenshot`  🟢 safe

[VISION] 截当前 tab 可见区域为 PNG（自动作为 image block 注入下轮）。用于视觉调试、看图回答、核对 page-index 证据。
如果已有 searchPageIndex/extractPageFields 返回的 blockId/indexId，优先传 {blockId,indexId}；工具会滚动并高亮该局部区域后截图。也可传 selector。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `selector` | string | 可选：CSS selector；截图前会滚动并高亮目标 | 否 |
| `blockId` | string | 可选：page-index 返回的 blockId，用于局部视觉证据 | 否 |
| `indexId` | string | 可选：产生 blockId 的 indexId，避免 refresh 后误读 | 否 |
| `highlightMs` | integer | 截图前目标高亮持续时间，250-5000ms | 否 |
| `fullPage` | boolean | 滚动分段截图后拼接整页 | 否 |
| `format` | string |  | 否 |
| `scale` | number | 0.1–1，缩小可省 token | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `askUser`  🟢 safe

[ASK] 向用户主动征询（不是执行操作）。任务有多个候选 / 二次确认 / 缺关键信息时调用。返回 {choice} / {value} / {cancelled:true}。
**仅在你确实卡住时才用**——别用它做闲聊。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `prompt` | string | 向用户展示的问题文本 | 是 |
| `kind` | string | select=用户从 options 选一项；confirm=是/否；text=自由文本 | 是 |
| `options` | array | kind=select 时必填，每项 {id, label, description?} | 否 |

---

## `searchBookmarks`  🟢 safe

[META] 搜索浏览器书签（chrome.bookmarks.search）。返回 [{id, title, url}]。

示例：{ query: 'react', limit: 20 }

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `query` | string |  | 是 |
| `limit` | integer |  | 否 |

---

## `searchHistory`  🟢 safe

[META] 搜索浏览器历史。daysBack 默认 7。返回 [{url, title, lastVisitTime, visitCount}]。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `query` | string |  | 是 |
| `daysBack` | integer |  | 否 |
| `limit` | integer |  | 否 |

---

## `downloadImage`  🟡 caution

[ACT] 把一个 URL 下载到本地（Chrome Downloads）。返回 {downloadId, filename}。caution 级。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `url` | string |  | 是 |
| `filename` | string | 可选：建议的文件名（含后缀） | 否 |

---

## `collectStructuredData`  🔴 dangerous

[COLLECT·REPLAY] 使用已经确认的本地采集配方运行结构化采集。返回有界 CollectionRunSummary（含 resultId 和最多 5 行预览），完整结果保存在本地，不需要 LLM。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `recipe` | object |  | 是 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `downloadSpreadsheet`  🔴 dangerous

[ACT] 生成并下载真正的 .xlsx Excel 文件（Chrome Downloads）。适合把采集/抽取结果导出为表格。支持多个 sheet；rows 可以是二维数组，也可以是对象数组。对象数组可配 columns 控制列顺序和表头。返回 {downloadId, filename, sheets, rows, bytes}。caution 级。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `filename` | string | 建议文件名；可不带 .xlsx 后缀 | 否 |
| `sheets` | array |  | 是 |

---

## `highlightElement`  🟢 safe

[VISUAL] 给页面某元素加红色虚线框（默认 3s 自动消失），让用户看清你说的是哪个。仅视觉，不改 DOM。
可用 selector 或 uid 任一种。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `selector` | string |  | 否 |
| `uid` | string | 或 takeSnapshot 返回的 uid | 否 |
| `ms` | integer |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `highlightText`  🟢 safe

[VISUAL] 在页面文本里高亮某段文字（黄色背景，3s 后还原）。仅找到第一次出现的位置。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `text` | string |  | 是 |
| `ms` | integer |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `consoleMessages`  🔴 dangerous

[OBSERVE] 读取本页 console 日志与未捕获错误。返回里带 backend 字段：main-world 档看不到脚本注入之前的消息和浏览器级 CORS/CSP 报错，cdp 档能看到。
示例：只看报错 { level: 'error', limit: 50 }；增量轮询 { sinceId: 上次返回的最大 id }

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `level` | string |  | 否 |
| `limit` | integer |  | 否 |
| `sinceId` | integer | 只返回 id 大于此值的消息，用于增量读取 | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `networkRequests`  🔴 dangerous

[OBSERVE] 列出本页发出的网络请求摘要（method / url / status / 耗时）。默认隐藏 PerformanceObserver 观测到的静态资源，includeStatic:true 才带上。
要看 headers 或 body 用 networkRequestDetail。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `urlPattern` | string | 子串匹配；用 /re/ 或 /re/i 包起来则按正则 | 否 |
| `method` | string |  | 否 |
| `status` | integer |  | 否 |
| `includeStatic` | boolean |  | 否 |
| `limit` | integer |  | 否 |
| `sinceId` | integer |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `networkRequestDetail`  🔴 dangerous

[OBSERVE] 读取单条请求的 headers 与 body。**dangerous**：响应头里可能有 Authorization / Set-Cookie / token。
main-world 档需先 recorderConfig({bodies:true}) 才会记录 body，且只记 256KB 以内的文本类响应；cdp 档直接可取。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `id` | integer | networkRequests 返回的条目 id | 是 |
| `part` | string | 只取其中一部分；省略则全给 | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `handleDialog`  🔴 dangerous

[OBSERVE] 设定 alert / confirm / prompt 的应答策略，并返回已记录的弹窗。
main-world 档下弹窗是同步的，无法挂起等你决定，所以这里设的是**预先策略**：调用之后发生的弹窗按此处理。cdp 档下弹窗真挂起，本调用会立即应答当前挂起的弹窗。
未调用过本工具时弹窗保持原生行为（passthrough），页面表现与没装扩展一致。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `accept` | boolean | true=确定，false=取消 | 是 |
| `promptText` | string | prompt 弹窗填入的文本 | 否 |
| `scope` | string |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `recorderConfig`  🔴 dangerous

[OBSERVE] 开关页面事件录制。bodies:true 打开请求/响应 body 捕获（默认关，有内存代价）；dialog:true 让弹窗走策略而不是原生行为；clear 清空缓冲。省略的字段保持原样。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `console` | boolean |  | 否 |
| `network` | boolean |  | 否 |
| `bodies` | boolean |  | 否 |
| `dialog` | boolean |  | 否 |
| `clear` | array |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `navigateBack`  🔴 dangerous

[FLOW] 后退一页。已在历史起点时返回 { ok:false, reason }，不抛错。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `navigateForward`  🔴 dangerous

[FLOW] 前进一页。已在历史末尾时返回 { ok:false, reason }，不抛错。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `resize`  🔴 dangerous

[FLOW] 把视口调整到指定尺寸。main-world 档量取 outerWidth-innerWidth 反推浏览器边框后改窗口外框，视口精确但**用户的窗口会真的变大小**；cdp 档用 Emulation 覆盖设备尺寸，不动真实窗口。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `width` | integer |  | 是 |
| `height` | integer |  | 是 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `drag`  🔴 dangerous

[ACT] 把一个元素拖到另一个元素上。同时发 pointer 序列和 HTML5 DragEvent（共用一个 DataTransfer），兼容原生拖放和自定义 pointer 拖放。
返回 { consumed: { pointer, html5 } } 说明目标实际消费了哪一类事件——都为 false 说明这个拖放实现两条路都不吃。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `fromSelector` | string |  | 否 |
| `fromUid` | string | takeSnapshot / findElements 返回的 uid | 否 |
| `toSelector` | string |  | 否 |
| `toUid` | string |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `drop`  🔴 dangerous

[ACT] 模拟从浏览器外部把文件或数据拖放到页面元素上。带 files 时等同上传（dangerous）。
示例：{ selector:'#dropzone', files:[{ name:'a.csv', mimeType:'text/csv', base64:'...' }] }

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `selector` | string |  | 否 |
| `uid` | string |  | 否 |
| `files` | array |  | 否 |
| `data` | object | MIME → 字符串，例如 { 'text/plain':'hi' } | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `findElements`  🔴 dangerous

[READ] 按文本或正则在可交互元素里找目标，返回 uid / role / name / bounds。不需要先 createPageIndex。
拿到 uid 后用 clickByUid / fillByUid 操作最稳。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `text` | string | 大小写不敏感子串 | 否 |
| `regex` | string | 与 text 二选一 | 否 |
| `limit` | integer |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---
