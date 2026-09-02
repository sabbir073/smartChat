-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "plan_change_status" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('issued', 'paid', 'void');

-- AlterEnum
ALTER TYPE "subscription_status" ADD VALUE 'paused';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "invoice_seq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "is_contact_sales" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "price_yearly_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tagline" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "grace_ends_at" TIMESTAMPTZ(6),
ADD COLUMN     "interval" "billing_interval" NOT NULL DEFAULT 'monthly',
ADD COLUMN     "paused_at" TIMESTAMPTZ(6),
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "plan_change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "from_plan_id" UUID NOT NULL,
    "to_plan_id" UUID NOT NULL,
    "interval" "billing_interval" NOT NULL DEFAULT 'monthly',
    "status" "plan_change_status" NOT NULL DEFAULT 'pending',
    "requested_by_user_id" UUID,
    "requested_by_email" TEXT,
    "decided_by_admin_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_name" TEXT NOT NULL,
    "interval" "billing_interval" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "status" "invoice_status" NOT NULL DEFAULT 'issued',
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "reference" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_change_requests_account_id_created_at_idx" ON "plan_change_requests"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "plan_change_requests_status_created_at_idx" ON "plan_change_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "invoices_account_id_issued_at_idx" ON "invoices"("account_id", "issued_at");

-- CreateIndex
CREATE INDEX "invoices_status_issued_at_idx" ON "invoices"("status", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_account_id_number_key" ON "invoices"("account_id", "number");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "subscriptions_status_grace_ends_at_idx" ON "subscriptions"("status", "grace_ends_at");

-- AddForeignKey
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_from_plan_id_fkey" FOREIGN KEY ("from_plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_to_plan_id_fkey" FOREIGN KEY ("to_plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
