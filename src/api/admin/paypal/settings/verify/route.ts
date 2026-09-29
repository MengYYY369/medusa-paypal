import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { PaypalService } from "../../../../../providers/paypal/paypal-core";
import {
  findPaypalProviderDeclaration,
  resolveSubscriptionModule,
} from "../../../../lib/paypal";
import type { AdminTestPaypalSettingsBodyType } from "../../../../middlewares";
import { sanitizeCredentialError } from "../utils";

/**
 * NOTE: this directory is named `verify`, not `test`.
 *
 * The framework's plugin compiler prunes any file whose path contains a `test`
 * path segment (`_Compiler_backendIgnoreFiles` in
 * `@medusajs/framework/dist/build-tools/compiler.js`; `isFileIgnored` in
 * `compiler-utils.js` matches whole segments). A `settings/test/route.ts`
 * therefore compiles fine but is silently dropped from `.medusa/server`, and
 * the host answers 404. Renaming the directory keeps the endpoint buildable;
 * do not rename it back.
 */

/** Body fields that count as "draft overrides" for the write-back rule. */
const DRAFT_FIELDS = ["clientId", "clientSecret", "isSandbox"] as const;

/**
 * Connection test against PayPal's OAuth token endpoint.
 *
 * The body may carry draft `clientId` / `clientSecret` / `isSandbox` from the
 * admin form; anything missing (or null) falls back to the effective value, so
 * an empty body tests exactly what is currently stored. Only a test of the
 * stored configuration writes the outcome back to `last_verified_*` - draft
 * tests are observational and must not annotate the saved row.
 *
 * The response never carries the secret (nor do logs): the error message is
 * scrubbed of the credential material before it leaves this handler.
 */
export const POST = async (
  req: MedusaRequest<AdminTestPaypalSettingsBodyType>,
  res: MedusaResponse
) => {
  const module = resolveSubscriptionModule(req.scope);
  const paymentModule = req.scope.resolve<any>("payment");
  const provider = findPaypalProviderDeclaration(paymentModule);

  const resolved = await module.getResolvedPaypalConfig({
    providerOptions: provider?.options ?? null,
  });

  const body = req.validatedBody ?? {};
  const hasDraftOverrides = DRAFT_FIELDS.some(
    (field) => body[field] !== undefined && body[field] !== null
  );

  const clientId = body.clientId ?? resolved.config.clientId ?? "";
  const clientSecret = body.clientSecret ?? resolved.config.clientSecret ?? "";
  const isSandbox = body.isSandbox ?? resolved.config.isSandbox;
  const environment = isSandbox ? "sandbox" : "production";

  const startedAt = Date.now();
  let ok = false;
  let error: string | undefined;

  if (!clientId.trim() || !clientSecret.trim()) {
    error =
      "PayPal is not configured: clientId and clientSecret are both required " +
      "(set them on this page or in medusa-config).";
  } else {
    try {
      const service = new PaypalService({
        clientId,
        clientSecret,
        isSandbox,
        includeShippingData: false,
        includeCustomerData: false,
      });

      await service.getAccessToken();
      ok = true;
    } catch (cause) {
      error = sanitizeCredentialError(cause, clientId, clientSecret);
    }
  }

  const durationMs = Date.now() - startedAt;

  if (!hasDraftOverrides) {
    try {
      await module.recordPaypalSettingsVerification({ ok });
    } catch (cause) {
      // Verification is observational: a failed write must not hide the test
      // result the admin asked for.
      req.scope
        .resolve<any>(ContainerRegistrationKeys.LOGGER)
        ?.warn?.(
          `Could not record PayPal settings verification: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
    }
  }

  return res.status(200).json({
    ok,
    environment,
    ...(error ? { error } : {}),
    durationMs,
  });
};
