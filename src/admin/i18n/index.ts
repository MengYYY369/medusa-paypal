/**
 * Single source of truth for every admin string in this plugin.
 *
 * Two consumers read this file:
 *   1. the Medusa admin bundler, which crawls `<admin>/i18n/index.*` and
 *      inlines the default export as the `virtual:medusa/i18n` resource - the
 *      dashboard deep-merges it over its own catalogs under the private
 *      `paypal` namespace, resolves any `defineRouteConfig` label carrying a
 *      `translationNs` hint with `t(label, { ns })`, and initialises its
 *      i18next singleton with the languages found here (`en`, `zhCN`);
 *   2. the extension pages, which read that same namespace through the
 *      dashboard's react-i18next instance (`useTranslation("paypal")` in
 *      components, `getI18n()` elsewhere - see `lib/i18n.ts`).
 * The host resource is derived from `DICT` rather than written twice, so the
 * sidebar labels and the page copy cannot drift.
 *
 * Keys follow the host convention `<domain>.<area>`, `menuItems.*` is
 * reserved for sidebar labels, and the English `menuItems.subscriptions` value
 * is a byte-for-byte copy of the label that shipped before i18n.
 *
 * Interpolation uses i18next's `{{name}}` syntax. `count` is a reserved
 * i18next option (it triggers plural-form lookup), so the subscription list
 * count passes `total` instead.
 */

export type Lang = "en" | "zh"

export type DictEntry = { en: string; zh: string }

export const DICT: Record<string, DictEntry> = {
  "menuItems.paypal": { en: "PayPal", zh: "PayPal" },
  "menuItems.subscriptions": { en: "PayPal Subscriptions", zh: "PayPal 订阅" },
  "menuItems.auditLog": { en: "Audit log", zh: "审计日志" },
  // Settings page: environment banner, read-only integration info, the four
  // form groups and the save/test status bars.
  "settings.title": { en: "PayPal", zh: "PayPal" },
  "settings.subtitle": { en: "Configuration", zh: "配置" },
  "settings.loadFailed": { en: "Failed to load settings:", zh: "配置加载失败：" },
  "settings.banner.sandbox.title": {
    en: "Sandbox environment",
    zh: "Sandbox 环境",
  },
  "settings.banner.sandbox.body": {
    en: "PayPal sandbox credentials are in use - payments are simulated.",
    zh: "当前使用 PayPal sandbox 凭据，支付为模拟交易。",
  },
  "settings.banner.production.title": {
    en: "Production environment",
    zh: "生产环境",
  },
  "settings.banner.production.body": {
    en: "Live PayPal payments are active.",
    zh: "PayPal 正式支付已启用。",
  },
  "settings.banner.unconfigured.title": {
    en: "PayPal is not configured",
    zh: "PayPal 尚未配置",
  },
  "settings.banner.unconfigured.body": {
    en: "Set clientId and clientSecret below to enable PayPal.",
    zh: "请在下方填写 clientId 与 clientSecret 以启用 PayPal。",
  },
  "settings.env.sandbox": { en: "Sandbox", zh: "Sandbox" },
  "settings.env.production": { en: "Production", zh: "生产环境" },
  "settings.env.unconfigured": { en: "Unconfigured", zh: "未配置" },
  "settings.integration.heading": { en: "Integration", zh: "集成信息" },
  "settings.integration.environment": { en: "Environment", zh: "当前环境" },
  "settings.integration.version": { en: "Config version", zh: "配置版本" },
  "settings.integration.secretTail": { en: "Client secret", zh: "客户端密钥" },
  "settings.integration.lastModified": { en: "Last modified", zh: "最近修改" },
  "settings.integration.lastVerified": { en: "Last verified", zh: "最近验证" },
  "settings.integration.never": { en: "Never", zh: "从未" },
  "settings.integration.verifiedOk": { en: "succeeded", zh: "成功" },
  "settings.integration.verifiedFailed": { en: "failed", zh: "失败" },
  "settings.integration.reconcileCron": {
    en: "Reconciliation cron",
    zh: "对账 cron",
  },
  "settings.integration.paymentWebhook": {
    en: "Payment webhook URL",
    zh: "支付 webhook 地址",
  },
  "settings.integration.subscriptionWebhook": {
    en: "Subscription webhook URL",
    zh: "订阅 webhook 地址",
  },
  "settings.integration.sources": { en: "Field sources", zh: "字段来源" },
  "settings.group.credentials": { en: "Credentials", zh: "凭据" },
  "settings.group.credentialsHint": {
    en: "Used for every PayPal API call.",
    zh: "用于所有 PayPal API 调用。",
  },
  "settings.group.environment": { en: "Environment", zh: "环境" },
  "settings.group.webhooks": { en: "Webhooks", zh: "Webhook" },
  "settings.group.webhooksHint": {
    en: "Webhook IDs used to verify incoming PayPal notifications.",
    zh: "用于验签 PayPal 回调的 Webhook ID。",
  },
  "settings.group.advanced": { en: "Advanced", zh: "高级" },
  "settings.field.clientId": { en: "Client ID", zh: "Client ID" },
  "settings.field.clientSecret": { en: "Client secret", zh: "客户端密钥" },
  "settings.field.isSandbox": { en: "Sandbox mode", zh: "Sandbox 模式" },
  "settings.field.webhookId": { en: "Webhook ID", zh: "Webhook ID" },
  "settings.field.subscriptionWebhookId": {
    en: "Subscription webhook ID",
    zh: "订阅 Webhook ID",
  },
  "settings.field.includeShippingData": {
    en: "Include shipping data",
    zh: "包含收货信息",
  },
  "settings.field.includeCustomerData": {
    en: "Include customer data",
    zh: "包含客户信息",
  },
  "settings.field.autoBillOutstanding": {
    en: "Auto-bill outstanding",
    zh: "自动补扣欠款",
  },
  "settings.field.paymentFailureThreshold": {
    en: "Payment failure threshold",
    zh: "支付失败阈值",
  },
  "settings.hint.clientSecret": {
    en: "Leave blank to keep the current secret.",
    zh: "留空表示不修改当前密钥。",
  },
  "settings.hint.isSandbox": {
    en: "Switching environments requires re-registering the webhook in PayPal.",
    zh: "切换环境后需在 PayPal 后台重新注册 webhook。",
  },
  "settings.hint.storefront": {
    en: "The storefront PayPal button follows the runtime configuration - no storefront rebuild needed.",
    zh: "收银台 PayPal 按钮跟随运行时配置，无需重新构建 storefront。",
  },
  "settings.hint.autoBillOutstanding": {
    en: "PayPal collects any outstanding balance on the next billing cycle.",
    zh: "PayPal 会在下个扣款周期自动补扣未结清金额。",
  },
  "settings.hint.paymentFailureThreshold": {
    en: "Consecutive failed payments before PayPal suspends the subscription (default 3).",
    zh: "连续扣款失败达到该次数后 PayPal 暂停订阅（默认 3）。",
  },
  "settings.source.db": { en: "Set in admin", zh: "后台设置" },
  "settings.source.provider_options": {
    en: "Inherited from medusa-config (payment provider options)",
    zh: "继承自 medusa-config（支付 provider options）",
  },
  "settings.source.plugin_options": {
    en: "Inherited from medusa-config (plugin options)",
    zh: "继承自 medusa-config（插件 options）",
  },
  "settings.source.none": {
    en: "Not set in medusa-config",
    zh: "medusa-config 中未设置",
  },
  "settings.sourceShort.db": { en: "admin", zh: "后台" },
  "settings.sourceShort.provider_options": {
    en: "provider options",
    zh: "provider options",
  },
  "settings.sourceShort.plugin_options": {
    en: "plugin options",
    zh: "插件 options",
  },
  "settings.sourceShort.none": { en: "not set", zh: "未设置" },
  "settings.state.pending": {
    en: "Pending change - save to apply",
    zh: "待保存的修改",
  },
  "settings.state.willInherit": {
    en: "Will inherit after save",
    zh: "保存后恢复继承",
  },
  "settings.value.inherit": { en: "inherit", zh: "继承" },
  "settings.value.unset": { en: "Not set", zh: "未设置" },
  "settings.value.on": { en: "On", zh: "开" },
  "settings.value.off": { en: "Off", zh: "关" },
  "settings.action.clear": { en: "Clear (inherit)", zh: "清除（恢复继承）" },
  "settings.action.undo": { en: "Undo", zh: "撤销" },
  "settings.action.save": { en: "Save", zh: "保存" },
  "settings.action.saving": { en: "Saving…", zh: "保存中…" },
  "settings.action.test": { en: "Test connection", zh: "测试连接" },
  "settings.action.testing": { en: "Testing…", zh: "测试中…" },
  "settings.action.discard": { en: "Discard changes", zh: "放弃修改" },
  "settings.save.dirtyCount": {
    en: "{{count}} unsaved change(s)",
    zh: "{{count}} 项未保存",
  },
  "settings.save.clean": { en: "No unsaved changes", zh: "没有未保存的修改" },
  "settings.save.success": {
    en: "Saved - takes effect immediately, no restart needed.",
    zh: "已保存并立即生效，无需重启。",
  },
  "settings.save.failed": { en: "Save failed:", zh: "保存失败：" },
  "settings.test.success": {
    en: "Connection test succeeded ({{environment}}, {{ms}} ms)",
    zh: "连接测试成功（{{environment}}，{{ms}} 毫秒）",
  },
  "settings.test.failed": {
    en: "Connection test failed ({{environment}}): {{error}}",
    zh: "连接测试失败（{{environment}}）：{{error}}",
  },
  "settings.envModal.heading": {
    en: "Switch PayPal environment?",
    zh: "确定切换 PayPal 环境？",
  },
  "settings.envModal.body": {
    en: "Switching from {{from}} to {{to}}. The following will be affected:",
    zh: "即将从 {{from}} 切换到 {{to}}，以下内容会受影响：",
  },
  "settings.envModal.activeCount": {
    en: "{{count}} active subscription(s) in the current environment keep renewing against the old environment.",
    zh: "当前环境有 {{count}} 个生效中的订阅，仍将在旧环境续费。",
  },
  "settings.envModal.activeCountLoading": {
    en: "Counting active subscriptions…",
    zh: "正在统计生效中的订阅…",
  },
  "settings.envModal.activeCountFailed": {
    en: "Could not load the active subscription count: {{error}}",
    zh: "无法获取生效中的订阅数量：{{error}}",
  },
  "settings.envModal.plans": {
    en: "Plan rows minted in the old environment will not be reused - new plans are minted for the new environment.",
    zh: "旧环境铸造的 plan 行不再复用——新环境会重新铸造 plan。",
  },
  "settings.envModal.webhook": {
    en: "Re-register the webhook in the PayPal dashboard: the webhook ID is environment-specific.",
    zh: "请在 PayPal 后台重新注册 webhook：webhook ID 与环境绑定。",
  },
  "settings.envModal.cancel": { en: "Cancel", zh: "取消" },
  "settings.envModal.confirm": { en: "Switch & save", zh: "切换并保存" },
  // Audit log sub-page (`/paypal/audit`): the settings change trail, moved out
  // of the configuration page. The change-history-to-audit-log rename is the
  // one sanctioned change to the frozen English baseline.
  "audit.title": { en: "Audit log", zh: "审计日志" },
  "audit.empty": { en: "No changes recorded yet.", zh: "暂无变更记录" },
  "audit.loadFailed": {
    en: "Failed to load audit log:",
    zh: "审计日志加载失败：",
  },
  "audit.actor": { en: "Actor", zh: "操作人" },
  "audit.time": { en: "Time", zh: "时间" },
  "audit.changes": { en: "Changes", zh: "变更内容" },
  "audit.system": { en: "System", zh: "系统" },
  "audit.loadMore": { en: "Load more", zh: "加载更多" },
  "app.title": { en: "PayPal Subscriptions", zh: "PayPal 订阅" },
  "common.loading": { en: "Loading…", zh: "加载中…" },
  "common.refresh": { en: "Refresh", zh: "刷新" },
  "common.previous": { en: "Previous", zh: "上一页" },
  "common.next": { en: "Next", zh: "下一页" },
  "list.count": { en: "{{total}} subscription(s)", zh: "{{total}} 个订阅" },
  "list.filterAll": { en: "All", zh: "全部" },
  "list.empty": { en: "No subscriptions found.", zh: "暂无订阅" },
  "list.resultsRange": {
    en: "{{from}}–{{to}} of {{total}}",
    zh: "第 {{from}}–{{to}} 条，共 {{total}} 条",
  },
  "list.zeroResults": { en: "0 results", zh: "0 条结果" },
  "list.loadFailed": {
    en: "Failed to load subscriptions:",
    zh: "订阅加载失败：",
  },
  "col.subscription": { en: "Subscription", zh: "订阅" },
  "col.status": { en: "Status", zh: "状态" },
  "col.customer": { en: "Customer", zh: "客户" },
  "col.variant": { en: "Variant", zh: "商品规格" },
  "col.lockedAmount": { en: "Locked amount", zh: "锁定金额" },
  "col.billingPeriod": { en: "Billing period", zh: "扣款周期" },
  "col.nextBilling": { en: "Next billing", zh: "下次扣款" },
  "col.failures": { en: "Failures", zh: "失败次数" },
  "col.sale": { en: "Sale", zh: "扣款单" },
  "col.refund": { en: "Refund", zh: "退款单" },
  "col.order": { en: "Order", zh: "订单" },
  "col.amount": { en: "Amount", zh: "金额" },
  "col.billedAt": { en: "Billed at", zh: "扣款时间" },
  "col.refundedAt": { en: "Refunded at", zh: "退款时间" },
  "period.every": { en: "Every {{unit}}", zh: "每 {{unit}}" },
  "period.everyN": { en: "Every {{count}} {{unit}}s", zh: "每 {{count}} {{unit}}" },
  "period.unit.day": { en: "day", zh: "天" },
  "period.unit.week": { en: "week", zh: "周" },
  "period.unit.month": { en: "month", zh: "月" },
  "period.unit.year": { en: "year", zh: "年" },
  "status.APPROVAL_PENDING": { en: "APPROVAL PENDING", zh: "待批准" },
  "status.ACTIVE": { en: "ACTIVE", zh: "生效中" },
  "status.SUSPENDED": { en: "SUSPENDED", zh: "已暂停" },
  "status.CANCELLED": { en: "CANCELLED", zh: "已取消" },
  "status.EXPIRED": { en: "EXPIRED", zh: "已过期" },
  "detail.fallbackTitle": { en: "PayPal Subscription", zh: "PayPal 订阅" },
  "detail.detailsHeading": { en: "Details", zh: "详细信息" },
  "detail.loadFailed": {
    en: "Failed to load subscription:",
    zh: "订阅加载失败：",
  },
  "field.paypalSubscriptionId": {
    en: "PayPal subscription ID",
    zh: "PayPal 订阅 ID",
  },
  "field.paypalPlanId": { en: "PayPal plan ID", zh: "PayPal 计划 ID" },
  "field.customer": { en: "Customer", zh: "客户" },
  "field.variant": { en: "Variant", zh: "商品规格" },
  "field.lockedAmount": { en: "Locked amount", zh: "锁定金额" },
  "field.lockedAmountNote": {
    en: "(renews at this price, not the current catalog price)",
    zh: "（续费按此金额扣款，不随当前商品价格变化）",
  },
  "field.billingPeriod": { en: "Billing period", zh: "扣款周期" },
  "field.nextBilling": { en: "Next billing", zh: "下次扣款" },
  "field.lastBilling": { en: "Last billing", zh: "上次扣款" },
  "field.failedRenewalAttempts": {
    en: "Failed renewal attempts",
    zh: "续费失败次数",
  },
  "field.paymentSession": { en: "Payment session", zh: "支付会话" },
  "field.paymentCollection": { en: "Payment collection", zh: "支付集合" },
  "field.provider": { en: "Provider", zh: "支付提供方" },
  "field.created": { en: "Created", zh: "创建时间" },
  "field.lastUpdated": { en: "Last updated", zh: "更新时间" },
  "sales.heading": { en: "Sales history", zh: "扣款记录" },
  "sales.empty": { en: "No sales recorded yet.", zh: "暂无扣款记录" },
  "refunds.heading": { en: "Refund history", zh: "退款记录" },
  "refunds.empty": { en: "No refunds recorded.", zh: "暂无退款记录" },
  "action.resume": { en: "Resume", zh: "恢复扣款" },
  "action.resuming": { en: "Resuming…", zh: "恢复中…" },
  "action.suspend": { en: "Suspend", zh: "暂停扣款" },
  "action.suspending": { en: "Suspending…", zh: "暂停中…" },
  "action.cancelSubscription": { en: "Cancel subscription", zh: "取消订阅" },
  "modal.heading": { en: "Cancel this subscription?", zh: "确定取消该订阅？" },
  "modal.irrevPrefix": { en: "This action is ", zh: "此操作" },
  "modal.irrevBold": { en: "irreversible", zh: "不可逆" },
  "modal.irrevSuffix": {
    en: ". Cancelling terminates the PayPal billing agreement immediately - it cannot be resumed.",
    zh: "。取消将立即终止 PayPal 扣款协议，且无法恢复。",
  },
  "modal.paidPeriods": {
    en: "The customer keeps access for periods already paid. To pause charging temporarily, use Suspend instead (reversible).",
    zh: "客户已付周期内的权益保留至期末。如需临时停止扣款，请使用\"暂停\"（可逆）。",
  },
  "modal.keep": { en: "Keep subscription", zh: "保留订阅" },
  "modal.confirm": { en: "Cancel permanently", zh: "永久取消" },
  "modal.cancelling": { en: "Cancelling…", zh: "取消中…" },
  "toast.cancelled": { en: "Subscription cancelled", zh: "订阅已取消" },
  "toast.suspended": { en: "Subscription suspended", zh: "订阅已暂停" },
  "toast.resumed": { en: "Subscription resumed", zh: "订阅已恢复" },
  "toast.actionFailed": { en: "Action failed", zh: "操作失败" },
  "error.session401": {
    en: "Your session has expired. Please sign in again.",
    zh: "登录状态已过期，请重新登录后台。",
  },
}

/**
 * Nest dotted keys into the resource shape the host consumes. The dashboard
 * resolves labels with i18next's default `.` separator, so
 * `menuItems.subscriptions` must arrive as `paypal.menuItems.subscriptions`.
 * `zh` maps to the host locale code `zhCN` at the export below.
 */
const nest = (lang: Lang): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(DICT)) {
    const parts = key.split(".")
    let node = out
    for (const part of parts.slice(0, -1)) {
      const child = node[part]
      if (child && typeof child === "object") {
        node = child as Record<string, unknown>
      } else {
        const created: Record<string, unknown> = {}
        node[part] = created
        node = created
      }
    }
    node[parts[parts.length - 1]] = entry[lang]
  }
  return out
}

export default {
  en: { paypal: nest("en") },
  zhCN: { paypal: nest("zh") },
}
