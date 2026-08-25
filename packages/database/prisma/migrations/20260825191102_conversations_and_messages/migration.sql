-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('open', 'pending', 'closed');

-- CreateEnum
CREATE TYPE "conversation_priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "conversation_channel" AS ENUM ('widget', 'offline_form', 'email', 'api');

-- CreateEnum
CREATE TYPE "sender_type" AS ENUM ('visitor', 'agent', 'system', 'bot');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('text', 'file', 'image', 'system', 'note');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "status" "conversation_status" NOT NULL DEFAULT 'open',
    "priority" "conversation_priority" NOT NULL DEFAULT 'normal',
    "channel" "conversation_channel" NOT NULL DEFAULT 'widget',
    "assigned_member_id" UUID,
    "message_seq" BIGINT NOT NULL DEFAULT 0,
    "subject" TEXT,
    "pre_chat_data" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_visitor_message_at" TIMESTAMPTZ(6),
    "last_agent_message_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_member_id" UUID,
    "visitor_unread_count" INTEGER NOT NULL DEFAULT 0,
    "agent_unread_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "client_message_id" TEXT,
    "senderType" "sender_type" NOT NULL,
    "sender_member_id" UUID,
    "sender_visitor_id" UUID,
    "type" "message_type" NOT NULL DEFAULT 'text',
    "body" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "delivered_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "edited_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_reads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_account_id_property_id_status_last_message_at_idx" ON "conversations"("account_id", "property_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_account_id_assigned_member_id_status_last_mes_idx" ON "conversations"("account_id", "assigned_member_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_account_id_visitor_id_last_message_at_idx" ON "conversations"("account_id", "visitor_id", "last_message_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_account_id_id_key" ON "conversations"("account_id", "id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_seq_idx" ON "messages"("conversation_id", "seq" DESC);

-- CreateIndex
CREATE INDEX "messages_account_id_created_at_idx" ON "messages"("account_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_client_message_id_key" ON "messages"("conversation_id", "client_message_id");

-- CreateIndex
CREATE INDEX "conversation_reads_account_id_member_id_idx" ON "conversation_reads"("account_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_reads_conversation_id_member_id_key" ON "conversation_reads"("conversation_id", "member_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_visitor_id_fkey" FOREIGN KEY ("account_id", "visitor_id") REFERENCES "visitors"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_assigned_member_id_fkey" FOREIGN KEY ("account_id", "assigned_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_conversation_id_fkey" FOREIGN KEY ("account_id", "conversation_id") REFERENCES "conversations"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_sender_member_id_fkey" FOREIGN KEY ("account_id", "sender_member_id") REFERENCES "account_members"("account_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_account_id_conversation_id_fkey" FOREIGN KEY ("account_id", "conversation_id") REFERENCES "conversations"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_account_id_member_id_fkey" FOREIGN KEY ("account_id", "member_id") REFERENCES "account_members"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
