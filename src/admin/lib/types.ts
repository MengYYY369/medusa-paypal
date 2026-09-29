import type { SubscriptionSaleRecord } from "../../subscription/types"

/**
 * Structural mirror of the admin settings API contracts
 * (`src/api/admin/paypal/settings/*`). Duplicated on purpose: the admin bundle
 * must not import server code, and these are the only fields the page reads.
 */
export type PaypalConfigSource =
  | "db"
  | "provider_options"
  | "plugin_options"
  | "none"

export type PaypalSettingsField<T> = {
  value: T | null
  source: PaypalConfigSource
}

export type PaypalSettingsResponse = {
  settings: {
    clientId: PaypalSettingsField<string>
    clientSecret: {
      hasSecret: boolean
      /** Last 4 characters of the effective secret; never the secret itself. */
      secretTail: string | null
      source: PaypalConfigSource
    }
    isSandbox: PaypalSettingsField<boolean>
    webhookId: PaypalSettingsField<string>
    subscriptionWebhookId: PaypalSettingsField<string>
    includeShippingData: PaypalSettingsField<boolean>
    includeCustomerData: PaypalSettingsField<boolean>
    autoBillOutstanding: PaypalSettingsField<boolean>
    paymentFailureThreshold: PaypalSettingsField<number>
  }
  environment: "sandbox" | "production" | "unconfigured"
  version: number
  lastModifiedBy: string | null
  lastModifiedById?: string | null
  lastModifiedAt: string | null
  lastVerifiedAt: string | null
  lastVerifiedOk: boolean | null
  integration: {
    paymentWebhookUrl: string
    subscriptionWebhookUrl: string
    reconcileCron: string
  }
}

export type PaypalAuditEntry = {
  id: string
  actorId: string | null
  /** Server-side display name; falls back to the raw actor id. */
  actorName: string | null
  changedFields: Record<string, { from?: unknown; to?: unknown } | null>
  createdAt: string | null
}

export type PaypalTestResult = {
  ok: boolean
  environment: string
  error?: string
  durationMs: number
}

export type SubscriptionRow = {
  id: string
  paypal_subscription_id: string | null
  paypal_plan_id: string | null
  variant_id: string | null
  customer_id: string | null
  payment_session_id: string | null
  payment_collection_id: string | null
  provider_id: string | null
  status: string
  locked_amount: number
  currency_code: string
  interval_unit: string
  interval_count: number
  next_billing_at: string | null
  last_billing_at: string | null
  failure_count: number
  sales: SubscriptionSaleRecord[] | null
  refunds:
    | {
        refund_id: string
        sale_id: string
        order_id: string | null
        amount: number
        currency_code: string
        refunded_at: string
      }[]
    | null
  created_at?: string
  updated_at?: string
}
