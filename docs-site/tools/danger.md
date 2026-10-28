<!-- ⚠ 自动生成 —— 修改源在 packages/shared/src/llm/builtin-tool-defs.ts；跑 `pnpm gen` 重生 -->


# 危险工具

提交表单、发带 cookie 请求、写 storage、执行含敏感 API 的 JS。默认 dangerous，每次弹审。

## `httpRequest`  🟡 caution

[ACT] 通过后台代理发请求。withCredentials=true 时带 cookie（dangerous，要审阅）；默认 omit。

示例：
- 翻评论页：{ url: 'https://x.com/api/comments?page=2', withCredentials: false }
- 带登录态调内部接口：{ url: '...', withCredentials: true }

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `method` | string |  | 否 |
| `url` | string |  | 是 |
| `headers` | object |  | 否 |
| `body` | any | any JSON-able value | 否 |
| `withCredentials` | boolean |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `readStorage`  🔴 dangerous

[DANGER] 读 localStorage 或 sessionStorage 指定 key。需要审阅。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `store` | string |  | 是 |
| `key` | string |  | 是 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `submitForm`  🔴 dangerous

[CONFIRM·DANGER] 提交 &lt;form&gt;。会触发服务端动作（下单、留言等），用户必须审阅。
调用前建议先用 askUser 让用户最终确认。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `selector` | string |  | 是 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `uploadFile`  🔴 dangerous

[CONFIRM·DANGER] 把后端代理拉到的文件填到 &lt;input type=file&gt;。某些站点会拒绝合成 File。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `selector` | string |  | 是 |
| `url` | string |  | 是 |
| `filename` | string |  | 否 |
| `mimeType` | string |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `runJS`  🟡 caution

[LAST RESORT·DANGER] 在 MAIN world 注入并执行 async 函数体（receives `ctx` = bindings）。必须 return 值。
**仅在结构化工具不够用时使用**——会经过静态扫描与人工审阅。严格 CSP 页面需要用户预先在扩展设置中开启 CDP/debugger；读取样式、位置或祖先链请优先使用 inspectElement。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `source` | string | async function body | 是 |
| `timeoutMs` | integer |  | 否 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---

## `writeStorage`  🔴 dangerous

[DANGER] 写 localStorage 或 sessionStorage。改站点状态，需要审阅。

**参数：**

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| `store` | string |  | 是 |
| `key` | string |  | 是 |
| `value` | string | 字符串值；非字符串请自行 JSON.stringify | 是 |
| `tabId` | integer | 目标 tab。要操作主会话 tab 时整个字段不要带（不要 0 / null）；要操作其它 tab 时它必须先在 attachedTabs（用 attachTab 申请） | 否 |

---
