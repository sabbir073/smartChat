# SmartChat — Billing

Plans, subscriptions, invoices and the lock. Stripe is the payment provider; the operator enters
the keys in the console, and nothing about billing lives in an environment variable except the key
that encrypts those.

## The model

Every account has exactly one `subscriptions` row from the moment it exists, pointing at a `plans`
row. New accounts land on the plan marked **default**, which must be free: the operator chose
"no card for the free plan", so the plan a new account lands on cannot cost anything, and the
console refuses to price it.

A plan is a row, not code. It carries:

| column | meaning |
| --- | --- |
| `max_properties`, `max_members` | limits; `NULL` is unlimited. Members counts active people *and* pending invitations |
| `ai_agent` | the AI agent feature (the flag is enforced by the entitlement service; the agent itself is a later phase) |
| `integrations` | public API keys and outbound webhooks |
| `remove_branding` | hide "Powered by" in the widget |
| `monthly_price_cents`, `annual_price_cents` | whole cents; 0 means "not sold on that interval" |
| `is_contact_sales` | "Talk to us" instead of a checkout button |
| `is_public` | shown on the Billing page. Hidden plans can still be assigned by hand |
| `is_default` | where new accounts land; exactly one, must be free and active |
| `is_active` | retired plans keep their subscribers but cannot be chosen |
| `stripe_product_id`, `stripe_*_price_id` | filled in by the sync; a price change archives the old price and creates a new one |

The four seeded plans, all editable from the console:

| key | monthly | yearly | websites | members | AI | integrations | branding removal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `free` (default) | $0 | $0 | 1 | 1 | no | no | no |
| `starter` | $20 | $200 | 3 | 5 | no | yes | no |
| `growth` | $50 | $500 | 10 | 15 | yes | yes | yes |
| `custom` | contact us | | unlimited | unlimited | yes | yes | yes |

Yearly is ten months' price. Existing accounts were put on `free` by the migration; the demo seed
puts its account on the smallest plan that fits two people.

## Entitlements — the one reader of the plan

`EntitlementService` (`packages/core/src/billing/entitlements.ts`) is the only code that reads a
plan row. Every limit and feature gate goes through it:

- `assertCanAddProperty` — `PropertyService.create`
- `assertCanInviteMember` — `TeamService.invite` (counted when the invitation is sent, not accepted)
- `assertFeature('integrations')` — API key and webhook creation
- `hasFeature('removeBranding')` — the widget bootstrap's `showBranding`
- `assertNotLocked` — the lock (below)

The plan and subscription are cached per account for thirty seconds; the usage counts are not,
because they decide the over-limit lock and an account that has just deleted a website must see
the lock lift on its next request. Webhooks and plan changes invalidate the cache.

A limit that is reached answers `PLAN_LIMIT_REACHED` (402) with a sentence naming the plan and the
limit; a feature that is not in the plan answers `FEATURE_NOT_IN_PLAN` (402).

## The lock

The operator's rule: a subscription that has stopped being paid locks the dashboard until it is
paid again. Reading stays open, the widget keeps working for visitors, nothing is deleted.

`evaluateLock` (`lock.ts`) decides from the subscription alone:

| status | verdict |
| --- | --- |
| `none`, `active` | open |
| `incomplete` | open — nothing has been bought yet, nothing has lapsed |
| `past_due` | open for **grace days** (`billing.grace_days`, default 3, console-editable) from `past_due_since`, then locked (`grace_expired`) |
| `unpaid`, `incomplete_expired` | locked |
| `canceled` | locked once `current_period_end` has passed (in practice never seen: a Stripe cancellation puts the account back on the default plan, below) |

One more reason comes from counts rather than money: **`over_limit`** — the account has more
websites or team members than its plan allows, which happens after a downgrade. Nothing is deleted
for them; the dashboard locks until they remove the extras or pick a plan that fits. `DELETE`
requests are allowed through so they can.

Where it is enforced:

- `authenticateTenant` (API): every non-GET request on a tenant route, sessions and API keys alike,
  except routes marked `skipBillingLock` — which is the billing routes and nothing else. Answers
  `BILLING_LOCKED` (402) with a sentence for the reason.
- `ConversationService.sendAgentMessage`, `update`, `assign` via the `assertWritable` hook — so the
  socket gateway is locked the same way as HTTP. Visitor-side methods never call it.
- The dashboard shows a wall on every page but Billing (`BillingGate`), and a banner with the date
  the lock lands while past due.

`locked_at` on the subscription is **not** the lock — it is the stamp that says the owner has been
told. The hourly `maintenance.billing_reconcile` job stamps accounts whose window has closed and
sends `accountLockedTemplate` once; a payment clears the stamp through the webhook.

## Stripe

Hosted Checkout in subscription mode, the hosted Customer Portal for cards and cancellation, and
webhooks for everything that comes back. Money never moves through our code.

- `POST /billing/checkout {planKey, interval}` → `{url}` to send the browser to. An account that
  already pays through Stripe is *moved* (`changeSubscriptionPrice`, prorated) rather than sold a
  second subscription, and gets `{changed: true}` instead.
- `POST /billing/portal` → `{url}`.
- `POST /billing/webhooks/stripe` — raw body, no session, no CSRF. Its own Fastify scope so the
  raw-body parser cannot leak into routes that expect JSON.

The webhook handler (`stripe-webhook.service.ts`) follows three rules: signature first (nothing is
read until `constructEvent` has verified it with the stored signing secret); every event once
(the id is written to `stripe_events` before handling, a unique violation means a retry and is
acknowledged and ignored); and the object is the truth (subscription events re-fetch the
subscription from Stripe, and an event about a subscription the account has already replaced is
ignored, so a late `deleted` for the old one cannot reset the new one).

What each event does:

| event | effect |
| --- | --- |
| `checkout.session.completed` | link the new subscription to the account (`client_reference_id`), activate, email `subscriptionActivatedTemplate` |
| `customer.subscription.created/updated/paused/resumed` | mirror status, period, price → plan; start the grace clock on `past_due`, stop it on `active` |
| `customer.subscription.deleted` | the paid period is over: back to the **default plan**, `status none`, keep the Stripe customer (card on file if they return), email `subscriptionCanceledTemplate` — which says whether the account still fits |
| `invoice.*` | upsert the mirror row in `invoices`; on the first `paid`, email `invoicePaidTemplate` once, however many paid events Stripe sends; on `payment_failed`, email `paymentFailedTemplate` with the date the lock lands |

Stripe statuses map as: `trialing → active`, `paused → unpaid`; everything else by name.

### Keys

A **restricted key** is the right secret key to use; the console accepts `rk_test_` / `rk_live_`
as well as `sk_`. Everything billing calls, and the permission each needs when creating the key
in Stripe (Developers → API keys → Create restricted key):

| Stripe permission | level | used for |
| --- | --- | --- |
| Customers | Write | creating the customer at first checkout |
| Checkout Sessions | Write | the hosted checkout page |
| Customer portal | Write | "Manage payment method" |
| Subscriptions | Write | re-fetching after a webhook, plan changes, cancellation |
| Invoices | Read | re-fetching an invoice |
| Products | Write | Sync with Stripe (one product per plan) |
| Prices | Write | Sync with Stripe (one price per plan and interval) |
| Balance | Read | Test connection (it reads `livemode` from the balance) |

Everything else can stay at None. Webhook signatures are verified with the signing secret, not
the key, so no webhook permission is needed.

Entered in the console (Billing tab), stored in `platform_settings`. The secret key and the
webhook signing secret are sealed with AES-256-GCM under `SETTINGS_ENCRYPTION_KEY` (`SecretBox`,
`v1:nonce:tag:ciphertext`), and the console only ever says "stored", never what. A test
publishable key next to a live secret key is refused — a checkout on one side and a webhook
verified on the other would never activate anything. Rotating `SETTINGS_ENCRYPTION_KEY` means
re-entering both secrets; a value sealed under the old key opens to "not configured", not to noise.

The Stripe client is built from the stored secret at the time of asking and rebuilt when it
changes; no restart.

### Syncing plans

Saving a priced plan pushes it to Stripe if keys are stored: a product per plan (by
`stripe_product_id`, created if missing), a recurring price per interval, archived and re-created
when the amount, currency or interval changes. A zero price archives the old one. The result is
reported on the save (`synced` / `skipped` / `failed` with the reason) rather than thrown, so the
row is never "saved but looks unsaved". **Sync with Stripe** does every sellable plan at once.

Existing subscribers keep the price they were sold at until they change plan — which is what
Stripe does too, and is the honest thing.

## The console

`platform:billing:manage` (granted to the super-admin by the migration and the seed):

- **Stripe settings** — keys, test connection (reads the balance's `livemode` and the account
  name), grace days, the address enquiries go to, and the webhook URL to paste into Stripe.
- **Plans** — create, edit, retire, mark default, hide; each shows its subscriber count and
  whether Stripe knows its prices.
- **Enquiries** — "I need something bigger" from the Billing page, stored and emailed to the
  contact address; mark handled.
- **Per account** (Accounts tab → Billing) — plan, status, usage, lock, invoices, and **set plan
  by hand** for sponsored or bespoke deals. Refused while the account pays through Stripe: cancel
  it in Stripe first, it falls back to the default plan, then set it.

Every action writes `platform_audit_logs` (`billing.*`).

## Emails

`packages/core/src/mail/templates.ts`: `subscriptionActivatedTemplate` (also used for a
reactivation after a lock), `invoicePaidTemplate` (the receipt, with hosted invoice and PDF
links), `paymentFailedTemplate` (amount, pay-now link, the date the lock lands),
`accountLockedTemplate` (from the reconcile job), `subscriptionCanceledTemplate` (says which plan
the account is now on and whether it fits), `billingEnquiryTemplate` (to the operator, reply-to the
enquirer). All go through the email queue, addressed to the account's owner.

## Setting it up

1. `SETTINGS_ENCRYPTION_KEY` in `.env` (`openssl rand -hex 32`); every app container needs it.
2. Console → Billing → paste the publishable and secret keys (test mode first), **Save**, **Test
   connection**.
3. In Stripe → Developers → Webhooks → add an endpoint for the URL the console shows
   (`https://api.<host>/api/v1/billing/webhooks/stripe`) with `checkout.session.completed`,
   `customer.subscription.*` and `invoice.*`; paste its signing secret into the console.
4. **Sync with Stripe** — each priced plan gets its product and prices.
5. In Stripe → Settings → Billing → Customer portal, enable it (cancellation and payment-method
   updates are what the "Manage payment method" button relies on).
6. Buy a plan on a test account with `4242 4242 4242 4242`; the Billing page should show it active
   within a second or two of returning, and the owner should have the welcome email.

## Rate limits

`billingAction` 10/min per account (checkout, portal), `billingEnquiry` 3/hour per account,
`stripeWebhook` 300/min per IP.

## Verifying it

`packages/core/src/billing/*.test.ts` — lock rules, entitlements (limits, features, over-limit,
cache), the webhook handler against an in-memory database (activation, dedupe, signature refusal,
grace clock, fallback to the default plan, stale-event guard, receipt-once, payment-failed email,
error recording), the reconcile job, and the operator service (default-plan rules, key-mode
mismatch, sealed secrets, manual plan override, Stripe-managed refusal).

Beyond unit tests, the whole surface was driven end to end against a running API: registration
onto Free, limits and feature gates answering 402 with their sentences, encrypted key storage,
plan editing with the Stripe sync failing gracefully on a fake key, manual plan override, the lock
in both flavours (reads 200, writes 402, deletes allowed when over limit), and the webhook with
real Stripe signatures (`generateTestHeaderString`): unsigned and forged refused, a signed
subscription activating the plan, an invoice mirrored with its receipt sent once, and a deletion
putting the account back on Free.
