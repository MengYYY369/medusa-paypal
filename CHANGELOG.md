# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.5] - 2026-10-10

_0.10.4 上线后在真实生产复验时发现：归属兜底写的「payment session → cart 链接 → cart」这条
链路在**支付 provider 内部跑不通** —— provider 是在自己的 localContainer 里构造的，cradle 只能
解析宿主 `dependencies` 里列出的模块键（`product`/`order`/`paypalSubscription` 都在，`query`
不在），`resolveQueryFromCradle` 拿不到 query，兜底静默返回 NULL。结果是 0.10.4 的修复在生产上
只对「用根容器的调用方」生效，重定向结账仍写 NULL 归属、R5 仍不拦。_

### Fixed

- **归属改读 payment session 的 context**：`resolveCustomerIdForSession` 先读
  `session.context.customer.id`（Medusa 建 session 时从购物车填入，任何结账路径都有），
  读不到才退回原来的 cart 链接查询；且 `query` 缺失不再导致整条链路短路（只有退回路径需要它）。
  重定向结账与每日对账补归属现在都不依赖宿主配置。

### Tests

- 新增 2 例：provider 无 `query` 时从 session context 取到归属；同一条件下 R5 拦下第二条存活订阅
  且不调用 `createSubscription`。

## [0.10.4] - 2026-10-10

_生产回归发现：订阅结账走的是「重定向到 PayPal」这条路，而这条路只在宿主把 `customer_id` 写进
payment session data 时才会给订阅行记归属 —— 宿主（storefront）把该字段当作“勾了自动续费”的
vault 信号，订阅结账从不写，于是线上 4 条订阅行的 `customer_id` 全是 NULL。后果有两层：
客户自己的订阅列表查不到（`GET /store/paypal/subscriptions` 返回空）、取消/改签一律 404；
R5「同商品只允许一条存活订阅」守门也永远查不到冲突行，重复订阅不被拦。_

### Fixed

- **订阅归属兜底**：`initiateSubscriptionSession` 在调用方没给 `customerId` 时，沿
  payment session → `cart_payment_collection` → `cart.customer_id` 反查归属并写进行。
  访客结账（购物车无客户）仍为 NULL，语义不变。
- **R5 守门下沉到重定向流程**：`initiateSubscriptionSession` 在创建 PayPal 订阅**之前**
  调用 `assertNoConflictingSubscription`。此前该守门只在
  `POST /store/paypal/subscriptions`（Buttons 流程）里，而重定向流程在 `initiatePayment`
  阶段就建好订阅，那个路由会因 `paypal_subscription_id` 已存在而短路，守门形同虚设。
  冲突时抛 `INVALID_DATA` + `SUBSCRIPTION_ALREADY_ACTIVE`，且**不会**在 PayPal 侧留下孤儿订阅。
- **对账补归属**：`reconcile()` 新增第 4 个计数 `customersBackfilled`，对 `customer_id` 为 NULL 的
  行按同一条链路反查补写 —— 已部署环境的历史行在次日对账（或手动跑一次对账）后自愈。

### Tests

- 新增 4 例：重定向流程从购物车反查归属；访客结账仍为 NULL；重定向流程触发 R5 且不调用
  `createSubscription`；对账把 NULL 归属补回。

## [0.10.3] - 2026-10-10

_订阅 webhook 在 2026-10-10 被补上了 `BILLING.SUBSCRIPTION.RE-ACTIVATED`（此前宿主侧未勾选，插件侧也无分支）。插件侧补分支是因为：买家在 PayPal 侧自行恢复订阅（或在 PayPal 重试扣款成功后由 PayPal 自动恢复）时，此前事件落进 `switch` 的 `default`，只回一句 `not_supported`，本地行会一直停在 `SUSPENDED` —— 前台显示“已暂停”、续费日为空，直到第二天凌晨的 `reconcile()` 才被拉回 `ACTIVE`。_

### Fixed

- **恢复订阅（resume）由 webhook 即时落库**：新增 `BILLING.SUBSCRIPTION.RE-ACTIVATED` 分支，与
  `ACTIVATED` 共用 `onSubscriptionActivated(resource, eventType)` —— 该函数本就覆盖
  `SUSPENDED → ACTIVE`（连同 `backfillNextBillingAt`），所以恢复时同一次写库带上事件自带的
  `billing_info.next_billing_time`，并只发一次 `transition: "status"` 的 rail 事件。
  已 `ACTIVE` 的行不受影响（不重复发事件），未知订阅只 warn。
  **注意与后台手动恢复的区别**：管理端 `requestLifecycleAction(row, "resume")` 是“先改 PayPal、
  再改本地行”，事件到达时本地已是 `ACTIVE`，因此不会多发事件；本分支覆盖的是
  **买家侧/ PayPal 侧**发起的恢复。
- **日志文案按事件名区分**：`onSubscriptionActivated` 现在把收到的 `eventType` 写进 warn，
  此前 RE-ACTIVATED 的未知订阅日志会误写成 `BILLING.SUBSCRIPTION.ACTIVATED`。
- **宿主侧配置**：订阅 webhook（`subscriptionWebhookId`）需勾选 `BILLING.SUBSCRIPTION.RE-ACTIVATED`，
  否则恢复仍只能靠每日对账；README 的 webhook 事件清单已补该条。

### Tests

- 新增 `webhook: BILLING.SUBSCRIPTION.RE-ACTIVATED (resume)` 三例：`SUSPENDED → ACTIVE`
  且续费日随事件落地并发一次 rail 事件；行已是 `ACTIVE` 时不发事件；未知订阅只 warn。

## [0.10.2] - 2026-10-10

_来自 2026-10-10 的 PayPal 沙箱实测（`.scratch/paypal-subscriptions/sandbox-plan-switch-2026-10-10.md`）：0.10.1 的改签实现把 PayPal 的「改签需买家同意」当成了同步生效，本地行在买家还没点同意时就已经改成了新计划。_

### Fixed

- **改签是买家同意流程，不是一次写入** (#09)：`POST /v1/billing/subscriptions/{id}/revise`
  返回 **200 + `rel=approve` 链接**，在买家打开该链接确认之前 PayPal 仍按旧计划计费
  （PayPal 文档原文："This type of update requires the buyer's consent"）。0.10.1 却在这之后
  立刻把本地行改成新计划，于是前台显示的计划与 PayPal 实际扣费的完全不一致。现在：
  `customerRevise` 返回 `{ subscription, approvalUrl, pending }`，**pending 期间本地行不动**
  （`subscription` 仍是旧计划，`pending: true`，`approval_url` 给前台跳转）。
  改签真正落地走两条路：`BILLING.SUBSCRIPTION.UPDATED` webhook（新增分支，见下）与每日
  对账（新增 plan 漂移自愈）。PayPal 若未返回同意链接，则视为无需同意、当场落库
  （`pending: false`）。
- **改签只在 `ACTIVE` 时发起** (#09)：沙箱实测 `SUSPENDED` 订阅调 revise 得到
  `422 SUBSCRIPTION_STATUS_INVALID`（"subscription status should be active"），跨产品用例
  因此永远走不到 `PLAN_PRODUCT_NOT_COMPATIBLE`。状态守卫由 `ACTIVE | SUSPENDED` 收窄为
  仅 `ACTIVE`，报错直接给出出路（"Resume the subscription first, then switch its plan."）。
- **`BILLING.SUBSCRIPTION.UPDATED` 现在会被处理** (#09)：新增 webhook 分支 →
  `onSubscriptionUpdated`：按 `paypal_subscription_id` 找到行 → 用事件自带的
  `billing_info.next_billing_time` 刷新续费日（不额外调 PayPal）→ 若 `plan_id` 与本地不同，
  用 `listPaypalPlans({ paypal_plan_id })` 反查回 variant，再落库。PayPal 报来本插件不认识的
  plan id 时只 warn 并保留本地计划（行里留着的仍是可计价的计划）。
  **宿主需要在订阅 webhook 里勾选 `BILLING.SUBSCRIPTION.UPDATED`**，否则改签只能靠每日对账收敛。
- **对账会修 plan 漂移** (#09)：`reconcile()` 在状态对齐、续费日回填之后，比对
  `subscription.plan_id` 与本地 `paypal_plan_id`，不一致则走同一条反查落库路径，
  把「买家已同意但 webhook 丢了」的改签补齐（计入 `aligned`）。
- **三条路径共用一个落库函数** (#09)：新增私有 `applyPlanSwitch(row, target)`，
  variant / plan id / 锁定金额 / 计费周期一起搬移，并只发一次 `transition: "status"` 的
  rail 事件 —— 改签、UPDATED webhook、对账三处的本地结果完全一致。

### Changed

- **改签接口响应体**（`POST /store/paypal/subscriptions/:id/revise`）由 `{ subscription }`
  变为 `{ subscription, approval_url, pending }`；仍返回 200，`pending: true` 时
  `subscription` 是**未改动**的旧计划行，前台应把买家送到 `approval_url` 并在返回后重新拉取订阅。
  `pending: false` 表示改签已生效（`approval_url` 为 `null`）。
- `PaypalService.reviseSubscription` 的文档注释按实测修正（只接受 `ACTIVE`、需买家同意），
  并保留 PayPal 响应体（含 `links`）以便读取同意链接。
- README 的「Plan switch」契约同步更新。

### Tests

- `subscription-engine.spec.ts`：新增「需要同意时把买家交给 PayPal」「`payer-action` 链接同样
  可用」「UPDATED 落库改签」「未知 plan 只 warn」「plan 未变只刷续费日」「UPDATED 忽略未知订阅」
  「`SUSPENDED` 被拒并提示先 resume」「对账修复 plan 漂移」；原「就地改签」用例补 `pending: false`
  断言，no-op 用例改用 `subscription.variant_id`。

## [0.10.1] - 2026-10-10

_来自 2026-09-21/22 源码审查工单（`.scratch/source-repo-fixes/issues` #01–#07），全部条目均已落地。_

### Fixed

- **empty credentials fail loudly instead of as a PayPal 401** (#01): every entry
  point that builds a client asserts the resolved configuration first
  (`assertPaypalConfigured`, throwing the named `PaypalNotConfiguredError`), so a
  missing credential pair reads as "PayPal is not configured" instead of the
  SDK's `Basic Og==` → 401. The shared helper is `resolvePaypalClient` (the
  client-token route and the subscription-webhook route both go through it); the
  rail's vault-binding path runs the same guard at its first call and maps it to
  a 500 `unexpected_state`. There is deliberately **no** environment-variable
  fallback: the host reads `PAYPAL_*` itself and passes the values in explicitly
  (`medusa-config.ts`), and the admin settings page is the runtime layer.
- **deletePayment tolerates the two session shapes that are not orders** (#02):
  a native subscription session (`paypal_subscription_id` / `is_subscription`)
  has its PayPal billing subscription cancelled best-effort — the cancel
  endpoint is posted the reason `Abandoned checkout` and any failure is logged
  rather than raised — and a session that never created an order (`data.id`
  absent) is reported `CANCELED` instead of throwing. Deleting a payment
  session can no longer take the cart down with it, which is what produced the
  production 500 `Could not delete all payment sessions`.
- **purchase-unit items are validated where they are mapped** (#04): a missing
  or blank `title`, a missing or non-numeric `unit_price`, and a `quantity`
  that is not a positive whole number are each rejected with an `INVALID_DATA`
  error naming the offending field and, for the title, the item's index. The
  check lives in `createOrder`'s item mapping — the only place session items
  become PayPal items — so it covers session initiation and both of
  `authorizePayment`'s order-rebuild paths at once. Previously a missing
  `quantity` escaped as a bare `TypeError` and a missing `unit_price` reached
  PayPal as the literal string `"NaN"`, both surfacing as an opaque 500.
- **approve link**: vaulted checkouts that receive `payer-action` instead of
  `approve` are now matched (both in `initiatePayment` and in
  `initiateSubscriptionSession`), eliminating the silently-missing
  `redirect_url`; the raw `links` are kept in the session data for storefronts.
  The two call sites share the exported `extractApproveUrl` helper, so the
  relation list lives in one place.
- **a second live subscription for the same product is refused at checkout**
  (#07, R5): the create route checks the buyer's live rows before creating
  anything and answers 400 with `code: "SUBSCRIPTION_ALREADY_ACTIVE"`, naming
  the product and the two ways forward (cancel it, or switch plans). Only
  `ACTIVE` and `SUSPENDED` rows block — an `APPROVAL_PENDING` row is an
  abandoned checkout and would trap the customer behind a subscription they
  never approved — and a guest checkout has no customer to key on, so this is a
  data-level guard against double-billing, not an identity check.
- **the renewal date is recorded when a subscription activates** (#07):
  `next_billing_at` is written in the same update as the status flip, from the
  ACTIVATED webhook resource (which carries `billing_info`, so no extra PayPal
  call) and from the subscription already fetched by `authorizePayment`'s
  re-query. A missing `next_billing_time` is logged and the column is left
  unset rather than filled with a guessed date; rows that were already ACTIVE
  keep their value and are backfilled by the daily reconciliation.

### Changed

- **Dependencies**: `@mikro-orm/*` dev and peer dependencies moved from 6.4.3 to
  exactly 6.6.14 to match the version embedded in Medusa 2.20, eliminating the
  duplicate-copy `improper qualified name (too many dotted names)` cart 500.
  **This plugin now requires Medusa 2.20** (or any host whose `@medusajs/deps`
  already pins mikro-orm 6.6.14); on an older host the peer range will resolve
  two mikro-orm copies again.

### Added

- **switch subscription in place** (#07): `POST /store/paypal/subscriptions/:id/revise`
  with `{ variant_id }`, authenticated as the owning customer, sends PayPal
  `POST /v1/billing/subscriptions/{id}/revise` and updates the row's variant,
  plan, interval and locked amount in place — no cancel-then-resubscribe, and
  the subscription id, its approval and its billing history are untouched. The
  request carries a deterministic `PayPal-Request-Id` (`revise-<row>-<plan>`),
  so a retry inside PayPal's 72h idempotency window reuses the same key
  instead of applying the change twice. Switches are same-product only
  (cross-product is refused with a readable error instead of PayPal's
  `PLAN_PRODUCT_NOT_COMPATIBLE`), only an `ACTIVE` or `SUSPENDED` subscription
  can be revised, PayPal's own refusal surfaces as a 400 with its message, and
  switching to the plan the customer is already on is a no-op. There is no
  proration: PayPal charges the new price from the next billing cycle. The
  change is mirrored to the rail with `transition: "status"`, which carries the
  new `plan_id` and interval.

## 0.10.0 — 2026-10-06

### Breaking

- **`@mengyyy369/medusa-paypal/binder` is gone; the subpath is now
  `…/rail`.** `createPaypalBinder` → `createPaypalRail`, which returns a
  **provider descriptor** instead of a bare binder: the binding protocol moves
  under `binding`, and the descriptor also carries PayPal's native subscription
  rail, its error mapping and its label. The host's map key changes with it
  (`binders: { … }` → `providers: { … }`, medusa-payment-methods 0.3.0).
- **The `paypal.subscription.*` events are deleted.** There is one rail event
  now — `payment-rail.native_subscription.changed` — and this package does not
  define it: the host wires `onNativeSubscriptionChanged` (exported by
  `medusa-payment-methods`) into this plugin's options, and the subscription
  engine calls it with the complete record of every transition. The name, the
  payload and the publication live in exactly one package. A host that wires
  nothing gets one warning at boot and no rail events.

### Added

- **The native rail descriptor** (`rail.native`): `listRecords` (this plugin's
  own rows as rail-neutral records), `cancel` (by PayPal's own subscription id,
  answering `skipped` / `cancelled` / `failed` instead of throwing), and
  `readVariantDeclaration` (a variant's declaration as the admin card's field
  rows).
- **`PaypalApprovalPendingError`** and the two binder predicates
  (`isAlreadyCompleted` / `isPendingApproval`), so the plugin classifies this
  package's failures without matching class names or message prose. A pending
  approval becomes a retryable 422; a consumed approval stays an idempotent
  replay.
- **`mapError`**: the credential-environment mismatch is claimed as
  `500 unexpected_state` with its message kept verbatim.

### Changed

- The rail payload's `kind` is `"paypal"` (the cross-repo join key — the row's
  `provider_id` is only a payment-session echo and is often null), and
  `transition` (`status` / `payment_succeeded` / `payment_failed`) carries what
  the deleted event names used to.
- The canonical payload fixture lives in
  `medusa-payment-methods/src/contract/`; this repo keeps a copy its tests
  assert against, so the two halves can no longer drift apart in silence.

## 0.9.5 — 2026-10-05

### Fixed

- **D1: a bind's reference is never resolved by listing.** `complete` hands
  back the vault id PayPal's create-payment-token response minted, and the
  binder contract now states that this id is authoritative the moment the
  exchange returns: callers must not verify it by listing vault payment
  methods afterwards. PayPal v3's create-then-list read-after-write latency
  drops freshly minted tokens from the list, which turned successful binds
  into 409 `bindingNotVerified` (2026-10-05 test plan, defect D1). Locked by
  a test asserting the list API is never invoked on the complete path.

### Added

- **Already-used approvals are a typed error.** When PayPal rejects the
  exchange because the approval session was already consumed, the failure now
  surfaces as `ApprovalAlreadyUsedError` (re-exported from
  `@mengyyy369/medusa-paypal/binder`) instead of a generic vault failure, so
  `medusa-payment-methods` can map it to an idempotent success with the
  method the first complete created. The error keeps type `unexpected_state`
  - an uncaught one is a loud 500, never a fabricated 400 - and its message
  never echoes the setup token id.
- **Duplicate completes replay instead of minting.** The vault exchange now
  carries a deterministic `PayPal-Request-Id` keyed by the setup token id, so
  a repeated complete of the same approval session returns the original vault
  id within PayPal's request-id window instead of creating a second
  same-provider token.

### Changed

- **The sandbox guard extends to the credential set itself (#18, walkthrough
  R11).** Credential sets can declare the environment they belong to via
  `credentialEnvironment: "sandbox" | "live"` on the binder options, the
  payment provider options and the plugin options. While a declared layer is
  the one supplying the active credentials, a contradiction with `is_sandbox`
  fails fast: the binder factory throws
  `PaypalCredentialEnvironmentMismatchError` at startup, the provider refuses
  to boot (`validateOptions`) and refuses every runtime call, and the
  subscription module's vault binding and charging engine refuse with the
  same typed error. Without a declaration nothing is checked - there is
  nothing local to compare - and a database row that overrides the
  credentials leaves the declaration inert; the admin settings "verify"
  action remains the probe against the live API.

### Tests

- 20 new jest cases (219 → 239): complete returns the created vault id with
  the list API asserted uninvoked, already-used mappings at the PayPal client
  and binder levels, the deterministic request id, and credential↔environment
  mismatch fail-fast at binder startup plus the module's bind/engine refusal
  points.

## 0.9.4 — 2026-10-04

- The exported binder now declares `kind: "paypal"` (2026-10-04 production
  walkthrough, item 5/10): `medusa-payment-methods` surfaces it in the
  `providers` list so the storefront can render one bind row per provider.


## [0.9.3] - 2026-10-03

### Added

- **Payment-method deletion.** The provider now implements the optional
  `deletePaymentMethod` (payment provider interface, `@since 2.16.0`). It
  resolves the account holder from the call context and requires the target id
  to be one of that holder's own vaulted tokens before calling
  `DELETE /v1/vault/payment-tokens/{id}` — an id outside the holder's vault is
  refused (`NOT_FOUND`), so the method cannot be turned into a blind
  delete-by-id primitive for another customer's wallet (IDOR). A `404` from
  PayPal is treated as success, keeping a retried unbind idempotent. The
  PayPal call's failures go through the existing vault sanitizer
  (`toVaultFailure`), so neither a response nor a log line can echo the token
  id.
- **`@mengyyy369/medusa-paypal/binder` subpath.** `createPaypalBinder({
  clientId, clientSecret, isSandbox })` returns a `PaymentMethodBinder`
  (`{ start, complete }`) that wraps the no-charge vault-approval flow. It is
  the PayPal implementation the `medusa-payment-methods` plugin consumes
  through its `binders` map; credentials are passed explicitly, so the binder
  reads no environment variables and holds no container reference.

### Tests

- Client-level deletion tests over a mocked vault controller: success, `404`
  idempotency, `5xx` and `401` (both sanitized to `UNEXPECTED_STATE` with no
  token id in the message), plus provider-level ownership refusal, missing
  account holder and missing id.
- Binder `start` / `complete` unit tests over the vault prototype: approval
  URL + state mapping, exchange to the payment method id, refusal of an
  unapproved setup token and pass-through of upstream failures.

## [0.9.2] - 2026-10-02

### Fixed

- **The vault-binding path can no longer resolve to the live API by
  accident.** The module's own configuration chain is
  `db -> provider options -> plugin options`, but the module declares no
  dependencies, so its local container cannot reach the payment provider's
  `providerOptions`; the last layer it can actually see is the plugin
  registration options. A host that registered the plugin as a bare string
  (no `options`) and left `is_sandbox` null in the database silently got a
  live client for the vault flow while the storefront reported the sandbox
  environment - a sandbox merchant's binding attempt then failed with a 401
  from the live API. Register the plugin with
  `options: { isSandbox: process.env.PAYPAL_IS_SANDBOX === "true" }`
  (mirroring the payment provider) and/or save the environment in the admin
  settings page.
- **One-time warning when no layer sets the environment.** When the database
  row, the provider options and the plugin options all leave `is_sandbox`
  unset, the resolved configuration still defaults to live, but the service
  now logs a single warning naming the field instead of staying silent.

### Added

- Vault-client environment regression tests: the client built for
  `is_sandbox` `true` / `false` / `null`-with-plugin-options /
  `null`-with-no-layer is asserted against its `baseUrl` and `environment`.

## [0.9.1] - 2026-10-02

### Changed

- **`completeVaultApproval()` no longer returns `customer_id`.** The field had
  been always `undefined` since 0.9.0 (the exchange response carries only the
  derived `customer.id`, because the merchant id is not sent); it is now
  removed from the result type and the returned object. Consumers read
  `status` and `vault_id`.

## [0.9.0] - 2026-10-02

### Fixed

- **Saved PayPal wallets are listable again.** PayPal's payment-token list
  endpoint resolves by the merchant-supplied `customer.id` (max 22 characters,
  `[0-9a-zA-Z_-]`), not by `customer.merchantCustomerId`. The plugin passed
  only the merchant id at vault time and then listed with the 30-character
  Medusa customer id, which PayPal rejects with `400 INVALID_STRING_LENGTH`.
  Both vault flows now send a deterministic 22-character id derived from the
  merchant id as `customer.id` and never send `customer.merchantCustomerId`,
  and the listing queries by the derived id. Same value on every instance, no
  storage and no migration. The merchant id cannot be sent: PayPal freezes a
  customer record's `customer.id` at the first `merchant_customer_id`
  association and ignores a later derived id, and Orders v2 rejects the two
  fields together with `422 INCOMPATIBLE_PARAMETER_VALUE`.
- **`permitMultiplePaymentTokens: true` on both vault paths.** The
  vault-approval setup token and the checkout `store_in_vault: ON_SUCCESS`
  branch now mint a token per customer. Without the flag PayPal reuses the
  payer's existing token, which carries a previously vaulted customer's ids,
  so the new customer's ids would never reach the stored token.
- **A customer with no vaulted tokens lists as an empty list instead of
  failing.** The listing maps `404 CUSTOMER_ID_NOT_FOUND` to `[]`; every other
  failure (including a `400`, which can no longer occur legitimately now that
  the queried id is always 22 characters) still surfaces as an error.
- **A vault setup-token response without a status is an upstream fault.**
  `getVaultSetupToken` throws `UNEXPECTED_STATE` instead of returning the
  `status: ""` sentinel, which callers could mistake for "not approved yet".

### Changed

- **Checkout vaulting now sends the derived customer id and the
  permit-multiple flag.** The `store_in_vault: ON_SUCCESS` branch keeps its
  shape and adds `paymentSource.paypal.attributes.customer.id` (the derived
  22-character id) and `attributes.vault.permitMultiplePaymentTokens`. Orders v2
  treats `customer.id` and `customer.merchant_customer_id` as mutually
  exclusive and rejects both together with `422 INCOMPATIBLE_PARAMETER_VALUE`,
  so this path sends no `customer.merchantCustomerId` — and neither does the
  vault-approval path, for the stickiness reason above.

### Notes

- **Tokens minted before 0.9.0 cannot be backfilled.** They carry a
  PayPal-generated `customer.id` and no API can change it - only deleting and
  re-vaulting would. They keep charging through the stored vault id, but they
  are not returned by the listing.
- **Re-binding accumulates tokens.** With `permitMultiplePaymentTokens: true`
  a repeat approval mints a new token rather than replacing the old one.
  Deleting the old token could break a subscription that still references it,
  so accumulation is accepted for now.
- **`completeVaultApproval()` no longer returns a `customer_id`.** The exchange
  response carries only the derived `customer.id`; consumers read `status` and
  `vault_id`.

## [0.8.0] - 2026-10-02

### Added

- **No-charge payment-method binding (vault approval).** A second, independent
  way to obtain a PayPal vault id, for cases the checkout path cannot serve -
  most importantly a free trial, which has nothing to capture and therefore
  cannot use `store_in_vault: ON_SUCCESS`. The plugin creates a PayPal Vault v3
  setup token, the buyer approves on PayPal, and the plugin exchanges the
  approved token for a permanent vault id. No money moves at any step. The
  resulting vault id is the same kind of value the checkout path stores as
  `payment_method`, so it charges through the existing off-session renewal
  path.
- **`startVaultApproval({ customer_id, return_url, cancel_url })`** on the
  `paypalSubscription` module service (resolved as
  `container.resolve("paypalSubscription")`). Returns
  `{ setup_token_id, approve_url }`; send the payer to `approve_url`.
  `return_url` and `cancel_url` must be absolute http(s) URLs or the call is
  rejected with `INVALID_DATA`.
- **`completeVaultApproval({ setup_token_id })`** on the same service. Returns
  `{ status, vault_id?, customer_id? }`. While the payer has not approved, only
  `status` is present and there is no `vault_id`; once the payer has approved
  the token is exchanged and `vault_id` is returned. `APPROVED`, `VAULTED` and
  `TOKENIZED` all mean approved-and-exchangeable (sandbox reads back
  `VAULTED`, not `APPROVED`).
- **`PAYPAL_VAULT_BINDING_CAPABILITY`** (`"vault-binding"`), exported from the
  package root as documentation of the capability. Detection is duck-typing -
  check that the resolved service exposes both `startVaultApproval` and
  `completeVaultApproval` as functions.
- **Vault v3 client methods** on the PayPal core service: create a setup token,
  read a setup token's status, and create a payment token from an approved
  setup token.

### Fixed

- **PayPal SDK client logging is left unset, so the SDK logs nothing.** The
  plugin no longer passes a `logging` config to the SDK client, so the SDK
  falls back to its `NullLogger` and emits nothing. Supplying a `logging`
  object made the SDK build its `ConsoleLogger`, which prints the request URL
  line - and the setup token lookup is `GET /v3/vault/setup-tokens/{id}`, so a
  setup token id reached stdout on every approval check. Request bodies are
  covered by the same change: they carry vault ids and setup token ids. This
  covers the plugin's own PayPal SDK client only; logging by the host
  framework is out of scope.

### Notes

- **`store_in_vault: ON_SUCCESS` is unchanged.** The checkout vault path still
  behaves exactly as before; this release adds a second, independent way to
  obtain a vault id. The two vault paths are gated separately on the PayPal
  application (see the README's "PayPal account requirements"), so an
  application without the "Save payment methods" feature can still vault at
  order time while the direct vault calls fail with a bare
  `403 NOT_AUTHORIZED`.
- Upgrading from 0.7.1 needs **no** database migration and no configuration
  change.
- The full chain - setup token, payer approval, exchange, and an off-session
  charge with the resulting vault id - was verified against the PayPal
  sandbox during development. The production account gates remain a pre-launch
  checklist item (see the README's "PayPal account requirements").

## [0.7.1] - 2026-09-29

### Changed

- **The admin extension now uses the dashboard's own i18n.** Page copy is
  translated through the admin's `react-i18next` instance (namespace `paypal`),
  so it follows the language each admin user selects in their profile. The
  plugin's own `EN | 中文` toggle, its `paypal_admin_lang` localStorage override
  and its language-detection chain are gone. `react-i18next@13.5.0` is pinned as
  a peer dependency - the import must resolve to the instance
  `@medusajs/dashboard` initialises, otherwise every `t()` returns raw keys.
- **"Change history" is now "Audit log" on its own page.** The collapsible
  section at the bottom of `/paypal` moved to a new sidebar child
  `/paypal/audit`, which lists 50 entries by default with a **Load more** button
  (the endpoint caps `limit` at 100) and a refresh button.

### Added

- **`/paypal/audit` admin route** - the field-level audit trail (actor,
  timestamp, `old → new` per field, secrets masked to their last 4 characters).

### Notes

- Upgrading from 0.7.0 needs **no** database migration.
- Admin URLs are unchanged; only a new child route was added under `/paypal`.

## [0.7.0] - 2026-09-29

### Added

- **Admin configuration page** at `/paypal`: the sidebar now has a **PayPal**
  parent entry whose page edits the nine provider options in four groups
  (credentials / environment / webhooks / advanced), shows read-only
  integration info (both webhook callback URLs, the reconciliation cron, the
  last change and the last credential check) and the last 20 field-level audit
  entries. Inherited fields render the `medusa-config` value as a grey
  placeholder plus a badge naming the source layer, and clearing a field
  restores inheritance. `clientSecret` is never returned by the API - only
  `hasSecret` and its last 4 characters. Saving runs an automatic connection
  test (fire-and-forget: it never blocks or rolls back the save) and a
  separate button tests draft values; the result is stored and shown.
- **Settings storage**: `paypal_settings` (singleton row of nullable
  field-level overrides plus a `version` that increments on every write) and
  `paypal_settings_audit` (per-write `{ field: { from, to } }` diff, secret
  values masked), created inside the existing `paypalSubscription` module.
  **Upgrading requires `npx medusa db:migrate`.** Until the migration runs,
  reads degrade with a warning and keep using the `medusa-config` values
  (payments do not break), while saves fail with a clear error.
- **Runtime config endpoint** `GET /store/paypal/config` ->
  `{ client_id, environment, configured }`: read-only, never calls PayPal,
  `Cache-Control: no-store`, scoped by the host publishable key like every
  `/store` route and requiring no customer authentication. Unconfigured answers
  200 with `client_id: null` / `configured: false`, so a storefront can render
  a disabled state; storefronts can read the client id and environment at
  runtime instead of baking `NEXT_PUBLIC_PAYPAL_CLIENT_ID` in at build time.
- **Hot reload**: a single resolver (per-field merge, keyed on the settings row
  version) is now the only configuration source, and the provider and module
  rebuild their PayPal client / subscription engine when the version or the
  resolved values change. Admin edits take effect immediately, with no
  restart.
- **Ops escape hatch** `PAYPAL_IGNORE_DB_SETTINGS` (truthy values `1`, `true`,
  `yes`, `on`): the resolver skips the DB layer entirely, so restarting the
  container with it set rolls back to the `medusa-config` state from before
  the admin edit.

### Changed

- **Configuration resolution is now per-field
  `admin settings (DB) -> payment provider options -> plugins[].options`**.
  An unset admin field inherits from the next layer, preserving both existing
  config surfaces unchanged; clearing a field removes its override.
- **`clientId` / `clientSecret` are optional at boot**: with neither set the
  plugin starts with a warning and can be configured from the admin page; with
  exactly one set it still refuses to start (typo guard). Every PayPal call
  without credentials now throws a clear "PayPal is not configured" error
  instead of a PayPal 401.
- **The module-side default environment converges to production**
  (`isSandbox: false`) when no layer sets it, matching the provider schema;
  the `paypalSubscription` module previously defaulted to sandbox. The
  client-token route derives its environment and REST base from the resolved
  config instead of `process.env.PAYPAL_SANDBOX`.
- **The plan cache hash now includes the environment** (`planConfigHash`), so
  a plan minted in sandbox is not reused in live. **Upgrade side effect**: the
  first checkout after upgrading mints one new plan per variant + currency in
  the current environment (the existing rows' hashes no longer match).
  Existing subscriptions keep their old plan and renew normally.
- **The sidebar label follows the dashboard language** (absorbed from the
  unreleased 0.6.2): the route configs declare `translationNs` and
  `src/admin/i18n/index.ts` registers the plugin's `paypal` namespace
  (`virtual:medusa/i18n`), so the sidebar shows "PayPal Subscriptions" in
  English and "PayPal 订阅" in Chinese. The English value is a byte-for-byte
  copy of the previous label.

### Fixed

- **The plugin no longer ships the never-loaded `src/api/middleware.ts`**
  (singular): the framework's middleware loader only probes `middlewares.ts` /
  `middlewares.js`, so the file was dead code. It is now
  `src/api/middlewares.ts`; besides hosting the new settings API validation,
  the rename restores `preserveRawBody: true` for
  `POST /hooks/paypal/subscriptions`, so the emitted `WebhookReceived` payload
  carries `rawData` like the standard payment webhook (signature verification
  was unaffected).
- **The connection-test endpoint actually reaches the build**: it is now
  `POST /admin/paypal/settings/verify`, renamed from
  `POST /admin/paypal/settings/test`. The framework's plugin compiler prunes
  any path containing a `test` segment
  (`_Compiler_backendIgnoreFiles`), so the old route was silently dropped from
  `.medusa/server` and every host answered 404 - the page's test button and
  the post-save auto-verification were dead, and `lastVerified*` could never
  be written. The handler behaviour is unchanged; the admin page, the
  middleware validator and the docs were updated to the new URL.
- **A missing `paypal_settings` table now fails the write readably**: saving
  settings (or recording a verification) before `npx medusa db:migrate` used
  to answer the framework's generic `500 {"code":"unknown_error"}` while only
  the log held the real `relation "paypal_settings" does not exist`. The write
  path now translates exactly that failure into a `400 invalid_data` naming
  the table and telling the operator to run `npx medusa db:migrate`; every
  other error still propagates unchanged, and the read path keeps degrading
  silently as before.
- **`POST /store/paypal/client-token` no longer 404s on hosts that register
  the provider without an explicit `id`**: it looked the provider up with an
  inline `provider.id === "paypal"` check, so a declaration keyed as
  `pp_paypal` (the common case - no `id` in `medusa-config`) answered
  `404 {"error":"Paypal provider not found"}`. It now uses the shared
  `findPaypalProviderDeclaration` lookup (which also accepts
  `resolve.includes("paypal")`) like every other consumer. This is a
  pre-existing defect, not a 0.7.0 regression.

### Breaking

- **Admin URLs moved**: subscriptions are now at `/paypal/subscriptions` and
  `/paypal/subscriptions/:id`; the old `/paypal-subscriptions*` URLs return
  404. Update bookmarks and hard-coded admin links.
- **Deployments must run `npx medusa db:migrate`**: without it the admin
  settings page cannot save, and settings reads log a warning while payments
  continue on the `medusa-config` values.

## [0.6.1] - 2026-09-27

### Fixed

- **Admin extension pages no longer 401**: the plugin's admin SDK client did
  not declare an auth type, so js-sdk sent every extension-page request with
  `credentials: "omit"` and no Bearer header - while the dashboard
  authenticates via the `/auth/session` cookie and never writes a JWT to
  localStorage, leaving those requests with no credentials at all. The client
  now declares `auth: { type: "session" }` (mirroring the dashboard's own
  js-sdk setup), so requests carry the session cookie, and a 401 surfaces as
  a friendly "session expired" message instead of a raw `Unauthorized`.

### Changed

- **Customer / product enrichment now takes effect**: the list and detail
  pages resolve customer emails and product/variant titles through the same
  SDK client, so with the auth fixed those columns show real emails and
  titles instead of raw ids - a visible change of the 0.6.0 enrichment, not a
  regression.

### Added

- **Chinese UI**: the admin extension pages now carry an English / Chinese
  dictionary. The language follows the dashboard's language setting or the
  browser language, and the subscription list page has a manual `EN | 中文`
  toggle (persisted in localStorage); the sidebar label stays English.

## [0.6.0] - 2026-09-27

### Added

- **Admin UI for PayPal subscriptions**: a built-in Medusa admin extension —
  sidebar entry "PayPal Subscriptions", a filterable/paginated subscription
  list (status chips for the full local status vocabulary, customer email and
  product/variant titles enriched client-side with graceful fallback to raw
  ids, major-unit amounts with currency, billing period, next billing date,
  failure count) and a detail page (all fields incl. PayPal plan id, payment
  session, sales/refund history) with suspend / resume / cancel actions.
  Cancel carries a strong red confirmation stating the action is irreversible
  (PayPal terminates the billing agreement); suspend/resume are reversible.
  Shipped as part of the npm package — no extra configuration. UI copy is
  English; no new runtime dependencies (`@medusajs/js-sdk` added as a
  devDependency for the bundled extension only).

### Changed

- Admin subscription list API now sorts by `created_at DESC` by default:
  offset pagination previously had no stable ordering, so concurrent webhook
  writes could shuffle rows across pages (duplicates / dropped rows).

### Fixed

- Admin lifecycle actions (`cancel` / `suspend` / `resume`) no longer surface
  PayPal rejections as opaque 500s: rejections are wrapped in a Medusa
  `invalid_data` error (`code: "paypal_rejected"`) whose message carries the
  HTTP status and PayPal issue, so the admin UI (and any API client) can show
  the actual rejection reason. State-class no-ops still converge to success
  idempotently (unchanged).

## [0.5.0] - 2026-09-22

### Changed — BREAKING: money units

- All amounts handed to PayPal are now **Medusa major units** (e.g. `9.99`),
  formatted with the currency's own `decimal_digits` instead of a hard-coded
  `/100`. The provider no longer rescales in either direction: the outbound
  `÷100` (order total, purchase-unit amount, plan price/trial/setup fee,
  refund) and the inbound `×100` (webhook capture/refund amounts) are gone, and
  `toPaypalMajorAmount`/`toMajorUnits` are replaced by
  `formatPaypalAmount(major, fractionDigits)` with
  `src/lib/currency-digits.ts` resolving digits via the currency module
  (falls back to 2 with a warning).
- **Deployment coupling**: this version must ship in the same window as the
  data migration `medusa-saas/scripts/money-minor-to-major.sql`. A deployment
  that stores amounts in minor units (cents/fen) while running this code charges
  **100× too much**; applying the SQL without this code charges 100× too little.
  Verify one real order three ways before and after: PayPal charge = admin order
  total = storefront display.
- Compatibility is unchanged here: the package still declares
  `@mikro-orm/*` **6.4.3** peers (the 6.6.14 alignment is still unreleased, see
  `[0.10.1]`), and requires Medusa 2.20.

### Fixed

- Webhook-derived capture/refund amounts are no longer inflated by 100, so
  recorded payments match the money PayPal actually moved.

### Dependencies

- `react` / `react-dom` added to `peerDependencies` (`^18.2.0`): admin bundles
  that resolve a second React copy break the dashboard, so resolution is left to
  the host app.

## [0.4.0] - 2026-09-19

### Added

- **Official PayPal Subscriptions (Billing Subscriptions API)** as a second,
  parallel billing path alongside vaulted renewals. Adoption is per-variant:
  metadata key `paypal_subscription` (interval/frequency, one trial period,
  setup fee, product type) turns a variant into a subscription product; the
  recurring price always comes from the variant's live per-currency price.

- **Plan auto-management**: PayPal products and billing plans are created on
  demand and cached in a new `paypal_plan` table keyed by variant x currency
  x configuration hash (plans are immutable on PayPal, so any price/config
  change mints a new plan version automatically). Admin route
  `POST /admin/paypal/plans/sync` for manual provisioning/inspection.

- **First-purchase checkout** (`initiatePayment` subscription branch): mixed
  subscription/regular carts are rejected with clear guidance; the PayPal
  subscription is created with the payment session id as `custom_id`, the
  approve link is exposed as `redirect_url`, and Buttons storefronts get the
  idempotent get-or-create route `POST /store/paypal/subscriptions`. The
  first order is created by the standard cart completion
  (`authorizePayment` subscription branch); the first charge flows through
  the standard captured mechanism via `PAYMENT.SALE.COMPLETED`. First-period
  amount semantics (setup fee / free trial) are exposed on events, not
  masked.

- **Subscription webhook route** `POST /hooks/paypal/subscriptions` for a
  second PayPal webhook carrying only subscription-class events
  (`BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.*`); payment-class events are
  acknowledged but never forwarded (no double delivery). New option
  `subscriptionWebhookId` (falls back to `webhookId`); signature verification
  tries both ids so mixed topologies keep working.

- **Renewal orders**: every subsequent `PAYMENT.SALE.COMPLETED` creates a
  renewal Medusa order through the injected order module - same customer,
  first-order items at locked prices, digital (no shipping), PayPal sale id
  stored on the payment as the refund anchor; duplicate events are
  idempotent. Failure events increment the subscription failure counter.

- **Bidirectional refund sync**: panel refunds (`PAYMENT.SALE.REFUNDED` /
  `REVERSED`) create Medusa refunds on the matching order (full refunds auto-
  recorded; partial refunds recorded on the subscription row), and Medusa
  Admin refunds on subscription payments refund the PayPal sale via the new
  provider branch (previously they errored on the Orders-v2-only structure).

- **Lifecycle APIs**: admin list/detail/`cancel`/`suspend`/`resume`
  (`/admin/paypal/subscriptions[...]`) and customer self-service
  (`GET /store/paypal/subscriptions`,
  `POST /store/paypal/subscriptions/:id/cancel` with ownership checks). All
  state changes - admin, customer, inbound PayPal webhooks, or PayPal-side
  self-service - emit `paypal.subscription.activated / suspended / resumed /
  cancelled / expired / payment_succeeded / payment_failed` events, only on
  actual state transitions.

- **Daily reconciliation job**
  (`paypal-subscription-reconciliation`, cron via
  `PAYPAL_SUBSCRIPTION_RECONCILE_CRON`, default `0 3 * * *`): aligns local
  status with PayPal, backfills missed charges by replaying the standard
  payment workflow, and compensates customers who approved but never
  returned to the store - all idempotent.

- **New plugin module** `paypalSubscription` (tables `paypal_plan` and
  `paypal_subscription`, first migrations shipped by the plugin - run
  `medusa db:migrate`). To enable subscriptions, add
  `dependencies: ["paypalSubscription", "order", "product"]` to the payment
  module declaration in medusa-config; without it, existing behavior is
  byte-for-byte unchanged.

### Notes

- The vault off-session renewal path and its contracts are unchanged.
- Sandbox end-to-end checklist for this feature lives in
  `.scratch/paypal-subscriptions/issues/07-sandbox-verification-and-docs.md`.

## [0.3.1] - 2026-09-10

### Fixed

- **vault:** forward `return_url` / `cancel_url` from the checkout session data into `createOrder` — PayPal rejects any order that vaults a payment source with 422 RETURN_URL_REQUIRED / CANCEL_URL_REQUIRED when the approval context lacks them (live-verified on sandbox). URLs ride in the session data; CIT-only, merchant-initiated (vaultId) charges are unaffected.

## [0.3.0]

First release of the forked package `@mengyyy369/medusa-paypal`, based on
upstream `@alphabite/medusa-paypal` 0.2.6.

### Added

- Vaulted off-session renewals: `customer_id` in the checkout payment session
  data saves a PayPal v3 payment token (`store_in_vault: ON_SUCCESS`) on
  captured orders, and the captured vault id is mirrored into the session data
  as `payment_method` (plus `vault_id` and `vault_status`) so subscription
  engines can store it as the reusable payment method reference.
- Merchant-initiated charging: `initiatePayment` short-circuits sessions that
  carry `off_session: true` and `payment_method` without creating a PayPal
  order, and `authorizePayment` creates and captures the order against the
  vault token with no buyer interaction.
- `decline_code` on off-session failures: every declined vault charge throws
  `UNAUTHORIZED` carrying the PayPal decline reason so dunning flows can
  classify it (for example `INSUFFICIENT_FUNDS`, `INSTRUMENT_DECLINED`).
- `redirect_url` on payment session data: the PayPal approval link is exposed
  for redirect-based (manual) renewal flows.
- `createAccountHolder` and `listPaymentMethods` hooks: saved PayPal wallets
  surface through the standard Payment Module interface as
  `{ id, data: { type: "paypal", email } }`.
- `POST /store/paypal/account-holder` route for storefront onboarding of the
  customer's PayPal account holder.

### Changed

- Renamed the package to `@mengyyy369/medusa-paypal` with neutral type names
  (`PaypalPluginOptions`), updated repository URLs, keywords and README.
- Aligned with Medusa 2.20: `initiatePayment` returns the session `id`
  required by current Medusa versions; peer dependencies updated to 2.20.0.
- Webhook handling: verification failures now map to `not_supported` instead
  of `failed`, so unverifiable events can no longer tear down payment
  sessions; `PAYMENT.CAPTURE.DECLINED` maps to `failed` for checkout sessions
  and `not_supported` when no session is referenced.

### Fixed

- The client-token route imported the package by its old self-name and a
  source path, both of which break at runtime; it now uses relative imports.
- `zod` is pinned as an explicit dependency (previously relied on hoisting).

### Testing

- Jest setup with 26 unit tests covering buyer-initiated payments, off-session
  vault charges, vault write-back, saved methods, account holders and webhook
  mapping.
