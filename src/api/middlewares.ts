import {
  authenticate,
  defineMiddlewares,
  validateAndTransformBody,
  validateAndTransformQuery,
} from "@medusajs/framework/http";
// Must be the framework's zod instance (zod 4), not the plugin's own zod 3:
// the validator converts a ZodError into a 400 only when it can recognise the
// error class. With the plugin's copy the raw ZodError falls through the
// framework error handler as a 500.
import { z } from "@medusajs/framework/zod";

/**
 * Body of `PATCH /admin/paypal/settings`.
 *
 * Every editable field is nullish: an omitted key leaves the stored override
 * untouched, an explicit `null` clears it so the field inherits from
 * medusa-config again. The framework's validator forces `.strict()` on object
 * schemas, so an undeclared key is a 400 - which is also the end-to-end proof
 * that this plural file (and not the old singular one) is the one loaded.
 */
export const AdminUpdatePaypalSettingsBody = z.object({
  clientId: z.string().nullish(),
  clientSecret: z.string().nullish(),
  isSandbox: z.boolean().nullish(),
  webhookId: z.string().nullish(),
  subscriptionWebhookId: z.string().nullish(),
  includeShippingData: z.boolean().nullish(),
  includeCustomerData: z.boolean().nullish(),
  autoBillOutstanding: z.boolean().nullish(),
  paymentFailureThreshold: z.number().int().nullish(),
});

export type AdminUpdatePaypalSettingsBodyType = z.infer<
  typeof AdminUpdatePaypalSettingsBody
>;

/**
 * Body of `POST /admin/paypal/settings/verify` (the connection test; the route
 * directory is `verify`, not `test`, because the plugin compiler drops any
 * path containing a `test` segment). Optional draft credentials from the admin
 * form: missing (or null) fields fall back to the effective values, and a body
 * without any draft value tests - and records the result for - the stored
 * configuration.
 */
export const AdminTestPaypalSettingsBody = z.object({
  clientId: z.string().nullish(),
  clientSecret: z.string().nullish(),
  isSandbox: z.boolean().nullish(),
});

export type AdminTestPaypalSettingsBodyType = z.infer<
  typeof AdminTestPaypalSettingsBody
>;

/** Query of `GET /admin/paypal/settings/audit` (default 20, capped at 100). */
export const AdminListPaypalSettingsAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type AdminListPaypalSettingsAuditQueryType = z.infer<
  typeof AdminListPaypalSettingsAuditQuery
>;

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/paypal/client-token",
      methods: ["POST"],
    },
    {
      matcher: "/store/paypal/account-holder",
      methods: ["POST"],
    },
    // Customer self-service: listing subscriptions requires a customer
    // identity. The store create-subscription route (POST on the collection)
    // stays public so guest Buttons checkouts keep working.
    {
      matcher: "/store/paypal/subscriptions",
      methods: ["GET"],
      middlewares: [authenticate("customer", ["bearer", "session"])],
    },
    {
      matcher: "/store/paypal/subscriptions/:id/cancel",
      methods: ["POST"],
      middlewares: [authenticate("customer", ["bearer", "session"])],
    },
    // Mirror of Medusa's core /hooks/payment/:provider config: keep the raw
    // request body available as req.rawBody on the subscription webhook so
    // merchant subscribers get the same payload shape as the payment rail.
    {
      matcher: "/hooks/paypal/subscriptions",
      methods: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    // PayPal settings API validation. This file must be the plural
    // `middlewares.ts`: the framework's middleware file loader only probes
    // `middlewares.ts` / `middlewares.js`, so these validators (and the
    // preserveRawBody entry above) were dead code under the old singular name.
    {
      matcher: "/admin/paypal/settings",
      methods: ["PATCH"],
      middlewares: [validateAndTransformBody(AdminUpdatePaypalSettingsBody)],
    },
    {
      matcher: "/admin/paypal/settings/verify",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(AdminTestPaypalSettingsBody)],
    },
    {
      matcher: "/admin/paypal/settings/audit",
      methods: ["GET"],
      middlewares: [
        validateAndTransformQuery(AdminListPaypalSettingsAuditQuery, {
          isList: true,
        }),
      ],
    },
  ],
});
