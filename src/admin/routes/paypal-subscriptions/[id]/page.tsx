import { useCallback, useEffect, useState } from "react"
import type { ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import {
  Button,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
  Toaster,
  toast,
} from "@medusajs/ui"
import { sdk } from "../../../lib/sdk"
import type { SubscriptionRow } from "../../../lib/types"
import {
  formatBillingPeriod,
  formatDate,
  formatMoney,
  statusBadgeColor,
} from "../../../lib/format"
import {
  customerLabel,
  fetchCustomerMap,
  fetchVariantMap,
  variantLabel,
  type CustomerInfo,
  type VariantInfo,
} from "../../../lib/enrich"

type Action = "cancel" | "suspend" | "resume"

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-y-0.5">
    <Text size="xsmall" className="text-ui-fg-subtle">
      {label}
    </Text>
    <Text size="small" className="text-ui-fg-base break-words">
      {children}
    </Text>
  </div>
)

const PaypalSubscriptionDetailPage = () => {
  const { id } = useParams()
  const [row, setRow] = useState<SubscriptionRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [customer, setCustomer] = useState<CustomerInfo | undefined>(undefined)
  const [variant, setVariant] = useState<VariantInfo | undefined>(undefined)
  const [pending, setPending] = useState<Action | null>(null)
  const [confirming, setConfirming] = useState<Action | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showCancelModal, setShowCancelModal] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await sdk.client.fetch<{ subscription: SubscriptionRow }>(
        `/admin/paypal/subscriptions/${id}`
      )
      setRow(res.subscription ?? null)

      // Best-effort enrichment; failures degrade to raw ids.
      if (res.subscription?.customer_id) {
        fetchCustomerMap([res.subscription.customer_id]).then((m) =>
          setCustomer(m[res.subscription.customer_id])
        )
      } else {
        setCustomer(undefined)
      }
      if (res.subscription?.variant_id) {
        fetchVariantMap([res.subscription.variant_id]).then((m) =>
          setVariant(m[res.subscription.variant_id])
        )
      } else {
        setVariant(undefined)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const runAction = async (action: Action) => {
    if (!id) return
    setPending(action)
    setActionError(null)
    try {
      await sdk.client.fetch(`/admin/paypal/subscriptions/${id}/actions`, {
        method: "POST",
        body: { action },
      })
      toast.success(
        action === "cancel"
          ? "Subscription cancelled"
          : action === "suspend"
            ? "Subscription suspended"
            : "Subscription resumed"
      )
      setConfirming(null)
      setShowCancelModal(false)
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setActionError(message)
      toast.error("Action failed")
    } finally {
      setPending(null)
    }
  }

  const canSuspend = row?.status === "ACTIVE"
  const canResume = row?.status === "SUSPENDED"
  const canCancel = row?.status === "ACTIVE" || row?.status === "SUSPENDED"
  const busy = pending !== null

  return (
    <div className="flex flex-col gap-y-3">
      <Toaster />

      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
          <div className="flex flex-col gap-y-1">
            <div className="flex items-center gap-3">
              <Heading level="h1">
                {row?.paypal_subscription_id || "PayPal Subscription"}
              </Heading>
              {row && (
                <StatusBadge color={statusBadgeColor(row.status)}>
                  {row.status.replace(/_/g, " ")}
                </StatusBadge>
              )}
            </div>
            <Text size="small" className="text-ui-fg-subtle font-mono">
              {row?.id}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="small" variant="secondary" onClick={load} disabled={busy}>
              Refresh
            </Button>
            {canResume && (
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => runAction("resume")}
              >
                {pending === "resume" ? "Resuming…" : "Resume"}
              </Button>
            )}
            {canSuspend && (
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => runAction("suspend")}
              >
                {pending === "suspend" ? "Suspending…" : "Suspend"}
              </Button>
            )}
            {canCancel && (
              <Button
                size="small"
                variant="danger"
                disabled={busy}
                onClick={() => setShowCancelModal(true)}
              >
                Cancel subscription
              </Button>
            )}
          </div>
        </div>
        {actionError && (
          <div className="px-6 pb-4">
            <Text size="small" className="text-ui-fg-error">
              {actionError}
            </Text>
          </div>
        )}
      </Container>

      {loading && (
        <Container className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            Loading…
          </Text>
        </Container>
      )}

      {!loading && error && (
        <Container className="px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            Failed to load subscription: {error}
          </Text>
        </Container>
      )}

      {!loading && !error && row && (
        <>
          <Container className="px-6 py-4">
            <Heading level="h2" className="mb-4">
              Details
            </Heading>
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
              <Field label="PayPal subscription ID">
                <span className="font-mono">{row.paypal_subscription_id || "—"}</span>
              </Field>
              <Field label="PayPal plan ID">
                <span className="font-mono">{row.paypal_plan_id || "—"}</span>
              </Field>
              <Field label="Customer">
                {customerLabel(customer) ? (
                  <>
                    {customerLabel(customer)}
                    <span className="font-mono text-ui-fg-subtle">
                      {" "}
                      ({row.customer_id})
                    </span>
                  </>
                ) : (
                  <span className="font-mono">{row.customer_id || "—"}</span>
                )}
              </Field>
              <Field label="Variant">
                {variantLabel(variant) ? (
                  <>
                    {variantLabel(variant)}
                    <span className="font-mono text-ui-fg-subtle">
                      {" "}
                      ({row.variant_id})
                    </span>
                  </>
                ) : (
                  <span className="font-mono">{row.variant_id || "—"}</span>
                )}
              </Field>
              <Field label="Locked amount">
                {formatMoney(row.locked_amount, row.currency_code)}{" "}
                <span className="text-ui-fg-subtle">
                  (renews at this price, not the current catalog price)
                </span>
              </Field>
              <Field label="Billing period">
                {formatBillingPeriod(row.interval_unit, row.interval_count)}
              </Field>
              <Field label="Next billing">{formatDate(row.next_billing_at)}</Field>
              <Field label="Last billing">{formatDate(row.last_billing_at)}</Field>
              <Field label="Failed renewal attempts">{row.failure_count}</Field>
              <Field label="Payment session">
                <span className="font-mono">{row.payment_session_id || "—"}</span>
              </Field>
              <Field label="Payment collection">
                <span className="font-mono">{row.payment_collection_id || "—"}</span>
              </Field>
              <Field label="Provider">
                <span className="font-mono">{row.provider_id || "—"}</span>
              </Field>
              <Field label="Created">{formatDate(row.created_at)}</Field>
              <Field label="Last updated">{formatDate(row.updated_at)}</Field>
            </div>
          </Container>

          <Container className="px-6 py-4">
            <Heading level="h2" className="mb-4">
              Sales history
            </Heading>
            {(row.sales ?? []).length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle">
                No sales recorded yet.
              </Text>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Sale</Table.HeaderCell>
                    <Table.HeaderCell>Order</Table.HeaderCell>
                    <Table.HeaderCell>Amount</Table.HeaderCell>
                    <Table.HeaderCell>Billed at</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body className="divide-y divide-ui-border-base">
                  {(row.sales ?? []).map((sale) => (
                    <Table.Row key={sale.sale_id}>
                      <Table.Cell>
                        <span className="font-mono text-ui-fg-subtle">
                          {sale.sale_id}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        {sale.order_id ? (
                          <Link
                            to={`/orders/${sale.order_id}`}
                            className="text-ui-fg-interactive"
                          >
                            {sale.order_id}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {formatMoney(sale.amount, sale.currency_code)}
                      </Table.Cell>
                      <Table.Cell>{formatDate(sale.billed_at)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </Container>

          <Container className="px-6 py-4">
            <Heading level="h2" className="mb-4">
              Refund history
            </Heading>
            {(row.refunds ?? []).length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle">
                No refunds recorded.
              </Text>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Refund</Table.HeaderCell>
                    <Table.HeaderCell>Order</Table.HeaderCell>
                    <Table.HeaderCell>Amount</Table.HeaderCell>
                    <Table.HeaderCell>Refunded at</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body className="divide-y divide-ui-border-base">
                  {(row.refunds ?? []).map((refund) => (
                    <Table.Row key={refund.refund_id}>
                      <Table.Cell>
                        <span className="font-mono text-ui-fg-subtle">
                          {refund.refund_id}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="font-mono text-ui-fg-subtle">
                          {refund.order_id || "—"}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        {formatMoney(refund.amount, refund.currency_code)}
                      </Table.Cell>
                      <Table.Cell>{formatDate(refund.refunded_at)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </Container>
        </>
      )}

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg">
            <Container className="p-6">
              <Heading level="h2" className="mb-2 text-ui-fg-error">
                Cancel this subscription?
              </Heading>
              <div className="flex flex-col gap-y-3">
                <Text size="small" className="text-ui-fg-base">
                  This action is <strong>irreversible</strong>. Cancelling
                  terminates the PayPal billing agreement immediately - it
                  cannot be resumed.
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  The customer keeps access for periods already paid. To pause
                  charging temporarily, use Suspend instead (reversible).
                </Text>
                {row?.paypal_subscription_id && (
                  <Text size="small" className="font-mono text-ui-fg-subtle">
                    {row.paypal_subscription_id}
                  </Text>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setShowCancelModal(false)}
                  >
                    Keep subscription
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy}
                    onClick={() => runAction("cancel")}
                  >
                    {pending === "cancel" ? "Cancelling…" : "Cancel permanently"}
                  </Button>
                </div>
              </div>
            </Container>
          </div>
        </div>
      )}
    </div>
  )
}

export default PaypalSubscriptionDetailPage
