import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { config as reconciliationJobConfig } from "../../../../jobs/paypal-subscription-reconciliation";
import { findPaypalProviderDeclaration, resolveSubscriptionModule } from "../../../lib/paypal";
import type { AdminUpdatePaypalSettingsBodyType } from "../../../middlewares";
import {
  resolveActorId,
  resolveActorNames,
  resolveRequestOrigin,
  shapePaypalSettingsResponse,
} from "./utils";

/**
 * Shared lookup for every settings route: the plugin module owns the settings
 * row, the payment module owns the provider entry that is the middle fallback
 * layer of the config chain. Mirrors the other admin routes' provider lookup.
 */
async function resolvePaypalContext(req: MedusaRequest) {
  const module = resolveSubscriptionModule(req.scope);
  const paymentModule = req.scope.resolve<any>("payment");
  const provider = findPaypalProviderDeclaration(paymentModule);

  const resolved = await module.getResolvedPaypalConfig({
    providerOptions: provider?.options ?? null,
  });

  return { module, provider, resolved };
}

/**
 * Admin PayPal settings: effective values per field plus their source layer
 * (`db` / `provider_options` / `plugin_options` / `none`), the environment, the
 * change/verification metadata and the read-only integration info.
 *
 * The client secret is never returned - only whether one is set and its last
 * 4 characters.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { provider, resolved } = await resolvePaypalContext(req);

  const payload = shapePaypalSettingsResponse({
    resolved,
    origin: resolveRequestOrigin(req),
    webhookProviderId: provider?.webhookProviderId ?? "paypal",
    reconcileCron: reconciliationJobConfig.schedule,
  });

  // "Last modified" is read by humans, so resolve the actor id to a display
  // name the same way the change history does. The raw id stays available.
  if (payload.lastModifiedById) {
    const names = await resolveActorNames(req.scope, [payload.lastModifiedById]);
    payload.lastModifiedBy =
      names.get(payload.lastModifiedById) ?? payload.lastModifiedById;
  }

  return res.status(200).json(payload);
};

/**
 * Patch-style update of the stored overrides: an omitted field is untouched,
 * an explicit null clears it back to "inherit from medusa-config". Body
 * validation lives in src/api/middlewares.ts (undeclared fields are a 400).
 * Returns the new row version and the audited field diff.
 */
export const PATCH = async (
  req: MedusaRequest<AdminUpdatePaypalSettingsBodyType>,
  res: MedusaResponse
) => {
  const module = resolveSubscriptionModule(req.scope);
  const values = (req.validatedBody ?? {}) as Record<string, unknown>;

  const result = await module.savePaypalSettings({
    values,
    actorId: resolveActorId(req),
  });

  return res.status(200).json(result);
};
