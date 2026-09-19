# Phase 6 — production hardening

## Call money

- Create uses optional `idempotencyKey` (unique on `Call`). Concurrent identical keys return one call.
- Settlement marks `settlementAppliedAt` once; charge/earning ledger keys are `call:{id}:charge` / `call:{id}:earning`.
- Admin refund uses `call:{id}:refund` (+ earning reverse). Duplicate refunds do not double-credit.
- Host share: `CREATOR_SHARE_BPS` (default 8000). Changing the percentage is **BUSINESS_RULE_REQUIRED**.

## Wallet / payments

- All mutations go through `WalletService.applyLedger` inside DB transactions.
- Admin reconcile: `GET /admin/users/:id/wallet/reconcile` (diagnostic only; no auto-correct).
- Stripe provider requires `STRIPE_SECRET_KEY` (**CONFIG_REQUIRED**). Mock remains for test/dev; production refuses mock.
- Webhooks: HMAC verify → `ProviderEvent` unique `eventId` → credit once.

## Payouts

- Host must save a `PayoutDestination` before `POST /payouts`.
- Request debits wallet with idempotent key; admin completes/rejects via admin APIs.
- External payout rail after destination capture is **BUSINESS_RULE_REQUIRED**.

## Notifications / FCM

- Device tokens + preferences (`NotificationPreference`).
- FCM provider throws without `FIREBASE_SERVICE_ACCOUNT_JSON` (**CONFIG_REQUIRED**). No fake delivery success.

## Safety / admin

- Block/report with admin visibility; report optional `referenceType`/`referenceId`.
- Admin: users, hosts, calls, payments, wallet adjust/reconcile/refund, payouts, reports, audit logs.
- Socket gateway: JWT access only, ACTIVE status, conversation room membership + block checks.

## Observability

- Fastify request IDs; pino redacts auth/OTP/tokens.
- Prefer structured logs with callId / paymentId / userId (never secrets).
