# Billing

Plans, subscriptions, limits, and what happens when an account stops fitting inside one.

Two decisions carry most of this document and are worth reading first:
[ADR-087](DECISIONS.md) draws the seam between "what a subscription means" and "who takes the
money", and [ADR-088](DECISIONS.md) says that an account over its limits becomes read-only and
never loses anything.

---

## The shape

```
plans ──< plan_features          what a plan includes
  ^
  └── subscriptions              one per account, exactly one
        ├── plan_change_requests a customer asking to move, and the answer
        └── invoices             what was owed for one period
```

A plan is a row, not a constant. Its entitlements live in `plan_features`, one row per key, each
carrying either a `limit_value` (a number, or null for unlimited) or a `bool_value` (a capability
that is on or off). The pricing page, the dashboard's usage bars and the server-side enforcement
all read the same rows, so a plan cannot advertise something it does not grant.

Every account has exactly one subscription, created with the account itself. There is no such thing
as an account without a plan — see ADR-089 for what happened when there was.

---

## Plans

| Code | Price | Annual | Self-serve |
| --- | --- | --- | --- |
| `free` | $0 | $0 | yes |
| `starter` | $29/mo | $290/yr | yes |
| `pro` | $99/mo | $990/yr | yes |
| `enterprise` | — | — | **no** — `is_contact_sales` |

Annual is stored, not derived: `price_yearly_cents` is a column, and the "two months free" the
pricing page shows is computed back from the two prices rather than hard-coded. Changing the
discount is a commercial decision somebody makes in the seed, not a constant somebody finds.

Enterprise is a real plan row with real entitlements that no customer can select. `requestChange`
refuses it with a 422 and the pricing page shows "Talk to us" instead of a price; an operator
assigns it in the console after an actual conversation. A plan a customer could pick and then not
be charged for would be a fake button.

---

## What a customer can do

`POST /billing/plan` with a plan code and an interval. Four outcomes, and the difference between
them is the whole of the commercial model:

| Situation | Outcome | What happens |
| --- | --- | --- |
| Moving to a free plan | `applied` | Immediately. Nobody should need permission to stop paying. |
| Moving to a cheaper paid plan | `scheduled` | A pending request is written; the sweeper applies it when the period the customer already paid for ends. The response carries the date. |
| Moving to a more expensive plan | `pending` | A request an operator decides. |
| Moving to a contact-sales plan | 422 | Not selectable. |

One open request at a time — a second is a 409 rather than a queue, because a queue of
contradictory intentions has no correct interpretation. `DELETE /billing/plan/:id` withdraws.

`POST /billing/cancel` stops the renewal (or, with `immediately`, ends the period now and pauses).
`POST /billing/resume` undoes it, whether or not it has already taken effect — the second case is
the one that keeps pausing from being a one-way door.

`GET /billing/subscription` is the whole billing screen in one response: plan, status, interval,
period, amount, every usage line counted live, the features the plan enables, and any pending
change.

---

## What an operator can do

In the console's **Billing** tab, behind `platform:plan:manage`:

- **Plan changes waiting on us** — upgrade requests, with Approve and Refuse. A refusal takes a
  note, because the note is what the customer is told, and "no" without a reason is a support
  ticket somebody has to answer anyway.
- **Downgrades already agreed** — listed, deliberately without buttons. Nobody has to decide these;
  an Approve button here would only be a way to take away a period the customer has paid for.
- **Invoices** — with Record payment, which marks one paid and, if the account was past due or
  read-only, restores it immediately.

`POST /platform/accounts/:id/plan` assigns a plan directly, which is how Enterprise is arranged.
`POST /platform/maintenance/subscriptions` runs the lifecycle sweeper on demand — the same method
the hourly job calls, and idempotent, so it cannot bill anybody twice.

---

## The lifecycle

One pass, hourly, in the worker (`MaintenanceJob.SUBSCRIPTION_LIFECYCLE`), with explicit stages
rather than a state machine spread across the codebase:

1. **Trials that have ended.** A trial runs on the full product for fourteen days, so ending one by
   activating it would put somebody on a paid plan they never agreed to. The subscription falls
   back to the free plan instead. Nothing built during the trial is deleted; anything past the free
   plan's limits becomes read-only.
2. **Periods that have ended.** A pending *cheaper* change is applied first, before the new period
   is priced — otherwise the customer is invoiced for the plan they asked to leave. Then the period
   rolls, an invoice is written if there is anything to bill, and a paid plan goes `past_due` with
   a fourteen-day grace window.
3. **Grace that has run out.** The subscription is paused. This is the only place an account becomes
   read-only, and it is deliberately a fortnight away from the moment a payment was missed.

Invoice numbers are per account and gapless, allocated by `UPDATE accounts SET invoice_seq =
invoice_seq + 1 ... RETURNING` inside the transaction that writes the invoice — the same trick the
ticket numbers use, and for the same reason `SELECT max(number) + 1` does not work. The plan name
and price are copied onto the invoice rather than joined, because an invoice records what was
agreed at the time and renaming a plan next year must not rewrite last year's paperwork.

---

## Enforcement

`PlanGuard` is the single place a plan decides whether something may happen. It is a **required**
constructor option on every service that creates a limited resource, so the compiler refuses to
build an unguarded one — which is the point. Before it existed, one entitlement of eighteen was
enforced and the rest were decoration.

- `assertFeature` / `assertFeatureForAccount` — is this capability in the plan at all?
- `assertCanAdd` / `assertCanAddForAccount` — would one more exceed the limit? The count lives in
  `PlanGuard`, not in the calling service, so two callers cannot count the same thing differently.
- `assertStorageRoom` — the one limit measured in bytes rather than rows.
- `assertWritable` — refuse a write while the account is paused.
- `isPropertyServing` / `entitledPropertyIds` — which websites are inside the allowance.

Two of these are applied in one place for the whole surface rather than route by route: the daily
API-request allowance and the paused-account write refusal both live in the tenant authentication
hook, so a route added next month is covered on the day it ships.

Entitlements are cached for thirty seconds per account and invalidated on every change, so an
upgrade takes effect while the customer is still looking at the page.

---

## Pause, never destroy

When an account stops fitting — a downgrade, a lapse, a cancellation — nothing is deleted,
unpublished or edited.

**A paused account** keeps every read: the inbox, the transcripts, the exports, the reports, the
billing screen. It loses every write, with a 402 `SUBSCRIPTION_PAUSED` whose message says nothing
has been deleted. `/billing/*` is the deliberate exception, because an account that cannot reach
its own billing screen can never stop being paused.

**Websites past the allowance** stop taking new conversations. Oldest-first, deterministically:
somebody has to decide which ones keep serving, and "the ones you had first" is the only answer a
customer can predict without asking. The excess are not deleted, not unpublished and not edited —
their widget simply stops starting new conversations, and they come back whole the moment the plan
does. A conversation already open keeps working: the visitor is mid-sentence, and cutting them off
punishes the wrong person for a bill they have never seen.

To a visitor, a website that has stopped serving looks exactly like one that was deleted — the same
`PROPERTY_NOT_FOUND`. A stranger on somebody else's page has no business learning that the owner is
behind on a bill.

The customer is told, in three places: a banner in the dashboard shell on every screen, an
"Outside your plan" badge on the affected websites, and the usage bars on the billing screen.

---

## Adding a card processor

Implement `BillingProvider` — `canSelfServe`, `requestChange`, `applyApprovedChange`, `cancel`,
`resume`, `issueInvoiceForPeriod` — and construct it in `apps/api/src/container.ts` instead of
`ManualBillingProvider`. Nothing above the seam changes.

`PlanChangeOutcome` already carries a `redirect` case that the manual provider never returns, so a
hosted checkout has somewhere to put its URL without that being a breaking change. Approval and
self-serve both end in `applyApprovedChange`, so a subscription only ever moves between plans down
one path — a webhook saying "the money arrived" lands in the same method an operator's approval
does.

---

## Testing

`pnpm e2e:billing` — 60-odd checks covering the public pricing endpoint, that a new account really
has a subscription, that a Free plan is refused what Free excludes (with a negative control on a
plan that includes it), the request/approve/refuse cycle, the scheduled downgrade, annual billing,
pause and resume, the over-limit website behaviour, and invoice isolation between accounts.

Two of those checks exist because the code failed them: registration created no subscription at
all, and a downgrade to a cheaper paid plan reported success while writing nothing.
