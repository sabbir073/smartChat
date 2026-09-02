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

**XSS** — message bodies are stored raw and escaped at render. React escapes by default, and the one
place that renders rich content (markdown in articles and formatted replies) escapes every character
of the source *first* and then inserts its own tags, so no tag is ever built from author-supplied
text; links go through an allow-list of schemes rather than a blocklist. `dangerouslySetInnerHTML`
is used in exactly one place — the root layout, to publish the environment's public URLs onto
`window`, from values the server read and never from anything a request supplied — and that script
carries the nonce like any other. Behind that, a Content Security Policy: the dashboard's is built
per request in middleware with a fresh nonce and `strict-dynamic`, so an injected script tag is
refused whether it is inline or sourced; the widget panel gets its own from nginx, with the origins
substituted at container start. `style-src` keeps `'unsafe-inline'` on both — Next and React emit
un-nonceable styles, a style cannot execute, and pretending otherwise would be worse than saying so.
See ADR-084.

**CSRF** — dashboard sessions are `SameSite=Lax` httpOnly cookies plus a double-submit token on
state-changing requests. The widget surface uses a bearer visitor token, not a cookie, so it is not
CSRF-reachable.

**SQL injection** — Prisma parameterises everything. The rare `$queryRaw` uses tagged templates
only; string-concatenated SQL is banned and caught in review.

**SSRF** — webhook URLs are validated at save time (https only, no private literal, no bare
hostname) and again at delivery, where the check is on the address rather than the text: the host is
resolved, **every** answer must be a public address, and the socket is then pinned to those vetted
addresses so the name is not resolved a second time between the check and the connection. Redirects
are not followed, the timeout is hard, and the response body is capped as it arrives. IPv4-mapped
IPv6, 6to4, NAT64, carrier-grade NAT and the cloud metadata address are all refused. See ADR-085 and
`packages/core/src/integrations/outbound.ts`.

**Malicious upload** — the file's real type is decided by **magic-byte sniffing of the stored
object**, after the upload, against an allowlist of kinds. The declared MIME type and the file name
are treated as claims and neither decides anything: a client that says `image/png` and uploads an
executable has its object deleted. Plus a size cap re-measured against the real object, randomly
generated storage keys (the client filename never becomes a path), `Content-Disposition:
attachment` with a non-executing content type, and private-by-default access behind short-lived
signed URLs. Path traversal is structurally impossible because the client never supplies a path.

One bucket, not two — this said "a separate bucket" and there has only ever been `S3_BUCKET`.
Separation is by key prefix and by the response headers above, which is what actually stops a
stored file being served as script.

**Per-agent reporting is account-wide**, and a member scoped to particular websites is refused it
rather than shown it. `daily_agent_metrics` counts per agent, not per website, so there is nothing
to filter by; answering with unfiltered numbers would leak colleagues' activity on websites the
member cannot otherwise see.

**Brute force / credential stuffing** — Argon2id hashing, per-IP and per-account login rate limits
with exponential lockout, constant-time comparison, generic failure messages, and an audit event for
every failure. Password reset and email verification tokens are single-use, hashed at rest and
short-lived.

**WebSocket abuse** — a single-use ticket in the handshake is the only credential, every room is
derived from the identity that ticket carried rather than from anything the client asks for, and
payloads are schema-validated per event. A socket that keeps violating a limit is disconnected after
ten strikes rather than merely throttled, because a rejected connection an attacker keeps open costs
us and not them. The handshake is deliberately **not** origin-restricted: the widget runs on domains
we cannot enumerate, a cross-origin page cannot obtain a ticket, and an origin check would break
every customer while adding nothing.

**Spam / flooding** — layered limits: per visitor, per property, per session, per key and per IP,
enforced in Redis so they hold across replicas. A visitor can be banned temporarily or permanently
from the agent's panel; the ban is checked both when a token is used and when a new one is minted,
so a reload does not clear it (ADR-083). There is no IP-level ban: IP addresses are shared and
reassigned, blocking one is as likely to catch a network as a person, and the per-IP rate limits
already bound what one address can do. See "Not implemented in v1" below.

**Malicious uploads** — implemented in phase 7. The bytes never pass through the API: a signed URL
authorises one PUT, to one key, for five minutes, with no read and no listing. What was actually
uploaded is then read back and identified from its leading bytes against a closed allow-list; the
browser's `Content-Type` and the file name are claims and neither is stored. Anything unrecognised —
every executable and script — is deleted from the bucket and the row marked rejected, so a signed
URL cannot be used to park content on our storage. The declared size is re-measured from the real
object, because the store enforces nothing on our behalf. Storage keys are built from three uuids
this service generated and contain not one character a client chose, so there is no traversal to
defend against. Download URLs are minted per request against the caller's own access, last ten
minutes, and pin the content type and disposition into their own signature. Non-image types are
always served `attachment`. See docs/FILES.md and ADR-044 through ADR-046.

**Secret exposure** — API keys stored as SHA-256 hashes and shown exactly once; webhook secrets never
returned by any endpoint after creation; `.env` is gitignored; no secret is ever logged (the logger
has a redaction list); the widget snippet contains no credential at all.

## 3. Rate limits (Redis-backed, per surface)

Every figure below is the value in `RATE_LIMITS` (`packages/core/src/redis/rate-limit.ts`). If the
two ever disagree, the code is right and this table is a bug.

| Surface | Limit | Keyed by |
| --- | --- | --- |
| Login | 5 / 15 min, then an escalating lockout | IP + email |
| Register | 10 / hour, and 3 / hour for one email address | IP, then email |
| Forgot password, resend verification | 3 / hour | IP |
| Email token redemption | 10 / hour | IP |
| Widget session creation | 30 / min | IP |
| Visitor messages | 20 / min, and 300 / min across the whole website | visitor, then property |
| Offline-form messages | 5 / hour | IP |
| Visitor uploads | 10 / hour | visitor |
| Everything behind a session or an API key | 600 / min | session, or key |
| Expensive mutations (property writes, upload signing) | 120 / min | account or member |
| Webhook deliveries | one attempt at a time per delivery, capped exponential backoff | delivery |

Register is 10 rather than 3 per IP on purpose: an agency behind one NAT legitimately creates several
accounts in an hour, and locking them out is a worse failure than the abuse it prevents — the
per-email limit and email verification are what actually bound bulk signup.

The 600/min budget is consumed in the authentication hook, so it covers every authenticated route
including ones added later; the tighter limits above sit on top of it (ADR-086). An unauthenticated
flood never reaches the limiter — it is refused before it, and bounding it is the edge proxy's job.

## 4. Privacy

Each account sets its own retention window. A nightly job deletes conversations past it along with
their messages, attachment rows and the objects behind them, and reports anything it could not
remove from storage rather than dropping the row and leaving the file (see docs/BACKUPS.md). Tickets,
contacts and the audit log are deliberately kept: a ticket is a commercial record, and an audit log
that erased the record of its own operation would be self-defeating.

We collect less than we could. Location is derived to country granularity only. The browser's
`Origin`, `Referer`, `User-Agent` and the page URL and title the widget reports are stored as claims
for the agent's sidebar and are never used for any authorisation decision. No third-party analytics
or tracking script is loaded on any surface — the dashboard's CSP would refuse one.

### Not implemented in v1

Named here rather than described as though they exist. Each has a designed attachment point and none
is faked in the interface:

- **Consent mode** — gating visitor tracking behind an explicit opt-in before a chat starts. It
  would attach at `VisitorService.bootstrap`, which is already the one place a visitor row is
  created.
- **Self-service erasure and account export** — a subject-access request is currently served by
  operators against the database. `RetentionService` already knows how to delete a conversation and
  everything under it, including storage objects; erasure on demand is that traversal driven by an
  endpoint rather than by a schedule.
- **On-demand conversation deletion** — the `conversation:delete` permission exists and no route
  consumes it. Conversations are removed by the retention job only.
- **IP-level bans** — see "Spam / flooding" above for why this is a considered omission rather than
  an oversight.

## 5. Audit logging

Append-only: nothing in the application updates or deletes an audit row, and retention keeps them
when it deletes the conversations they describe. Each row carries the actor (user, API key or the
system), the action, the resource type and id, the IP, the user agent, the timestamp, and a metadata
bag.

What is recorded today: account created and updated; sign-in, failed sign-in, sign-out, session
revoked, password changed, password reset, email verified; property created, updated and deleted;
allowed domains added and removed; widget published; member invited, invitation revoked, joined,
updated and removed; trigger and shortcut created, updated and deleted; article created; contact
updated; conversation assigned; ticket created, updated and opened from an offline message; API key
created and revoked; webhook created; visitor banned and unbanned.

Two honest qualifications. The metadata bag usually records *which* fields changed rather than their
old and new values — enough to answer "who touched this and when", not enough to reconstruct a
previous state; storing both versions of every field would put customer content in a table that
outlives the retention window it was meant to respect. And platform-operator actions (suspending an
account, changing a plan, toggling a flag) are written to `platform_audit_log`, a separate table with
a separate actor space, not into any account's own log — see docs/PLATFORM.md.

## 6. Verification

`/docs/SECURITY_AUDIT.md` is produced in Phase 14 and records an explicit, tested result for every
item in this document. An untested control is not a control.
