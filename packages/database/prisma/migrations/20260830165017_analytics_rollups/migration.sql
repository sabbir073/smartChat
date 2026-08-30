-- CreateTable
CREATE TABLE "daily_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "conversations_started" INTEGER NOT NULL DEFAULT 0,
    "conversations_closed" INTEGER NOT NULL DEFAULT 0,
    "messages_from_visitors" INTEGER NOT NULL DEFAULT 0,
    "messages_from_agents" INTEGER NOT NULL DEFAULT 0,
    "first_response_count" INTEGER NOT NULL DEFAULT 0,
    "first_response_seconds" INTEGER NOT NULL DEFAULT 0,
    "resolution_count" INTEGER NOT NULL DEFAULT 0,
    "resolution_seconds" INTEGER NOT NULL DEFAULT 0,
    "new_visitors" INTEGER NOT NULL DEFAULT 0,
    "engaged_visitors" INTEGER NOT NULL DEFAULT 0,
    "tickets_opened" INTEGER NOT NULL DEFAULT 0,
    "tickets_resolved" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_agent_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "messages_sent" INTEGER NOT NULL DEFAULT 0,
    "conversations_closed" INTEGER NOT NULL DEFAULT 0,
    "first_response_count" INTEGER NOT NULL DEFAULT 0,
    "first_response_seconds" INTEGER NOT NULL DEFAULT 0,
    "ticket_replies_sent" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_agent_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_metrics_account_id_day_idx" ON "daily_metrics"("account_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "daily_metrics_account_id_property_id_day_key" ON "daily_metrics"("account_id", "property_id", "day");

-- CreateIndex
CREATE INDEX "daily_agent_metrics_account_id_day_idx" ON "daily_agent_metrics"("account_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "daily_agent_metrics_account_id_member_id_day_key" ON "daily_agent_metrics"("account_id", "member_id", "day");

-- AddForeignKey
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_agent_metrics" ADD CONSTRAINT "daily_agent_metrics_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_agent_metrics" ADD CONSTRAINT "daily_agent_metrics_account_id_member_id_fkey" FOREIGN KEY ("account_id", "member_id") REFERENCES "account_members"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
