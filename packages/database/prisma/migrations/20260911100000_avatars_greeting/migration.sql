-- Profile pictures: the object key and the verified content type beside the public URL.
ALTER TABLE "users"
  ADD COLUMN "avatar_key" TEXT,
  ADD COLUMN "avatar_content_type" TEXT;

-- The proactive greeting: once a day per visitor, and a conversation that knows it was opened
-- by the widget rather than by the visitor.
ALTER TABLE "visitors" ADD COLUMN "greeted_at" TIMESTAMPTZ(6);
ALTER TABLE "conversations" ADD COLUMN "greeting_at" TIMESTAMPTZ(6);
CREATE INDEX "conversations_greeting_open_idx" ON "conversations" ("greeting_at")
  WHERE "greeting_at" IS NOT NULL AND "last_visitor_message_at" IS NULL AND "status" = 'open';
