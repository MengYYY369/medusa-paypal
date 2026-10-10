#!/usr/bin/env node
/**
 * Sandbox check for the plan-switch behaviour (0.10.2, ticket #09).
 *
 * The plugin's own code paths are covered by unit tests; what cannot be tested
 * locally is PayPal's side of a switch. The 0.10.1 run of this script
 * established three facts the plugin had wrong: `revise` answers **200 with a
 * consent link** (nothing changes until the buyer approves on PayPal's page),
 * a SUSPENDED subscription is refused with 422 SUBSCRIPTION_STATUS_INVALID,
 * and a cross-product plan is refused with PLAN_PRODUCT_NOT_COMPATIBLE. This
 * script drives the sandbox REST API directly with the same request shapes the
 * plugin sends and asserts those facts, so the 0.10.2 contract stays pinned.
 *
 * Usage:
 *   node scripts/sandbox-plan-switch-check.mjs
 *
 * Credentials are read from ~/.paypal-sandbox-credentials.json (keys:
 * clientId, clientSecret) or from PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.
 * They are never printed. Live is refused unless --allow-live is passed.
 *
 * The script stops twice and waits for a human: PayPal requires a buyer in a
 * browser to approve the subscription and again to consent to the plan switch.
 * It prints each URL and polls until PayPal reports the expected state.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CRED_FILE = join(homedir(), ".paypal-sandbox-credentials.json");
const ALLOW_LIVE = process.argv.includes("--allow-live");
const CURRENCY = process.env.CHECK_CURRENCY ?? "USD";
const MONTHLY_PRICE = process.env.CHECK_MONTHLY_PRICE ?? "19.99";
const YEARLY_PRICE = process.env.CHECK_YEARLY_PRICE ?? "199.99";

const results = [];
let failed = 0;

function loadCredentials() {
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
    return {
      clientId: process.env.PAYPAL_CLIENT_ID,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET,
      environment: process.env.PAYPAL_ENVIRONMENT ?? "sandbox",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CRED_FILE, "utf8"));
  } catch (error) {
    console.error(`Cannot read ${CRED_FILE}: ${error.message}`);
    console.error("Provide PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET instead.");
    process.exit(2);
  }
  if (!parsed.clientId || !parsed.clientSecret) {
    console.error(`${CRED_FILE} has no clientId/clientSecret.`);
    process.exit(2);
  }
  return parsed;
}

const credentials = loadCredentials();
const environment = credentials.environment === "live" ? "live" : "sandbox";
if (environment === "live" && !ALLOW_LIVE) {
  console.error("Refusing to run against live PayPal. Pass --allow-live to override.");
  process.exit(2);
}
const BASE = environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

let accessToken = null;

async function token() {
  if (accessToken) return accessToken;
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`token request failed (${response.status}): ${body.error_description ?? body.error ?? ""}`);
  }
  accessToken = body.access_token;
  return accessToken;
}

/** Returns { status, body, requestId } — never throws on a non-2xx, the caller decides. */
async function call(method, path, body, requestId) {
  const headers = { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, requestId };
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function info(message) {
  console.log(`      ${message}`);
}

function money(value, currency) {
  return `${value} ${currency}`;
}

async function createPlan(productId, intervalUnit, price, label) {
  const created = await call("POST", "/v1/billing/plans", {
    product_id: productId,
    name: `0.10.1 check — ${label}`,
    status: "ACTIVE",
    billing_cycles: [
      {
        frequency: { interval_unit: intervalUnit, interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: price, currency_code: CURRENCY } },
      },
    ],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
  });
  if (created.status !== 201) {
    throw new Error(`createBillingPlan(${label}) failed (${created.status}): ${JSON.stringify(created.body)}`);
  }
  return created.body.id;
}

async function createProduct(name) {
  const created = await call("POST", "/v1/catalogs/products", { name, type: "SERVICE" });
  if (created.status !== 201) {
    throw new Error(`createBillingProduct failed (${created.status}): ${JSON.stringify(created.body)}`);
  }
  return created.body.id;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer))));
}

async function waitForApproval(subscriptionId, approveUrl, timeoutMs = 15 * 60 * 1000) {
  console.log("\n--- HUMAN STEP 1/2 ---");
  console.log("Open this URL in a browser and approve with a sandbox PERSONAL (buyer) account:\n");
  console.log(`  ${approveUrl}\n`);
  console.log("The script polls every 5s until PayPal reports ACTIVE (max 15 min).");
  await ask("Press Enter once the browser shows the approval (or just wait here)…");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await call("GET", `/v1/billing/subscriptions/${subscriptionId}`);
    if (current.body?.status === "ACTIVE") return current.body;
    if (["CANCELLED", "EXPIRED"].includes(current.body?.status)) {
      throw new Error(`subscription became ${current.body.status} before approval`);
    }
    process.stdout.write(`\r      status=${current.body?.status ?? current.status} …`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("timed out waiting for approval");
}

/**
 * Waits for the buyer to consent to a plan switch on PayPal's page. The
 * subscription keeps its old plan until then - that is the whole point of this
 * check, so the plan id (not the status) is what we poll for.
 */
async function waitForConsent(subscriptionId, consentUrl, expectedPlanId, timeoutMs = 10 * 60 * 1000) {
  console.log("\n--- HUMAN STEP 2/2 ---");
  console.log("Open this URL in a browser and confirm the plan change with the SAME sandbox buyer:\n");
  console.log(`  ${consentUrl}\n`);
  console.log(`The script polls every 5s until plan_id becomes ${expectedPlanId} (max 10 min).`);
  await ask("Press Enter once the browser shows the confirmation (or just wait here)…");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await call("GET", `/v1/billing/subscriptions/${subscriptionId}`);
    if (current.body?.plan_id === expectedPlanId) return current.body;
    process.stdout.write(`\r      plan_id=${current.body?.plan_id ?? "?"} status=${current.body?.status ?? "?"} …`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("timed out waiting for the buyer to consent to the plan switch");
}

function nextBillingTime(subscription) {
  return subscription?.billing_info?.next_billing_time ?? null;
}

async function main() {
  console.log(`PayPal environment: ${environment}`);
  console.log(`Currency: ${CURRENCY}, monthly ${money(MONTHLY_PRICE, CURRENCY)}, yearly ${money(YEARLY_PRICE, CURRENCY)}\n`);

  const productId = await createProduct("0.10.2 plan-switch check");
  const monthlyPlan = await createPlan(productId, "MONTH", MONTHLY_PRICE, "monthly");
  const yearlyPlan = await createPlan(productId, "YEAR", YEARLY_PRICE, "yearly");
  const foreignProductId = await createProduct("0.10.2 plan-switch check (other product)");
  const foreignPlan = await createPlan(foreignProductId, "MONTH", MONTHLY_PRICE, "other product");
  info(`product=${productId} monthly=${monthlyPlan} yearly=${yearlyPlan} foreign=${foreignPlan}`);

  // --- create + approve -----------------------------------------------------
  const created = await call("POST", "/v1/billing/subscriptions", {
    plan_id: monthlyPlan,
    custom_id: `check-${Date.now()}`,
    application_context: {
      return_url: "https://example.com/return",
      cancel_url: "https://example.com/cancel",
      user_action: "SUBSCRIBE_NOW",
      shipping_preference: "NO_SHIPPING",
    },
  });
  if (created.status !== 201) {
    throw new Error(`createSubscription failed (${created.status}): ${JSON.stringify(created.body)}`);
  }
  const subscriptionId = created.body.id;
  const approveUrl = (created.body.links ?? []).find((link) => link.rel === "approve")?.href;
  if (!approveUrl) throw new Error(`no approve link in ${JSON.stringify(created.body.links)}`);

  const active = await waitForApproval(subscriptionId, approveUrl);
  console.log("");
  const before = { nextBillingTime: nextBillingTime(active), planId: active.plan_id, status: active.status };
  info(`subscription=${subscriptionId}`);
  info(`before revise: plan=${before.planId} next_billing_time=${before.nextBillingTime}`);
  record("subscription approved and ACTIVE", before.status === "ACTIVE", `status=${before.status}`);
  record("plan_id is the monthly plan", before.planId === monthlyPlan, `plan_id=${before.planId}`);

  // --- switch MONTH -> YEAR (consent flow) ---------------------------------
  // PayPal answers 200 with a consent link and keeps billing the old plan
  // until the buyer approves on that page ("This type of update requires the
  // buyer's consent"). The plugin must not write the new plan before that.
  const requestId = `revise-${subscriptionId}-${yearlyPlan}`;
  const revised = await call("POST", `/v1/billing/subscriptions/${subscriptionId}/revise`, { plan_id: yearlyPlan }, requestId);
  const consentUrl = (revised.body?.links ?? []).find(
    (link) => link.rel === "approve" || link.rel === "payer-action",
  )?.href;
  record(
    "revise returns 200 with a consent link (not a silent switch)",
    revised.status === 200 && Boolean(consentUrl),
    `status=${revised.status} link=${consentUrl ?? "none"}`,
  );
  const beforeConsent = await call("GET", `/v1/billing/subscriptions/${subscriptionId}`);
  record(
    "plan is unchanged until the buyer consents",
    beforeConsent.body?.plan_id === monthlyPlan,
    `plan_id=${beforeConsent.body?.plan_id}`,
  );

  if (!consentUrl) {
    throw new Error(`no consent link in ${JSON.stringify(revised.body?.links)} - cannot continue`);
  }

  const afterConsentRaw = await waitForConsent(subscriptionId, consentUrl, yearlyPlan);
  console.log("");
  const after = {
    nextBillingTime: nextBillingTime(afterConsentRaw),
    planId: afterConsentRaw?.plan_id,
    status: afterConsentRaw?.status,
  };
  info(`after consent: plan=${after.planId} next_billing_time=${after.nextBillingTime} status=${after.status}`);
  record("plan_id moved to the yearly plan after consent", after.planId === yearlyPlan, `plan_id=${after.planId}`);
  record("status stays ACTIVE across the switch", after.status === "ACTIVE", `status=${after.status}`);
  record(
    "no proration: next_billing_time is unchanged",
    before.nextBillingTime === after.nextBillingTime,
    `${before.nextBillingTime} -> ${after.nextBillingTime}`,
  );

  // --- cross-product refusal while ACTIVE (the branch the plugin pre-empts) --
  const crossProduct = await call(
    "POST",
    `/v1/billing/subscriptions/${subscriptionId}/revise`,
    { plan_id: foreignPlan },
    `revise-${subscriptionId}-${foreignPlan}`,
  );
  const issue = crossProduct.body?.details?.[0]?.issue ?? crossProduct.body?.name ?? null;
  record(
    "cross-product revise is refused with PLAN_PRODUCT_NOT_COMPATIBLE",
    (crossProduct.status === 400 || crossProduct.status === 422) && issue === "PLAN_PRODUCT_NOT_COMPATIBLE",
    `status=${crossProduct.status} issue=${issue}`,
  );

  // --- retry with the same idempotency key (soft check) ---------------------
  const retry = await call("POST", `/v1/billing/subscriptions/${subscriptionId}/revise`, { plan_id: yearlyPlan }, requestId);
  record(
    "retrying with the same PayPal-Request-Id is accepted (soft)",
    retry.status === 200 || retry.status === 204,
    `status=${retry.status} body=${JSON.stringify(retry.body)}`,
  );

  // --- revise while SUSPENDED ----------------------------------------------
  const suspended = await call("POST", `/v1/billing/subscriptions/${subscriptionId}/suspend`, { reason: "0.10.2 check" });
  record("suspend returns 204", suspended.status === 204, `status=${suspended.status}`);
  const suspendedState = await call("GET", `/v1/billing/subscriptions/${subscriptionId}`);
  record("status is SUSPENDED", suspendedState.body?.status === "SUSPENDED", `status=${suspendedState.body?.status}`);

  const suspendedRevise = await call(
    "POST",
    `/v1/billing/subscriptions/${subscriptionId}/revise`,
    { plan_id: monthlyPlan },
    `revise-${subscriptionId}-${monthlyPlan}`,
  );
  const suspendedIssue =
    suspendedRevise.body?.details?.[0]?.issue ?? suspendedRevise.body?.name ?? null;
  record(
    "a SUSPENDED subscription cannot be revised (422 SUBSCRIPTION_STATUS_INVALID)",
    suspendedRevise.status === 422 && suspendedIssue === "SUBSCRIPTION_STATUS_INVALID",
    `status=${suspendedRevise.status} issue=${suspendedIssue}`,
  );
  const afterSuspendedRevise = await call("GET", `/v1/billing/subscriptions/${subscriptionId}`);
  info(`after refused revise: plan=${afterSuspendedRevise.body?.plan_id} status=${afterSuspendedRevise.body?.status}`);
  record(
    "the refused revise changed nothing (still SUSPENDED on the yearly plan)",
    afterSuspendedRevise.body?.status === "SUSPENDED" && afterSuspendedRevise.body?.plan_id === yearlyPlan,
    `status=${afterSuspendedRevise.body?.status} plan=${afterSuspendedRevise.body?.plan_id}`,
  );

  // --- cleanup --------------------------------------------------------------
  const cancelled = await call("POST", `/v1/billing/subscriptions/${subscriptionId}/cancel`, { reason: "0.10.2 check finished" });
  record("cleanup: subscription cancelled", cancelled.status === 204, `status=${cancelled.status}`);

  console.log("\n=== summary ===");
  console.log(`subscription: ${subscriptionId}`);
  console.log(`next_billing_time before/after MONTH->YEAR: ${before.nextBillingTime} -> ${after.nextBillingTime}`);
  console.log(`${results.length - failed}/${results.length} checks passed`);
  if (failed > 0) {
    console.log("\nPaste this whole output back — the FAIL lines are the ones that matter.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nABORTED: ${error.message}`);
  process.exitCode = 1;
});
