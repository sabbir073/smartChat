-- The assistant's rhythm: it takes a chat back when the person it handed off to does not reply,
-- asks a quiet visitor whether to close, closes politely, and speaks under its own name.

ALTER TABLE "ai_settings"
  ALTER COLUMN "ticket_offer_text" SET DEFAULT 'I''ve checked our information and I don''t have a definite answer on that. Let me create a ticket so a team member can look into it properly and get back to you by email.',
  ADD COLUMN "checking_text" TEXT NOT NULL DEFAULT 'Give me a moment, I''m checking that for you...',
  ADD COLUMN "offline_handoff_text" TEXT NOT NULL DEFAULT 'Our team isn''t online right now. I can open a ticket so they follow up by email, and I''m happy to keep helping you here in the meantime.',
  ADD COLUMN "urgent_text" TEXT NOT NULL DEFAULT 'I''ve marked this as urgent so the team sees it first.',
  ADD COLUMN "handoff_wait_minutes" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "handoff_back_text" TEXT NOT NULL DEFAULT 'It looks like our team member isn''t available right now. I can keep helping you here, or open a ticket so they follow up by email - which would you prefer?',
  ADD COLUMN "idle_nudge_minutes" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "idle_nudge_text" TEXT NOT NULL DEFAULT 'I haven''t heard from you for a little while - is there anything else I can help with, or shall I close this chat?',
  ADD COLUMN "idle_close_minutes" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "idle_close_text" TEXT NOT NULL DEFAULT 'Thanks for chatting with us today - I''ll close this chat for now. Come back any time, we''re always happy to help. Goodbye!',
  ADD COLUMN "show_ai_badge" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "suggest_replies" BOOLEAN NOT NULL DEFAULT true;

-- Websites still on the old refusal sentence get the new one; anyone who wrote their own keeps it.
UPDATE "ai_settings" SET "ticket_offer_text" = 'I''ve checked our information and I don''t have a definite answer on that. Let me create a ticket so a team member can look into it properly and get back to you by email.'
WHERE "ticket_offer_text" = 'I can''t help with that from here, but our team can. Would you like me to open a support ticket so they can follow up by email?';

ALTER TABLE "conversations"
  ADD COLUMN "ai_followup_seq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ai_idle_nudged_at" TIMESTAMPTZ(6),
  ADD COLUMN "ai_suggestions" JSONB,
  ADD COLUMN "ai_suggested_at" TIMESTAMPTZ(6);
