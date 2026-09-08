-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('month', 'year');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('none', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired');

-- CreateEnum
CREATE TYPE "billing_provider" AS ENUM ('manual', 'stripe');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'open', 'paid', 'uncollectible', 'void');

-- DropIndex
DROP INDEX "ip_country_ranges_network_idx";

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "description" TEXT,
    "monthly_price_cents" INTEGER NOT NULL DEFAULT 0,
    "annual_price_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'usd',
    "max_properties" INTEGER,
    "max_members" INTEGER,
    "ai_agent" BOOLEAN NOT NULL DEFAULT false,
    "integrations" BOOLEAN NOT NULL DEFAULT false,
    "remove_branding" BOOLEAN NOT NULL DEFAULT false,
    "is_contact_sales" BOOLEAN NOT NULL DEFAULT false,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "stripe_product_id" TEXT,
    "stripe_monthly_price_id" TEXT,
    "stripe_annual_price_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'none',
    "interval" "billing_interval" NOT NULL DEFAULT 'month',
    "provider" "billing_provider" NOT NULL DEFAULT 'manual',
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "past_due_since" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "number" TEXT,
    "status" "invoice_status" NOT NULL DEFAULT 'open',
    "amount_due_cents" INTEGER NOT NULL,
    "amount_paid_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "plan_name" TEXT,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "hosted_invoice_url" TEXT,
    "invoice_pdf_url" TEXT,
    "issued_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_enquiries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "user_id" UUID,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "wants" JSONB NOT NULL DEFAULT '{}',
    "handled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_admin_id" UUID,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE INDEX "plans_is_active_sort_order_idx" ON "plans"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_account_id_key" ON "subscriptions"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_past_due_since_idx" ON "subscriptions"("status", "past_due_since");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "invoices_account_id_created_at_idx" ON "invoices"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stripe_events_received_at_idx" ON "stripe_events"("received_at" DESC);

-- CreateIndex
CREATE INDEX "billing_enquiries_handled_at_created_at_idx" ON "billing_enquiries"("handled_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ip_country_ranges_network_idx" ON "ip_country_ranges" USING GIST ("network" inet_ops);

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_enquiries" ADD CONSTRAINT "billing_enquiries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The catalogue this product launches with. The operator edits it in the console from here on;
-- these rows are only the starting point, and re-running the migration never overwrites edits.
--
-- Annual is ten months for the price of twelve. Prices are in cents.
-- ---------------------------------------------------------------------------
INSERT INTO "plans" (
  "id", "key", "name", "tagline", "description",
  "monthly_price_cents", "annual_price_cents", "currency",
  "max_properties", "max_members", "ai_agent", "integrations", "remove_branding",
  "is_contact_sales", "is_public", "is_default", "is_active", "sort_order", "updated_at"
) VALUES
  (gen_random_uuid(), 'free', 'Free', 'For one website and one person',
   'Live chat on one website, with one seat. Everything a small site needs to talk to its visitors.',
   0, 0, 'usd', 1, 1, false, false, false, false, true, true, true, 0, NOW()),
  (gen_random_uuid(), 'starter', 'Starter', 'For a small team',
   'Up to three websites and five team members, with API access and webhooks.',
   2000, 20000, 'usd', 3, 5, false, true, false, false, true, false, true, 10, NOW()),
  (gen_random_uuid(), 'growth', 'Growth', 'For a support team, with an AI agent',
   'Ten websites, fifteen team members, an AI agent that answers first, and your own branding on the widget.',
   5000, 50000, 'usd', 10, 15, true, true, true, false, true, false, true, 20, NOW()),
  (gen_random_uuid(), 'custom', 'Custom', 'For larger teams and special requirements',
   'More websites, more seats, single sign-on, a dedicated contact. Tell us what you need.',
   0, 0, 'usd', NULL, NULL, true, true, true, true, true, false, true, 30, NOW())
ON CONFLICT ("key") DO NOTHING;

-- Every account has a subscription, always. Existing accounts land on the default plan with no
-- Stripe objects behind them, exactly as a new signup does.
INSERT INTO "subscriptions" ("id", "account_id", "plan_id", "status", "interval", "provider", "updated_at")
SELECT gen_random_uuid(), a."id", p."id", 'none', 'month', 'manual', NOW()
FROM "accounts" a
CROSS JOIN (SELECT "id" FROM "plans" WHERE "is_default" = true LIMIT 1) p
WHERE NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."account_id" = a."id");

-- Grace before a past-due account is locked, in days. Editable in the console.
INSERT INTO "platform_settings" ("key", "value", "encrypted", "updated_at")
VALUES ('billing.grace_days', '3', false, NOW())
ON CONFLICT ("key") DO NOTHING;

-- Permissions are copied into each account's editable role rows when the account is created, so
-- a new permission has to be granted to the roles that already exist. Owners and admins get
-- billing; managers and agents do not - the same split as every other account-level setting.
UPDATE "roles"
SET "permissions" = array_cat("permissions", ARRAY['billing:view', 'billing:manage'])
WHERE "is_system" = true
  AND "key" IN ('owner', 'admin')
  AND NOT ('billing:manage' = ANY("permissions"));

-- The platform administrators that exist today were seeded before billing had a permission.
UPDATE "platform_admins"
SET "permissions" = array_append("permissions", 'platform:billing:manage')
WHERE NOT ('platform:billing:manage' = ANY("permissions"));
