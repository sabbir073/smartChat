# SmartChat — API Design

Base URL: `/api/v1`. Framework: Fastify 5 + Zod. Every request and response body is schema-validated;
schemas live in `@smartchat/validation` and are shared with the dashboard and widget.

## 1. Surfaces

| Surface | Prefix | Auth | Notes |
| --- | --- | --- | --- |
| Dashboard | `/api/v1/...` | session cookie | CSRF-protected, CORS limited to `APP_URL` |
| Public API | `/api/v1/...` | `Authorization: Bearer sc_live_…` | scoped API keys, separate rate limits |
| Widget | `/api/v1/widget/...` | visitor token + `Origin` check | permissive CORS, restricted to the property's allowed domains |
| Platform | `/api/v1/platform/...` | platform-admin session | separate role space, never reachable by tenant users |
| Health | `/health`, `/ready` | none | no tenant data |

## 2. Response envelope

Success:
```json
{ "success": true, "data": { }, "meta": { "cursor": "…", "hasMore": true } }
```

Error:
```json
{
  "success": false,
  "error": {
    "code": "CONVERSATION_NOT_FOUND",
    "message": "Conversation not found",
    "details": [{ "path": "body.email", "message": "Invalid email" }],
    "requestId": "01J8…"
  }
}
```

`code` is a stable machine-readable string; `message` is safe to show a user. Stack traces, SQL,
driver errors and filesystem paths are never serialised to a client.

## 3. Status codes

| Code | Used for |
| --- | --- |
| 200 / 201 / 204 | success |
| 400 | malformed request |
| 401 | missing or invalid credential |
| 403 | authenticated but not permitted |
| 404 | not found **or** not visible to this tenant (deliberately indistinguishable) |
| 409 | conflict (duplicate slug, version mismatch) |
| 413 | payload too large |
| 422 | semantically invalid (validation failure) |
| 429 | rate limited (`Retry-After` set) |
| 500 | unexpected — logged with a request id, opaque to the client |

Cross-tenant access returns **404, not 403**. Returning 403 would confirm that the resource exists.

## 4. Pagination

Cursor-based everywhere that matters:
`GET /conversations?limit=25&cursor=eyJ…&status=open&propertyId=…`
The cursor is an opaque base64 of the sort key; it is validated, never trusted, and scoped to the
requesting tenant.

## 5. Route map

Every route this API serves, and nothing else. It was a "target" map written in phase 0 and never
reconciled, which meant it named a Platform surface at `/admin` that does not exist and about
twenty endpoints the router never registered — `/webhooks` rather than `/integrations/webhooks`,
`/account/members/invite` rather than `POST /team/members`, `/conversations/:id/close` rather than
a `PATCH`. A route map that is a wish list is worse than no route map: it is the thing somebody
builds a client against.

Everything below is under the `/api/v1` prefix.

```
# auth — no tenant context; a session or a token is what these produce
POST   /auth/register                 POST   /auth/login
POST   /auth/logout                   GET    /auth/me
PATCH  /auth/profile                  POST   /auth/switch-account
POST   /auth/accept-invitation
POST   /auth/verify-email             POST   /auth/resend-verification
POST   /auth/forgot-password          POST   /auth/reset-password
POST   /auth/change-password          GET    /auth/sessions
DELETE /auth/sessions/:id

# the account itself
GET    /account                       PATCH  /account
GET    /account/members               GET    /account/audit-logs

# team, roles, departments, availability
GET    /team/members                  POST   /team/members
PATCH  /team/members/:id              DELETE /team/members/:id
GET    /team/invitations              POST   /team/invitations/:id/resend
DELETE /team/invitations/:id
GET    /team/availability             PUT    /team/availability
GET    /team/roles                    POST   /team/roles
PATCH  /team/roles/:id                DELETE /team/roles/:id
GET    /team/departments              POST   /team/departments
PATCH  /team/departments/:id          DELETE /team/departments/:id

# websites and their widgets
GET    /properties                    POST   /properties
GET    /properties/:id                PATCH  /properties/:id
DELETE /properties/:id                GET    /properties/:id/install
POST   /properties/:id/domains        DELETE /properties/:id/domains/:domainId
GET    /properties/:id/widget         PATCH  /properties/:id/widget
POST   /properties/:id/widget/publish POST   /properties/:id/widget/discard

# conversations. Status, priority, tags and notes are all PATCH /conversations/:id
# or a message with a different visibility - not separate verbs.
GET    /conversations                 GET    /conversations/:id
PATCH  /conversations/:id             POST   /conversations/:id/assign
POST   /conversations/:id/read
GET    /conversations/:id/messages    POST   /conversations/:id/messages
POST   /realtime/ticket
GET    /presence/agents               GET    /presence/visitors
POST   /visitors/:id/ban              DELETE /visitors/:id/ban

# contacts
GET    /contacts                      GET    /contacts/:id
GET    /contacts/:id/history          PATCH  /contacts/:id
GET    /contacts-fields               POST   /contacts-fields
PATCH  /contacts-fields/:id           DELETE /contacts-fields/:id

# automation
GET    /automation/schema
GET    /automation/triggers           POST   /automation/triggers
GET    /automation/triggers/:id       PATCH  /automation/triggers/:id
DELETE /automation/triggers/:id
GET    /automation/shortcuts          POST   /automation/shortcuts
PATCH  /automation/shortcuts/:id      DELETE /automation/shortcuts/:id
POST   /automation/shortcuts/:id/used

# knowledge base
GET    /kb/:propertyId/categories     POST   /kb/:propertyId/categories
PATCH  /kb/categories/:id             DELETE /kb/categories/:id
GET    /kb/:propertyId/articles       POST   /kb/:propertyId/articles
GET    /kb/articles/:id               PATCH  /kb/articles/:id
DELETE /kb/articles/:id

# tickets
GET    /tickets                       POST   /tickets
GET    /tickets/:id                   PATCH  /tickets/:id
DELETE /tickets/:id
GET    /tickets/:id/messages          POST   /tickets/:id/messages

# reporting
GET    /reports/overview              GET    /reports/agents
GET    /reports/articles              POST   /reports/rebuild

# integrations
GET    /integrations/keys             POST   /integrations/keys
DELETE /integrations/keys/:id
GET    /integrations/webhooks         POST   /integrations/webhooks
PATCH  /integrations/webhooks/:id     DELETE /integrations/webhooks/:id
GET    /integrations/webhooks/:id/deliveries
POST   /integrations/webhooks/:id/ping

# billing, from the customer's side
GET    /billing/subscription          GET    /billing/invoices
POST   /billing/plan                  DELETE /billing/plan/:id
POST   /billing/cancel                POST   /billing/resume

# files
POST   /uploads/sign                  POST   /uploads/:id/confirm
GET    /attachments/:id/url

# ---------------------------------------------------------------------------
# widget surface. No cookies, no session; a visitor token in an Authorization
# header. Conversations and messages are NOT here - they travel over the
# realtime gateway, which is what /widget/realtime-ticket buys a seat on.
# ---------------------------------------------------------------------------
GET    /widget/config                 POST   /widget/session
POST   /widget/page-view              POST   /widget/identify
POST   /widget/offline-message        POST   /widget/realtime-ticket
POST   /widget/uploads/sign           POST   /widget/uploads/:id/confirm
GET    /widget/attachments/:id/url    GET    /widget/me

# ---------------------------------------------------------------------------
# public. No credential of any kind, and its own scope with no auth hook.
# ---------------------------------------------------------------------------
GET    /public/plans
GET    /public/kb/:publicId           GET    /public/kb/:publicId/search
GET    /public/kb/:publicId/articles/:slug

# ---------------------------------------------------------------------------
# platform console. A different cookie, a different principal, a different
# permission space. A tenant session reaches none of it.
# ---------------------------------------------------------------------------
POST   /platform/auth/login           POST   /platform/auth/logout
GET    /platform/auth/me
GET    /platform/accounts             GET    /platform/accounts/:id/usage
POST   /platform/accounts/:id/suspend POST   /platform/accounts/:id/resume
POST   /platform/accounts/:id/plan
GET    /platform/plans
GET    /platform/plan-changes         POST   /platform/plan-changes/:id/decide
GET    /platform/invoices             POST   /platform/invoices/:id/paid
GET    /platform/health               GET    /platform/audit
GET    /platform/flags                PATCH  /platform/flags/:key
POST   /platform/maintenance/retention
POST   /platform/maintenance/subscriptions
```

## 6. Non-negotiable rules

1. Every route declares a permission. There is no "authenticated is good enough" route.
2. Every route that touches tenant data resolves a `TenantContext` before the handler runs.
3. Internal Prisma models are never returned. Handlers map to DTOs from `@smartchat/types`.
4. Every authenticated request consumes the `dashboardApi` budget in the auth hook (ADR-086), so
   there is no unlimited route. The tighter per-route budgets — `mutation`, `offlineMessage`,
   `widgetSession`, `visitorMessage`, `propertyMessage` — sit on top of that floor on the routes
   whose cost warrants them, and are named in `RATE_LIMITS`. Mutations that change security
   posture are audit logged.
5. `/api/v1` is a contract. Breaking changes require `/api/v2`; additive changes do not.
