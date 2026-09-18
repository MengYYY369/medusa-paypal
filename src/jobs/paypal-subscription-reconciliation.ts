import { Modules } from "@medusajs/framework/utils";

/**
 * Daily reconciliation safety net (schedule overridable via
 * PAYPAL_SUBSCRIPTION_RECONCILE_CRON):
 *
 * 1. Aligns local ACTIVE/SUSPENDED subscription status with PayPal
 *    (suspends, cancels, expirations converge; stuck approvals activate).
 * 2. Backfills missed subscription charges from PayPal transactions:
 *    missed first-period charges are replayed through the standard
 *    process-payment workflow, missed renewals create their orders.
 * 3. Compensates customers who approved a subscription but never returned
 *    to the store - the standard workflow completes their cart
 *    idempotently.
 *
 * Every branch is idempotent; re-running never duplicates orders.
 */
export const config = {
  name: "paypal-subscription-reconciliation",
  schedule: process.env.PAYPAL_SUBSCRIPTION_RECONCILE_CRON ?? "0 3 * * *",
};

export default async function paypalSubscriptionReconciliation({
  container,
  logger,
}: {
  container: any;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  const subscriptionModule = container.resolve("paypalSubscription");

  if (!subscriptionModule) {
    return;
  }

  const result = await subscriptionModule.reconcile({
    productModule: container.resolve(Modules.PRODUCT),
    orderModule: container.resolve(Modules.ORDER),
    paymentModule: container.resolve(Modules.PAYMENT),
    workflowEngine: container.resolve(Modules.WORKFLOW_ENGINE),
  });

  logger.info(
    `PayPal subscription reconciliation: ${result.aligned} status-aligned, ` +
      `${result.salesBackfilled} sales backfilled, ` +
      `${result.firstPurchasesBackfilled} first purchases compensated.`
  );
}
