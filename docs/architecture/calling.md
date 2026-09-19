# Calling

## Access patterns

- Create call as caller.
- Fetch by id (caller, callee, or admin).
- List history by caller or callee, newest first.
- Provider callback by `providerSessionId`.

## Indexes (justified)

- `Call.providerSessionId` unique: provider callbacks.
- `Call (callerId, createdAt)` and `Call (calleeId, createdAt)`: history.
- Partial unique indexes on caller/callee for non-terminal statuses: one in-flight call per user.

## State machine

See `src/modules/calling/call-state.machine.ts`. Persistence updates `WHERE id = $id AND version = $version AND status = $from`. Zero rows means a concurrent transition; the service reloads and either no-ops (already at target) or conflicts.

**CallStatus** and **settlementStatus** are separate. API responses include derived `settlementStatus` (`PENDING` | `SETTLED` | `NOT_APPLICABLE`). `ENDED` does not imply money moved — see product contract.

## Billing

- `ratePerMinuteCents` is copied from the callee host profile at initiation and frozen on the call.
- `CONNECTED` places a one-minute hold. A recurring job extends the hold.
- If the hold cannot be extended, the call is failed for insufficient funds.
- Duration is `endedAt - connectedAt` in whole seconds. Cost is `ceil(rate * seconds / 60)`.
- Client-supplied duration is ignored.
- Settlement runs on billable end; clients must read `settlementStatus` / ledger.

## Failure modes

- Duplicate accept/reject/end: idempotent if already in a compatible terminal/target state.
- Provider duplicate callbacks: `ProviderEvent` unique key.
- Process crash: timeout/heartbeat jobs move stale `INITIATED`/`RINGING` to `TIMEOUT` and stale `CONNECTED` without heartbeat to `FAILED`, then settle.

