# Wallet and payments

## Access patterns

- Get wallet by `userId` (unique).
- Paginate ledger by `walletId, createdAt DESC, id DESC`.
- Lookup ledger/payment by `idempotencyKey`.
- Lookup provider events by `(provider, eventId)`.

## Indexes (justified)

- `Wallet.userId` unique: 1:1 wallet fetch on every call/payment.
- `WalletLedgerEntry.idempotencyKey` unique: duplicate credit/debit prevention.
- `WalletLedgerEntry (walletId, createdAt, id)`: ledger pagination.
- `Payment.idempotencyKey` unique: client retries.
- `Payment.providerPaymentId` unique: webhook correlation.
- `ProviderEvent (provider, eventId)` unique: webhook/callback idempotency.

## Transaction rules

1. Lock wallet row `FOR UPDATE`.
2. Apply balance mutation.
3. Insert immutable ledger row (credits/debits only).
4. Insert or update payment/call as needed.
5. Insert `ProviderEvent` in the same transaction as the money movement.

Never credit the wallet before inserting the unique provider event. If the unique insert fails, return the already-processed result.

## Holds

Active calls move funds from `available` to `held` without a ledger debit. Settlement writes a single `CALL_CHARGE` debit and releases leftover hold. This keeps the ledger as an economic history rather than a stream of hold noise.

Integrity invariant: `sum(CREDIT) - sum(DEBIT) = available + held`.
