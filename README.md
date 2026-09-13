# Enterprise Social Calling Backend

Modular monolith for authenticated discovery, wallet-billed audio/video calls, and payments.

Media is owned by an external calling provider. This API owns identity, authorization, call lifecycle, billing, money, notifications, moderation, and admin.

Read `ARCHITECTURE_MASTER_CONTEXT.md` before changing domain code.

## Stack

Node.js 22, TypeScript, NestJS, Fastify, PostgreSQL, Prisma, Redis, BullMQ, Socket.IO, Jest, k6.

## Run locally

PostgreSQL and Redis must be available. Copy `.env.example` to `.env`.

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run prisma:seed
npm run start:dev
```

API: `http://127.0.0.1:43121/api/v1`  
Swagger: `http://127.0.0.1:43121/api/v1/docs`  
Health: `http://127.0.0.1:43121/health`

Seeded users (password `ChangeMe123!`):

- `admin@example.com` (ADMIN)
- `alice@example.com` (wallet preloaded)
- `bob@example.com`

## Docker

```bash
docker compose up --build
```

## Tests

```bash
npm test
npm run test:e2e
```

Load:

```bash
k6 run load/health-and-discovery.js
```

## Money and calls

- Amounts are integer cents.
- Wallet history is an immutable ledger. Available/held balances are updated in the same transaction as ledger or hold changes.
- Payment webhooks are HMAC-verified and idempotent.
- Call duration and cost are computed from server timestamps.

Development-only helpers (disabled in production):

- `POST /api/v1/dev/payments/simulate-webhook`
- `POST /api/v1/dev/calling/simulate-callback`

Production must set `CALLING_PROVIDER`, `PAYMENT_PROVIDER`, and `PUSH_PROVIDER` to real adapters and supply their secrets.
