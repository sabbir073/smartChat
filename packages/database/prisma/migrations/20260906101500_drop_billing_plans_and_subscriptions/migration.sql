-- Remove billing entirely.
--
-- The product is free: there are no plans, no subscriptions, no invoices and no metered usage,
-- so the tables that held them are dropped rather than left empty. An empty table nobody writes
-- to is a standing invitation to write to it again by accident, and a schema that still describes
-- a commercial model the software does not have is a lie the next reader has to discover.
--
-- Order matters: dependent tables first, then the tables they point at, then the enum types that
-- only those tables used.

-- Dependents of plans/accounts.
DROP TABLE IF EXISTS "invoices";
DROP TABLE IF EXISTS "plan_change_requests";
DROP TABLE IF EXISTS "subscriptions";
DROP TABLE IF EXISTS "plan_features";
DROP TABLE IF EXISTS "usage_records";

-- The plan catalogue itself.
DROP TABLE IF EXISTS "plans";

-- Per-account invoice numbering has nothing left to number.
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "invoice_seq";

-- These types were used only by the tables above.
DROP TYPE IF EXISTS "invoice_status";
DROP TYPE IF EXISTS "plan_change_status";
DROP TYPE IF EXISTS "subscription_status";
DROP TYPE IF EXISTS "billing_interval";
