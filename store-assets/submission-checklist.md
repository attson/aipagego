# Chrome Web Store 人工提交清单

本清单记录人工外部状态，不由 CI 自动声称已提交或发布。

## 发布身份

- 版本：提交时填写（必须与 tag 和 ZIP manifest 一致）
- ZIP 文件名：`aipagego-<version>.zip`
- ZIP SHA-256：打包审计生成后填写
- 当前状态：`materials_ready`
- 允许状态：`materials_ready` / `submitted` / `in_review` / `published`

## 材料

- [x] 128×128 商店图标：`store-assets/icon-128.png`
- [x] 扩展图标：16 / 32 / 48 / 128 px
- [x] 1280×800 截图：首次引导、网页任务、固化、危险审批
- [x] 简体中文文案：`store-assets/listing.zh-CN.md`
- [x] 英文文案：`store-assets/listing.en.md`
- [x] 中文隐私政策：https://attson.github.io/aipagego/privacy
- [x] English privacy policy：https://attson.github.io/aipagego/en/privacy
- [x] 权限说明：https://attson.github.io/aipagego/permissions
- [x] Permission explanations：https://attson.github.io/aipagego/en/permissions
- [x] 支持地址：https://github.com/attson/aipagego/issues

## 人工提交记录

- 提交人：未提交
- 提交时间：未提交
- 商店后台证据：未提交
- 公开商店 URL：未发布

只有人工完成对应动作并留下可核验证据后，才能把状态改为 `submitted`、`in_review` 或 `published`。

## 自动审计与 smoke 证据

- 自动审计：`pnpm audit:store -- --report <report-path>`
- 2026-10-23 本地验收包：`aipagego-0.0.11.zip`
- 2026-10-24 本地验收 SHA-256：`abe6fb9d134e71ca1c6c17c1e9d5044be81e55e78ba666ce95e27df098a56ed1`
- 2026-10-27 P4 release candidate（0.0.11）审计包 SHA-256：`7cb1fce6302acf4a9db20a9138c54306014e686a67fe28baa5bc53f26765f09d`；35 个 ZIP 条目，0 errors。
- 2026-10-27 v0.1.2 release candidate 审计包 SHA-256：`4f5c28611a45d080317d6377fed51901c2d5b6b0b7357df8cf91114ca0802fb2`；35 个 ZIP 条目，0 errors。最终 tag artifact 以 CI 上传的审计报告为准。
- 后续 tag 包的实际 SHA-256 以同次构建生成并随 artifact 上传的 `store-audit-report.json` 为准。
- 2026-10-23 验收记录：[`smoke/2026-10-23-p0-smoke.md`](./smoke/2026-10-23-p0-smoke.md)
- 2026-10-27 P4 连接器与安全分享自动化替代证据：[`smoke/2026-10-27-p4-smoke.md`](./smoke/2026-10-27-p4-smoke.md)
- 干净 Chrome profile 的首次成功、原生 side panel、按需权限和危险审批实机 smoke 已完成；外部门禁只剩 Chrome Web Store 账号提交与审核。
