-- Phase 4 of the AI agent: Anthropic as a provider, an account's own key, product feeds.

ALTER TYPE "AiProviderKind" ADD VALUE 'anthropic';
ALTER TYPE "KnowledgeDocumentKind" ADD VALUE 'product';

CREATE TYPE "AccountAiRouting" AS ENUM ('local_first', 'own_only');

ALTER TABLE "plans" ADD COLUMN "ai_own_key" BOOLEAN NOT NULL DEFAULT false;
-- The custom plan is where "bring your own key" was promised.
UPDATE "plans" SET "ai_own_key" = true WHERE "key" = 'custom';

ALTER TABLE "ai_settings"
  ADD COLUMN "product_feed_url" TEXT,
  ADD COLUMN "last_feed_at" TIMESTAMPTZ(6),
  ADD COLUMN "feed_products" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "feed_error" TEXT;

CREATE TABLE "account_ai_settings" (
    "account_id" UUID NOT NULL,
    "provider" "AiProviderKind" NOT NULL,
    "api_key_sealed" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "routing" "AccountAiRouting" NOT NULL DEFAULT 'local_first',
    "last_tested_at" TIMESTAMPTZ(6),
    "last_test_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_ai_settings_pkey" PRIMARY KEY ("account_id")
);

ALTER TABLE "account_ai_settings" ADD CONSTRAINT "account_ai_settings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
