import { sdk } from "./sdk"

export type CustomerInfo = {
  id: string
  email?: string | null
  first_name?: string | null
  last_name?: string | null
}

export type VariantInfo = {
  id: string
  title?: string | null
  product?: { title?: string | null } | null
}

/**
 * Rows only store customer_id / variant_id. Enrichment resolves them in one
 * batched request each; any failure degrades to raw IDs and must never block
 * rendering. Variants go through /admin/product-variants (there is no
 * top-level /admin/variants route) with dot-path fields to pull product title
 * - subscription rows carry no product_id, so products cannot be filtered
 * directly.
 */
export async function fetchCustomerMap(
  ids: string[]
): Promise<Record<string, CustomerInfo>> {
  if (ids.length === 0) return {}
  const map: Record<string, CustomerInfo> = {}
  try {
    const res = await sdk.client.fetch<{ customers: CustomerInfo[] }>(
      "/admin/customers",
      { query: { id: ids, limit: 100 } }
    )
    for (const c of res.customers ?? []) map[c.id] = c
  } catch {
    // fall through - callers show raw ids
  }
  return map
}

export async function fetchVariantMap(
  ids: string[]
): Promise<Record<string, VariantInfo>> {
  if (ids.length === 0) return {}
  const map: Record<string, VariantInfo> = {}
  try {
    const res = await sdk.client.fetch<{ variants: VariantInfo[] }>(
      "/admin/product-variants",
      {
        query: {
          id: ids,
          limit: 100,
          fields: "id,title,product.title",
        },
      }
    )
    for (const v of res.variants ?? []) map[v.id] = v
  } catch {
    // fall through - callers show raw ids
  }
  return map
}

export function customerLabel(info?: CustomerInfo): string | undefined {
  if (!info) return undefined
  const name = [info.first_name, info.last_name].filter(Boolean).join(" ")
  return info.email || name || undefined
}

export function variantLabel(info?: VariantInfo): string | undefined {
  if (!info) return undefined
  const product = info.product?.title
  const variant = info.title
  if (product && variant && product !== variant) return `${product} - ${variant}`
  return product || variant || undefined
}
