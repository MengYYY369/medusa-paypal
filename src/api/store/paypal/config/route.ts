import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import {
  findPaypalProviderDeclaration,
  resolveSubscriptionModule,
} from "../../../lib/paypal";

function isPresentString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Storefront-facing runtime configuration.
 *
 * Read-only and side-effect free: it resolves the effective PayPal config
 * (db -> provider options -> plugin options) without calling PayPal. Public in
 * the sense that no customer identity is required, but still scoped by the
 * host's publishable key like every /store route. Unconfigured is a normal
 * answer, not an error: HTTP 200 with `client_id: null` and
 * `configured: false` so the storefront can render a disabled state.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "no-store");

  const module = resolveSubscriptionModule(req.scope);

  let providerOptions: Record<string, unknown> | null = null;

  try {
    const paymentModule = req.scope.resolve<any>("payment");
    providerOptions =
      findPaypalProviderDeclaration(paymentModule)?.options ?? null;
  } catch {
    // No payment module (misconfigured host): fall through to the plugin
    // options layer instead of failing a storefront read.
    providerOptions = null;
  }

  const { config } = await module.getResolvedPaypalConfig({ providerOptions });

  const clientId = isPresentString(config.clientId) ? config.clientId : null;
  const configured = Boolean(
    clientId && isPresentString(config.clientSecret)
  );

  return res.status(200).json({
    client_id: configured ? clientId : null,
    environment: config.isSandbox ? "sandbox" : "production",
    configured,
  });
};
