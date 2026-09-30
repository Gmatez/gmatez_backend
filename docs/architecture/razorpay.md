# Razorpay payments

Gmatez collects wallet top-ups with the Razorpay Payment Gateway. Call billing and host earnings stay on the internal ledger. They are not Razorpay transfers.

## What is integrated

| Piece | Status |
|---|---|
| Razorpay Orders API | IMPLEMENTED |
| Flutter Checkout (`razorpay_flutter`) | IMPLEMENTED |
| Checkout signature `order_id\|payment_id` | IMPLEMENTED |
| Webhook raw-body HMAC (`X-Razorpay-Signature`) | IMPLEMENTED |
| Idempotent wallet credit | IMPLEMENTED |
| Payment refund API | IMPLEMENTED, needs Razorpay test keys to call live |
| RazorpayX / Route host payouts | CONFIG_REQUIRED |

## Currency

Razorpay orders are INR. Amounts are integer paise. ₹500 is `50000`. The existing `amountCents` columns store minor units. For a Razorpay payment that minor unit is a paisa, and `Payment.currency` is `INR`.

Mock and Stripe payments stay on USD so existing local tests keep working. New wallets use `PLATFORM_CURRENCY`, which defaults to INR when `PAYMENT_PROVIDER=razorpay`.

The client sends `rechargePlanId` only. The server loads `priceMinor` and `walletCreditMinor` from `RechargePlan`. A mismatched client amount is rejected.

## Lifecycle

```text
REQUIRES_ACTION   order created, checkout not confirmed
SUCCEEDED         captured payment, one PAYMENT_TOPUP ledger credit
FAILED            payment.failed, wallet unchanged
CANCELLED         checkout dismissed and Razorpay order is not paid
```

`refundStatus` is separate: `NONE | PENDING | PROCESSED | FAILED`. A call refund (`CALL_REFUND`) is not a Razorpay refund.

Wallet credit runs only after:

1. Checkout HMAC with `RAZORPAY_KEY_SECRET`, or a webhook HMAC with `RAZORPAY_WEBHOOK_SECRET` over the raw body.
2. A live `GET /v1/payments/:id` (or the signed webhook plus that fetch) shows `captured`.
3. Order id, amount, and currency match the internal `Payment` row.

The ledger key is `payment:{id}:credit`. A repeated webhook, a checkout verify, and a reconcile all share that key.

## Environment

Set these in `gmatez_backend/.env`. Do not commit them.

```env
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
PLATFORM_CURRENCY=INR
```

`RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are server-only. Flutter receives `checkout.keyId` from `POST /payments/intents`.

Startup fails if `PAYMENT_PROVIDER=razorpay` and any of the three Razorpay values is empty. Production also refuses `PAYMENT_PROVIDER=mock`.

Local mock top-ups stay available with `PAYMENT_PROVIDER=mock` outside production. `POST /payments/:id/sandbox-confirm` is not a Razorpay payment.

## Razorpay Dashboard

1. Use Test mode.
2. Copy the test Key ID and Key Secret into the server env.
3. Webhook URL: `https://<api-host>/api/v1/payments/webhooks/razorpay`
4. Webhook secret: the value you set as `RAZORPAY_WEBHOOK_SECRET`.
5. Events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`.

The handler reads `X-Razorpay-Signature` and `X-Razorpay-Event-Id`. It does not accept the mock header `x-provider-signature` for this route.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/payments/intents` | User. Body: `rechargePlanId`, `idempotencyKey` |
| POST | `/api/v1/payments/:id/verify` | User. Body: `razorpayOrderId`, `razorpayPaymentId`, `razorpaySignature` |
| POST | `/api/v1/payments/:id/abandon` | User. Checkout closed |
| GET | `/api/v1/payments/:id` | Owner |
| POST | `/api/v1/payments/webhooks/razorpay` | Razorpay signature |
| POST | `/api/v1/admin/payments/:id/reconcile` | Admin. Fetches the order and credits a captured payment that was missed |
| POST | `/api/v1/admin/payments/:id/refund` | Admin. Razorpay refund of the captured top-up |

## Refunds

Admin refund debits `creditCents` with reason `PAYMENT_REFUND` only when the wallet can cover it, then calls `POST /v1/payments/:id/refund` for `amountCents` (the money paid). If Razorpay rejects the refund, the wallet debit is reversed. A second processed refund does not debit again.

This does not reverse a call. Call reversals stay on `POST /api/v1/admin/calls/:id/refund`.

## Host earnings and payouts

Call settlement is unchanged. `CREATOR_SHARE_BPS` defaults to `8000` (80% of the call charge to the host, 20% platform remainder). The share is snapshotted on the call. A Razorpay top-up does not create a host earning.

Gmatez is a marketplace: users buy credits, then per-minute calls move credits to the host wallet. Razorpay Route splits a payment at capture time, which does not match per-minute settlement. RazorpayX payouts are the rail that matches a later withdrawal. That rail is not activated. `PATCH /admin/payouts/:id` with `COMPLETED` is rejected so the admin UI cannot claim a bank transfer.

## Tests without live keys

`src/providers/payments/razorpay-payment.provider.spec.ts` and `src/modules/payments/payments-razorpay.service.spec.ts` cover signatures, amount and currency mismatch, unknown orders, failed payments, and duplicate webhook delivery. They do not call Razorpay.

A live test-mode payment needs the three env values above, a public webhook URL, and a recharge plan whose `priceMinor` is the paise amount. Do not paste secrets into source files.
