-- A call that nobody answered while the AI was on as many calls as the machine can carry now
-- waits for the AI instead of being dropped, oldest first; and when that wait runs out, the call
-- ends as "busy" rather than as "nobody is available", which is not what happened.
ALTER TYPE "call_end_reason" ADD VALUE 'busy';
ALTER TYPE "call_event_type" ADD VALUE 'ai_queued';

ALTER TABLE "calls" ADD COLUMN "ai_queued_at" TIMESTAMPTZ(6);

-- Server-wide questions, across accounts: how many calls the AI is on, and who is waiting.
CREATE INDEX "calls_status_handled_by_ai_idx" ON "calls"("status", "handled_by_ai");
CREATE INDEX "calls_status_ai_queued_at_idx" ON "calls"("status", "ai_queued_at");
