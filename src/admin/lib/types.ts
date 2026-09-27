import type { SubscriptionSaleRecord } from "../../../subscription/types"

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
