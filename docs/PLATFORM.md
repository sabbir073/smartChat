# SmartChat — The platform console

A different product from the dashboard, sharing a database. Everything in it acts **on** accounts
from outside them: suspending, changing a plan, switching a capability off.

## No TenantContext, anywhere

`TenantContext` exists to make tenant scoping impossible to forget — every repository takes one and
injects `accountId` into the query. An operator suspending an account is deliberately *not* scoped
to it, so using that object here would either be a lie or would have to be defeated, and both are
worse than a separate path.

So the console has its own principal (`PlatformPrincipal`), its own permission vocabulary
(`PlatformPermission`, a different namespace from tenant permissions), its own session cookie, its
own routes and its own audit log.

## The session

`sc_platform`, not `sc_session`. Two names, and that matters more than it looks:

- signing out of the dashboard must not sign an operator out of the console;
- and, far more importantly, a stolen tenant session must never be usable as a platform one. Two
  cookie names make that structural rather than a matter of remembering to check.

`SameSite=Strict`, not `Lax` — the console has no email links to arrive from, so the looser setting
buys nothing and costs the strongest CSRF protection available. Eight hours, not thirty days.

Sign-in has **no registration, no invitation, no password reset by email and no "remember me"**. A
platform administrator is created by somebody with database access. Every convenience the dashboard
offers would be another door on the most privileged credential in the system.

Failed sign-ins lock the administrator for fifteen minutes after five attempts, and a missing
address spends the same time as a wrong password so latency cannot be used to enumerate operators.
Every refusal returns the identical error.

## Suspension, and what "immediately" means

A suspension that took effect at the next login would be worthless: the agent already signed in
keeps working, the widget keeps taking messages, and the account keeps costing money.

It is immediate because **membership is re-checked from the database on every request**.
`AccountService.requireMembership` refuses a suspended account, and `authenticateTenant` calls it
every time — there is no cached authorisation to expire. The same is true of the other two doors:

| Door | What stops it |
| --- | --- |
| Dashboard session | `requireMembership` → `ACCOUNT_SUSPENDED` on the next request |
| API key | `ApiKeyService.authenticate` requires an active account |
| Widget / visitor | `findPublishedByPublicId` requires an active account |

The e2e suite proves this the only way that means anything: it signs somebody in **first**,
suspends them while that session is live, and then tries all three.

**The reason is required**, and it is not decoration — it is what the account's own people are
shown, and it is the only thing that turns "everything stopped working" into something a support
conversation can start from.

Resuming restores the same live session. Nobody was signed out; they were refused.

## Plans

Assigning a plan changes what an account is **entitled** to. Nothing charges anybody — billing is
not implemented and is not faked. `EntitlementService` caches for 30 seconds, so a change is
visible while the operator is still looking at the page.

## Feature flags

A **closed list**. Every key corresponds to one capability that is genuinely read in exactly one
place in the code:

| Flag | Read in | What it stops |
| --- | --- | --- |
| `uploads` | `AttachmentService.sign` | Signing new upload targets. Existing files stay readable. |
| `webhooks` | `WebhookService.queue` | Queueing new deliveries. Ones already queued still go. |
| `public_help_centre` | `KbService.resolvePublic` | The public pages. The dashboard side keeps working. |

Rows are created lazily from that list, and a key that is not on it is **refused** rather than
created. A flag nothing consults is worse than no flag: somebody will flip it during an incident,
watch nothing change, and lose the minutes it takes to work out why.

`enabled` is the global default; `disabledAccountIds` turns it off for named accounts only, which
is the shape an operator actually needs — something is on for everybody and has to be taken away
from the one account melting the storage bill.

**Reads fail open.** A missing row, or a database that will not answer, means the capability is on.
A kill switch should require a deliberate act to kill; the alternative is a hiccup in a table
nobody was thinking about silently turning off uploads for every customer.

Each flag pauses *new* work and never destroys existing data. That distinction is what makes it
safe to use at three in the morning.

The refusal is `TEMPORARILY_UNAVAILABLE` (503), deliberately not `FEATURE_NOT_AVAILABLE` (402).
402 means "upgrade your plan", which would be an infuriating thing to tell somebody during an
incident on our side.

## Health

Counts, not verdicts:

```
database { ok, ms }         a real query, separately timed
activeAccounts / suspendedAccounts
queuedEmails                emails written but not yet sent
pendingWebhookDeliveries    deliveries due or retrying
failedWebhookDeliveries     deliveries given up on
```

"The process is up" is a different question from "the database answers", so the database check is a
real query with its own timing rather than an inference from the process being alive.

A pending count that keeps growing is the alarm the delivery tables exist for — but it is reported
rather than judged. How many is too many depends on the hour, and a threshold guessed here would
either cry wolf or stay quiet during the outage.

## Audit

`platform_audit_logs` is separate from the tenant `audit_logs`, and the separation is the point:
these are actions taken *on* accounts by people outside them. An account must not be able to read
them, and a platform action must not be lost among a tenant's own.

Sign-ins, suspensions, resumes, plan changes and flag changes are all recorded, with the operator
named. Recording never fails the action it is recording.

## Endpoints

```
POST /api/v1/platform/auth/login
POST /api/v1/platform/auth/logout
GET  /api/v1/platform/auth/me

GET  /api/v1/platform/accounts?search=&status=&limit=
POST /api/v1/platform/accounts/:id/suspend   { reason }
POST /api/v1/platform/accounts/:id/resume
GET  /api/v1/platform/accounts/:id/usage
POST /api/v1/platform/accounts/:id/plan      { planCode }

GET  /api/v1/platform/plans
GET  /api/v1/platform/health
GET  /api/v1/platform/flags
PATCH /api/v1/platform/flags/:key            { enabled?, disabledAccountIds? }
GET  /api/v1/platform/audit?limit=
```

Each is gated on a specific `PlatformPermission`, so a read-only operator role is expressible.

## The console itself

`/console` in the web app, with its own dark layout. Visually distinct on purpose: somebody with
the power to suspend a business should never be a moment's confusion away from believing they are
in an ordinary account.

## Verifying it

```
node scripts/e2e-platform.mjs
```

The suspension test signs in first and suspends second, which is the only ordering that can catch
a suspension that merely blocks new logins. Takes about a minute, because it waits out the flag
cache twice rather than reaching into it.
