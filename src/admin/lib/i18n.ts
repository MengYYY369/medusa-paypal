/**
 * Language resolution and error text for the admin extension pages - the copy
 * itself lives in the single dictionary (`src/admin/i18n/index.ts`), which the
 * host dashboard also consumes through the `virtual:medusa/i18n` convention.
 * Zero new dependencies. Language resolution is re-evaluated on every call
 * (never cached) so a language switch takes effect immediately, in order:
 *   1. `localStorage["paypal_admin_lang"]` - manual override ("en" | "zh"),
 *      written by the list page toggle;
 *   2. `localStorage["lng"]` - the host dashboard's language detector writes
 *      the admin language there (hyphenless code, Chinese is "zhCN");
 *   3. `navigator.language` starting with "zh".
 * Falls back to English. "—" placeholders are deliberately not part of the
 * dictionary.
 */
import { DICT, type Lang } from "../i18n"

export type { Lang }

const LANG_KEY = "paypal_admin_lang"
const HOST_LANG_KEY = "lng"

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
