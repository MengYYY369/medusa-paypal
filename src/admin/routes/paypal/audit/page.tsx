import { useCallback, useEffect, useState } from "react"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Table, Text } from "@medusajs/ui"
import { sdk } from "../../../lib/sdk"
import type { PaypalAuditEntry } from "../../../lib/types"
import { formatDate } from "../../../lib/format"
import { friendlyError, translate, usePaypalT } from "../../../lib/i18n"

/**
 * PayPal audit log (`/paypal/audit`): the settings change trail that used to
 * sit collapsed under the configuration form. The endpoint takes only a
 * `limit` (schema-capped at 100 - a larger value is rejected with a 400), so
 * "load more" grows the window over the newest rows instead of paging.
 */
const PAGE_SIZE = 50
const MAX_LIMIT = 100

/**
 * Audit diff values: null means the field was (or becomes) inherited, so it
 * gets the explicit "inherit" label instead of an ambiguous dash. Secrets are
 * already masked by the server.
 */
const formatAuditValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return translate("settings.value.inherit")
  }
  if (typeof value === "boolean") {
    return value
      ? translate("settings.value.on")
      : translate("settings.value.off")
  }
  return String(value)
}

const fieldLabel = (key: string): string => translate(`settings.field.${key}`)

const PaypalAuditPage = () => {
  const t = usePaypalT()
  const [audits, setAudits] = useState<PaypalAuditEntry[]>([])
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (nextLimit: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await sdk.client.fetch<{ audits: PaypalAuditEntry[] }>(
        "/admin/paypal/settings/audit",
        { query: { limit: nextLimit } }
      )
      setAudits(res.audits ?? [])
    } catch (e) {
      setError(friendlyError(e))
      setAudits([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(limit)
  }, [load, limit])

  // The API returns newest first with no offset, so more rows are only
  // reachable by raising the limit; a short page means the end was reached.
  const canLoadMore = audits.length >= limit && limit < MAX_LIMIT

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <Heading level="h1">{t("audit.title")}</Heading>
          <Button
            size="small"
            variant="secondary"
            disabled={loading}
            onClick={() => void load(limit)}
          >
            {t("common.refresh")}
          </Button>
        </div>

        {loading && audits.length === 0 ? (
          <div className="px-6 pb-4">
            <Text size="small" className="text-ui-fg-subtle">
              {t("common.loading")}
            </Text>
          </div>
        ) : null}
        {error ? (
          <div className="px-6 pb-4">
            <Text size="small" className="text-ui-fg-error">
              {t("audit.loadFailed")} {error}
            </Text>
          </div>
        ) : null}
        {!loading && !error && audits.length === 0 ? (
          <div className="px-6 pb-4">
            <Text size="small" className="text-ui-fg-subtle">
              {t("audit.empty")}
            </Text>
          </div>
        ) : null}

        {!error && audits.length > 0 ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("audit.actor")}</Table.HeaderCell>
                <Table.HeaderCell>{t("audit.time")}</Table.HeaderCell>
                <Table.HeaderCell>{t("audit.changes")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body className="divide-y divide-ui-border-base">
              {audits.map((entry) => {
                const changes = Object.entries(entry.changedFields ?? {})
                return (
                  <Table.Row key={entry.id}>
                    <Table.Cell>
                      <span className="font-mono text-ui-fg-subtle">
                        {entry.actorName ?? entry.actorId ?? t("audit.system")}
                      </span>
                    </Table.Cell>
                    <Table.Cell>{formatDate(entry.createdAt)}</Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col gap-y-0.5">
                        {changes.map(([field, diff]) => (
                          <Text key={field} size="xsmall">
                            {fieldLabel(field)}:{" "}
                            <span className="text-ui-fg-subtle">
                              {formatAuditValue(diff?.from)}
                            </span>{" "}
                            → {formatAuditValue(diff?.to)}
                          </Text>
                        ))}
                        {changes.length === 0 ? (
                          <Text size="xsmall" className="text-ui-fg-subtle">
                            —
                          </Text>
                        ) : null}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
        ) : null}

        {canLoadMore ? (
          <div className="px-6 py-4">
            <Button
              size="small"
              variant="secondary"
              disabled={loading}
              onClick={() =>
                setLimit((current) => Math.min(current + PAGE_SIZE, MAX_LIMIT))
              }
            >
              {t("audit.loadMore")}
            </Button>
          </div>
        ) : null}
      </Container>
    </div>
  )
}

export default PaypalAuditPage

// Child of the /paypal menu item, after PayPal Subscriptions; no icon - the
// dashboard renders only the label for nested items.
export const config = defineRouteConfig({
  label: "menuItems.auditLog",
  translationNs: "paypal",
  rank: 2,
})

export const handle = {
  breadcrumb: () => translate("menuItems.auditLog"),
}
