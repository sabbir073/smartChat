-- CreateEnum
CREATE TYPE "attachment_status" AS ENUM ('pending', 'ready', 'rejected');

-- CreateEnum
CREATE TYPE "contact_field_type" AS ENUM ('text', 'number', 'url', 'date', 'select', 'boolean');

-- AlterTable
ALTER TABLE "visitors" ADD COLUMN     "contact_id" UUID;

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID,
    "uploader_type" "sender_type" NOT NULL,
    "uploader_member_id" UUID,
    "uploader_visitor_id" UUID,
    "storage_key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "checksum" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "status" "attachment_status" NOT NULL DEFAULT 'pending',
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "email" CITEXT,
    "name" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "notes" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_field_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "contact_field_type" NOT NULL DEFAULT 'text',
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contact_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_account_id_conversation_id_status_idx" ON "attachments"("account_id", "conversation_id", "status");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE INDEX "attachments_status_created_at_idx" ON "attachments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_account_id_id_key" ON "attachments"("account_id", "id");

-- CreateIndex
CREATE INDEX "contacts_account_id_last_seen_at_idx" ON "contacts"("account_id", "last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "contacts_name_idx" ON "contacts" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "contacts_email_idx" ON "contacts" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_account_id_id_key" ON "contacts"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_account_id_email_key" ON "contacts"("account_id", "email");

-- CreateIndex
CREATE INDEX "contact_field_definitions_account_id_position_idx" ON "contact_field_definitions"("account_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "contact_field_definitions_account_id_key_key" ON "contact_field_definitions"("account_id", "key");

-- CreateIndex
CREATE INDEX "visitors_account_id_contact_id_idx" ON "visitors"("account_id", "contact_id");

-- AddForeignKey
-- Column-list form: a bare SET NULL would try to null account_id as well, which is NOT NULL.
-- See ADR-034.
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_account_id_contact_id_fkey" FOREIGN KEY ("account_id", "contact_id") REFERENCES "contacts"("account_id", "id") ON DELETE SET NULL ("contact_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_account_id_conversation_id_fkey" FOREIGN KEY ("account_id", "conversation_id") REFERENCES "conversations"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_field_definitions" ADD CONSTRAINT "contact_field_definitions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
