-- Voice calls from the widget.
--
-- A call is a chat head: it belongs to the conversation the visitor was in, the team is rung in
-- the dashboard, the AI answers when nobody does, and everything said on an AI call lands in the
-- same transcript. The plan decides whether a website may offer calls at all and how many
-- minutes a month they get.

ALTER TABLE "plans"
  ADD COLUMN "voice" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "voice_minutes_per_month" INTEGER;

-- Growth and above include calling, as promised on the pricing page. Growth gets a fair-use
-- allowance; the custom plan is unlimited and priced by hand.
UPDATE "plans" SET "voice" = true, "voice_minutes_per_month" = 500 WHERE "key" = 'growth';
UPDATE "plans" SET "voice" = true, "voice_minutes_per_month" = NULL WHERE "key" = 'custom';

-- A turn spoken on a call is recorded like a chat turn but billed as call minutes.
ALTER TABLE "ai_turns" ADD COLUMN "voice" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "call_status" AS ENUM ('ringing', 'connecting', 'active', 'ended');
CREATE TYPE "call_leg_kind" AS ENUM ('visitor', 'member', 'ai');
CREATE TYPE "call_end_reason" AS ENUM ('completed', 'no_answer', 'cancelled', 'declined', 'visitor_left', 'agent_left', 'ai_ended', 'allowance', 'failed');
CREATE TYPE "call_event_type" AS ENUM ('started', 'ring', 'answer', 'decline', 'no_answer', 'transfer_requested', 'transfer_accepted', 'transfer_failed', 'ai_joined', 'ai_left', 'ended', 'error');

CREATE TABLE "voice_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "ring_seconds" INTEGER NOT NULL DEFAULT 25,
    "ai_answers" BOOLEAN NOT NULL DEFAULT true,
    "ai_max_seconds" INTEGER NOT NULL DEFAULT 600,
    "default_language" TEXT NOT NULL DEFAULT 'en',
    "voice_en" TEXT NOT NULL DEFAULT 'en_female',
    "voice_bn" TEXT NOT NULL DEFAULT 'bn_bd',
    "voice_bn_speaker" INTEGER NOT NULL DEFAULT 0,
    "phrases" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "voice_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voice_settings_account_id_property_id_key" ON "voice_settings"("account_id", "property_id");
ALTER TABLE "voice_settings" ADD CONSTRAINT "voice_settings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_settings" ADD CONSTRAINT "voice_settings_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "status" "call_status" NOT NULL DEFAULT 'ringing',
    "room_name" TEXT NOT NULL,
    "answered_by_member_id" UUID,
    "handled_by_ai" BOOLEAN NOT NULL DEFAULT false,
    "pending_kind" "call_leg_kind",
    "pending_member_id" UUID,
    "ring_seq" INTEGER NOT NULL DEFAULT 0,
    "language" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" "call_end_reason",
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "ai_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "calls_room_name_key" ON "calls"("room_name");
CREATE UNIQUE INDEX "calls_account_id_id_key" ON "calls"("account_id", "id");
CREATE INDEX "calls_account_id_property_id_status_started_at_idx" ON "calls"("account_id", "property_id", "status", "started_at" DESC);
CREATE INDEX "calls_account_id_status_idx" ON "calls"("account_id", "status");
CREATE INDEX "calls_conversation_id_started_at_idx" ON "calls"("conversation_id", "started_at" DESC);
CREATE INDEX "calls_account_id_started_at_idx" ON "calls"("account_id", "started_at" DESC);
ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_conversation_id_fkey" FOREIGN KEY ("account_id", "conversation_id") REFERENCES "conversations"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_visitor_id_fkey" FOREIGN KEY ("account_id", "visitor_id") REFERENCES "visitors"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_answered_by_member_id_fkey" FOREIGN KEY ("account_id", "answered_by_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "call_legs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "kind" "call_leg_kind" NOT NULL,
    "member_id" UUID,
    "identity" TEXT NOT NULL,
    "joined_at" TIMESTAMPTZ(6),
    "left_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "call_legs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "call_legs_call_id_created_at_idx" ON "call_legs"("call_id", "created_at");
ALTER TABLE "call_legs" ADD CONSTRAINT "call_legs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_legs" ADD CONSTRAINT "call_legs_account_id_call_id_fkey" FOREIGN KEY ("account_id", "call_id") REFERENCES "calls"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_legs" ADD CONSTRAINT "call_legs_account_id_member_id_fkey" FOREIGN KEY ("account_id", "member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "call_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "type" "call_event_type" NOT NULL,
    "member_id" UUID,
    "target_member_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "call_events_call_id_at_idx" ON "call_events"("call_id", "at");
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_account_id_call_id_fkey" FOREIGN KEY ("account_id", "call_id") REFERENCES "calls"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
