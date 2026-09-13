# Auth

## Access patterns

- Register and login by email (unique).
- Refresh by hashed refresh token lookup.
- OTP by email, stored in Redis as a hash with TTL.

## Security

- Passwords hashed with argon2id.
- Refresh tokens stored hashed (SHA-256). Rotation on refresh. Reuse of a revoked token revokes the whole family.
- OTP hashed with HMAC-SHA256 and pepper. Never logged.
- JWT access tokens are short-lived. Authorization is always re-checked against `User.status`.

## Concurrency

- Unique email constraint is the duplicate-registration guard.
- Refresh rotation uses a transaction: mark used, insert new.
