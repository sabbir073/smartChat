-- ADR-034. A composite `ON DELETE SET NULL` nulls EVERY column in the key, including
-- `account_id`, which would move a row into no tenant at all rather than merely unlinking it.
-- Postgres 15's column-list form names the one column that may be nulled, so the tenant key is
-- untouchable. Prisma cannot express this, so these six constraints are written by hand here and
-- the schema is left claiming plain SetNull - which is why `prisma validate` warns about them.

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('open', 'pending', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "ticket_author_type" AS ENUM ('contact', 'agent', 'system');

-- CreateEnum
CREATE TYPE "ticket_message_visibility" AS ENUM ('public', 'internal');

-- CreateEnum
CREATE TYPE "email_delivery_status" AS ENUM ('queued', 'sent', 'failed');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "ticket_seq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "support_email" CITEXT;

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "contact_id" UUID,
    "conversation_id" UUID,
    "requester_email" CITEXT NOT NULL,
    "requester_name" TEXT,
    "subject" TEXT NOT NULL,
    "status" "ticket_status" NOT NULL DEFAULT 'open',
    "priority" "ticket_priority" NOT NULL DEFAULT 'normal',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assigned_member_id" UUID,
    "department_id" UUID,
    "message_seq" INTEGER NOT NULL DEFAULT 0,
    "first_response_at" TIMESTAMPTZ(6),
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "authorType" "ticket_author_type" NOT NULL,
    "author_member_id" UUID,
    "visibility" "ticket_message_visibility" NOT NULL DEFAULT 'public',
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID,
    "template" TEXT NOT NULL,
    "to_email" CITEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "email_delivery_status" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ticket_id" UUID,
    "ticket_message_id" UUID,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tickets_account_id_status_last_message_at_idx" ON "tickets"("account_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "tickets_account_id_property_id_status_idx" ON "tickets"("account_id", "property_id", "status");

-- CreateIndex
CREATE INDEX "tickets_account_id_assigned_member_id_status_idx" ON "tickets"("account_id", "assigned_member_id", "status");

-- CreateIndex
CREATE INDEX "tickets_account_id_contact_id_idx" ON "tickets"("account_id", "contact_id");

-- CreateIndex
CREATE INDEX "tickets_account_id_conversation_id_idx" ON "tickets"("account_id", "conversation_id");

-- CreateIndex
CREATE INDEX "tickets_subject_idx" ON "tickets" USING GIN ("subject" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "tickets_account_id_id_key" ON "tickets"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_account_id_number_key" ON "tickets"("account_id", "number");

-- CreateIndex
CREATE INDEX "ticket_messages_account_id_ticket_id_created_at_idx" ON "ticket_messages"("account_id", "ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_messages_account_id_id_key" ON "ticket_messages"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_messages_ticket_id_seq_key" ON "ticket_messages"("ticket_id", "seq");

-- CreateIndex
CREATE INDEX "email_deliveries_account_id_queued_at_idx" ON "email_deliveries"("account_id", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "email_deliveries_status_queued_at_idx" ON "email_deliveries"("status", "queued_at");

-- CreateIndex
CREATE INDEX "email_deliveries_account_id_ticket_id_idx" ON "email_deliveries"("account_id", "ticket_id");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_account_id_contact_id_fkey" FOREIGN KEY ("account_id", "contact_id") REFERENCES "contacts"("account_id", "id") ON DELETE SET NULL ("contact_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_account_id_conversation_id_fkey" FOREIGN KEY ("account_id", "conversation_id") REFERENCES "conversations"("account_id", "id") ON DELETE SET NULL ("conversation_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_account_id_assigned_member_id_fkey" FOREIGN KEY ("account_id", "assigned_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ("assigned_member_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_account_id_department_id_fkey" FOREIGN KEY ("account_id", "department_id") REFERENCES "departments"("account_id", "id") ON DELETE SET NULL ("department_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_account_id_ticket_id_fkey" FOREIGN KEY ("account_id", "ticket_id") REFERENCES "tickets"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_account_id_author_member_id_fkey" FOREIGN KEY ("account_id", "author_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ("author_member_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_account_id_ticket_id_fkey" FOREIGN KEY ("account_id", "ticket_id") REFERENCES "tickets"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_account_id_ticket_message_id_fkey" FOREIGN KEY ("account_id", "ticket_message_id") REFERENCES "ticket_messages"("account_id", "id") ON DELETE SET NULL ("ticket_message_id") ON UPDATE CASCADE;
