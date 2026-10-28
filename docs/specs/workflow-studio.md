# Workflow Studio 固化工具工作流

## 适用范围

本规范约束 `steps` 工具的参数、变量、可视化编辑、单步测试、版本发布与启用、导入导出，以及持久工具失败后的自主 self-heal。`prompt` 工具继续通过聊天执行，不进入 Workflow Studio。

## Canonical 工具与版本

- `StepsTool` 只持久化 metadata、必填的 `activeVersion` 和不可变 `versions`；每个 `StepsToolVersion` 都包含必填 `parameters`、`steps`、`outputSchema`，可选 `outputBinding`、`basedOnVersion` 和 `note`。禁止重新引入顶层 `steps/outputSchema` 镜像。
- 运行、详情、匹配、统计、diff、导入导出和 self-heal 必须通过 `getActiveStepsVersion(tool)` 读取同一个启用快照；`versions.at(-1)` 不能表示当前版本。
- 发布以当前启用版本为 `basedOnVersion` 做冲突检查，成功后追加 `max(existing version) + 1` 并启用。冲突必须保留草稿并要求用户比较，不能静默覆盖。
- 启用历史版本只更新 `activeVersion` 指针，不修改历史快照，也不复制成新版本。RunRecord 必须记录本次实际执行的版本。
- IDB 名保持 `aipagego`，当前 DB version 为 5。v3 仍是 Workflow Studio 引入 canonical tools 与 collection_results 的迁移；v4 只新增 Jobs，v5 只新增 connector/delivery store，均不重写旧 store。legacy 顶层镜像只在读取时规范化；正常 publish、activate 或统计写入时再 canonical 化，不因读取立即改库。

## 参数、变量与输出

- 参数类型为 string、number、boolean 或 json；支持 required、description、非敏感默认值和 sensitive 标记。未知输入、缺少必填项或类型不匹配必须在页面副作用前失败。
- 参数与前序 Step 的 `bindResultTo` 共享同一变量命名空间。`${binding}` 保留原 JSON 类型，字符串中的内嵌引用转为文本；对象、数组与安全 path 可递归解析。
- 禁止未来引用、重复 binding、无效名称以及 `__proto__`、`prototype`、`constructor` 等危险 path。工作流分析失败时不得执行部分步骤。
- `outputBinding` 存在时返回对应 binding；未指定时保持 legacy 行为，返回最后一步输出。
- sensitive taint 从参数沿引用 Step 和 `bindResultTo` 传播。tainted 输入、输出与错误在 RunRecord 和 self-heal 上下文中使用结构化脱敏值，原值只存在于执行内存，不写入工具、草稿或导出包。

## 编辑、测试与审批

- Workflow Studio 打开时捕获目标 `tabId`；草稿编辑、单步测试、完整测试和发布后的运行不得在异步回调中改读后来切换的当前 tab。
- 草稿支持参数增删、普通 tool/js Step 增删复制与重排、args/timeout/output binding 编辑，以及 output schema 编辑。`collectStructuredData` 的复杂 recipe 交给 Collect Studio，返回后仍只更新草稿。
- 单步测试使用当前草稿参数与已成功步骤产生的临时 bindings；缺少上游 binding 时明确阻断，不暗中执行依赖步骤。测试本身不创建版本。
- 单步与完整草稿测试在实际执行前按解析后的输入重新分类 safe/caution/dangerous，并复用现有权限模式和审批卡。完整测试对依赖上游输出的动态危险字段做保守分类，未经显式批准不能进入 `runs.start`。`runJS` 静态扫描仍只做标签；用户可明确批准，编辑动作本身不执行副作用。
- 草稿保存在 sidepanel 本地状态中；发布成功后清理对应草稿。版本冲突、受限页面、固定 tab 关闭、超限与执行错误都必须保留可恢复上下文。

## Diff、兼容与分享

- 结构化 diff 覆盖参数增删改、Step 增删改与唯一语义 Step 的移动，以及 output binding/schema 变化；重复 Step 无稳定 id 时降级为 remove + add。
- 本地备份导出格式为 `aipagego.tools/v3`，仅包含 canonical 工具快照。默认分享使用 active-only `aipagego.tool-package/v1`。二者都不得包含运行 inputs、临时 bindings、页面结果、connector、Cookie 或 API key，并在输出前扫描 literal secret。
- 导入接受 v2、v3 和 package/v1，但 UI 必须先 `tools.import.preview`，再以相同 bundle digest 调 `tools.import.commit`。v2 做 legacy normalization；v3/package 使用严格 canonical schema。active 缺失/不存在、重复版本、未知 tool、参数或 binding 无效时逐项拒绝，不能猜测修复；旧 `tools.import` 不得直接写库。
- Preview 重新计算所有版本的能力、最高 severity、host、secret、冲突与依赖 Job。dangerous 和动态 prompt 必须明示确认；冲突默认 copy，可逐项 skip/overwrite。Overwrite 改变固定版本 hash 时主动将依赖 Job 标为 `tool_version_changed`。
- 未修改的 preset 副本继续从 v3 backup 过滤；package snapshot 去除 origin 并重置 stats。导入不运行工具，运行时原审批保持不变。

## Self-heal 与安全边界

- 只有本地持久 `steps` 工具可在运行失败后尝试自主 self-heal；draft、Coordinator EXEC/chat 和 `collectStructuredData` 不进入该路径。
- self-heal 上下文使用本次真实 active snapshot，并保留参数、输出定义和未修改步骤。background 只向 sidepanel bridge 发请求，不读取 API key 或 LLM 设置。
- 每次运行最多成功应用一次补丁。补丁必须通过 Step schema、binding 分析和严格 dangerous gate；危险补丁拒绝，修复后再次失败以 `step_still_fails` 结束，不级联调用 LLM。
- dangerous gate 必须使用本次运行的实际 bindings 解析补丁输入；不能因原始 `${binding}` 字符串看似无害而放过解析后带凭据的请求。用户触发的敏感单步 AI 修复也不得额外抓取页面 DOM。
- 成功补丁从失败位置替换后续步骤，追加全局 `max+1` 版本并记录 `basedOnVersion`；RunRecord 更新为新版本，并写入 `healed.fromVersion/toVersion/fixedStepIndex`。

## 验证锚点

- `packages/shared/tests/workflow.test.ts`
- `packages/shared/tests/messages.test.ts`
- `packages/extension/tests/background/storage/tools.test.ts`
- `packages/extension/tests/background/storage/export-import.test.ts`
- `packages/extension/tests/background/tool-share-export.test.ts`
- `packages/extension/tests/background/tool-import-review.test.ts`
- `packages/extension/tests/background/bg-tool-runner-heal.test.ts`
- `packages/extension/tests/background/self-heal.test.ts`
- `packages/extension/tests/sidepanel/self-heal-host.test.ts`
- `packages/extension/tests/sidepanel/workflow-studio/editor-model.test.ts`
- `packages/extension/tests/sidepanel/workflow-studio/draft-storage.test.ts`
- `packages/extension/tests/sidepanel/drawers/workflow-studio-drawer.test.tsx`

## 决策记录

### 2026-10-26 版本快照作为唯一持久真源

`StepsTool` 采用不可变版本快照加单一 `activeVersion` 指针，不保留顶层 workflow 镜像；切换旧版只移动指针，人工发布和 self-heal 才追加全局新版本。该选择以一次 v2→v3 兼容迁移换取执行、编辑、diff 和修复都读取同一真源，避免双写漂移与“启用即复制”造成的虚假版本。

### 2026-10-26 Self-heal 继承实际启用版本并追加全局版本号

自主修复必须以本次实际 active snapshot 为基线，但新版本号始终取全局 `max+1`，并用 `basedOnVersion` 和 RunRecord `healed` 保留谱系。这样允许用户回退旧版后继续修复而不覆盖既有历史，代价是版本号表达追加顺序而非线性父子关系。
