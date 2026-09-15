-- When the assistant may say "give me a moment".
--
-- It used to be a constant of 4.5 seconds, set from a stale measurement: on the production CPU a
-- real answer takes about 6.4 seconds, so the line went out before almost every one of them and
-- read as noise. This is the floor for a rule that also compares against the website's own recent
-- replies, so the line is only said when an answer is genuinely slower than usual. 0 = never.
ALTER TABLE "ai_settings"
  ADD COLUMN "checking_after_seconds" INTEGER NOT NULL DEFAULT 10;
