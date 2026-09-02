-- Backfill: every account gets a subscription.
--
-- Registration created accounts without one for the whole of the product's life before this. An
-- account with no subscription has no entitlements, and no entitlements reads as "no limits"
-- everywhere downstream - so every account created that way was silently on an unmetered plan
-- while the pricing page advertised limits.
--
-- Purely additive: it inserts rows for accounts that have none and touches nothing that exists.
-- Safe to re-run, and a no-op on a database whose plans have not been seeded yet (the code path
-- that creates subscriptions repairs those accounts on their next billing read).
--
-- The cheapest published, self-serve plan is the deliberate target. These accounts never agreed
-- to pay for anything, so putting them on a paid plan would be inventing a contract; nothing they
-- already have is deleted, and anything past the limit becomes read-only rather than removed.
INSERT INTO subscriptions (
  id, account_id, plan_id, status, "interval",
  current_period_start, current_period_end, provider, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  a.id,
  p.id,
  'active'::"subscription_status",
  'monthly'::"billing_interval",
  now(),
  now() + interval '1 month',
  'manual',
  now(),
  now()
FROM accounts a
CROSS JOIN LATERAL (
  SELECT plans.id
  FROM plans
  WHERE plans.is_public = true AND plans.is_contact_sales = false
  ORDER BY plans.price_monthly_cents ASC, plans.sort_order ASC
  LIMIT 1
) p
WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id);
