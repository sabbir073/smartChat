-- Visitors can rate an AI reply; agents can ask the AI for a draft. Both live on ai_turns.

ALTER TYPE "AiDecision" ADD VALUE 'draft';

CREATE TYPE "AiRating" AS ENUM ('up', 'down');

ALTER TABLE "ai_turns"
  ADD COLUMN "rating" "AiRating",
  ADD COLUMN "rated_at" TIMESTAMPTZ(6);

CREATE INDEX "ai_turns_property_id_created_at_idx" ON "ai_turns"("property_id", "created_at" DESC);
CREATE INDEX "ai_turns_reply_message_id_idx" ON "ai_turns"("reply_message_id");
