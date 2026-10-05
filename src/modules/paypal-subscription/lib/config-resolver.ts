import { MedusaError } from "@medusajs/framework/utils";

/**
 * Pure merge of the PayPal configuration layers. No IO lives here - the module
 * service owns every read/write, so the fallback rules stay testable without a
 * database. The DB layer is the raw `paypal_settings` row (snake_case columns);
 * the two options layers use the camelCase option names.
 */

export type PaypalConfigField =
  | "clientId"
  | "clientSecret"
  | "isSandbox"
  | "webhookId"
  | "subscriptionWebhookId"
  | "includeShippingData"
  | "includeCustomerData"
  | "autoBillOutstanding"
  | "paymentFailureThreshold";

export type PaypalConfigSource =
  | "db"
  | "provider_options"
  | "plugin_options"
  | "none";

export type PaypalResolvedConfig = {
  clientId?: string;
  clientSecret?: string;
  isSandbox: boolean;
  webhookId?: string;
  subscriptionWebhookId?: string;
  includeShippingData: boolean;
  includeCustomerData: boolean;
  autoBillOutstanding?: boolean;
  paymentFailureThreshold?: number;
};

export type PaypalResolvedConfigResult = {
  config: PaypalResolvedConfig;
  sources: Record<PaypalConfigField, PaypalConfigSource>;
};

export const PAYPAL_CONFIG_FIELDS: PaypalConfigField[] = [
  "clientId",
  "clientSecret",
  "isSandbox",
  "webhookId",
  "subscriptionWebhookId",
  "includeShippingData",
  "includeCustomerData",
  "autoBillOutstanding",
  "paymentFailureThreshold",
];

/** Field name -> `paypal_settings` column. The only layer that is snake_case. */
export const PAYPAL_CONFIG_COLUMNS: Record<PaypalConfigField, string> = {
  clientId: "client_id",
  clientSecret: "client_secret",
  isSandbox: "is_sandbox",
  webhookId: "webhook_id",
  subscriptionWebhookId: "subscription_webhook_id",
  includeShippingData: "include_shipping_data",
  includeCustomerData: "include_customer_data",
  autoBillOutstanding: "auto_bill_outstanding",
  paymentFailureThreshold: "payment_failure_threshold",
};

export function isPaypalConfigField(key: string): key is PaypalConfigField {
  return Object.prototype.hasOwnProperty.call(PAYPAL_CONFIG_COLUMNS, key);
}

/** The two PayPal API environments a credential set can belong to. */
export type PaypalEnvironment = "sandbox" | "live";

export function paypalEnvironmentOf(isSandbox: boolean): PaypalEnvironment {
  return isSandbox ? "sandbox" : "live";
}

/**
 * Thrown when a loaded credential set is declared to belong to one PayPal
 * environment but would run against the other (sandbox credentials on the
 * live API or vice versa) - the environment-mismatch class of incident from
 * the 2026-10-02 walkthrough R11: sandbox credentials hitting live turned a
 * vault delete into an idempotent-looking 404 and silently did nothing.
 *
 * Identified by `name` ("PaypalCredentialEnvironmentMismatchError") so hosts
 * and the reorder adapter can catch it by class; the `type` is
 * UNEXPECTED_STATE (a server fault), so an uncaught mismatch surfaces as a
 * 500 instead of a fabricated 400 customer refusal.
 */
export class PaypalCredentialEnvironmentMismatchError extends MedusaError {
  constructor(message: string) {
    super(MedusaError.Types.UNEXPECTED_STATE, message);

    this.name = "PaypalCredentialEnvironmentMismatchError";
  }
}

/**
 * Where a credential-environment declaration is bound to: a config layer
 * (`plugin_options` / `provider_options`) or a self-contained options object
 * (`"self"` - the binder factory and `validateOptions`, whose credential set
 * and environment live on the same object).
 */
export type PaypalCredentialEnvironmentSource =
  | Exclude<PaypalConfigSource, "none">
  | "self";

export type PaypalCredentialEnvironmentMismatch = {
  /** Layer or options object that supplied the active credential set. */
  credentialsSource: PaypalCredentialEnvironmentSource;
  /** Environment the credential set is declared to belong to. */
  declaredEnvironment: PaypalEnvironment;
  /** Layer (or options object) that supplied the winning environment flag. */
  environmentSource: PaypalConfigSource | PaypalCredentialEnvironmentSource;
  /** Environment the resolved configuration would actually run against. */
  resolvedEnvironment: PaypalEnvironment;
};

/**
 * Where the credential-environment declaration is enforced. The merge itself
 * cannot prove a contradiction: a layer that supplies `clientId` also wins
 * `is_sandbox` whenever it declares one (per-field first-wins, same layer
 * order), so a mismatch is only knowable from an explicit declaration riding
 * with the credential set - `credentialEnvironment` on the binder/provider/
 * plugin options. The declaration is meaningful only while its own layer is
 * the one supplying the active credentials; when the database row overrides
 * the credentials, the declaration is inert (the row's own coherence is what
 * the admin settings "verify" action probes against the live API).
 */
export function detectDeclaredCredentialEnvironmentMismatch(input: {
  /** The declared environment of the credential set, if the layer declares one. */
  declaredEnvironment: PaypalEnvironment | undefined;
  /** The config layer (or options object) the declared credential set comes from. */
  declaredLayer: PaypalCredentialEnvironmentSource;
  /** Only `clientId` (which layer supplied the active credentials) and `isSandbox` (which layer won the environment) are read. */
  sources: {
    clientId: PaypalConfigSource | PaypalCredentialEnvironmentSource;
    isSandbox: PaypalConfigSource | PaypalCredentialEnvironmentSource;
  };
  resolvedIsSandbox: boolean;
}): PaypalCredentialEnvironmentMismatch | null {
  const { declaredEnvironment, declaredLayer, sources, resolvedIsSandbox } =
    input;

  if (declaredEnvironment === undefined) {
    return null;
  }

  if (sources.clientId !== declaredLayer) {
    return null;
  }

  const resolvedEnvironment = paypalEnvironmentOf(resolvedIsSandbox);

  if (declaredEnvironment === resolvedEnvironment) {
    return null;
  }

  return {
    credentialsSource: declaredLayer,
    declaredEnvironment,
    environmentSource: sources.isSandbox,
    resolvedEnvironment,
  };
}

/** Refuses a resolved configuration whose credential set contradicts the environment it would run against. */
export function assertNoCredentialEnvironmentMismatch(
  mismatch: PaypalCredentialEnvironmentMismatch | null | undefined,
): void {
  if (!mismatch) {
    return;
  }

  throw new PaypalCredentialEnvironmentMismatchError(
    `PayPal credential environment mismatch: the loaded credential set is declared for the ${mismatch.declaredEnvironment} environment but the resolved configuration runs against ${mismatch.resolvedEnvironment} (is_sandbox from ${mismatch.environmentSource}). Refusing to call PayPal with the wrong environment's credentials; fix is_sandbox or the credential set.`,
  );
}

/**
 * A layer "provides" a field when the value is defined, non-null and not a
 * blank string. Booleans are values in their own right - `false` must win over
 * a lower layer instead of inheriting (only null/undefined/blank inherit).
 */
function provides(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    !(typeof value === "string" && value.trim() === "")
  );
}

/**
 * Per-field first-wins merge over the layers in precedence order
 * `db -> providerOptions -> pluginOptions`. `sources` records the layer that
 * actually provided each field, `"none"` when no layer did; the three schema
 * defaults (isSandbox/includeShippingData/includeCustomerData) are applied
 * after the merge and deliberately do not change the reported source.
 */
export function mergePaypalConfigLayers(input: {
  db?: Record<string, unknown> | null;
  providerOptions?: Record<string, unknown> | null;
  pluginOptions?: Record<string, unknown> | null;
}): PaypalResolvedConfigResult {
  const layers: Array<{
    source: Exclude<PaypalConfigSource, "none">;
    values: Record<string, unknown>;
    snakeCaseKeys: boolean;
  }> = [];

  if (input.db) {
    layers.push({ source: "db", values: input.db, snakeCaseKeys: true });
  }
  if (input.providerOptions) {
    layers.push({
      source: "provider_options",
      values: input.providerOptions,
      snakeCaseKeys: false,
    });
  }
  if (input.pluginOptions) {
    layers.push({
      source: "plugin_options",
      values: input.pluginOptions,
      snakeCaseKeys: false,
    });
  }

  const resolved = {} as Record<PaypalConfigField, unknown>;
  const sources = {} as Record<PaypalConfigField, PaypalConfigSource>;

  for (const field of PAYPAL_CONFIG_FIELDS) {
    let value: unknown;
    let source: PaypalConfigSource = "none";

    for (const layer of layers) {
      const candidate = layer.snakeCaseKeys
        ? layer.values[PAYPAL_CONFIG_COLUMNS[field]]
        : layer.values[field];

      if (provides(candidate)) {
        value = candidate;
        source = layer.source;
        break;
      }
    }

    resolved[field] = value;
    sources[field] = source;
  }

  return {
    config: {
      clientId: resolved.clientId as string | undefined,
      clientSecret: resolved.clientSecret as string | undefined,
      isSandbox: (resolved.isSandbox as boolean | undefined) ?? false,
      webhookId: resolved.webhookId as string | undefined,
      subscriptionWebhookId: resolved.subscriptionWebhookId as string | undefined,
      includeShippingData:
        (resolved.includeShippingData as boolean | undefined) ?? false,
      includeCustomerData:
        (resolved.includeCustomerData as boolean | undefined) ?? false,
      autoBillOutstanding: resolved.autoBillOutstanding as boolean | undefined,
      paymentFailureThreshold: resolved.paymentFailureThreshold as
        | number
        | undefined,
    },
    sources,
  };
}

/**
 * Display/audit form of a secret: null for anything empty, otherwise the
 * masked dots plus the last 4 characters (shorter secrets keep their whole
 * value after the dots - there is nothing to redact out of 4 chars).
 */
export function maskSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }

  const tail = value.length > 4 ? value.slice(-4) : value;

  return `••••${tail}`;
}

/**
 * Runtime guard for every PayPal entry point. With empty credentials the SDK
 * sends `Basic Og==` and PayPal answers 401, which reads as a bad credential
 * instead of a missing configuration. The guard runs on the resolved config
 * (after the layer merge), never once at boot - credentials can be filled in
 * on the admin settings page while the process is running.
 */
export function assertPaypalConfigured(config: PaypalResolvedConfig): void {
  if (!provides(config.clientId) || !provides(config.clientSecret)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "PayPal is not configured. Set clientId and clientSecret on the admin PayPal settings page."
    );
  }
}
