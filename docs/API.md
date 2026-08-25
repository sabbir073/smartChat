# SmartChat — API Design

Base URL: `/api/v1`. Framework: Fastify 5 + Zod. Every request and response body is schema-validated;
schemas live in `@smartchat/validation` and are shared with the dashboard and widget.

## 1. Surfaces

| Surface | Prefix | Auth | Notes |
| --- | --- | --- | --- |
| Dashboard | `/api/v1/...` | session cookie | CSRF-protected, CORS limited to `APP_URL` |
| Public API | `/api/v1/...` | `Authorization: Bearer sc_live_…` | scoped API keys, separate rate limits |
| Widget | `/api/v1/widget/...` | visitor token + `Origin` check | permissive CORS, restricted to the property's allowed domains |
| Platform | `/api/v1/admin/...` | platform-admin session | separate role space, never reachable by tenant users |
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

## 5. Route map (target)

```
POST   /auth/register                 POST   /auth/login
POST   /auth/logout                   GET    /auth/me
POST   /auth/verify-email             POST   /auth/resend-verification
POST   /auth/forgot-password          POST   /auth/reset-password
POST   /auth/change-password          GET    /auth/sessions
DELETE /auth/sessions/:id

GET    /account                       PATCH  /account
GET    /account/members               POST   /account/members/invite
PATCH  /account/members/:id           DELETE /account/members/:id
GET    /account/roles                 POST   /account/roles

GET    /properties                    POST   /properties
GET    /properties/:id                PATCH  /properties/:id
DELETE /properties/:id                GET    /properties/:id/install
POST   /properties/:id/verify         GET    /properties/:id/domains
POST   /properties/:id/domains        DELETE /properties/:id/domains/:domainId

GET    /properties/:id/widget         PATCH  /properties/:id/widget
POST   /properties/:id/widget/publish

GET    /conversations                 GET    /conversations/:id
PATCH  /conversations/:id             POST   /conversations/:id/close
POST   /conversations/:id/reopen      POST   /conversations/:id/assign
POST   /conversations/:id/transfer    POST   /conversations/:id/tags
GET    /conversations/:id/messages    POST   /conversations/:id/messages
POST   /conversations/:id/notes       POST   /conversations/:id/read

GET    /visitors                      GET    /visitors/:id
GET    /contacts                      POST   /contacts
GET    /contacts/:id                  PATCH  /contacts/:id

GET    /shortcuts                     POST   /shortcuts
GET    /triggers                      POST   /triggers
GET    /kb/:propertyId/articles       POST   /kb/:propertyId/articles
GET    /tickets                       POST   /tickets
GET    /reports/overview              GET    /reports/conversations
GET    /webhooks                      POST   /webhooks
GET    /api-keys                      POST   /api-keys
DELETE /api-keys/:id

POST   /uploads/sign                  POST   /uploads/complete

# widget surface
POST   /widget/session                GET    /widget/config
POST   /widget/conversations          POST   /widget/messages
POST   /widget/offline-message        POST   /widget/events
POST   /widget/realtime-ticket
```

## 6. Non-negotiable rules

1. Every route declares a permission. There is no "authenticated is good enough" route.
2. Every route that touches tenant data resolves a `TenantContext` before the handler runs.
3. Internal Prisma models are never returned. Handlers map to DTOs from `@smartchat/types`.
4. Every mutating route is rate limited and, where it changes security posture, audit logged.
5. `/api/v1` is a contract. Breaking changes require `/api/v2`; additive changes do not.
