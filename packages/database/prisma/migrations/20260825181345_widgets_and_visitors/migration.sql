-- CreateEnum
CREATE TYPE "device_type" AS ENUM ('desktop', 'mobile', 'tablet', 'bot', 'unknown');

-- CreateTable
CREATE TABLE "widgets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "draft_config" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "external_id" TEXT,
    "name" TEXT,
    "email" CITEXT,
    "phone" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visit_count" INTEGER NOT NULL DEFAULT 1,
    "country" CHAR(2),
    "region" TEXT,
    "city" TEXT,
    "timezone" TEXT,
    "language" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "device_type" "device_type" NOT NULL DEFAULT 'unknown',
    "is_banned" BOOLEAN NOT NULL DEFAULT false,
    "banned_until" TIMESTAMPTZ(6),
    "ban_reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "ip" TEXT,
    "user_agent" TEXT,
    "referrer" TEXT,
    "landing_url" TEXT,
    "current_url" TEXT,
    "current_title" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "device_type" "device_type" NOT NULL DEFAULT 'unknown',
    "screen_width" INTEGER,
    "screen_height" INTEGER,
    "language" TEXT,
    "country" CHAR(2),
    "region" TEXT,
    "city" TEXT,
    "page_view_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "visitor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_page_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "referrer" TEXT,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_page_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "widgets_property_id_key" ON "widgets"("property_id");

-- CreateIndex
CREATE INDEX "widgets_account_id_idx" ON "widgets"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "widgets_account_id_id_key" ON "widgets"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "widgets_account_id_property_id_key" ON "widgets"("account_id", "property_id");

-- CreateIndex
CREATE INDEX "visitors_account_id_property_id_last_seen_at_idx" ON "visitors"("account_id", "property_id", "last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "visitors_property_id_email_idx" ON "visitors"("property_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "visitors_account_id_id_key" ON "visitors"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "visitors_property_id_external_id_key" ON "visitors"("property_id", "external_id");

-- CreateIndex
CREATE INDEX "visitor_sessions_account_id_visitor_id_started_at_idx" ON "visitor_sessions"("account_id", "visitor_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "visitor_sessions_property_id_last_seen_at_idx" ON "visitor_sessions"("property_id", "last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_account_id_id_key" ON "visitor_sessions"("account_id", "id");

-- CreateIndex
CREATE INDEX "visitor_page_views_account_id_session_id_viewed_at_idx" ON "visitor_page_views"("account_id", "session_id", "viewed_at");

-- CreateIndex
CREATE INDEX "visitor_page_views_property_id_viewed_at_idx" ON "visitor_page_views"("property_id", "viewed_at" DESC);

-- AddForeignKey
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_account_id_visitor_id_fkey" FOREIGN KEY ("account_id", "visitor_id") REFERENCES "visitors"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_page_views" ADD CONSTRAINT "visitor_page_views_account_id_session_id_fkey" FOREIGN KEY ("account_id", "session_id") REFERENCES "visitor_sessions"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
