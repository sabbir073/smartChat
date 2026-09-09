-- The AI agent reads the website: crawled pages join articles and key facts in the index, the
-- crawl's state lives on the settings row, and the model may `chat` - answer a greeting or a
-- general question in its own words, uncited.

ALTER TYPE "KnowledgeDocumentKind" ADD VALUE 'page';
ALTER TYPE "AiDecision" ADD VALUE 'chat';

ALTER TABLE "ai_settings"
  ADD COLUMN "crawl_max_pages" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "crawl_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_crawled_at" TIMESTAMPTZ(6),
  ADD COLUMN "crawl_pages_found" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "crawl_pages_indexed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "crawl_error" TEXT;

ALTER TABLE "knowledge_documents" ADD COLUMN "last_seen_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "knowledge_documents_account_id_property_id_url_key" ON "knowledge_documents"("account_id", "property_id", "url");
