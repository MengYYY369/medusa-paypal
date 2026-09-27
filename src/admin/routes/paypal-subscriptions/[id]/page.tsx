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
import { friendlyError, statusLabel, t } from "../../../lib/i18n"

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
      setError(friendlyError(e))
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
          ? t("toast.cancelled")
          : action === "suspend"
            ? t("toast.suspended")
            : t("toast.resumed")
      )
      setConfirming(null)
      setShowCancelModal(false)
      await load()
    } catch (e) {
      const message = friendlyError(e)
      setActionError(message)
      toast.error(t("toast.actionFailed"))
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
                {row?.paypal_subscription_id || t("detail.fallbackTitle")}
              </Heading>
              {row && (
                <StatusBadge color={statusBadgeColor(row.status)}>
                  {statusLabel(row.status)}
                </StatusBadge>
              )}
            </div>
            <Text size="small" className="text-ui-fg-subtle font-mono">
              {row?.id}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="small" variant="secondary" onClick={load} disabled={busy}>
              {t("common.refresh")}
            </Button>
            {canResume && (
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => runAction("resume")}
              >
                {pending === "resume" ? t("action.resuming") : t("action.resume")}
              </Button>
            )}
            {canSuspend && (
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => runAction("suspend")}
              >
                {pending === "suspend"
                  ? t("action.suspending")
                  : t("action.suspend")}
              </Button>
            )}
            {canCancel && (
              <Button
                size="small"
                variant="danger"
                disabled={busy}
                onClick={() => setShowCancelModal(true)}
              >
                {t("action.cancelSubscription")}
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
            {t("common.loading")}
          </Text>
        </Container>
      )}

      {!loading && error && (
        <Container className="px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            {t("detail.loadFailed")} {error}
          </Text>
        </Container>
      )}

      {!loading && !error && row && (
        <>
          <Container className="px-6 py-4">
            <Heading level="h2" className="mb-4">
              {t("detail.detailsHeading")}
            </Heading>
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
              <Field label={t("field.paypalSubscriptionId")}>
                <span className="font-mono">{row.paypal_subscription_id || "—"}</span>
              </Field>
              <Field label={t("field.paypalPlanId")}>
                <span className="font-mono">{row.paypal_plan_id || "—"}</span>
              </Field>
              <Field label={t("field.customer")}>
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
              <Field label={t("field.variant")}>
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
              <Field label={t("field.lockedAmount")}>
                {formatMoney(row.locked_amount, row.currency_code)}{" "}
                <span className="text-ui-fg-subtle">
                  {t("field.lockedAmountNote")}
                </span>
              </Field>
              <Field label={t("field.billingPeriod")}>
                {formatBillingPeriod(row.interval_unit, row.interval_count)}
              </Field>
              <Field label={t("field.nextBilling")}>
                {formatDate(row.next_billing_at)}
              </Field>
              <Field label={t("field.lastBilling")}>
                {formatDate(row.last_billing_at)}
              </Field>
              <Field label={t("field.failedRenewalAttempts")}>
                {row.failure_count}
              </Field>
              <Field label={t("field.paymentSession")}>
                <span className="font-mono">{row.payment_session_id || "—"}</span>
              </Field>
              <Field label={t("field.paymentCollection")}>
                <span className="font-mono">
                  {row.payment_collection_id || "—"}
                </span>
              </Field>
              <Field label={t("field.provider")}>
                <span className="font-mono">{row.provider_id || "—"}</span>
              </Field>
              <Field label={t("field.created")}>{formatDate(row.created_at)}</Field>
              <Field label={t("field.lastUpdated")}>
                {formatDate(row.updated_at)}
              </Field>
            </div>
          </Container>

          <Container className="px-6 py-4">
            <Heading level="h2" className="mb-4">
              {t("sales.heading")}
            </Heading>
            {(row.sales ?? []).length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle">
                {t("sales.empty")}
              </Text>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t("col.sale")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("col.order")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("col.amount")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("col.billedAt")}</Table.HeaderCell>
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
              {t("refunds.heading")}
            </Heading>
            {(row.refunds ?? []).length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle">
                {t("refunds.empty")}
              </Text>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t("col.refund")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("col.order")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("col.amount")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("col.refundedAt")}</Table.HeaderCell>
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
                {t("modal.heading")}
              </Heading>
              <div className="flex flex-col gap-y-3">
                <Text size="small" className="text-ui-fg-base">
                  {t("modal.irrevPrefix")}
                  <strong>{t("modal.irrevBold")}</strong>
                  {t("modal.irrevSuffix")}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  {t("modal.paidPeriods")}
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
                    {t("modal.keep")}
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy}
                    onClick={() => runAction("cancel")}
                  >
                    {pending === "cancel" ? t("modal.cancelling") : t("modal.confirm")}
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
