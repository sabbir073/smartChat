-- The assistant reads files the owner uploads (PDF, DOCX, text), and the crawl can be told which
-- paths to skip.

ALTER TYPE "KnowledgeDocumentKind" ADD VALUE 'file';

CREATE TYPE "KnowledgeFileStatus" AS ENUM ('pending', 'processing', 'ready', 'failed');

ALTER TABLE "ai_settings" ADD COLUMN "crawl_exclude" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "knowledge_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "document_id" UUID,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT '',
    "byte_size" INTEGER NOT NULL DEFAULT 0,
    "storage_key" TEXT NOT NULL,
    "status" "KnowledgeFileStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "uploaded_by_member_id" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_files_document_id_key" ON "knowledge_files"("document_id");
CREATE INDEX "knowledge_files_account_id_property_id_created_at_idx" ON "knowledge_files"("account_id", "property_id", "created_at");
CREATE UNIQUE INDEX "knowledge_files_account_id_id_key" ON "knowledge_files"("account_id", "id");

ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
