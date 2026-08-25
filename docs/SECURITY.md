# SmartChat — Security Model

Threat model in one line: **an attacker controls a visitor's browser, a customer's website, and can
sign up for a free account.** Everything below follows from assuming all three at once.

## 1. Trust boundaries

| Input | Trust |
| --- | --- |
| Visitor message body, name, email, custom fields | none |
| `Origin`, `Referer`, `User-Agent`, page URL/title reported by the widget | none — recorded as claims, never used for authorisation |
| Property public id in the snippet | identifies, authorises nothing |
| Uploaded file name, MIME type, size reported by client | none — re-derived server side |
| Any id in a URL or body (`conversationId`, `visitorId`, `propertyId`) | none — re-resolved against the caller's tenant on every request |
| Session cookie / API key / connection ticket | verified credential, still permission-checked |

## 2. Controls by attack class

**Broken access control / IDOR** — the primary risk in a multi-tenant product. Every tenant query
goes through a repository that requires a `TenantContext`; composite foreign keys make cross-tenant
references impossible in the schema itself; cross-tenant reads return 404. A mandatory automated
isolation suite asserts this per resource type and blocks CI.

**Privilege escalation** — permissions are data, checked server side per route. A user can never
grant a permission they do not hold; role edits are audit logged. Platform admins live in a separate
table and a separate role space, unreachable from any tenant session.

**XSS** — message bodies are stored raw and escaped at render. React escapes by default; the two
places that must render rich content (knowledge base articles, formatted agent replies) run through
an allowlist sanitiser server side, and the output is re-checked client side. `dangerouslySetInnerHTML`
is banned outside that sanitiser. Strict CSP on dashboard and widget panel: no `unsafe-eval`, no
inline scripts without a nonce.

**CSRF** — dashboard sessions are `SameSite=Lax` httpOnly cookies plus a double-submit token on
state-changing requests. The widget surface uses a bearer visitor token, not a cookie, so it is not
CSRF-reachable.

**SQL injection** — Prisma parameterises everything. The rare `$queryRaw` uses tagged templates
only; string-concatenated SQL is banned and caught in review.

**SSRF** — webhook URLs are validated at save time and again at delivery: HTTPS only, public DNS
resolution only, private/link-local/loopback/metadata ranges rejected after resolution, redirects
not followed, hard timeout.

**Malicious upload** — extension allowlist, MIME allowlist, magic-byte sniffing of the real content,
size cap, randomly generated storage keys (client filename never becomes a path), served from a
separate bucket with `Content-Disposition: attachment` and a non-executing content type, private by
default behind short-lived signed URLs. Path traversal is structurally impossible because the client
never supplies a path.

**Brute force / credential stuffing** — Argon2id hashing, per-IP and per-account login rate limits
with exponential lockout, constant-time comparison, generic failure messages, and an audit event for
every failure. Password reset and email verification tokens are single-use, hashed at rest and
short-lived.

**WebSocket abuse** — authenticate before joining any room, origin-validate the handshake, rooms
derived from server-side identity only, per-socket message and payload limits, strike-based
disconnect and temporary ban.

**Spam / flooding** — layered limits: per visitor, per property, per account, per IP. Configurable
ban system (temporary and permanent) at visitor and IP level.

**Secret exposure** — API keys stored as SHA-256 hashes and shown exactly once; webhook secrets never
returned by any endpoint after creation; `.env` is gitignored; no secret is ever logged (the logger
has a redaction list); the widget snippet contains no credential at all.

## 3. Rate limits (Redis-backed, per surface)

| Surface | Limit |
| --- | --- |
| Login | 5 / 15 min per IP+email, then exponential lockout |
| Register / forgot-password / resend-verification | 3 / hour per IP |
| Widget session creation | 30 / min per IP |
| Visitor messages | 20 / min per visitor, 300 / min per property |
| File uploads | 10 / hour per visitor, 100 / hour per account |
| Dashboard API | 600 / min per session |
| Public API | per-key quota from the account's plan |
| Webhook deliveries | per-endpoint concurrency cap + backoff |

## 4. Privacy

Configurable per account: data retention windows for conversations, visitors and sessions; visitor
and contact erasure; conversation deletion; full account export. Location is derived to
country/region granularity only. Consent mode can gate visitor tracking before a chat is started.
Sensitive fields are minimised by default — we do not collect what we do not need.

## 5. Audit logging

Append-only. Actor, action, resource type, resource id, IP, user agent, timestamp, before/after
metadata. Covers login/logout, password and email changes, property and widget changes, member and
role changes, API key and webhook lifecycle, data exports and deletions, and account
suspension/activation.

## 6. Verification

`/docs/SECURITY_AUDIT.md` is produced in Phase 14 and records an explicit, tested result for every
item in this document. An untested control is not a control.
