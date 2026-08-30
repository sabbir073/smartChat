-- CreateEnum
CREATE TYPE "article_status" AS ENUM ('draft', 'published');

-- CreateTable
CREATE TABLE "kb_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" CITEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "kb_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_articles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "category_id" UUID,
    "slug" CITEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "body" TEXT NOT NULL,
    "status" "article_status" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(6),
    "author_member_id" UUID,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "not_helpful_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_categories_account_id_property_id_position_idx" ON "kb_categories"("account_id", "property_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "kb_categories_account_id_id_key" ON "kb_categories"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "kb_categories_property_id_slug_key" ON "kb_categories"("property_id", "slug");

-- CreateIndex
CREATE INDEX "kb_articles_account_id_property_id_status_published_at_idx" ON "kb_articles"("account_id", "property_id", "status", "published_at" DESC);

-- CreateIndex
CREATE INDEX "kb_articles_account_id_category_id_status_idx" ON "kb_articles"("account_id", "category_id", "status");

-- CreateIndex
CREATE INDEX "kb_articles_title_idx" ON "kb_articles" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "kb_articles_body_idx" ON "kb_articles" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "kb_articles_account_id_id_key" ON "kb_articles"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "kb_articles_property_id_slug_key" ON "kb_articles"("property_id", "slug");

-- AddForeignKey
ALTER TABLE "kb_categories" ADD CONSTRAINT "kb_categories_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_categories" ADD CONSTRAINT "kb_categories_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_account_id_property_id_fkey" FOREIGN KEY ("account_id", "property_id") REFERENCES "properties"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Column-list form: a bare SET NULL would null account_id too, which is NOT NULL. See ADR-034.
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_account_id_category_id_fkey" FOREIGN KEY ("account_id", "category_id") REFERENCES "kb_categories"("account_id", "id") ON DELETE SET NULL ("category_id") ON UPDATE CASCADE;
