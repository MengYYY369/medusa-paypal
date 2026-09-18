import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { resolveSubscriptionModule } from "../../../lib/paypal";

/**
 * Admin subscription list. Auth is enforced by the global /admin middleware
 * (user bearer/session/api-key). Filters: status (csv), customer_id,
 * variant_id; pagination via limit/offset.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const module = resolveSubscriptionModule(req.scope);

  const query = (req.query ?? {}) as Record<string, string>;
  const statusFilter = query.status
    ? { status: query.status.split(",").map((s) => s.trim()) }
    : {};

  const [subscriptions, count] = await module.listSubscriptions(
    {
      ...(query.customer_id && { customer_id: query.customer_id }),
      ...(query.variant_id && { variant_id: query.variant_id }),
      ...statusFilter,
    },
    {
      ...(query.limit && { take: Number(query.limit) }),
      ...(query.offset && { skip: Number(query.offset) }),
    }
  );

  return res.status(200).json({ subscriptions, count });
};
