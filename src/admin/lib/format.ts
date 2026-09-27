type BadgeColor = "green" | "red" | "blue" | "orange" | "grey" | "purple"

const STATUS_BADGE_COLORS: Record<string, BadgeColor> = {
  ACTIVE: "green",
  SUSPENDED: "orange",
  CANCELLED: "red",
  EXPIRED: "grey",
  APPROVAL_PENDING: "blue",
}

/** Full local status vocabulary (src/subscription/types.ts) for filters. */
export const SUBSCRIPTION_STATUSES = [
  "APPROVAL_PENDING",
  "ACTIVE",
  "SUSPENDED",
  "CANCELLED",
  "EXPIRED",
] as const

export const statusBadgeColor = (status: string | null | undefined): BadgeColor =>
  (status && STATUS_BADGE_COLORS[status]) || "grey"

/**
 * All amounts in this plugin are major units (e.g. 9.99 = $9.99) - never
 * apply a x/÷100 conversion here. Currency follows the row's currency_code.
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency?: string | null
): string {
  if (amount === null || amount === undefined || amount === "") return "—"
  const n = Number(amount)
  if (Number.isNaN(n)) return String(amount)
  const code = (currency || "USD").toUpperCase()
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(n)
  } catch {
    return `${n} ${code}`
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d)
}

export function formatBillingPeriod(
  unit: string | null | undefined,
  count: number | null | undefined
): string {
  const c = Number(count) || 1
  const u = (unit || "").toLowerCase()
  if (!u) return "—"
  return c === 1 ? `Every ${u}` : `Every ${c} ${u}s`
}
