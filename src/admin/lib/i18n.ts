/**
 * Lightweight dictionary for the admin extension pages - zero new
 * dependencies. Language resolution is re-evaluated on every call (never
 * cached) so a language switch takes effect immediately, in order:
 *   1. `localStorage["paypal_admin_lang"]` - manual override ("en" | "zh"),
 *      written by the list page toggle;
 *   2. `localStorage["lng"]` - the host dashboard's language detector writes
 *      the admin language there (hyphenless code, Chinese is "zhCN");
 *   3. `navigator.language` starting with "zh".
 * Falls back to English. The sidebar `defineRouteConfig` label and "—"
 * placeholders are deliberately not part of this dictionary.
 */

export type Lang = "en" | "zh"

type DictEntry = { en: string; zh: string }

const LANG_KEY = "paypal_admin_lang"
const HOST_LANG_KEY = "lng"

const DICT: Record<string, DictEntry> = {
  "app.title": { en: "PayPal Subscriptions", zh: "PayPal 订阅" },
  "common.loading": { en: "Loading…", zh: "加载中…" },
  "common.refresh": { en: "Refresh", zh: "刷新" },
  "common.previous": { en: "Previous", zh: "上一页" },
  "common.next": { en: "Next", zh: "下一页" },
  "list.count": { en: "{count} subscription(s)", zh: "{count} 个订阅" },
  "list.filterAll": { en: "All", zh: "全部" },
  "list.empty": { en: "No subscriptions found.", zh: "暂无订阅" },
  "list.resultsRange": {
    en: "{from}–{to} of {total}",
    zh: "第 {from}–{to} 条，共 {total} 条",
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
  "period.every": { en: "Every {unit}", zh: "每 {unit}" },
  "period.everyN": { en: "Every {count} {unit}s", zh: "每 {count} {unit}" },
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

/** Resolve the display language at call time (see the module docblock). */
export const resolveLang = (): Lang => {
  const override = localStorage.getItem(LANG_KEY)
  if (override === "en" || override === "zh") return override
  const host = localStorage.getItem(HOST_LANG_KEY)
  if (host) return host.toLowerCase().startsWith("zh") ? "zh" : "en"
  const nav = typeof navigator !== "undefined" ? navigator.language : ""
  return (nav || "").toLowerCase().startsWith("zh") ? "zh" : "en"
}

/** Persist the manual language override (list page toggle). */
export const setLang = (lang: Lang): void => {
  localStorage.setItem(LANG_KEY, lang)
}

/** Look up a dictionary key with {name} placeholder substitution. */
export const t = (
  key: string,
  vars?: Record<string, string | number>
): string => {
  const entry = DICT[key]
  let text = entry ? entry[resolveLang()] : key
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name])
        : match
    )
  }
  return text
}

/** Localized status label; unknown statuses keep the space-ized raw text. */
export const statusLabel = (status: string | null | undefined): string => {
  if (!status) return "—"
  const key = `status.${status}`
  return DICT[key] ? t(key) : status.replace(/_/g, " ")
}

/** Localized billing period unit; unknown units keep the raw text. */
export const unitLabel = (unit: string): string => {
  const key = `period.unit.${unit}`
  return DICT[key] ? t(key) : unit
}

/** Intl locale tag following the selected language ("en-US" / "zh-CN"). */
export const localeTag = (): string =>
  resolveLang() === "zh" ? "zh-CN" : "en-US"

/**
 * Catch-branch error text: js-sdk's FetchError carries a `status` field - a
 * 401 means the admin session has expired and gets a friendly message
 * instead of the raw "Unauthorized".
 */
export const friendlyError = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "status" in e) {
    if ((e as { status?: number }).status === 401) return t("error.session401")
  }
  return e instanceof Error ? e.message : String(e)
}
