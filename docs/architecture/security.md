# Security baseline

Every route is classified as public, authenticated, or admin.

IDOR rule: a user may only read/mutate resources they own, except:

- Public profile fields of discoverable, non-blocked users.
- Callee/caller may see the call they participate in.
- Admin role for `/api/v1/admin/*`.

Webhooks authenticate via HMAC signature, not JWT.

Rate limits (Redis): auth endpoints are stricter than general API. Call initiation is limited per user.

Never return password hashes, refresh token hashes, OTP, or raw provider secrets. Access tokens appear only in the login/refresh response body, never in logs.
