# Architecture Master Context

Enterprise social calling backend. Modular monolith. PostgreSQL is the source of truth.

This file is the session entry point. Read it before changing code. Then read the domain document under `docs/architecture/` for the module you are touching.

## Product

Authenticated users discover other people, place audio/video calls billed from a wallet, and top up that wallet through an external payment gateway. Media is handled by an external calling provider. This backend owns identity, authorization, call lifecycle, billing, money, notifications, moderation, and admin.

## Non-negotiables

1. PostgreSQL is authoritative for users, profiles, wallets, ledger, payments, calls, reports, blocks, and audit.
2. Redis is cache, presence, rate limits, OTP, locks, and queue infrastructure only.
3. Wallet balances are never trusted from the client. They are derived from an immutable ledger plus transactional holds.
4. Call duration and cost are computed from server timestamps, never from the client.
5. Payment and calling webhooks are signature-verified, idempotent, and applied in a database transaction.
6. Call status transitions are explicit. Invalid transitions are rejected.
7. Every mutating API is authenticated (except explicitly public auth/webhook/health routes) and authorization is server-side.
8. Secrets (passwords, OTP, tokens, provider keys) are never logged.

## Modules

| Module | Owns | May call |
| --- | --- | --- |
| Auth | Credentials, OTP, JWT, refresh rotation | Prisma (user/profile/wallet create on register) |
| Users | Account record, status, self-service | Prisma |
| Profiles | Public/self profile fields | Prisma |
| Discovery | Feed/search of discoverable profiles | Blocking, Presence (Redis) |
| Calling | Call lifecycle, provider tokens, billing settlement | Wallet, Notifications, Blocking, CallingProvider |
| Wallet | Ledger, holds, available/held balances | Prisma only |
| Payments | Payment intents and webhooks | Wallet, PaymentProvider |
| Notifications | Device tokens, push dispatch | PushProvider, Queue |
| Reports | User reports | Prisma, Admin visibility |
| Blocking | Block graph | Prisma |
| Admin | Moderation, adjustments, inspection | Wallet, Users, Reports, Calls, Payments |
| Analytics | Append-only events, coarse aggregates | Prisma |

Infrastructure (not domain): Config, Prisma, Redis, Queue, Logger, Health, Provider adapters.

## Money

- Currency amounts are integer **cents**.
- `Wallet.availableBalanceCents` and `Wallet.heldBalanceCents` are transactional caches updated in the same transaction as the ledger (and call hold rows).
- Source of truth for history is `WalletLedgerEntry` (append-only).
- Credits and debits use an application-generated `idempotencyKey` with a unique constraint.
- Concurrent wallet mutations take `SELECT … FOR UPDATE` on the wallet row.

## Calling

Valid states: `INITIATED`, `RINGING`, `ACCEPTED`, `CONNECTING`, `CONNECTED`, `REJECTED`, `TIMEOUT`, `CANCELLED`, `FAILED`, `ENDED`.

Transitions are defined in `CallStateMachine`. Persistence uses `version` optimistic concurrency plus status preconditions.

Billing starts when the call becomes `CONNECTED`. Settlement runs when the call becomes terminal. Unused holds return to available balance.

## External systems

Adapters live under `src/providers`. Each has a port (interface) and at least a `mock` adapter used in development and tests. Production configuration selects the adapter. Missing production credentials must fail startup, not silently use mock.

## API

Prefix: `/api/v1`. Swagger: `/api/v1/docs`.

Error envelope:

```json
{
  "error": {
    "code": "WALLET_INSUFFICIENT_FUNDS",
    "message": "Insufficient available balance",
    "requestId": "…"
  }
}
```

## Observability

Every request has `requestId` (incoming `x-request-id` or generated). Logs include requestId, route, status, duration, userId when authenticated, environment. Business events (payment credited, call billed, admin adjustment) are structured logs without secrets.

## Testing expectations

- Unit: state machine, billing math, webhook parsing, transition guards.
- Integration: wallet ledger, payment webhook, call persistence.
- E2E: register → login → top-up → call → settle.
- Concurrency: parallel wallet debit/credit and duplicate webhooks.
- Load: k6 scripts in `load/`.

## What this backend does not do

- Mix or store audio/video media.
- Treat Redis as a wallet.
- Trust Flutter/client validation.
- Split into microservices.
