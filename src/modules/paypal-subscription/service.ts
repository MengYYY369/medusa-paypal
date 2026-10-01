import {
  Logger,
  FindConfig,
} from "@medusajs/framework/types";
import { MedusaError, MedusaService } from "@medusajs/framework/utils";
import PaypalPlan from "./models/paypal-plan";
import PaypalSubscription from "./models/paypal-subscription";
import PaypalSettings from "./models/paypal-settings";
import PaypalSettingsAudit from "./models/paypal-settings-audit";
import {
  assertPaypalConfigured,
  isPaypalConfigField,
  maskSecret,
  mergePaypalConfigLayers,
  PAYPAL_CONFIG_COLUMNS,
  PAYPAL_CONFIG_FIELDS,
  PaypalConfigField,
  PaypalConfigSource,
  PaypalResolvedConfig,
} from "./lib/config-resolver";
import { PaypalService } from "../../providers/paypal/paypal-core/paypal-core";
import * as vault from "../../vault";
import {
  SubscriptionEngine,
  SubscriptionEngineModules,
  SubscriptionEngineOptions,
} from "../../subscription/engine";

/** Fixed primary key of the singleton settings row. */
const SETTINGS_SINGLETON_ID = "ppset_singleton";

/**
 * Ops escape hatch: when truthy the resolver behaves as if no settings row
 * exists, so a bad admin configuration can be rolled back by restarting the
 * container with this env set instead of reaching for the database.
 */
const IGNORE_DB_SETTINGS_ENV = "PAYPAL_IGNORE_DB_SETTINGS";
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function isIgnoreDbSettingsEnabled(): boolean {
  const raw = process.env[IGNORE_DB_SETTINGS_ENV];

  return (
    typeof raw === "string" && TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase())
  );
}

function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True only for "the settings table is not there yet", i.e. the plugin's
 * migration has not run on this host: PostgreSQL's `undefined_table` (42P01),
 * which MikroORM surfaces as `TableNotFoundException`, or its raw message.
 * Anything else (connection lost, permissions, ...) is a different problem and
 * must not be dressed up as a migration hint.
 */
function isMissingSettingsTableError(error: unknown): boolean {
  let current: unknown = error;

  // Walk a short `cause` chain: the driver error may arrive wrapped.
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };

    if (
      candidate.name === "TableNotFoundException" ||
      candidate.code === "42P01" ||
      /relation "paypal_settings" does not exist/i.test(
        errorMessage(candidate.message)
      )
    ) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

type InjectedDependencies = {
  logger: Logger;
  [key: string]: unknown;
};

export type PaypalSubscriptionModuleOptions = SubscriptionEngineOptions & {
  clientId?: string;
  clientSecret?: string;
  isSandbox?: boolean;
  webhookId?: string;
  subscriptionWebhookId?: string;
};

/**
 * Data-access home for the plugin's two tables plus the orchestration surface
 * routes and the reconciliation job use. The service receives the plugin
 * options (clientId/secret) so it can construct its own PayPal client - the
 * plugin's module is auto-registered and always resolvable, unlike the
 * payment provider which lives inside the payment module's container.
 */
export default class PaypalSubscriptionModuleService extends MedusaService({
  PaypalPlan,
  PaypalSubscription,
  PaypalSettings,
  PaypalSettingsAudit,
}) {
  protected logger: Logger;
  /** Plugin options captured at bootstrap; the last layer of the fallback chain. */
  protected pluginOptions: PaypalSubscriptionModuleOptions;
  private eventBus?: unknown;
  private settingsReadFailureWarned = false;
  private engineCache?: { key: string; engine: SubscriptionEngine };

  constructor(container: InjectedDependencies, options: PaypalSubscriptionModuleOptions = {}) {
    super(...arguments);

    this.logger = (container.logger ?? console) as Logger;
    this.pluginOptions = options;
    this.eventBus = container["event_bus"];
  }

  /**
   * Builds the subscription engine against the currently resolved config.
   * Rebuilt whenever the settings version or the resolved values change:
   * autoBillOutstanding / paymentFailureThreshold and the credentials are
   * baked into the engine at construction, so a cached engine would silently
   * ignore admin edits. Reads no `providerOptions` - the module's legacy
   * layer is `plugins[].options`, exactly as before.
   */
  private async resolveEngine(): Promise<SubscriptionEngine> {
    const { config, version } = await this.getResolvedPaypalConfig();
    const key = `${version}:${JSON.stringify(config)}`;

    if (this.engineCache?.key === key) {
      return this.engineCache.engine;
    }

    assertPaypalConfigured(config);

    const engine = new SubscriptionEngine({
      client: new PaypalService(config),
      logger: this.logger,
      eventBus: this.eventBus as any,
      subscriptionModule: this as any,
      options: {
        autoBillOutstanding: config.autoBillOutstanding,
        paymentFailureThreshold: config.paymentFailureThreshold,
      },
    });

    this.engineCache = { key, engine };

    return engine;
  }

  /** Merges caller-resolved collaborators into the engine for one call. */
  private async withModules(modules: SubscriptionEngineModules = {}): Promise<SubscriptionEngine> {
    return (await this.resolveEngine()).for(modules);
  }

  // -- Settings (admin-managed overrides) ----------------------------------

  /**
   * Reads the singleton settings row. Degrades instead of throwing: a missing
   * table (migrations not run) or an unavailable DB must not take payments
   * down - consumers fall back to the config layers, exactly as if no admin
   * override existed. The kill switch skips the read entirely.
   */
  private async readSettingsRow(): Promise<Record<string, any> | null> {
    if (isIgnoreDbSettingsEnabled()) {
      return null;
    }

    try {
      const rows = await (this as any).listPaypalSettings({
        id: SETTINGS_SINGLETON_ID,
      });

      return rows?.[0] ?? null;
    } catch (error) {
      if (!this.settingsReadFailureWarned) {
        this.settingsReadFailureWarned = true;
        this.logger.warn(
          `Could not read PayPal settings from the database; falling back to medusa-config values. ` +
            `If the plugin was just upgraded, run "npx medusa db:migrate". Cause: ${errorMessage(error)}`
        );
      }

      return null;
    }
  }

  /**
   * Reads the singleton row for a write. The write path must not degrade: a
   * missing table is translated into an actionable error naming the table and
   * the migration to run, so the admin page shows a readable message instead
   * of the framework's generic "An unknown error occurred." Every other
   * failure propagates unchanged.
   */
  private async readSettingsRowForWrite(): Promise<Record<string, any> | null> {
    try {
      const rows = await (this as any).listPaypalSettings({
        id: SETTINGS_SINGLETON_ID,
      });

      return rows?.[0] ?? null;
    } catch (error) {
      if (isMissingSettingsTableError(error)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          'The "paypal_settings" table does not exist, so PayPal settings cannot be saved. ' +
            'The plugin\'s migrations have not been run on this host - run "npx medusa db:migrate" and retry.'
        );
      }

      throw error;
    }
  }

  /**
   * The single configuration source for every consumer: per-field merge of
   * `db -> provider options -> plugin options`, plus the row version that
   * callers use to decide whether their cached client/engine is still valid.
   * Never throws.
   */
  async getResolvedPaypalConfig(
    layers: { providerOptions?: Record<string, unknown> | null } = {}
  ): Promise<{
    config: PaypalResolvedConfig;
    version: number;
    sources: Record<PaypalConfigField, PaypalConfigSource>;
    meta: {
      lastModifiedBy: string | null;
      lastModifiedAt: string | null;
      lastVerifiedAt: string | null;
      lastVerifiedOk: boolean | null;
    };
  }> {
    const row = await this.readSettingsRow();

    const { config, sources } = mergePaypalConfigLayers({
      db: row,
      providerOptions: layers.providerOptions,
      pluginOptions: this.pluginOptions as Record<string, unknown>,
    });

    return {
      config,
      version: row?.version ?? 0,
      sources,
      meta: {
        lastModifiedBy: row?.last_modified_by ?? null,
        lastModifiedAt: toIsoString(row?.last_modified_at),
        lastVerifiedAt: toIsoString(row?.last_verified_at),
        lastVerifiedOk: row?.last_verified_ok ?? null,
      },
    };
  }

  /**
   * Patch-style write of the singleton row: only the keys present in `values`
   * are touched, explicit null clears a column back to "inherit". Unlike the
   * read path this never degrades - the admin page must see why a save failed.
   * Secrets are masked on both sides of the diff so the audit trail and the
   * response can never leak the raw value.
   */
  async savePaypalSettings(input: {
    values: Record<string, unknown>;
    actorId?: string | null;
  }): Promise<{
    version: number;
    changedFields: Record<string, { from: unknown; to: unknown }>;
  }> {
    const values = input?.values ?? {};
    const keys = Object.keys(values);

    for (const key of keys) {
      if (!isPaypalConfigField(key)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Unknown PayPal setting "${key}". Allowed fields: ${PAYPAL_CONFIG_FIELDS.join(", ")}`
        );
      }
    }

    const row = await this.readSettingsRowForWrite();

    if (keys.length === 0) {
      return { version: row?.version ?? 0, changedFields: {} };
    }

    const changedFields: Record<string, { from: unknown; to: unknown }> = {};
    const patch: Record<string, unknown> = {};

    for (const key of keys as PaypalConfigField[]) {
      const column = PAYPAL_CONFIG_COLUMNS[key];
      const previous = row?.[column] ?? null;
      // JSON bodies cannot carry undefined; normalizing it to null keeps
      // direct JS callers on the same "present means write" semantics.
      const next = values[key] ?? null;

      if (previous !== next) {
        changedFields[key] =
          key === "clientSecret"
            ? {
                from: maskSecret(previous as string | null),
                to: maskSecret(next as string | null),
              }
            : { from: previous, to: next };
      }

      patch[column] = next;
    }

    const version = (row?.version ?? 0) + 1;
    const lastModifiedAt = new Date();

    if (row) {
      await (this as any).updatePaypalSettings({
        id: SETTINGS_SINGLETON_ID,
        ...patch,
        version,
        last_modified_by: input.actorId ?? null,
        last_modified_at: lastModifiedAt,
      });
    } else {
      await (this as any).createPaypalSettings({
        id: SETTINGS_SINGLETON_ID,
        ...patch,
        version,
        last_modified_by: input.actorId ?? null,
        last_modified_at: lastModifiedAt,
      });
    }

    await (this as any).createPaypalSettingsAudits({
      actor_id: input.actorId ?? null,
      changed_fields: changedFields,
    });

    return { version, changedFields };
  }

  /**
   * Stores the outcome of the most recent credential check. Verification is
   * observational, so it neither bumps `version` nor writes an audit row, and
   * a missing settings row is a silent no-op (nothing to annotate yet).
   */
  async recordPaypalSettingsVerification(input: {
    ok: boolean;
    at?: Date;
  }): Promise<void> {
    const row = await this.readSettingsRowForWrite();

    if (!row) {
      return;
    }

    await (this as any).updatePaypalSettings({
      id: SETTINGS_SINGLETON_ID,
      last_verified_at: input.at ?? new Date(),
      last_verified_ok: input.ok,
    });
  }

  // -- Plans ---------------------------------------------------------------

  async syncPlanForVariant(
    { variantId, currencyCode }: { variantId: string; currencyCode: string },
    modules: SubscriptionEngineModules = {}
  ): Promise<{ paypal_plan_id: string; config_hash: string; variant_id: string; currency_code: string }> {
    const engine = await this.withModules(modules);
    const resolved = await engine.resolveSubscriptionVariant(variantId, currencyCode);

    if (!resolved) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Variant ${variantId} does not carry "${"paypal_subscription"}" metadata`
      );
    }

    const { planRow } = await engine.ensurePlan({
      variant: resolved.variant,
      config: resolved.declaration,
      currencyCode,
      amount: resolved.amount,
    });

    return {
      paypal_plan_id: planRow.paypal_plan_id,
      config_hash: planRow.config_hash,
      variant_id: variantId,
      currency_code: currencyCode,
    };
  }

  /**
   * PayPal -> Medusa sync for PAYMENT.CAPTURE.REFUNDED / REVERSED webhook
   * events (the refund event type the subscriptions platform actually fires).
   */
  async syncCaptureRefundFromPaypal(
    resource: any,
    modules: SubscriptionEngineModules = {}
  ): Promise<void> {
    const engine = await this.withModules(modules);

    await engine.syncCaptureRefundFromPaypal(resource);
  }

  listPaypalPlanRows(filters?: any, config?: FindConfig<any>): Promise<any[]> {
    return (this as any).listPaypalPlans(filters, config);
  }

  // -- Checkout ------------------------------------------------------------

  /**
   * Cart validation for the Buttons route: throws on mixed carts, returns the
   * subscription variant when the cart is a valid single-subscription order.
   */
  async detectSubscriptionSession(
    { items }: { items: any[] },
    modules: SubscriptionEngineModules = {}
  ): Promise<{ subscription: boolean; variant?: any }> {
    const engine = await this.withModules(modules);

    return engine.detectSubscriptionSession(items);
  }

  async getOrCreateSubscriptionForSession(
    { sessionId, email, customerId, variantId, currencyCode, amount, returnUrl, cancelUrl }: {
      sessionId: string;
      email?: string;
      customerId?: string;
      variantId: string;
      currencyCode: string;
      amount: number;
      returnUrl?: string;
      cancelUrl?: string;
    },
    modules: SubscriptionEngineModules = {}
  ): Promise<{ id: string; subscription_id: string; status: string }> {
    const engine = await this.withModules(modules);
    const { row } = await engine.initiateSubscriptionSession({
      sessionId,
      variantId,
      currencyCode,
      amount,
      email,
      customerId,
      returnUrl,
      cancelUrl,
    });

    return {
      id: row.paypal_subscription_id,
      subscription_id: row.paypal_subscription_id,
      status: row.status,
    };
  }

  // -- Listing / detail ----------------------------------------------------

  async listSubscriptions(
    filters: Record<string, unknown> = {},
    config?: FindConfig<any>
  ): Promise<[any[], number]> {
    return (this as any).listAndCountPaypalSubscriptions(filters, config);
  }

  async retrieveSubscriptionDetail(id: string): Promise<any> {
    return (this as any).retrievePaypalSubscription(id);
  }

  // -- Lifecycle -----------------------------------------------------------

  async requestLifecycleAction(
    id: string,
    action: "cancel" | "suspend" | "resume"
  ): Promise<any> {
    const row = await (this as any).retrievePaypalSubscription(id);
    const engine = await this.resolveEngine();

    return engine.requestLifecycleAction(row, action);
  }

  async listForCustomer(customerId: string): Promise<any[]> {
    return (this as any).listPaypalSubscriptions({ customer_id: customerId });
  }

  async customerCancel(id: string, customerId: string): Promise<any> {
    const row = await (this as any).retrievePaypalSubscription(id);
    const engine = await this.resolveEngine();

    return engine.customerCancel(row, customerId);
  }

  // -- Reconciliation ------------------------------------------------------

  async reconcile(modules: SubscriptionEngineModules = {}): Promise<{
    aligned: number;
    salesBackfilled: number;
    firstPurchasesBackfilled: number;
  }> {
    const engine = await this.withModules(modules);

    return engine.reconcile();
  }

  // -- Vault binding (no-charge payment-method binding) ---------------------

  /**
   * Client for the vault-binding flow. Built from the module's own resolved
   * configuration (db -> providerOptions -> pluginOptions) because the DB
   * settings row is the authoritative layer in production: the host registers
   * this plugin as a bare string, so module options never arrive and a client
   * built from anything else would silently ignore an admin edit. Do not
   * "simplify" this to module options, and do not resolve the payment module -
   * this module declares no dependencies, so its local container cannot reach
   * it. Overridable so unit tests can inject a mock client.
   */
  protected async getVaultClient(): Promise<PaypalService> {
    const { config } = await this.getResolvedPaypalConfig();

    try {
      assertPaypalConfigured(config);
    } catch (error) {
      // assertPaypalConfigured throws INVALID_DATA for the settings page; for
      // this capability an unconfigured plugin is a server fault. reorder
      // preserves INVALID_DATA and would render it as a 400 customer refusal.
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, errorMessage(error));
    }

    return new PaypalService(config);
  }

  async startVaultApproval(
    input: vault.StartVaultApprovalInput
  ): Promise<vault.StartVaultApprovalResult> {
    const client = await this.getVaultClient();

    return vault.startVaultApproval(client, input);
  }

  async completeVaultApproval(
    input: vault.CompleteVaultApprovalInput
  ): Promise<vault.CompleteVaultApprovalResult> {
    const client = await this.getVaultClient();

    return vault.completeVaultApproval(client, input);
  }
}
