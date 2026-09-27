import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { MedusaError } from "@medusajs/framework/utils";
import { resolveSubscriptionModule } from "../../../../../lib/paypal";

const VALID_ACTIONS = ["cancel", "suspend", "resume"] as const;

type ActionBody = { action?: string };

/**
 * Admin lifecycle action: cancel / suspend / resume. Syncs PayPal first,
 * then the local row; the corresponding PayPal webhook finds the row already
 * transitioned and stays silent (dual-path idempotency).
 */
export const POST = async (req: MedusaRequest<ActionBody>, res: MedusaResponse) => {
  const module = resolveSubscriptionModule(req.scope);
  const action = req.body?.action as (typeof VALID_ACTIONS)[number];

  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({
      error: `Invalid action "${String(req.body?.action)}". Expected one of: ${VALID_ACTIONS.join(", ")}`,
    });
  }

  try {
    const subscription = await module.requestLifecycleAction(
      req.params.id,
      action
    );

    return res.status(200).json({ subscription });
  } catch (error) {
    if (
      error instanceof MedusaError &&
      error.type === MedusaError.Types.NOT_FOUND
    ) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    // PayPal rejections surface as raw fetch errors with paypalStatus /
    // paypalIssue attached by the core client; rethrowing them falls through
    // the framework error handler as an opaque 500. Wrap so the admin UI can
    // show the actual rejection reason.
    if (!(error instanceof MedusaError)) {
      const paypalStatus = (error as any)?.paypalStatus;
      const paypalIssue = (error as any)?.paypalIssue;
      const extras = [
        paypalStatus !== undefined && `HTTP ${paypalStatus}`,
        paypalIssue && `issue ${paypalIssue}`,
      ]
        .filter(Boolean)
        .join(", ");
      const detail =
        error instanceof Error
          ? error.message
          : String(error ?? "unknown error");

      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `PayPal rejected "${action}" on subscription ${req.params.id}: ${detail}${extras ? ` (${extras})` : ""}`,
        "paypal_rejected"
      );
    }

    throw error;
  }
};
