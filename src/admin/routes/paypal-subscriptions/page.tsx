import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CreditCard } from "@medusajs/icons"
import {
  Badge,
  Button,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
} from "@medusajs/ui"
import { sdk } from "../../lib/sdk"
import type { SubscriptionRow } from "../../lib/types"
import {
  SUBSCRIPTION_STATUSES,
  formatBillingPeriod,
  formatDate,
  formatMoney,
  statusBadgeColor,
} from "../../lib/format"
import {
  customerLabel,
  fetchCustomerMap,
  fetchVariantMap,
  variantLabel,
  type CustomerInfo,
  type VariantInfo,
} from "../../lib/enrich"

const PAGE_SIZE = 20

const FILTERS = ["ALL", ...SUBSCRIPTION_STATUSES] as const

const SubscriptionListPage = () => {
  const [rows, setRows] = useState<SubscriptionRow[]>([])
  const [count, setCount] = useState(0)
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState<string>("ALL")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [customers, setCustomers] = useState<Record<string, CustomerInfo>>({})
  const [variants, setVariants] = useState<Record<string, VariantInfo>>({})

  const load = useCallback(
    async (opts: { status: string; offset: number }) => {
      setLoading(true)
      setError(null)
      try {
        const query: Record<string, unknown> = {
          limit: PAGE_SIZE,
          offset: opts.offset,
        }
        if (opts.status !== "ALL") query.status = opts.status
        const res = await sdk.client.fetch<{
          subscriptions: SubscriptionRow[]
          count: number
        }>("/admin/paypal/subscriptions", { query })

        setRows(res.subscriptions ?? [])
        setCount(res.count ?? 0)

        // Enrichment is best-effort: failures degrade to raw ids.
        const customerIds = [
          ...new Set(
            (res.subscriptions ?? [])
              .map((s) => s.customer_id)
              .filter((v): v is string => Boolean(v))
          ),
        ]
        const variantIds = [
          ...new Set(
            (res.subscriptions ?? [])
              .map((s) => s.variant_id)
              .filter((v): v is string => Boolean(v))
          ),
        ]
        const [customerMap, variantMap] = await Promise.all([
          fetchCustomerMap(customerIds),
          fetchVariantMap(variantIds),
        ])
        setCustomers(customerMap)
        setVariants(variantMap)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setRows([])
        setCount(0)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    load({ status, offset })
  }, [load, status, offset])

  const changeFilter = (next: string) => {
    if (next === status) return
    setStatus(next)
    setOffset(0)
  }

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h1">PayPal Subscriptions</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {loading ? "Loading…" : `${count} subscription${count === 1 ? "" : "s"}`}
            </Text>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-6 pb-4">
          {FILTERS.map((f) => {
            const active = status === f
            return (
              <button
                key={f}
                type="button"
                aria-pressed={active}
                onClick={() => changeFilter(f)}
                className="focus:outline-none"
              >
                <Badge size="2xsmall" color={active ? "purple" : "grey"}>
                  {f === "ALL" ? "All" : f.replace(/_/g, " ")}
                </Badge>
              </button>
            )
          })}
        </div>
      </Container>

      <Container className="p-0">
        {error ? (
          <div className="px-6 py-4">
            <Text size="small" className="text-ui-fg-error">
              Failed to load subscriptions: {error}
            </Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Subscription</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell>Customer</Table.HeaderCell>
                <Table.HeaderCell>Variant</Table.HeaderCell>
                <Table.HeaderCell>Locked amount</Table.HeaderCell>
                <Table.HeaderCell>Billing period</Table.HeaderCell>
                <Table.HeaderCell>Next billing</Table.HeaderCell>
                <Table.HeaderCell>Failures</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body className="divide-y divide-ui-border-base">
              {rows.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <Link
                      to={`/paypal-subscriptions/${row.id}`}
                      className="text-ui-fg-base font-medium hover:text-ui-fg-interactive"
                    >
                      {row.paypal_subscription_id || row.id}
                    </Link>
                    <Text size="xsmall" className="text-ui-fg-subtle font-mono">
                      {row.id}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={statusBadgeColor(row.status)}>
                      {row.status.replace(/_/g, " ")}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>
                    {customerLabel(customers[row.customer_id ?? ""]) ?? (
                      <span className="font-mono text-ui-fg-subtle">
                        {row.customer_id || "—"}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {variantLabel(variants[row.variant_id ?? ""]) ?? (
                      <span className="font-mono text-ui-fg-subtle">
                        {row.variant_id || "—"}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {formatMoney(row.locked_amount, row.currency_code)}
                  </Table.Cell>
                  <Table.Cell>
                    {formatBillingPeriod(row.interval_unit, row.interval_count)}
                  </Table.Cell>
                  <Table.Cell>{formatDate(row.next_billing_at)}</Table.Cell>
                  <Table.Cell>{row.failure_count}</Table.Cell>
                </Table.Row>
              ))}
              {!loading && rows.length === 0 && (
                <Table.Row>
                  <Table.Cell colSpan={8}>
                    <Text size="small" className="text-ui-fg-subtle">
                      No subscriptions found.
                    </Text>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        )}
      </Container>

      <div className="flex items-center justify-between px-6">
        <Text size="small" className="text-ui-fg-subtle">
          {count === 0
            ? "0 results"
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, count)} of ${count}`}
        </Text>
        <div className="flex gap-2">
          <Button
            size="small"
            variant="secondary"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={offset + PAGE_SIZE >= count || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

export default SubscriptionListPage

export const config = defineRouteConfig({
  label: "PayPal Subscriptions",
  icon: CreditCard,
})
