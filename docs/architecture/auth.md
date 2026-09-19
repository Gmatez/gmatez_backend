# Auth

## Access patterns (CURRENT)

- Register and login by email (unique).
- Phone OTP request/verify (`/auth/phone/otp/*`) — primary Flutter path; creates user+profile+wallet on first verify.
- Refresh by hashed refresh token lookup.
- Email OTP by email, stored in Redis as a hash with TTL.

## Providers

- `OTP_PROVIDER=mock|sms` (see `docs/ENVIRONMENT_CONFIGURATION.md`).
- Mock OTP (local/test only): HMAC in Redis; optional `MOCK_OTP`; never allowed in production config.
- SMS delivery adapter is PLANNED (Phase 2).

## Security

- Passwords hashed with argon2id.
- Refresh tokens stored hashed (SHA-256). Rotation on refresh. Reuse of a revoked token revokes the whole family.
- OTP hashed with HMAC-SHA256 and pepper. Never logged.
- JWT access tokens are short-lived. Authorization is always re-checked against `User.status`.
- Production refuses `OTP_PROVIDER=mock` and rejects `ALLOW_MOCK_PROVIDERS=true`.

## Concurrency

- Unique email / phone constraints guard duplicates.
- Refresh rotation uses a transaction: mark used, insert new.
