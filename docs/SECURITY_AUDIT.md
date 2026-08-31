# SmartChat — Security Audit

*Phase 14. Every control claimed in `docs/SECURITY.md`, checked against the running system.*

An untested control is not a control, and — as this audit found five times — a **documented** control
is not a control either. The rule applied throughout was: read the code, then make the system do it,
and where the two disagreed, change the code or change the document, never leave the difference.

Every "verified by" below is a command anyone can run. Where a row says a control was *added* during
this audit, the claim existed in `SECURITY.md` and the implementation did not.

---

## 1. What this audit changed

Five documented controls turned out not to exist, and one existed but could not be switched on. All
six are now real, and each is pinned by a test that fails if it regresses.

| # | What the document claimed | What was actually there | What was done |
| --- | --- | --- | --- |
| 1 | "Strict CSP on dashboard and widget panel: no `unsafe-eval`, no inline scripts without a nonce" | The API had a CSP (it serves JSON). The dashboard had `X-Frame-Options` and nothing else. The widget panel had nothing. | A per-request nonce and a `strict-dynamic` policy in `apps/web/src/middleware.ts`; a policy for the panel in `infrastructure/nginx/widget.conf`, with origins substituted at container start. ADR-084. |
| 2 | Webhook URLs "validated … again at delivery: public DNS resolution only, private/link-local/loopback/metadata ranges rejected after resolution, redirects not followed" | Delivery called `fetch` on the stored URL. No resolution check, no pinning, redirects followed by default. A name that passed the save-time check could resolve to `169.254.169.254`. | `packages/core/src/integrations/outbound.ts`: re-validate, resolve, require every answer to be public, then pin the socket to those addresses. 38 unit tests. ADR-085. |
| 3 | "Dashboard API 600 / min per session" and "Public API: per-key quota" | `RATE_LIMITS.dashboardApi` was defined and **never consumed by any route**. Three routes had their own limit; everything else was unlimited. | Consumed in `authenticateTenant`, keyed by session or by API key. ADR-086. |
| 4 | "Configurable ban system (temporary and permanent) at visitor level" | `is_banned` / `banned_until` existed and `authenticate` enforced them — but no route, service method or interface could set them. A control nobody could reach. | `POST`/`DELETE /visitors/:id/ban`, a moderation section in the agent's visitor panel, and an audit entry. ADR-083. |
| 5 | (implied by 4) A ban stops a visitor | `bootstrap` did **not** check the ban. A banned visitor reloading the page was recognised, handed a fresh token, and carried on. The ban lasted one page view. | The check moved into a shared `assertNotBanned` called from both doors, and `scripts/e2e-abuse.mjs` exists specifically to try the reload. |
| 6 | (not claimed anywhere) The stack starts from a clean checkout | `docker compose` writes `METRICS_TOKEN=""` when nobody sets it; `z.string().min(16).optional()` treats an empty string as present, so **the API refused to boot with the shipped defaults**. | `loadConfig` now strips empty environment variables before parsing, so "absent" and "empty" mean the same thing. Pinned in `packages/config/src/load.test.ts`. |

Three documentation claims were corrected rather than implemented, because building them in a final
QA phase would have been worse than saying they are not there. They are listed in §7.

---

## 2. Trust boundaries

| Claim | Verified by | Result |
| --- | --- | --- |
| Visitor message body, name, email and custom fields are untrusted | `e2e-automation` (an unconfigured pre-chat key is dropped), `markdown.test.ts` (14 cases including `javascript:`, `data:`, `vbscript:`, `//evil.example`) | Pass |
| `Origin`, `Referer`, `User-Agent`, page URL/title are recorded as claims and never authorise | Code review of `visitor.service.ts` and the realtime namespaces: every room is derived from ticket claims; no authorisation reads a header | Pass |
| The property public id identifies and authorises nothing | `smoke` — the installation snippet contains no secret, key or internal id; `e2e-isolation` — a public id from another account issues its own identity, not the presented one | Pass |
| Uploaded file name, MIME type and size are re-derived server side | `e2e-files` — an executable named and declared as a picture is refused *by its signature* and deleted from the bucket; an understated size is caught by measuring the real object | Pass |
| Every id in a URL or body is re-resolved against the caller's tenant | `e2e-isolation` — 15 reads and 19 writes with real ids from another account, all 404 | Pass |
| A session cookie, API key or ticket is a verified credential and still permission-checked | `e2e-integrations` (a key with fewer scopes on the same routes), `e2e-abuse` (an agent cannot ban) | Pass |

---

## 3. Controls by attack class

| Control | Verified by | Result |
| --- | --- | --- |
| **IDOR / broken access control** — cross-tenant reads return 404, not 403 | `pnpm e2e:isolation` | Pass — see §4 |
| **Privilege escalation** — permissions checked server-side per route | `e2e-team` (a scoped agent sees one website in list, by id, by message, by search, and when replying), `e2e-abuse` (agent cannot ban or unban) | Pass |
| **Privilege escalation** — platform admins unreachable from a tenant session | `e2e-platform`; `e2e-isolation` asserts `/platform/*` requires its own session | Pass |
| **XSS** — escape-first rendering, no tag built from author text | `apps/web/src/lib/markdown.test.ts`, 14 cases | Pass |
| **XSS** — `dangerouslySetInnerHTML` confined | Repository-wide search: one occurrence, the root layout's runtime-config script, built from server-side environment values and carrying the nonce | Pass |
| **XSS** — CSP with a nonce on the dashboard | Live header inspection, below | Pass (**added**) |
| **XSS** — CSP on the widget panel | Live header inspection, below | Pass (**added**) |
| **CSRF** — double-submit token on state-changing requests | `smoke` — a mutation without, or with a wrong, token is rejected | Pass |
| **CSRF** — the widget surface is bearer-token, never cookie | `smoke` — the widget surface serves any origin but never with `Access-Control-Allow-Credentials` | Pass |
| **SQL injection** — Prisma parameterises; raw SQL only in tagged templates | Code review of every `$queryRaw`/`$executeRaw` site; all are tagged templates with interpolated *values*, none with interpolated identifiers | Pass |
| **SSRF** — address re-checked at delivery, connection pinned, redirects not followed | `packages/core/src/integrations/outbound.test.ts` (38 cases), `e2e-integrations` | Pass (**added**) |
| **Malicious upload** — signature sniffing, size re-measurement, generated keys | `e2e-files` | Pass |
| **Brute force** — Argon2id, login throttle, identical answers for unknown email and wrong password | `smoke` — identical status *and* error code; `redis/login-throttle.ts` escalates | Pass |
| **Tokens** — single-use, hashed at rest, short-lived | `e2e-team` — an invitation link works once and not twice; `crypto/tokens.ts` stores SHA-256 and compares in constant time | Pass |
| **WebSocket abuse** — ticket-only auth, rooms from server identity, strike-based disconnect | `e2e-realtime`, and `e2e-isolation` proves a gateway ticket is genuinely single-use | Pass |
| **Spam / flooding** — layered limits, and a visitor ban that survives a reload | `pnpm e2e:abuse` | Pass (**added**) |
| **Secret exposure** — keys hashed and shown once, snippet carries no credential | `e2e-integrations` (the secret is returned exactly once and never again), `smoke` (the snippet) | Pass |

### The two CSP headers, as served

```
$ curl -si http://localhost:3000/login | grep -i content-security-policy
$ curl -si http://localhost:3003/panel/ | grep -i content-security-policy
```

Both are recorded verbatim in §8 below, taken from the running stack rather than from the source.

---

## 4. Tenant isolation

`pnpm e2e:isolation` — **82 checks, all passing.**

Two complete accounts are built, each with a website, a conversation with an agent reply, a contact,
a ticket, a category, a draft article, a trigger, a shortcut, an API key and a webhook. Account B is
then given every real identifier account A owns.

- 15 reads → 404, 19 writes → 404
- A's data re-read afterwards: status unchanged, nothing injected into the transcript, the article
  still a draft with its own title
- Eight of B's own list endpoints scanned for any of A's ids: none appear
- B's API key against four of A's resources → 404
- A visitor cannot read, write, resync or close another account's conversation over the gateway, and
  is told `CONVERSATION_NOT_FOUND` rather than "forbidden"
- The public help centre does not expose A's draft, by index or by slug
- A forged `x-account-id` header and a cursor forged from A's row grant nothing
- A gateway ticket nobody issued does not connect; a real one connects exactly once
- Six endpoints, signed out → 401

**And a note on how this suite is trusted.** Its first version asserted 404 against
`/widget/conversations/:id/messages`, a route this API does not have. Five checks passed on Fastify's
route-not-found handler while proving nothing. The suite now probes every path it uses
*unauthenticated* first — a real route answers 401 from its auth hook, a missing one answers 404 —
and fails loudly if any path is not a route. That guard was negative-controlled: a deliberately
phantom path was added, the suite failed and named it, and the path was removed.

---

## 5. Rate limits

Every value in `SECURITY.md` §3 was checked against `RATE_LIMITS` and the table rewritten where they
disagreed. Three rows were wrong (register was documented as 3/hour and is 10/hour per IP plus
3/hour per email; a per-account upload limit was documented and does not exist; the dashboard limit
was documented and was not applied anywhere). `smoke` exercises the registration limiter live.

The 600/min budget is now consumed in the authentication hook, so it covers every authenticated
route including ones added later. Anonymous requests are refused *before* the limiter runs — bounding
an unauthenticated flood is the edge proxy's job, and `infrastructure/nginx/edge.conf` gives sign-in
paths their own stricter bucket there.

---

## 6. Audit logging

Twenty-nine distinct actions are recorded; the full list is in `SECURITY.md` §5, taken from the code
rather than from memory. `e2e-abuse` asserts that a ban lands in the log against the right visitor id
with the reason the manager typed.

Two claims were narrowed to the truth: the metadata bag records *which* fields changed rather than
their old and new values, and platform-operator actions go to `platform_audit_log`, a separate table,
not into any account's own log.

---

## 7. Documented but not built

Corrected in `SECURITY.md` rather than implemented. Each is a real gap, stated as one:

- **Consent mode** gating visitor tracking before a chat starts.
- **Self-service erasure and account export.** A subject-access request is served by operators
  against the database today. `RetentionService` already performs the traversal an erasure endpoint
  would need.
- **On-demand conversation deletion.** The `conversation:delete` permission exists and no route
  consumes it; conversations are removed by the retention job only.
- **IP-level bans.** A considered omission rather than an oversight — addresses are shared and
  reassigned, and the per-IP rate limits already bound what one address can do.
- **Playwright / Testcontainers / k6.** `TESTING.md` described a testing strategy in the present
  tense that had never been built. The table now lists only what `pnpm` can run.

---

## 8. Evidence

Recorded from the running stack at the end of Phase 14.

### Every suite, one run

```
smoke          64    realtime       64    team           49    automation     55
files          56    kb             62    tickets        64    reports        41
integrations   51    platform       42    retention      25    isolation      82
abuse          29
                                          restore rehearsal   22
                                          rollback rehearsal  19
```

Unit and component tests: 252 across 27 files, including the 38 that fence the outbound address
guard and the 8 that cover the ban control in the browser layer.

### The dashboard's policy, as served

```
default-src 'self';
script-src 'self' 'nonce-YjYyMTRmMjMtNjgzNy00YmI5LWJhNGItNzU0YTZjNzM4NTlj' 'strict-dynamic';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: http://localhost:9100;
font-src 'self' data:;
connect-src 'self' http://localhost:3002 ws://localhost:3002 http://localhost:3001 http://localhost:9100;
frame-src 'self' http://localhost:3003;
worker-src 'self' blob:; manifest-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```

The origins are the running container's environment, not the build's. The nonce differs on every
request, and **every script tag in the delivered HTML carries that request's nonce** — 18 of 18 on
`/login`, 20 of 20 on `/register`, none un-nonced.

That last measurement is the one worth keeping. The first version of this policy was served against
statically prerendered pages, where a per-request nonce cannot exist: the header looked perfect and
every script tag in the HTML came back without one, so the policy would have blanked the application
on the first real page load. It was caught by reading the served HTML rather than the source. The
root layout now reads the request headers, which both fetches the nonce and opts the routes out of
prerendering. Confirmed afterwards in a browser: the page renders, React hydrates, the nonced inline
script runs, and the console reports no CSP violation.

### The widget panel's policy, as served

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: http://localhost:9100; font-src 'self' data:;
connect-src 'self' http://localhost:3001 ws://localhost:3001 http://localhost:3002 ws://localhost:3002 http://localhost:9100;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'
```

No nonce and none needed: the panel is a Vite build with no inline scripts, so `'self'` is the whole
allow-list. `frame-ancestors` is deliberately absent — the panel is framed on customer domains by
design, which is the one thing it must keep allowing.

### Under load

40 visitors × 10 messages across 4 websites, over real sockets, with every rate limit in force
except the per-IP session limit (one machine here stands in for forty browsers):

```
wall clock        8.6 s
throughput        46.7 messages/second
send → committed  p50 99 ms | p95 206 ms | p99 251 ms | max 273 ms
failures          0
```

Latency is the least interesting line. The one that matters: all 40 transcripts re-read afterwards
held exactly the messages sent, with sequence numbers strictly increasing and unique, and no message
written twice.

An earlier shape of this test drove all 400 messages at a single website and was refused 30 times —
correctly, by `propertyMessage`, which caps one customer's site at 300/min. The test was reshaped to
fit inside the product's own limits rather than the limits being relaxed to fit the test.

### Rollback

19 checks. The rehearsal damaged a scratch copy of the database — dropping a column and truncating a
table — restored the pre-deploy backup over it, and confirmed the column, every row, the rest of the
schema and the `_prisma_migrations` ledger all came back. It also classified all 15 migrations:
**13 additive, 2 requiring a backup first** (`20260827091910_automation`, which drops a constraint,
and `20260830172000_snake_case_enum_columns`, which renames columns). For the 13, putting the
previous image back is a complete rollback. For the 2, it is not, and the runbook now says so.

### A defect this audit caused, and how it was caught

Worth recording because it is the failure mode this whole phase is about. Hardening webhook delivery
made the worker refuse private addresses — correct — but only the API had
`ALLOW_PRIVATE_WEBHOOK_URLS` set in development. The API accepted a webhook pointing at a local
receiver and the worker then refused every delivery to it. Two processes disagreeing about one
setting; found by the integrations suite, not by reading the diff.
