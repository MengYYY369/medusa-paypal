# medusa-paypal

Medusa v2 PayPal 支付 provider 插件（`@mengyyy369/medusa-paypal`，fork 自 `@alphabite/medusa-paypal`）。核心概念：支付轨道（Orders v2 + Vault v3 payment token）、off-session MIT 续费（计费调度外包给外部引擎 `@mengyyy369/reorder`，本插件只提供扣款能力）、webhook 经 Medusa 标准支付钩子消费。

## Agent skills

### Issue tracker

本地 markdown：spec 位于 `.scratch/<feature-slug>/spec.md`，工单位于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，一票一文件，`Status:` 行记录triage 状态。详见 `docs/agents/issue-tracker.md`。

### Domain docs

Single-context：仓库根 `CONTEXT.md` + `docs/adr/`（懒创建，不存在时静默跳过）。详见 `docs/agents/domain.md`。
