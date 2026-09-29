/**
 * Thin wrapper over the host dashboard's react-i18next instance. The copy
 * itself lives in the single dictionary (`src/admin/i18n/index.ts`), which the
 * dashboard deep-merges into its own resources under the private `paypal`
 * namespace - components resolve it with `useTranslation("paypal")`, and
 * non-component code (route handles, module-level helpers) with `translate()`
 * below.
 *
 * `react-i18next` must resolve to the dashboard's own copy: it is pinned
 * exactly (13.5.0) in package.json because a second, uninitialised copy makes
 * every `t()` return the raw key while core dashboard pages stay translated.
 */
import { getI18n, useTranslation } from "react-i18next"

const NAMESPACE = "paypal"

/** The `t` returned by `usePaypalT`, for helpers that receive it as a param. */
export type PaypalTranslate = ReturnType<typeof usePaypalT>

/** The `t` bound to the `paypal` namespace, for React components. */
export const usePaypalT = () => useTranslation(NAMESPACE).t

/**
 * Reads a translation outside a React component, where hooks are unavailable.
 * Falls back to the key itself if the dashboard i18n instance is not ready yet
 * (route modules evaluate at import time).
 */
export const translate = (
  key: string,
  options?: Record<string, unknown>
): string => {
  const i18n = getI18n()
  if (!i18n) return key
  return i18n.t(key, { ns: NAMESPACE, ...options })
}

/** Localized status label; unknown statuses keep the space-ized raw text. */
export const statusLabel = (status: string | null | undefined): string => {
  if (!status) return "—"
  return translate(`status.${status}`, {
    defaultValue: status.replace(/_/g, " "),
  })
}

/** Localized billing period unit; unknown units keep the raw text. */
export const unitLabel = (unit: string): string =>
  translate(`period.unit.${unit}`, { defaultValue: unit })

/** Intl locale tag following the dashboard language ("en-US" / "zh-CN"). */
export const localeTag = (): string =>
  (getI18n()?.language ?? "").toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en-US"

/**
 * Catch-branch error text: js-sdk's FetchError carries a `status` field - a
 * 401 means the admin session has expired and gets a friendly message
 * instead of the raw "Unauthorized". Components may pass their `t`; without
 * one the module-level `translate` is used.
 */
export const friendlyError = (e: unknown, t?: PaypalTranslate): string => {
  if (typeof e === "object" && e !== null && "status" in e) {
    if ((e as { status?: number }).status === 401) {
      return t ? t("error.session401") : translate("error.session401")
    }
  }
  return e instanceof Error ? e.message : String(e)
}
