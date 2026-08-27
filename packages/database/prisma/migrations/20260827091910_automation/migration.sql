-- CreateEnum
CREATE TYPE "trigger_event" AS ENUM ('visitor_arrived', 'page_viewed', 'time_on_site', 'conversation_started');

-- CreateEnum
CREATE TYPE "trigger_match" AS ENUM ('all', 'any');

-- CreateEnum
CREATE TYPE "trigger_frequency" AS ENUM ('once_per_session', 'once_per_visitor', 'every_time');

-- CreateTable
CREATE TABLE "triggers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "event" "trigger_event" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "match" "trigger_match" NOT NULL DEFAULT 'all',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "frequency" "trigger_frequency" NOT NULL DEFAULT 'once_per_session',
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 60,
    "after_seconds" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "fire_count" INTEGER NOT NULL DEFAULT 0,
    "last_fired_at" TIMESTAMPTZ(6),
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_firings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "trigger_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "session_id" UUID,
    "conversation_id" UUID,
    "dedupe_key" TEXT,
    "fired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_firings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shortcuts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "key" CITEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "shortcuts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "triggers_account_id_event_enabled_position_idx" ON "triggers"("account_id", "event", "enabled", "position");

-- CreateIndex
CREATE INDEX "triggers_account_id_property_id_deleted_at_idx" ON "triggers"("account_id", "property_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "triggers_account_id_id_key" ON "triggers"("account_id", "id");

-- CreateIndex
CREATE INDEX "trigger_firings_account_id_trigger_id_visitor_id_fired_at_idx" ON "trigger_firings"("account_id", "trigger_id", "visitor_id", "fired_at" DESC);

-- CreateIndex
CREATE INDEX "trigger_firings_account_id_fired_at_idx" ON "trigger_firings"("account_id", "fired_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "trigger_firings_trigger_id_dedupe_key_key" ON "trigger_firings"("trigger_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "shortcuts_account_id_deleted_at_usage_count_idx" ON "shortcuts"("account_id", "deleted_at", "usage_count" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shortcuts_account_id_id_key" ON "shortcuts"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shortcuts_account_id_key_key" ON "shortcuts"("account_id", "key");

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_account_id_created_by_member_id_fkey" FOREIGN KEY ("account_id", "created_by_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ("created_by_member_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_firings" ADD CONSTRAINT "trigger_firings_account_id_trigger_id_fkey" FOREIGN KEY ("account_id", "trigger_id") REFERENCES "triggers"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_firings" ADD CONSTRAINT "trigger_firings_account_id_visitor_id_fkey" FOREIGN KEY ("account_id", "visitor_id") REFERENCES "visitors"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_firings" ADD CONSTRAINT "trigger_firings_account_id_conversation_id_fkey" FOREIGN KEY ("account_id", "conversation_id") REFERENCES "conversations"("account_id", "id") ON DELETE SET NULL ("conversation_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortcuts" ADD CONSTRAINT "shortcuts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortcuts" ADD CONSTRAINT "shortcuts_account_id_created_by_member_id_fkey" FOREIGN KEY ("account_id", "created_by_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ("created_by_member_id") ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Repair: ON DELETE SET NULL across a tenant-composite foreign key
--
-- Prisma emits a bare `ON DELETE SET NULL`, which tells Postgres to null *every* column in the
-- key. On these keys one of those columns is `account_id`, which is NOT NULL - so deleting a
-- referenced row does not null the reference, it fails outright with a not-null violation. The
-- three constraints below were written that way by earlier migrations. Postgres 15 added the
-- column-list form, which nulls only the column that is allowed to be null; that is what these
-- keys have always meant. See ADR-034.
--
-- Nothing hard-deletes an account member or a department today (both are soft-deleted), so this
-- repairs a latent fault rather than a live one.
-- ---------------------------------------------------------------------------

ALTER TABLE "conversations" DROP CONSTRAINT "conversations_account_id_assigned_member_id_fkey";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_assigned_member_id_fkey" FOREIGN KEY ("account_id", "assigned_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ("assigned_member_id") ON UPDATE CASCADE;

ALTER TABLE "conversations" DROP CONSTRAINT "conversations_account_id_department_id_fkey";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_department_id_fkey" FOREIGN KEY ("account_id", "department_id") REFERENCES "departments"("account_id", "id") ON DELETE SET NULL ("department_id") ON UPDATE CASCADE;

ALTER TABLE "messages" DROP CONSTRAINT "messages_account_id_sender_member_id_fkey";
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_sender_member_id_fkey" FOREIGN KEY ("account_id", "sender_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ("sender_member_id") ON UPDATE CASCADE;
