# PayPal 插件使用教程(Medusa v2)

> `@mengyyy369/medusa-paypal` — 基于 Medusa v2 的 PayPal 支付 provider,
> 同时支持「一次性支付 / 保存支付方式自动续费(Vault)/ 官方 PayPal 订阅(Subscriptions)」三条路径。
> 本文是从零开始到生产上线的完整操作手册,按顺序阅读即可,每步都给出可直接复制的配置与请求示例。

---

## 目录

1. [插件能做什么](#1-插件能做什么)
2. [两条自动续费路径怎么选](#2-两条自动续费路径怎么选)
3. [环境准备](#3-环境准备)
4. [安装与注册](#4-安装与注册)
5. [数据库迁移](#5-数据库迁移)
6. [Webhook 配置(最容易出错的一步)](#6-webhook-配置最容易出错的一步)
7. [插件选项完整参考](#7-插件选项完整参考)
8. [把商品变成订阅](#8-把商品变成订阅)
9. [前端集成](#9-前端集成)
10. [完整业务流时间线](#10-完整业务流时间线)
11. [API 参考](#11-api-参考)
12. [退款(双向)](#12-退款双向)
13. [对账 Job(丢 webhook 的兜底)](#13-对账-job丢-webhook-的兜底)
14. [生产部署 Checklist](#14-生产部署-checklist)
15. [常见问题 FAQ](#15-常见问题-faq)

---

## 1. 插件能做什么

```
┌────────────────────────────── Medusa Backend ──────────────────────────────┐
│                                                                            │
│  medusa.config.ts                                                          │
│   ├── plugins: [{ resolve: "@mengyyy369/medusa-paypal", options }]         │
│   │        └─ 自动加载: modules / api 路由 / jobs / subscribers            │
│   └── modules: payment ─ providers: [paypal]                              │
│                └─ dependencies: ["paypalSubscription", ...] (可选启用订阅)  │
│                                                                            │
│  ├── paypalSubscription 模块(两张表)                                       │
│  │     paypal_plan        商品变体 × 货币 → PayPal 计费计划缓存             │
│  │     paypal_subscription 订阅行(状态/金额/销售流水/退款流水)              │
│  ├── API 路由                                                              │
│  │     POST /hooks/payment/paypal            支付 webhook(Medusa 标准)     │
│  │     POST /hooks/paypal/subscriptions      订阅 webhook(本插件)          │
│  │     admin/paypal/*                        admin 管理订阅/计划           │
│  │     store/paypal/*                        顾客自助/Buttons/令牌         │
│  ├── Job: paypal-subscription-reconciliation 每日对账兜底                   │
│  └── Subscriber: paypal-refund-sync          面板退款同步                   │
└────────────────────────────────────────────────────────────────────────────┘
                              │                     │
             ① 标准支付流(Checkout)         ② 官方订阅流(Subscriptions)
        POST /v2/checkout/orders        POST /v1/billing/subscriptions
        (含 vault 保存支付方式)           (PayPal 托管计费/重试/自助)
                              │                     │
                              └──────── PayPal API ──┘
```

能力一览:

| 能力 | 说明 |
| --- | --- |
| 一次性 PayPal 支付 | 标准 checkout 流程,支持 Card Fields / 智能按钮 / 跳转 |
| 保存支付方式(Vault) | 结账时经 PayPal Vault 保存买家钱包,后续免打扰扣款 |
| 官方订阅(Subscriptions) | 商品变体标记后走 PayPal Billing 计划,PayPal 负责周期计费、失败重试、买家自助管理 |
| 面板退款同步 | PayPal 后台退款 → `CAPTURE.REFUNDED` webhook → 自动记入 Medusa 退款 |
| Admin 退款 | Medusa 后台对(含订阅产生的)订单退款 → 调用 PayPal capture 退款 |
| 每日对账 | 定时 job 把漏掉的扣款/未完成的首购补回来,幂等不重复 |
| 生命周期管理 | admin 取消/暂停/恢复;顾客自助取消;与 PayPal 侧状态双向对齐 |

---

## 2. 两条自动续费路径怎么选

| 维度 | Vault 自动续费(Vault + 外部引擎) | 官方订阅(Subscriptions,本插件内置) |
| --- | --- | --- |
| 计费调度 | 外部引擎(如 `@mengyyy369/reorder`)负责账单日程、催缴、换卡 | PayPal 全托管:按时扣款、失败自动重试、买家在 PayPal 内自助管理 |
| 扣款方式 | 每次用 `vault_id` 建 v2 order 并捕获(免打扰) | PayPal Billing 周期扣款,webhook 通知 |
| 需要额外账号开通 | 参考交易(ref transactions)+ 「Save payment methods」开关 | PayPal 商业账号勾选 Subscriptions 能力 |
| 商品侧配置 | 无;引擎决定金额 | 变体 metadata 声明周期/试用/设置费 |
| 适合 | 已有计费引擎、需要复杂计费规则(用量计费) | 标准周期订阅、想省掉自建调度 |

两条路径**可以并存**:没标记订阅 metadata 的变体完全走原来的支付流程。

---

## 3. 环境准备

### 3.1 版本要求

| 组件 | 要求 |
| --- | --- |
| Medusa | `>= 2.20.*`(推荐 `latest`);旧版本见 README 兼容矩阵(`0.2.6` 支持 2.13–2.19) |
| Node.js | Medusa 2.20 官方要求版本(建议 20/22 LTS) |
| PostgreSQL | Medusa 需要(推荐 14+) |
| Redis | 可选(本地没有会用 fake bus,生产建议启用) |

检查你的 Medusa 版本:

```bash
npm list @medusajs/medusa
```

### 3.2 PayPal 开发者账号准备

1. 打开 <https://developer.paypal.com> → 登录 → **Apps & Credentials**。
2. **创建 REST App**(或沿用已有),记录:
   - `Client ID`
   - `Secret`(可生成新 secret)
3. **开启 Subscriptions 能力**(做订阅必须):进入 App 详情 → **Features** →
   **Subscriptions — Set up recurring payments for customers** → 开启。
   开启后 REST App 才有权访问 `/v1/billing/*`。
4. (仅 Vault 路径需要)**Save payment methods**:App 详情 → Features →
   **Save PayPal and Venmo payment methods** → 开启;
   同时商业账号侧:Account Settings → Payment preferences →
   “Save PayPal and Venmo payment methods” 通过资格审核。
5. **沙箱账号**:Sandbox → Accounts 里建/用现成的:
   - 一个 **Business**(商家,即上面 App 的持有者)
   - 一个 **Personal/Buyer**(买家,用于批准订阅、付款)

> ⚠️ 生产环境:上述能力在正式账号上也需要开通,并建议先用沙箱完整验证一遍
> (本插件所有功能均已在沙箱真实回归,见第 15 节 FAQ 末尾)。

### 3.3 让本地环境公网可达(webhook 必需)

PayPal webhook 需要**公网能访问到你的后端**,本地开发可用内网穿透:

```bash
# 方式一: pinggy(免费隧道,60 分钟过期,适合联调)
ssh -p 443 -R 0:localhost:9000 a.pinggy.io
# 输出里拿 https://xxxx-xxx-xxx-xxx.run.pinggy-free.link

# 方式二: ngrok
ngrok http 9000

# 方式三: cloudflared
cloudflared tunnel --url http://localhost:9000
```

拿到公网 URL 后,webhook URL 就是 `https://<公网域名>/hooks/payment/paypal` 与
`https://<公网域名>/hooks/paypal/subscriptions`(见第 6 节)。

> 免费隧道会过期:过期后 webhook 收不到,但**每日对账 job 会兜底补单**
> (见第 13 节),不会丢扣款。联调时记得及时重建隧道并重新 PATCH webhook URL。

---

## 4. 安装与注册

### 4.1 安装

```bash
npm install @mengyyy369/medusa-paypal
```

### 4.2 最小配置(仅一次性支付 + Vault)

`medusa.config.ts`:

```ts
import { defineConfig } from "@medusajs/framework/utils";

export default defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET!,
      cookieSecret: process.env.COOKIE_SECRET!,
    },
  },
  admin: { disable: false },
  plugins: [
    {
      resolve: "@mengyyy369/medusa-paypal",
      options: {
        clientId: process.env.PAYPAL_CLIENT_ID,
        clientSecret: process.env.PAYPAL_CLIENT_SECRET,
        isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
        includeShippingData: false,
        includeCustomerData: false,
      },
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "@mengyyy369/medusa-paypal/providers/paypal",
            options: {
              clientId: process.env.PAYPAL_CLIENT_ID,
              clientSecret: process.env.PAYPAL_CLIENT_SECRET,
              isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
              webhookId: process.env.PAYPAL_WEBHOOK_ID,
              includeShippingData: false,
              includeCustomerData: false,
            },
          },
        ],
      },
    },
  ],
});
```

> `plugins` 数组是**必须**的,不能只配 provider:插件模块、API 路由、job、subscriber
> 都靠它自动加载。provider 与 plugin 的 options 可以相同。

### 4.3 启用订阅(加一行 dependencies)

在 payment module 上追加 `dependencies`,把插件自带的 `paypalSubscription` 模块
以及订阅引擎依赖的 `order` / `product` / `query` 注进来:

```ts
modules: [
  {
    resolve: "@medusajs/medusa/payment",
    dependencies: ["paypalSubscription", "order", "product", "query"], // ← 订阅开关
    options: { providers: [/* 同上 */] },
  },
],
```

> 不加这一行:普通支付、Vault 完全不受影响;只是订阅相关能力不可用。
> `query` 是必填依赖(续费建单、订单解析、退款同步都通过它查 Medusa 聚合)。

### 4.4 环境变量(.env 示例)

```env
DATABASE_URL=postgres://medusa:password@127.0.0.1:5432/medusa
PAYPAL_CLIENT_ID=xxxxxx
PAYPAL_CLIENT_SECRET=xxxxxx
PAYPAL_IS_SANDBOX=true
PAYPAL_WEBHOOK_ID=2TP24406V5668852N            # 支付 webhook 的 ID
PAYPAL_SUBSCRIPTION_WEBHOOK_ID=2KW72347GJ283894G # 订阅 webhook 的 ID(可选,见 6.3)
# 可选: 对账 cron 覆盖(见第 13 节)
PAYPAL_SUBSCRIPTION_RECONCILE_CRON=0 3 * * *
```

> `clientSecret` 属于机密,**绝不要提交进仓库**。

---

## 5. 数据库迁移

启用订阅后,插件会新增两张表,运行迁移即可:

```bash
npx medusa db:migrate
```

新增的表:

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `paypal_plan` | 变体 × 货币 → PayPal 计费计划缓存,保证同一变体复用同一个计划 | `variant_id`, `currency_code`, `paypal_plan_id`, `config_hash`, `status` |
| `paypal_subscription` | 一条本地订阅行,记录状态、金额、销售流水、退款流水 | `paypal_subscription_id`, `variant_id`, `payment_session_id`, `status`, `locked_amount`, `sales` (JSONB), `refunds` (JSONB) |

金额一律用 **major units**(主单位,即 `9.99` 而不是 `999`):`locked_amount = 9.99` 表示 `$9.99`,
小数位跟随币种(USD/CNY 2 位、JPY/KRW 0 位、KWD/BHD 3 位)。
`sales` / `refunds` 是 JSONB 流水,续费、退款都会追加且**幂等**(按 sale/refund id 去重)。

---

## 6. Webhook 配置(最容易出错的一步)

本插件需要**两个 webhook**,职责必须分清,否则会出现双投递或收不到事件。

### 6.1 职责总览

| Webhook | 指向的 URL | 订阅的事件 | 用途 |
| --- | --- | --- | --- |
| 支付 webhook(标准) | `https://<你的后端>/hooks/payment/paypal` | `PAYMENT.CAPTURE.*`(COMPLETED/REFUNDED/REVERSED/DENIED 等) | Medusa 标准支付事件:捕获确认、面板退款同步 |
| 订阅 webhook(插件新增) | `https://<你的后端>/hooks/paypal/subscriptions` | `BILLING.SUBSCRIPTION.*`、`PAYMENT.SALE.*` | 订阅生命周期、续费建单 |

> **URL 路径段为什么是 `paypal`**:Medusa 内部会给 provider id 自动加 `pp_` 前缀,
> 所以 webhook 路径要写**去掉 `pp_` 后的 provider id**(`pp_paypal` → `/hooks/payment/paypal`;
> 若 provider 配了 `id: "mypaypal"`,则是 `/hooks/payment/paypal_mypaypal`)。
> 写错会得到 `pp_pp_paypal`,webhook 验签/路由都失败。

### 6.2 支付 webhook(第一个)

在 PayPal Developer Dashboard → **Webhooks** → **Add Webhook**:

- **Webhook URL**: `https://<你的后端>/hooks/payment/paypal`
- **Event types**: 勾选支付类事件:
  - `PAYMENT.CAPTURE.COMPLETED`
  - `PAYMENT.CAPTURE.REFUNDED`
  - `PAYMENT.CAPTURE.REVERSED`
  - `PAYMENT.CAPTURE.DENIED`(按需)
  - `PAYMENT.CAPTURE.PENDING`(按需)
- 创建后记下 **Webhook ID**,填到 `PAYPAL_WEBHOOK_ID`。

### 6.3 订阅 webhook(第二个)

同样在 Webhooks 页 **Add Webhook**:

- **Webhook URL**: `https://<你的后端>/hooks/paypal/subscriptions`
- **Event types**: 只勾选订阅类事件:

```
BILLING.SUBSCRIPTION.ACTIVATED
BILLING.SUBSCRIPTION.SUSPENDED
BILLING.SUBSCRIPTION.CANCELLED
BILLING.SUBSCRIPTION.EXPIRED
BILLING.SUBSCRIPTION.PAYMENT.FAILED   (沙箱实测若收不到,PAYMENT.SALE.DENIED 也会被处理)
PAYMENT.SALE.COMPLETED
PAYMENT.SALE.REFUNDED / PAYMENT.SALE.REVERSED   (旧版计费协议的兜底退款事件)
```

- **不要勾 `PAYMENT.CAPTURE.*`**:这些属于支付 webhook,勾了会双投递。
  (插件内部会忽略误投过来的 `PAYMENT.CAPTURE.*`,所以误勾也不致命,但避免最好。)
- 创建后记下 **Webhook ID**,填到 `PAYPAL_SUBSCRIPTION_WEBHOOK_ID`。
  不填时回退用 `webhookId`;验签时两个 id 都会尝试,所以即使只配一个 webhook 也能工作。

### 6.4 验证 webhook

配置完成后重启 Medusa,做三件事确认:

1. **登录日志**确认路由已挂载(启动时无报错,`/hooks/paypal/subscriptions` 可达)。
2. **伪造事件被拒**:随便 POST 一个没有合法签名头的事件到订阅 webhook,
   应返回 `4xx`(验签失败),证明验签生效。
3. **真实事件可达**:在 PayPal 后台 Webhook 详情页 → **Send Test Event**(或直接跑一次真实购买),
   看 Medusa 日志收到 `POST /hooks/paypal/subscriptions` 返回 `200`。

### 6.5 换 URL / 联调时的注意事项

- 换 URL 用 **PATCH** 更新 webhook(后台点 Edit 即可),webhook **ID 和事件历史都会保留**。
- PayPal 后台对历史事件支持 **Resend**(重投),重投的事件会走完整验签 + 处理链路,
  可用于补测丢失的 webhook(本插件对重复投递幂等,重投安全)。
- 事件投递失败时 PayPal 会按退避策略重试一段时间;若重试也失败,
  每日对账 job(第 13 节)会兜底,不会漏扣款。

---

## 7. 插件选项完整参考

以下选项可同时传给 `plugins` 里的插件和 payment provider(二者通常相同):

| 选项 | 类型 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `clientId` | `string` | — | ✅ | PayPal REST App 的 Client ID |
| `clientSecret` | `string` | — | ✅ | PayPal REST App 的 Secret(机密,勿入库) |
| `isSandbox` | `boolean` | `true` | — | `true` 走 `api-m.sandbox.paypal.com`;`false` 走生产 `api-m.paypal.com` |
| `webhookId` | `string` | — | 建议 | 支付 webhook 的 ID;开启 webhook 验签与捕获确认 |
| `subscriptionWebhookId` | `string` | 回退 `webhookId` | — | 订阅 webhook 的 ID;验签时两个都尝试 |
| `includeShippingData` | `boolean` | `false` | — | 把订单的收货地址带进 PayPal order |
| `includeCustomerData` | `boolean` | `false` | — | 把客户信息带进 PayPal order |
| `autoBillOutstanding` | `boolean` | `true` | — | 订阅计划:是否自动追缴欠款 |
| `paymentFailureThreshold` | `number` | `3` | — | 订阅计划:连续失败多少次后 PayPal 暂停订阅(整数) |

---

## 8. 把商品变成订阅

### 8.1 变体 metadata 声明

在**商品变体**(ProductVariant)的 `metadata` 上写 `paypal_subscription` 键:

```json
{
  "paypal_subscription": {
    "interval_unit": "MONTH",
    "interval_count": 1,
    "trial_periods": [{ "unit": "DAY", "count": 7, "price": 0 }],
    "setup_fee": 1.99,
    "product_type": "SERVICE"
  }
}
```

字段说明:

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `interval_unit` | ✅ | `DAY` / `WEEK` / `MONTH` / `YEAR` |
| `interval_count` | — | 每 N 个周期扣一次,默认 `1` |
| `trial_periods` | — | 试用期,只支持一段;`price` 用 major units(主单位,小数位跟随币种),`0` = 免费试用 |
| `setup_fee` | — | 一次性设置费(major units,主单位),批准时收取 |
| `product_type` | — | PayPal 产品类型:`SERVICE`(默认)/ `PHYSICAL` / `DIGITAL` |

> **价格不写死**:取变体在结账货币下的实时价,所以只支持**固定价格**订阅。
> 用量计费等动态金额请走 Vault 路径(交给外部计费引擎)。

### 8.2 创建/更新示例(Admin API)

```bash
# 用 admin token 创建变体(或 PATCH 已有变体加 metadata)
curl -X POST http://localhost:9000/admin/products \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Pro 订阅",
    "options": [{ "title": "周期" }],
    "variants": [{
      "title": "Pro 月付",
      "prices": [{ "currency_code": "usd", "amount": 9.99 }],
      "metadata": {
        "paypal_subscription": {
          "interval_unit": "MONTH",
          "interval_count": 1,
          "setup_fee": 0
        }
      }
    }]
  }'
```

### 8.3 预创建计划(可选,上线前做)

首次购买时会自动在 PayPal 建产品 + 计划并缓存到 `paypal_plan`。
想在上线前预建(或排查计划状态),用 admin 端点:

```bash
curl -X POST http://localhost:9000/admin/paypal/plans/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "variant_id": "variant_xxx", "currency_code": "usd" }'
```

返回缓存的计划对象(含 `paypal_plan_id`、`status` 等)。

### 8.4 金额语义(重要)

- 购物车总额 = **完整周期价**(例如 `$9.99`)。
- 若配了试用期/设置费,首期 PayPal **只收设置费(或 0)**,试用期后第一期才收全价。
- 因此首购订单可能是**部分捕获**(例如只捕获了设置费),这是正常现象;
  实际扣款金额以订单的支付记录与 PayPal 侧为准（轨道事件带的是订阅状态，不是钱）。
- 续费单金额 = 首次下单时锁定的变体价(防止日后改价影响老用户)。

---

## 9. 前端集成

两种批准方式,不需要改后端,任选其一:

### 9.1 方式 A:Redirect(最省事,零前端改动)

1. 结账时正常创建支付 session(见 9.3),**在 session data 里带上**:

```ts
await paymentModule.createPaymentSession(paymentCollectionId, {
  provider_id: "pp_paypal_paypal",
  data: {
    customer_id: customer.id,            // 可选,订阅归属
    return_url: "https://example.store/checkout/return",  // 批准后回跳
    cancel_url: "https://example.store/checkout/cancel",  // 取消回跳
  },
})
```

2. `initiatePayment` 检测到订阅商品 → 自动创建 PayPal 订阅 →
   在 session data 里给出 `redirect_url`(批准链接)。
3. 前端拿到 `redirect_url` 后跳转(PayPal 页面上买家登录/确认)。
4. 批准后 PayPal 回跳到 `return_url`(带 `subscription_id` / `token` 等),此时正常走 `place order` 收尾。

> 订阅商品和普通商品**不能混在一个购物车**——插件会明确报错,请让订阅单独下单。

### 9.2 方式 B:Buttons(JS SDK,内嵌按钮)

用官方 `@paypal/react-paypal-js`,在 `createSubscription` 回调里调
`POST /store/paypal/subscriptions`:

```tsx
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";

export function SubscribeButton({ cart, onApproved }) {
  return (
    <PayPalScriptProvider
      options={{
        clientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID,
        components: "buttons",
        intent: "subscription",
        vault: true,
      }}
    >
      <PayPalButtons
        style={{ label: "subscribe" }}
        createSubscription={async (data, actions) => {
          // 1. 先由 Medusa 建好支付 session(见 9.3),拿到 session_id
          const res = await fetch("/store/paypal/subscriptions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id }),
          });
          const { subscription } = await res.json();
          // 2. 返回 PayPal 订阅 id,让 SDK 继续订阅审批流
          return subscription.id;
        }}
        onApprove={async (data, actions) => {
          await onApproved(); // 收尾: place order / 更新 UI
        }}
      />
    </PayPalScriptProvider>
  );
}
```

该路由是**幂等 get-or-create**:session 已带订阅(redirect 流创建过)时直接返回既有 id,
两条路径不会重复建订阅。返回体:

```json
// 201(新建)或 200(existing:true)
{ "subscription": { "id": "I-XXXX", "subscription_id": "I-XXXX", "status": "APPROVAL_PENDING" } }
```

### 9.3 一次性支付 / Card Fields(普通商品)

标准流程即可,provider id 是 `pp_paypal_paypal`(带 id 则是 `pp_paypal_<id>`):

```tsx
const createOrder = async () => {
  const { payment_session } = await sdk.store.payment.initiatePaymentSession(
    cart,
    { provider_id: "pp_paypal_paypal" }
  );
  return payment_session.data.paypal_order_id; // provider 建好的 PayPal order
};
```

Card Fields 方式**必须**先取客户端令牌:

```bash
POST /store/paypal/client-token
# → { "clientToken": "..." }
```

把 `clientToken` 传给 `PayPalScriptProvider` 的 `dataClientToken`(见 README 前端章节示例)。

---

## 10. 完整业务流时间线

### 10.1 首次购买(订阅)

| 步骤 | 发生的事 | 触发的 webhook / 事件 |
| --- | --- | --- |
| 1 | 结账 → 插件建 PayPal 订阅(APPROVAL_PENDING) | — |
| 2 | 买家批准(redirect 或 Buttons) | `BILLING.SUBSCRIPTION.ACTIVATED` → 本地行转 ACTIVE |
| 3 | PayPal 收首期(设置费/全价) | `PAYMENT.SALE.COMPLETED` → 走标准捕获机制 |
| 4 | 标准购物车结算完成 | 首购订单生成（轨道事件 `transition: payment_succeeded`） |
| 5 | 买家批准后没回店? | 对账 job 自动把首购补成订单(见 13) |

### 10.2 续费(周期扣款)

| 步骤 | 发生的事 | 触发的 webhook |
| --- | --- | --- |
| 1 | PayPal 到点自动扣款 | `PAYMENT.SALE.COMPLETED`(金额为当期价) |
| 2 | 插件自动创建**续费订单** | 同客户、同商品、锁定首购时的价格,`sale id` 作为退款锚点 |
| 3 | 本地 `paypal_subscription.sales` 追加一条流水 | 幂等:同一 sale id 重复投递不建第二单 |

### 10.3 退款(双向)

| 场景 | 路径 |
| --- | --- |
| PayPal 后台面板退款 | `PAYMENT.CAPTURE.REFUNDED/REVERSED` → 支付 webhook → 插件自动同步成 Medusa 退款(按 refund id 去重) |
| Medusa Admin 对订阅订单退款 | provider 调 PayPal capture 退款,全额/部分都支持 |

(细节见第 12 节)

### 10.4 取消 / 暂停 / 恢复

- Admin:`POST /admin/paypal/subscriptions/:id/actions`,body `{ "action": "cancel" | "suspend" | "resume" }`。
- 顾客自助:`POST /store/paypal/subscriptions/:id/cancel`(仅限本人订阅)。
- 买家也可在 PayPal 内自助取消 → 订阅 webhook 收到 `BILLING.SUBSCRIPTION.CANCELLED` → 本地同步。
- 取消语义(遵循 PayPal):未来扣款立即停止,已付周期的权益保留到期满。

---

## 11. API 参考

### 11.1 Admin(全局 admin 鉴权)

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/admin/paypal/subscriptions` | query:`status` `customer_id` `variant_id` `limit` `offset` | `{ subscriptions: [...] }` |
| GET | `/admin/paypal/subscriptions/:id` | — | `{ subscription }` |
| POST | `/admin/paypal/subscriptions/:id/actions` | `{ "action": "cancel" \| "suspend" \| "resume" }` | `{ subscription }` |
| POST | `/admin/paypal/plans/sync` | `{ "variant_id", "currency_code" }` | `{ plan }` |

示例:

```bash
curl http://localhost:9000/admin/paypal/subscriptions?status=ACTIVE \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X POST http://localhost:9000/admin/paypal/subscriptions/ppsub_xxx/actions \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{ "action": "suspend" }'
```

### 11.2 Store(顾客鉴权)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/store/paypal/subscriptions` | 当前顾客自己的订阅列表(未登录 401) |
| POST | `/store/paypal/subscriptions` | Buttons 用,body `{ "session_id" }`,幂等 get-or-create |
| POST | `/store/paypal/subscriptions/:id/cancel` | 顾客自助取消(非本人订阅返回 404) |
| GET/POST | `/store/paypal/client-token` | 取 PayPal 客户端令牌(Card Fields 用) |
| POST | `/store/paypal/account-holder` | (Vault)登记 account holder,让已保存的支付方式可被列出/更换 |

### 11.3 轨道事件(`payment-rail.native_subscription.changed`)

插件**不再自己定义事件名**（0.10.0 起 `paypal.subscription.*` 已删除）：宿主把
`medusa-payment-methods` 的 `emitNativeSubscriptionChanged` 接到本插件的
`onNativeSubscriptionChanged` 选项上，事件名、载荷与发布全部由那个插件拥有
（见 README「The rail descriptor」）。每次状态变化发出的是**完整记录**：

| 字段 | 说明 |
| --- | --- |
| `transition` | `status`（状态变化）/ `payment_succeeded`（扣款成功）/ `payment_failed`（扣款失败） |
| `status` | 轨中性状态：`active` / `paused` / `past_due` / `cancelled`，或 `null`（不镜像，如 APPROVAL_PENDING） |
| `kind` | `"paypal"`（跨仓的加入键；`provider_id` 只是支付会话回显，常为 null） |
| 其余 | `provider_subscription_id` / `plan_id` / `customer_id` / `variant_id` / `interval_unit` / `interval_count` / `next_billing_at` / `last_billing_at` |

可在自己的 subscriber 里监听做通知/权益发放：

```ts
export default function subscribe({ eventBusService }) {
  eventBusService.subscribe("payment-rail.native_subscription.changed", async (data) => {
    if (data.kind !== "paypal") return;
    // 续费成功时 PayPal 侧状态仍是 ACTIVE，只有 last_billing_at 变化——
    // 所以靠 data.transition 区分「扣款成功」与「状态刷新」。
  });
}
```

未接钩子的宿主会在启动时看到一条警告，且不会发出任何轨道事件。

---

## 12. 退款(双向)

### 12.1 PayPal 面板退款 → 同步进 Medusa

在 PayPal 后台对订阅扣款做退款时,PayPal 实际发出的是
**`PAYMENT.CAPTURE.REFUNDED` / `PAYMENT.CAPTURE.REVERSED`**(不是 `SALE.REFUNDED`!),
它们投递到**支付 webhook**。插件的 `paypal-refund-sync` subscriber 会自动:

1. 从退款资源里拿 `custom_id`(对应支付 session id)定位 Medusa payment;
2. 在对应订单上记一笔退款(全额/部分都支持,按 refund id 幂等);
3. 在 `paypal_subscription.refunds` 流水里追加。

所以支付 webhook 必须勾上 `PAYMENT.CAPTURE.REFUNDED` + `REVERSED`(见 6.2)。
`PAYMENT.SALE.REFUNDED/REVERSED`(旧计费协议形状)作为兜底也会被处理。

### 12.2 Medusa Admin 退款 → 退到 PayPal

对订阅产生的订单(首购单/续费单)在 Admin 里正常退款即可:
provider 会拿到该单对应的 PayPal capture id 调退款接口,全额退款不传金额(退剩余),部分退款传金额。
退款完成后同样会把结果写进订阅行的 `refunds` 流水。

---

## 13. 对账 Job(丢 webhook 的兜底)

插件内置一个定时 job:`paypal-subscription-reconciliation`。

- **调度**:默认每天 `0 3 * * *`(凌晨 3 点),可用环境变量覆盖:

```env
PAYPAL_SUBSCRIPTION_RECONCILE_CRON=*/10 * * * *   # 联调时每 10 分钟跑一次
```

- **做什么**:
  1. 把本地 ACTIVE/SUSPENDED 订阅与 PayPal 状态对齐(补激活、收敛取消/过期);
  2. 从 PayPal 交易记录把**漏掉的扣款**补成订单(首购没结算的补首购,续费没建单的补续费单);
  3. 补偿「批准了订阅但没回店结算」的顾客(标准工作流幂等完成购物车)。
- **幂等**:每个分支都按 sale id / 订单 id 去重,重复跑不产生重复订单。

> 这是整个插件可靠性设计的地基:webhook 丢失、隧道过期、服务器宕机错过扣款,
> 只要恢复运行,对账 job 就会把账补平。本插件已在沙箱真实验证该降级路径
> (两笔真实续费在环境停机期间发生,恢复后对账 job 自动补成两笔续费订单,随后重投的 webhook 幂等跳过)。

---

## 14. 生产部署 Checklist

上线前逐项打勾:

- [ ] PayPal **生产** App 已创建,`PAYPAL_IS_SANDBOX=false`
- [ ] 生产商业账号已开通 **Subscriptions** 能力(做订阅时)
- [ ] (Vault 路径)参考交易审批 + “Save payment methods” 开关 + 资格审核
- [ ] 两个生产 webhook 已创建并指向**生产域名**,事件类型按第 6 节勾选
  - 支付 webhook:`/hooks/payment/paypal`(路径段不带 `pp_`),勾 `PAYMENT.CAPTURE.*`
  - 订阅 webhook:`/hooks/paypal/subscriptions`,勾订阅类事件,**不勾** `PAYMENT.CAPTURE.*`
- [ ] `PAYPAL_WEBHOOK_ID` / `PAYPAL_SUBSCRIPTION_WEBHOOK_ID` 配好
- [ ] payment module 的 `dependencies` 包含 `["paypalSubscription", "order", "product", "query"]`
- [ ] `medusa db:migrate` 已跑,`paypal_plan` / `paypal_subscription` 表存在
- [ ] 订阅变体的 metadata 已配(第 8 节),价格/试用/设置费与运营确认
- [ ] 前端接入完成(redirect_url 跳转或 Buttons `createSubscription`),`return_url`/`cancel_url` 可访问
- [ ] 对账 cron 确认启用(默认每天 3 点;多实例部署只让一个实例跑 job)
- [ ] 在沙箱完整回归一轮:首购、续费建单、面板退款同步、Admin 退款、取消/暂停/恢复、自助取消
- [ ] `clientSecret` 只存在于环境变量/密钥管理,不落仓库

---

## 15. 常见问题 FAQ

### Q1:webhook 一直 404 / 验签失败

- **路径写错**:支付 webhook 路径段是去掉 `pp_` 的 provider id。
  `pp_paypal` → `/hooks/payment/paypal`;配了 `id` 的 provider 带上 id 后缀。
  常见错误:写了 `pp_pp_paypal`、只配了 provider 没配 `plugins`(路由没加载)。
- **忘了加 `plugins` 条目**:provider-only 配置不会加载本插件的 API 路由/模块/job。
- **bodyParser**:Medusa 内置对 `/hooks/payment/:provider` 开了 `preserveRawBody`,
  订阅 webhook `/hooks/paypal/subscriptions` 也由插件中间件开启,不要手动改。

### Q2:订阅相关 API 报 404 / “paypalSubscription is not registered”

- 没加 `dependencies: ["paypalSubscription", ...]`(见 4.3)。
- 加了之后要**重启**并确认迁移已跑。

### Q3:PayPal 报 404(空响应体)

- 检查是不是把订阅相关资源打到了错误的 API 路径:产品在 `/v1/catalogs/products`,
  plan/subscription 在 `/v1/billing/*`。本插件内部路径已修正,若自定义脚本复现 404,
  先核对端点。
- 订阅从未扣款时,交易列表 API 返回 `INVALID_RESOURCE_ID` 是 PayPal 的已知行为,
  引擎已 try/catch 兜底,批准/首次扣款后自然消失。

### Q4:金额对不上 / 首单只捕获了一部分

- 插件内部金额一律 major units(`9.99` = `$9.99`),小数位跟随币种。
- 带试用/设置费时,首期只收设置费或 0,订单呈现部分捕获是正常的(见 8.4)。
- 续费单金额 = 首购锁定价,与改价无关。

### Q5:面板退款没有同步到 Medusa

- 确认支付 webhook 勾了 `PAYMENT.CAPTURE.REFUNDED` / `REVERSED`(见 6.2)。
- 确认订阅 webhook 上没勾 `PAYMENT.CAPTURE.*`(避免双投递混淆)。
- 退款定位靠 `custom_id`(session id);若手动构造的退款没带,同步会跳过。

### Q6:免费隧道过期后收不到 webhook

- 正常:重建隧道 + 更新两个 webhook 的 URL(PATCH 保留 id/历史)。
- 期间发生的扣款由对账 job 兜底补单,不会丢(见第 13 节)。

### Q7:订阅批准了但顾客没回店

- 标准工作流会从 `BILLING.SUBSCRIPTION.ACTIVATED` / `SALE.COMPLETED` 完成购物车;
- 万一 webhook 也丢了,每日对账 job 会补偿首购。无需人工处理。

### Q8:取消/暂停后又被激活了?

- 生命周期以 PayPal 为准,本地行先同步 PayPal 再落地;
- 若在 PayPal 侧手动操作,webhook 会把本地状态收敛回来。

### Q9:想用 PayPal MCP / 自动化工具查询沙箱

- 注意 token 缓存会过期(常见 `401 Access Token not found in cache`);
  用 REST 凭据直接换 token 即可,不需要额外授权。

### Q10:本插件沙箱实测覆盖了哪些链路?

截至 v0.4.0,已在真实 PayPal 沙箱回归:

- 产品/计划/订阅创建(试用期 + 设置费的计划一次通过);
- redirect 首购全流程、Buttons 路径、批准后未回店由对账补单;
- **两笔真实周期续费**:环境停机期间 PayPal 照常扣款,恢复后对账 job 自动补成续费订单,
  随后重投真实 `PAYMENT.SALE.COMPLETED` 走完整 webhook 链路,幂等不重复;
- 面板退款同步(真实 `PAYMENT.CAPTURE.REFUNDED` 重投,退款落到正确 payment/订单,幂等);
- suspend → activate → cancel 全链路;伪造 webhook 被真实验签拒绝。

---

## 附:更多资料

- 本文件配套代码:`README.md`(兼容矩阵、前端示例、选项表)
- Vault 外部引擎:`@mengyyy369/reorder`(负责计费调度/催缴/换卡)
- 仓库内联调脚本(未入库,仅参考):`.scratch/paypal-subscriptions/`
  (sandbox-contract-test.cjs / e2e-phase3.cjs / retarget-webhooks.cjs 等)
