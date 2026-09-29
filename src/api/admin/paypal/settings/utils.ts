import type {
  PaypalConfigField,
  PaypalConfigSource,
  PaypalResolvedConfig,
} from "../../../../modules/paypal-subscription/lib/config-resolver";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

type ScopeLike = { resolve: (key: string) => unknown };

/**
 * Structural copy of what `getResolvedPaypalConfig` returns. Kept structural
 * (instead of importing the module service type) so the API layer stays
 * decoupled from the module internals.
 */
export interface ResolvedPaypalSettings {
  config: PaypalResolvedConfig;
  version: number;
  sources: Record<PaypalConfigField, PaypalConfigSource>;
  meta: {
    lastModifiedBy: string | null;
    lastModifiedAt: string | null;
    lastVerifiedAt: string | null;
    lastVerifiedOk: boolean | null;
  };
}

type RequestLike = {
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  auth_context?: { actor_id?: string | null; actor_type?: string | null } | null;
  actor_id?: string | null;
};

function firstHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;

  if (typeof raw !== "string") {
    return undefined;
  }

  const first = raw.split(",")[0].trim();

  return first || undefined;
}

/**
 * Best-effort backend origin for the read-only webhook URLs.
 *
 * The plugin has no configured backend URL of its own (the admin's
 * `__BACKEND_URL__` is a browser build-time constant), so the origin is
 * derived from the request the admin made. Medusa runs Express with
 * `trust proxy = 1`, so behind a reverse proxy `req.protocol` already honours
 * `X-Forwarded-Proto`; `X-Forwarded-Host` / `Host` are read explicitly to keep
 * the port (Express' `req.hostname` strips it). Falls back to `null` when no
 * Host header is present (unreachable over HTTP/1.1) - callers then emit a
 * path-only URL.
 */
export function resolveRequestOrigin(req: RequestLike): string | null {
  const headers = req.headers ?? {};
  const protocol =
    firstHeaderValue(headers["x-forwarded-proto"]) ?? req.protocol ?? "http";
  const host =
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers["host"]);

  return host ? `${protocol}://${host}` : null;
}

/**
 * The authenticated actor behind an /admin request: a user id for
 * bearer/session auth, an API key id for api-key auth. The fallbacks keep the
 * lookup tolerant of framework version differences.
 */
export function resolveActorId(req: RequestLike): string | null {
  return req.auth_context?.actor_id ?? req.actor_id ?? null;
}

function isPresentString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Strips credentials out of a PayPal client error before it is returned to
 * the admin UI (or logged). The SDK stringifies errors, so the raw message can
 * carry the Basic auth header derived from `clientId:clientSecret`.
 */
export function sanitizeCredentialError(
  error: unknown,
  clientId: string,
  clientSecret: string
): string {
  let message = error instanceof Error ? error.message : String(error);

  if (clientSecret) {
    message = message.split(clientSecret).join("[redacted]");

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64"
    );
    message = message.split(basic).join("[redacted]");
  }

  return message;
}

/**
 * Server-side actor display names. Users resolve through the query graph;
 * API key ids (and users the lookup misses) fall back to the raw actor id.
 * A failed lookup is non-fatal - the caller still has the raw id.
 */
export async function resolveActorNames(
  scope: ScopeLike,
  actorIds: string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  if (!actorIds.length) {
    return names;
  }

  try {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY) as any;
    const { data } = await query.graph({
      entity: "user",
      fields: ["id", "first_name", "last_name", "email"],
      filters: { id: actorIds },
    });

    for (const user of data ?? []) {
      const fullName = [user.first_name, user.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();

      names.set(user.id, fullName || user.email || user.id);
    }
  } catch (cause) {
    (scope.resolve(ContainerRegistrationKeys.LOGGER) as any)?.warn?.(
      `Could not resolve PayPal settings actor names: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  return names;
}

export interface PaypalSettingsField<T> {
  value: T | null;
  source: PaypalConfigSource;
}

export interface PaypalSettingsResponse {
  settings: {
    clientId: PaypalSettingsField<string>;
    clientSecret: {
      hasSecret: boolean;
      /** Last 4 characters of the effective secret; never the secret itself. */
      secretTail: string | null;
      source: PaypalConfigSource;
    };
    isSandbox: PaypalSettingsField<boolean>;
    webhookId: PaypalSettingsField<string>;
    subscriptionWebhookId: PaypalSettingsField<string>;
    includeShippingData: PaypalSettingsField<boolean>;
    includeCustomerData: PaypalSettingsField<boolean>;
    autoBillOutstanding: PaypalSettingsField<boolean>;
    paymentFailureThreshold: PaypalSettingsField<number>;
  };
  environment: "sandbox" | "production" | "unconfigured";
  version: number;
  /** Display name of the last editor; falls back to the raw actor id. */
  lastModifiedBy: string | null;
  /** Raw actor id behind `lastModifiedBy` (user id, or API key id). */
  lastModifiedById: string | null;
  lastModifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedOk: boolean | null;
  integration: {
    paymentWebhookUrl: string;
    subscriptionWebhookUrl: string;
    reconcileCron: string;
  };
}

/**
 * Shapes the resolved config for `GET /admin/paypal/settings`. The raw secret
 * never leaves this function: only `hasSecret` and its last 4 characters are
 * exposed. `environment` is `"unconfigured"` until both credential halves
 * resolve, mirroring the boot guard's definition.
 */
export function shapePaypalSettingsResponse(input: {
  resolved: ResolvedPaypalSettings;
  origin: string | null;
  webhookProviderId: string;
  reconcileCron: string;
}): PaypalSettingsResponse {
  const { config, sources, version, meta } = input.resolved;

  const clientId = isPresentString(config.clientId) ? config.clientId : null;
  const clientSecret = isPresentString(config.clientSecret)
    ? config.clientSecret
    : null;
  const configured = Boolean(clientId && clientSecret);

  const field = <T>(
    value: T | null | undefined,
    source: PaypalConfigSource
  ): PaypalSettingsField<T> => ({ value: value ?? null, source });

  const withOrigin = (path: string) =>
    input.origin ? `${input.origin}${path}` : path;

  return {
    settings: {
      clientId: field(clientId, sources.clientId),
      clientSecret: {
        hasSecret: clientSecret !== null,
        secretTail: clientSecret ? clientSecret.slice(-4) : null,
        source: sources.clientSecret,
      },
      isSandbox: field(config.isSandbox, sources.isSandbox),
      webhookId: field(config.webhookId, sources.webhookId),
      subscriptionWebhookId: field(
        config.subscriptionWebhookId,
        sources.subscriptionWebhookId
      ),
      includeShippingData: field(
        config.includeShippingData,
        sources.includeShippingData
      ),
      includeCustomerData: field(
        config.includeCustomerData,
        sources.includeCustomerData
      ),
      autoBillOutstanding: field(
        config.autoBillOutstanding,
        sources.autoBillOutstanding
      ),
      paymentFailureThreshold: field(
        config.paymentFailureThreshold,
        sources.paymentFailureThreshold
      ),
    },
    environment: configured
      ? config.isSandbox
        ? "sandbox"
        : "production"
      : "unconfigured",
    version,
    lastModifiedBy: meta.lastModifiedBy,
    lastModifiedById: meta.lastModifiedBy,
    lastModifiedAt: meta.lastModifiedAt,
    lastVerifiedAt: meta.lastVerifiedAt,
    lastVerifiedOk: meta.lastVerifiedOk,
    integration: {
      // README convention: the payment webhook path is the provider's
      // registration key minus the "pp_" prefix, which the framework adds.
      paymentWebhookUrl: withOrigin(
        `/hooks/payment/${input.webhookProviderId}`
      ),
      subscriptionWebhookUrl: withOrigin("/hooks/paypal/subscriptions"),
      reconcileCron: input.reconcileCron,
    },
  };
}
