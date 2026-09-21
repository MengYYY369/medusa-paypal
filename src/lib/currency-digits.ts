import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

const FALLBACK_DIGITS = 2
const cache = new Map<string, number>()

type QueryGraphLike = {
  graph: (args: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
  }) => Promise<{ data?: Array<Record<string, unknown>> }>
}

/**
 * PayPal amounts are decimal strings using the currency's own fraction digits
 * (usd -> "9.99", jpy -> "100"). Medusa hands us major units already, so the
 * digits are the only thing the currency module is needed for; the answer is
 * cached per process because it never changes at runtime.
 */
export async function getPaypalFractionDigits(
  query: unknown,
  currencyCode: string,
  logger?: { warn?: (msg: string) => void }
): Promise<number> {
  const code = (currencyCode || "").toLowerCase()

  if (!code) {
    return FALLBACK_DIGITS
  }

  const cached = cache.get(code)
  if (cached !== undefined) {
    return cached
  }

  let digits = FALLBACK_DIGITS

  if (typeof (query as QueryGraphLike)?.graph === "function") {
    const { data } = await (query as QueryGraphLike).graph({
      entity: "currency",
      fields: ["code", "decimal_digits"],
      filters: { code },
    })

    const row = (data ?? []).find(
      (currency) => String(currency?.code ?? "").toLowerCase() === code
    )
    const configured = Number(row?.decimal_digits)

    if (Number.isFinite(configured) && configured >= 0) {
      digits = configured
    } else {
      logger?.warn?.(
        `[medusa-paypal] currency "${code}" has no decimal_digits; formatting amounts with ${FALLBACK_DIGITS} decimals`
      )
    }
  }

  cache.set(code, digits)

  return digits
}

export function resolveQueryFromCradle(cradle: unknown): unknown {
  try {
    return (cradle as Record<string, unknown>)?.[ContainerRegistrationKeys.QUERY]
  } catch {
    // The awilix cradle proxy throws for unregistered keys.
    return undefined
  }
}

export function resetPaypalFractionDigitsCache(): void {
  cache.clear()
}
