import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { resolveSubscriptionModule } from "../../../../lib/paypal";

type SyncBody = { variant_id?: string; currency_code?: string };

/**
 * Admin manual plan sync: creates or refreshes the cached PayPal billing
 * plan for a variant x currency. Useful to pre-provision plans before launch
 * and to inspect the plan state during troubleshooting.
 */
export const POST = async (req: MedusaRequest<SyncBody>, res: MedusaResponse) => {
  const { variant_id: variantId, currency_code: currencyCode } = req.body ?? {};

  if (!variantId || !currencyCode) {
    return res.status(400).json({
      error: "variant_id and currency_code are required",
    });
  }

  const module = resolveSubscriptionModule(req.scope);

  const plan = await module.syncPlanForVariant(
    { variantId, currencyCode },
    {
      productModule: req.scope.resolve(Modules.PRODUCT),
      query: req.scope.resolve(ContainerRegistrationKeys.QUERY),
    }
  );

  return res.status(200).json({ plan });
};
