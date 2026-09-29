import { useCallback, useEffect, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  CreditCard,
  ExclamationCircleSolid,
  InformationCircleSolid,
  XCircleSolid,
} from "@medusajs/icons"
import {
  Alert,
  Badge,
  Button,
  Container,
  Copy,
  Heading,
  Input,
  Label,
  Switch,
  Text,
  TooltipProvider,
} from "@medusajs/ui"
import { sdk } from "../../lib/sdk"
import type {
  PaypalConfigSource,
  PaypalSettingsResponse,
  PaypalTestResult,
} from "../../lib/types"
import { formatDate } from "../../lib/format"
import { friendlyError, translate, usePaypalT } from "../../lib/i18n"

/**
 * PayPal configuration page (`/paypal`).
 *
 * The form is a dirty diff over the stored overrides: a key present in `patch`
 * is submitted, an explicit null clears the override so the field inherits
 * from medusa-config again. Fields whose effective source is not `db` render
 * the inherited value as a grey placeholder plus a badge naming the layer -
 * "inherited" and "set to empty" are the same thing in the resolver, so the
 * UI makes the inherited state visually explicit instead of pretending an
 * empty override exists.
 */

type EditableField =
  | "clientId"
  | "clientSecret"
  | "isSandbox"
  | "webhookId"
  | "subscriptionWebhookId"
  | "includeShippingData"
  | "includeCustomerData"
  | "autoBillOutstanding"
  | "paymentFailureThreshold"

type TextField = "clientId" | "webhookId" | "subscriptionWebhookId"
type BoolField =
  | "isSandbox"
  | "includeShippingData"
  | "includeCustomerData"
  | "autoBillOutstanding"

type PatchValue = string | number | boolean | null
type Patch = Partial<Record<EditableField, PatchValue>>
type FieldState = "none" | "set" | "clear"

const EDITABLE_FIELDS: EditableField[] = [
  "clientId",
  "clientSecret",
  "isSandbox",
  "webhookId",
  "subscriptionWebhookId",
  "includeShippingData",
  "includeCustomerData",
  "autoBillOutstanding",
  "paymentFailureThreshold",
]

/** Cosmetic only: db = admin-set, the two config layers stay distinguishable. */
const SOURCE_BADGE_COLORS: Record<
  PaypalConfigSource,
  "purple" | "blue" | "orange" | "grey"
> = {
  db: "purple",
  provider_options: "blue",
  plugin_options: "orange",
  none: "grey",
}

const BANNER_STYLES: Record<
  PaypalSettingsResponse["environment"],
  { className: string; Icon: ComponentType<{ className?: string }> }
> = {
  sandbox: {
    className: "border-ui-tag-orange-border bg-ui-tag-orange-bg text-ui-tag-orange-text",
    Icon: ExclamationCircleSolid,
  },
  production: {
    className: "border-ui-border-base bg-ui-bg-subtle text-ui-fg-base",
    Icon: InformationCircleSolid,
  },
  unconfigured: {
    className: "border-ui-tag-red-border bg-ui-tag-red-bg text-ui-tag-red-text",
    Icon: XCircleSolid,
  },
}

type GenericField = {
  value?: string | number | boolean | null
  source: PaypalConfigSource
}

/** `clientSecret` has no `value`; this reads any field uniformly. */
const fieldOf = (
  settings: PaypalSettingsResponse,
  key: EditableField
): GenericField =>
  (settings.settings as unknown as Record<string, GenericField>)[key] ?? {
    source: "none",
  }

const envLabel = (environment: string): string => {
  const key = `settings.env.${environment}`
  return ["sandbox", "production", "unconfigured"].includes(environment)
    ? translate(key)
    : environment
}

const fieldLabel = (key: string): string => translate(`settings.field.${key}`)

const EnvironmentBanner = ({
  environment,
}: {
  environment: PaypalSettingsResponse["environment"]
}) => {
  const { className, Icon } = BANNER_STYLES[environment]
  return (
    <div className={`flex items-start gap-3 rounded-lg border p-4 ${className}`}>
      <Icon className="mt-0.5 shrink-0" />
      <div className="flex flex-col gap-y-0.5">
        <Text size="small" weight="plus">
          {translate(`settings.banner.${environment}.title`)}
        </Text>
        <Text size="small">
          {translate(`settings.banner.${environment}.body`)}
        </Text>
      </div>
    </div>
  )
}

const InfoItem = ({
  label,
  value,
  copy,
}: {
  label: string
  value: ReactNode
  copy?: string
}) => (
  <div className="flex flex-col gap-y-0.5">
    <Text size="xsmall" className="text-ui-fg-subtle">
      {label}
    </Text>
    <div className="flex items-start gap-1.5">
      <Text size="small" className="break-all">
        {value}
      </Text>
      {copy ? <Copy content={copy} variant="mini" /> : null}
    </div>
  </div>
)

/**
 * One editable field: label + source badge, the control, the inheritance
 * status line and the clear / undo affordance. `state` is what makes
 * "inherited" and "pending clear" unambiguous.
 */
const FieldShell = ({
  label,
  source,
  state,
  hint,
  onClear,
  onUndo,
  children,
}: {
  label: string
  source: PaypalConfigSource
  state: FieldState
  hint?: ReactNode
  onClear: () => void
  onUndo: () => void
  children: ReactNode
}) => (
  <div className="flex flex-col gap-y-1.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Label size="small" weight="plus">
        {label}
      </Label>
      <Badge size="2xsmall" color={SOURCE_BADGE_COLORS[source]}>
        {translate(`settings.sourceShort.${source}`)}
      </Badge>
    </div>
    {children}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text size="xsmall" className="text-ui-fg-subtle">
        {state === "set"
          ? translate("settings.state.pending")
          : state === "clear"
            ? translate("settings.state.willInherit")
            : translate(`settings.source.${source}`)}
      </Text>
      {state !== "none" ? (
        <Button
          type="button"
          size="small"
          variant="transparent"
          className="h-fit px-0"
          onClick={onUndo}
        >
          {translate("settings.action.undo")}
        </Button>
      ) : (
        // Present on every field so "clear = inherit" is discoverable; it is
        // disabled when the field already inherits (a null would be a no-op).
        <Button
          type="button"
          size="small"
          variant="transparent"
          className="h-fit px-0"
          disabled={source !== "db"}
          onClick={onClear}
        >
          {translate("settings.action.clear")}
        </Button>
      )}
    </div>
    {hint ? (
      <Text size="xsmall" className="text-ui-fg-subtle">
        {hint}
      </Text>
    ) : null}
  </div>
)

const PaypalSettingsPage = () => {
  const t = usePaypalT()
  const [settings, setSettings] = useState<PaypalSettingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [patch, setPatch] = useState<Patch>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<PaypalTestResult | null>(null)
  const [envModalOpen, setEnvModalOpen] = useState(false)
  const [activeCount, setActiveCount] = useState<number | null>(null)
  const [activeCountError, setActiveCountError] = useState<string | null>(null)

  const loadSettings = useCallback(async (silent = false) => {
    if (!silent) setLoadError(null)
    try {
      const res = await sdk.client.fetch<PaypalSettingsResponse>(
        "/admin/paypal/settings"
      )
      setSettings(res)
    } catch (e) {
      if (!silent) setLoadError(friendlyError(e))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings(false)
  }, [loadSettings])

  // A new edit invalidates the "saved" confirmation from the previous save.
  useEffect(() => {
    if (Object.keys(patch).length > 0) setSaved(false)
  }, [patch])

  const sourceOf = (key: EditableField): PaypalConfigSource =>
    settings ? fieldOf(settings, key).source : "none"

  const effectiveValue = (key: EditableField): PatchValue =>
    settings ? fieldOf(settings, key).value ?? null : null

  /** The stored override, i.e. what an explicit null would remove. */
  const storedValue = (key: EditableField): PatchValue =>
    sourceOf(key) === "db" ? effectiveValue(key) : null

  const stateOf = (key: EditableField): FieldState =>
    !(key in patch) ? "none" : patch[key] === null ? "clear" : "set"

  const textDraft = (key: TextField): string => {
    const state = stateOf(key)
    if (state === "set") return String(patch[key] ?? "")
    if (state === "clear") return ""
    const stored = storedValue(key)
    return stored === null || stored === undefined ? "" : String(stored)
  }

  const textPlaceholder = (key: TextField): string => {
    if (stateOf(key) !== "none" || sourceOf(key) === "db") return ""
    const effective = effectiveValue(key)
    return effective === null || effective === ""
      ? t("settings.value.unset")
      : String(effective)
  }

  const numberDraft = (): string => {
    const state = stateOf("paymentFailureThreshold")
    if (state === "set") return String(patch.paymentFailureThreshold ?? "")
    if (state === "clear") return ""
    const stored = storedValue("paymentFailureThreshold")
    return stored === null || stored === undefined ? "" : String(stored)
  }

  const numberPlaceholder = (): string => {
    if (
      stateOf("paymentFailureThreshold") !== "none" ||
      sourceOf("paymentFailureThreshold") === "db"
    ) {
      return ""
    }
    const effective = effectiveValue("paymentFailureThreshold")
    return effective === null || effective === undefined
      ? t("settings.value.unset")
      : String(effective)
  }

  const boolChecked = (key: BoolField): boolean =>
    stateOf(key) === "set" ? Boolean(patch[key]) : Boolean(effectiveValue(key))

  const onTextChange = (key: TextField, raw: string) => {
    const next = raw.trim() === "" ? null : raw
    setPatch((prev) => {
      const copy = { ...prev }
      if (next === storedValue(key)) delete copy[key]
      else copy[key] = next
      return copy
    })
  }

  // Blank means "keep the stored secret" (US18): only the explicit clear
  // button can send a null for this field.
  const onSecretChange = (raw: string) => {
    setPatch((prev) => {
      const copy = { ...prev }
      if (raw === "") delete copy.clientSecret
      else copy.clientSecret = raw
      return copy
    })
  }

  const onNumberChange = (raw: string) => {
    const trimmed = raw.trim()
    const parsed = trimmed === "" ? null : Number(trimmed)
    if (parsed !== null && !Number.isFinite(parsed)) return
    const next = parsed === null ? null : Math.trunc(parsed)
    setPatch((prev) => {
      const copy = { ...prev }
      if (next === storedValue("paymentFailureThreshold")) {
        delete copy.paymentFailureThreshold
      } else {
        copy.paymentFailureThreshold = next
      }
      return copy
    })
  }

  const onBoolChange = (key: BoolField, checked: boolean) => {
    setPatch((prev) => {
      const copy = { ...prev }
      if (checked === storedValue(key)) delete copy[key]
      else copy[key] = checked
      return copy
    })
  }

  const clearField = (key: EditableField) =>
    setPatch((prev) => ({ ...prev, [key]: null }))

  const undoField = (key: EditableField) =>
    setPatch((prev) => {
      const copy = { ...prev }
      delete copy[key]
      return copy
    })

  const dirtyCount = Object.keys(patch).length

  const loadActiveCount = async () => {
    setActiveCount(null)
    setActiveCountError(null)
    try {
      const res = await sdk.client.fetch<{ count: number }>(
        "/admin/paypal/subscriptions",
        { query: { status: "ACTIVE", limit: 1 } }
      )
      setActiveCount(res.count ?? 0)
    } catch (e) {
      setActiveCountError(friendlyError(e))
    }
  }

  /**
   * Draft test body: only fields actually edited in this session are sent.
   * A cleared field is omitted so the server falls back to the effective
   * value, and an untouched clientSecret is omitted so the stored secret is
   * used (the page never sees it).
   */
  const buildDraftTestBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {}
    if (stateOf("clientId") === "set") body.clientId = patch.clientId
    if (stateOf("clientSecret") === "set") body.clientSecret = patch.clientSecret
    if (stateOf("isSandbox") === "set") body.isSandbox = patch.isSandbox
    return body
  }

  const runConnectionTest = async (draft: boolean) => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await sdk.client.fetch<PaypalTestResult>(
        "/admin/paypal/settings/verify",
        { method: "POST", body: draft ? buildDraftTestBody() : {} }
      )
      setTestResult(res)
    } catch (e) {
      setTestResult({
        ok: false,
        environment: settings?.environment ?? "unconfigured",
        error: friendlyError(e),
        durationMs: 0,
      })
    } finally {
      setTesting(false)
    }
    if (!draft) void loadSettings(true)
  }

  const performSave = async () => {
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    setTestResult(null)
    setEnvModalOpen(false)
    try {
      await sdk.client.fetch("/admin/paypal/settings", {
        method: "PATCH",
        body: { ...patch },
      })
      setPatch({})
      setSaved(true)
      void loadSettings(true)
      // Fire-and-forget: the automatic test must not block (nor roll back)
      // the save result the admin is looking at.
      void runConnectionTest(false)
    } catch (e) {
      setSaveError(friendlyError(e))
    } finally {
      setSaving(false)
    }
  }

  const onSaveClick = () => {
    if (dirtyCount === 0 || saving) return
    if ("isSandbox" in patch) {
      setEnvModalOpen(true)
      void loadActiveCount()
      return
    }
    void performSave()
  }

  const targetEnvironment: PaypalSettingsResponse["environment"] =
    patch.isSandbox === true ? "sandbox" : "production"

  const secretTail = settings?.settings.clientSecret.secretTail
  const hasSecret = settings?.settings.clientSecret.hasSecret ?? false

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-y-3">
        {settings ? (
          <EnvironmentBanner environment={settings.environment} />
        ) : null}

        <Container className="px-6 py-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <Heading level="h1">{t("settings.title")}</Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {t("settings.subtitle")}
              </Text>
            </div>
            <Button
              size="small"
              variant="secondary"
              disabled={loading}
              onClick={() => void loadSettings(false)}
            >
              {t("common.refresh")}
            </Button>
          </div>

          {loading && !settings ? (
            <Text size="small" className="text-ui-fg-subtle">
              {t("common.loading")}
            </Text>
          ) : null}
          {loadError ? (
            <Text size="small" className="text-ui-fg-error">
              {t("settings.loadFailed")} {loadError}
            </Text>
          ) : null}

          {settings ? (
            <>
              <Heading level="h2" className="mb-3">
                {t("settings.integration.heading")}
              </Heading>
              <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
                <InfoItem
                  label={t("settings.integration.environment")}
                  value={envLabel(settings.environment)}
                />
                <InfoItem
                  label={t("settings.integration.version")}
                  value={`v${settings.version}`}
                />
                <InfoItem
                  label={t("settings.integration.secretTail")}
                  value={
                    hasSecret ? (
                      <span className="font-mono">••••{secretTail}</span>
                    ) : (
                      t("settings.value.unset")
                    )
                  }
                />
                <InfoItem
                  label={t("settings.integration.lastModified")}
                  value={
                    settings.lastModifiedAt
                      ? `${formatDate(settings.lastModifiedAt)}${
                          settings.lastModifiedBy
                            ? ` · ${settings.lastModifiedBy}`
                            : ""
                        }`
                      : t("settings.integration.never")
                  }
                />
                <InfoItem
                  label={t("settings.integration.lastVerified")}
                  value={
                    settings.lastVerifiedAt
                      ? `${formatDate(settings.lastVerifiedAt)} · ${
                          settings.lastVerifiedOk
                            ? t("settings.integration.verifiedOk")
                            : t("settings.integration.verifiedFailed")
                        }`
                      : t("settings.integration.never")
                  }
                />
                <InfoItem
                  label={t("settings.integration.reconcileCron")}
                  value={
                    <span className="font-mono">
                      {settings.integration.reconcileCron}
                    </span>
                  }
                />
                <InfoItem
                  label={t("settings.integration.paymentWebhook")}
                  value={
                    <span className="font-mono">
                      {settings.integration.paymentWebhookUrl}
                    </span>
                  }
                  copy={settings.integration.paymentWebhookUrl}
                />
                <InfoItem
                  label={t("settings.integration.subscriptionWebhook")}
                  value={
                    <span className="font-mono">
                      {settings.integration.subscriptionWebhookUrl}
                    </span>
                  }
                  copy={settings.integration.subscriptionWebhookUrl}
                />
              </div>

              <Heading level="h3" className="mb-2 mt-5">
                {t("settings.integration.sources")}
              </Heading>
              <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
                {EDITABLE_FIELDS.map((key) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-2"
                  >
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      {fieldLabel(key)}
                    </Text>
                    <Text size="xsmall">
                      {t(`settings.source.${sourceOf(key)}`)}
                    </Text>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </Container>

        {settings ? (
          <>
            <Container className="px-6 py-4">
              <Heading level="h2" className="mb-1">
                {t("settings.group.credentials")}
              </Heading>
              <Text size="small" className="mb-4 text-ui-fg-subtle">
                {t("settings.group.credentialsHint")}
              </Text>
              <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
                <FieldShell
                  label={t("settings.field.clientId")}
                  source={sourceOf("clientId")}
                  state={stateOf("clientId")}
                  hint={
                    stateOf("clientId") !== "none"
                      ? t("settings.hint.storefront")
                      : undefined
                  }
                  onClear={() => clearField("clientId")}
                  onUndo={() => undoField("clientId")}
                >
                  <Input
                    size="small"
                    value={textDraft("clientId")}
                    placeholder={textPlaceholder("clientId")}
                    onChange={(e) => onTextChange("clientId", e.target.value)}
                  />
                </FieldShell>
                <FieldShell
                  label={t("settings.field.clientSecret")}
                  source={sourceOf("clientSecret")}
                  state={stateOf("clientSecret")}
                  hint={t("settings.hint.clientSecret")}
                  onClear={() => clearField("clientSecret")}
                  onUndo={() => undoField("clientSecret")}
                >
                  <Input
                    size="small"
                    type="password"
                    autoComplete="new-password"
                    value={
                      stateOf("clientSecret") === "set"
                        ? String(patch.clientSecret ?? "")
                        : ""
                    }
                    placeholder={
                      hasSecret ? `••••${secretTail}` : t("settings.value.unset")
                    }
                    onChange={(e) => onSecretChange(e.target.value)}
                  />
                </FieldShell>
              </div>
            </Container>

            <Container className="px-6 py-4">
              <Heading level="h2" className="mb-1">
                {t("settings.group.environment")}
              </Heading>
              <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
                <FieldShell
                  label={t("settings.field.isSandbox")}
                  source={sourceOf("isSandbox")}
                  state={stateOf("isSandbox")}
                  hint={
                    stateOf("isSandbox") !== "none"
                      ? t("settings.hint.storefront")
                      : undefined
                  }
                  onClear={() => clearField("isSandbox")}
                  onUndo={() => undoField("isSandbox")}
                >
                  <div className="flex items-center gap-2">
                    <Switch
                      size="small"
                      checked={boolChecked("isSandbox")}
                      onCheckedChange={(checked) =>
                        onBoolChange("isSandbox", checked)
                      }
                    />
                    <Text size="small" className="text-ui-fg-subtle">
                      {boolChecked("isSandbox")
                        ? t("settings.value.on")
                        : t("settings.value.off")}
                    </Text>
                  </div>
                </FieldShell>
              </div>
              <Text size="xsmall" className="mt-3 text-ui-fg-subtle">
                {t("settings.hint.isSandbox")}
              </Text>
            </Container>

            <Container className="px-6 py-4">
              <Heading level="h2" className="mb-1">
                {t("settings.group.webhooks")}
              </Heading>
              <Text size="small" className="mb-4 text-ui-fg-subtle">
                {t("settings.group.webhooksHint")}
              </Text>
              <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
                <FieldShell
                  label={t("settings.field.webhookId")}
                  source={sourceOf("webhookId")}
                  state={stateOf("webhookId")}
                  onClear={() => clearField("webhookId")}
                  onUndo={() => undoField("webhookId")}
                >
                  <Input
                    size="small"
                    value={textDraft("webhookId")}
                    placeholder={textPlaceholder("webhookId")}
                    onChange={(e) => onTextChange("webhookId", e.target.value)}
                  />
                </FieldShell>
                <FieldShell
                  label={t("settings.field.subscriptionWebhookId")}
                  source={sourceOf("subscriptionWebhookId")}
                  state={stateOf("subscriptionWebhookId")}
                  onClear={() => clearField("subscriptionWebhookId")}
                  onUndo={() => undoField("subscriptionWebhookId")}
                >
                  <Input
                    size="small"
                    value={textDraft("subscriptionWebhookId")}
                    placeholder={textPlaceholder("subscriptionWebhookId")}
                    onChange={(e) =>
                      onTextChange("subscriptionWebhookId", e.target.value)
                    }
                  />
                </FieldShell>
              </div>
            </Container>

            <Container className="px-6 py-4">
              <Heading level="h2" className="mb-4">
                {t("settings.group.advanced")}
              </Heading>
              <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
                {(
                  [
                    "includeShippingData",
                    "includeCustomerData",
                    "autoBillOutstanding",
                  ] as const
                ).map((key) => (
                  <FieldShell
                    key={key}
                    label={fieldLabel(key)}
                    source={sourceOf(key)}
                    state={stateOf(key)}
                    hint={
                      key === "autoBillOutstanding"
                        ? t("settings.hint.autoBillOutstanding")
                        : undefined
                    }
                    onClear={() => clearField(key)}
                    onUndo={() => undoField(key)}
                  >
                    <div className="flex items-center gap-2">
                      <Switch
                        size="small"
                        checked={boolChecked(key)}
                        onCheckedChange={(checked) =>
                          onBoolChange(key, checked)
                        }
                      />
                      <Text size="small" className="text-ui-fg-subtle">
                        {boolChecked(key)
                          ? t("settings.value.on")
                          : t("settings.value.off")}
                      </Text>
                    </div>
                  </FieldShell>
                ))}
                <FieldShell
                  label={t("settings.field.paymentFailureThreshold")}
                  source={sourceOf("paymentFailureThreshold")}
                  state={stateOf("paymentFailureThreshold")}
                  hint={t("settings.hint.paymentFailureThreshold")}
                  onClear={() => clearField("paymentFailureThreshold")}
                  onUndo={() => undoField("paymentFailureThreshold")}
                >
                  <Input
                    size="small"
                    type="number"
                    min={1}
                    step={1}
                    value={numberDraft()}
                    placeholder={numberPlaceholder()}
                    onChange={(e) => onNumberChange(e.target.value)}
                  />
                </FieldShell>
              </div>
            </Container>

            <Container className="px-6 py-4">
              <div className="flex flex-col gap-y-3">
                {saveError ? (
                  <Alert variant="error">
                    {t("settings.save.failed")} {saveError}
                  </Alert>
                ) : null}
                {saved && !saveError ? (
                  <Alert variant="success">{t("settings.save.success")}</Alert>
                ) : null}
                {testResult ? (
                  <Alert variant={testResult.ok ? "success" : "error"}>
                    {testResult.ok
                      ? t("settings.test.success", {
                          environment: envLabel(testResult.environment),
                          ms: testResult.durationMs,
                        })
                      : t("settings.test.failed", {
                          environment: envLabel(testResult.environment),
                          error: testResult.error ?? "",
                        })}
                  </Alert>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Text size="small" className="text-ui-fg-subtle">
                    {dirtyCount > 0
                      ? t("settings.save.dirtyCount", { count: dirtyCount })
                      : t("settings.save.clean")}
                  </Text>
                  <div className="flex gap-2">
                    {dirtyCount > 0 ? (
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={saving || testing}
                        onClick={() => setPatch({})}
                      >
                        {t("settings.action.discard")}
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={saving || testing}
                      onClick={() => void runConnectionTest(true)}
                    >
                      {testing
                        ? t("settings.action.testing")
                        : t("settings.action.test")}
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={dirtyCount === 0 || saving || testing}
                      onClick={onSaveClick}
                    >
                      {saving
                        ? t("settings.action.saving")
                        : t("settings.action.save")}
                    </Button>
                  </div>
                </div>
              </div>
            </Container>
          </>
        ) : null}

        {envModalOpen && settings ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-lg">
              <Container className="p-6">
                <Heading level="h2" className="mb-2">
                  {t("settings.envModal.heading")}
                </Heading>
                <div className="flex flex-col gap-y-3">
                  <Text size="small">
                    {t("settings.envModal.body", {
                      from: envLabel(settings.environment),
                      to: envLabel(targetEnvironment),
                    })}
                  </Text>
                  <ul className="flex list-disc flex-col gap-y-1 pl-5">
                    <li>
                      <Text size="small" className="text-ui-fg-subtle">
                        {activeCountError
                          ? t("settings.envModal.activeCountFailed", {
                              error: activeCountError,
                            })
                          : activeCount === null
                            ? t("settings.envModal.activeCountLoading")
                            : t("settings.envModal.activeCount", {
                                count: activeCount,
                              })}
                      </Text>
                    </li>
                    <li>
                      <Text size="small" className="text-ui-fg-subtle">
                        {t("settings.envModal.plans")}
                      </Text>
                    </li>
                    <li>
                      <Text size="small" className="text-ui-fg-subtle">
                        {t("settings.envModal.webhook")}
                      </Text>
                    </li>
                  </ul>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={saving}
                      onClick={() => setEnvModalOpen(false)}
                    >
                      {t("settings.envModal.cancel")}
                    </Button>
                    <Button
                      size="small"
                      variant="danger"
                      disabled={saving}
                      onClick={() => void performSave()}
                    >
                      {saving
                        ? t("settings.action.saving")
                        : t("settings.envModal.confirm")}
                    </Button>
                  </div>
                </div>
              </Container>
            </div>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  )
}

export default PaypalSettingsPage

export const config = defineRouteConfig({
  label: "menuItems.paypal",
  translationNs: "paypal",
  icon: CreditCard,
})
