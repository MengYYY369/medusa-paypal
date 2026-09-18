import { defineMiddlewares, authenticate } from "@medusajs/framework/http";

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
  ],
});
