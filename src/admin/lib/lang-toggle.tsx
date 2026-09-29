import { Badge } from "@medusajs/ui"
import type { Lang } from "./i18n"

/**
 * EN / 中文 toggle shared by the admin pages. Purely presentational: the
 * parent owns the state because `t()` resolves the language on every render.
 * The choice is persisted by the caller through `setLang` (localStorage).
 */
export const LanguageToggle = ({
  lang,
  onSwitch,
}: {
  lang: Lang
  onSwitch: (lang: Lang) => void
}) => (
  <div className="flex items-center gap-1">
    <button
      type="button"
      aria-pressed={lang === "en"}
      onClick={() => onSwitch("en")}
      className="focus:outline-none"
    >
      <Badge size="2xsmall" color={lang === "en" ? "purple" : "grey"}>
        EN
      </Badge>
    </button>
    <button
      type="button"
      aria-pressed={lang === "zh"}
      onClick={() => onSwitch("zh")}
      className="focus:outline-none"
    >
      <Badge size="2xsmall" color={lang === "zh" ? "purple" : "grey"}>
        中文
      </Badge>
    </button>
  </div>
)
