import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { MedusaError } from "@medusajs/framework/utils";
import { resolveSubscriptionModule } from "../../../../lib/paypal";

/** Admin subscription detail (status, amounts, period, failures, sales). */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const module = resolveSubscriptionModule(req.scope);

  try {
    const subscription = await module.retrieveSubscriptionDetail(req.params.id);

    return res.status(200).json({ subscription });
  } catch (error) {
    if (
      error instanceof MedusaError &&
      error.type === MedusaError.Types.NOT_FOUND
    ) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    throw error;
  }
};
