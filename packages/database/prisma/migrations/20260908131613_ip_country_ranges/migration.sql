-- CreateTable
CREATE TABLE "ip_country_ranges" (
    "id" SERIAL NOT NULL,
    "network" cidr,
    "country" CHAR(2) NOT NULL,
    "registry" VARCHAR(8) NOT NULL,

    CONSTRAINT "ip_country_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_datasets" (
    "id" TEXT NOT NULL,
    "refreshed_at" TIMESTAMPTZ(6),
    "range_count" INTEGER NOT NULL DEFAULT 0,
    "sources" JSONB NOT NULL DEFAULT '{}',
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "geo_datasets_pkey" PRIMARY KEY ("id")
);

-- Nullable to Prisma, never null in fact: see the model's comment for why the schema cannot say
-- NOT NULL, and this constraint says it instead.
ALTER TABLE "ip_country_ranges" ADD CONSTRAINT "ip_country_ranges_network_present" CHECK ("network" IS NOT NULL);

-- The lookup is `network >>= $ip` - "which stored block contains this address" - and a B-tree
-- cannot answer containment. A GiST index with inet_ops can, in a handful of page reads over
-- ~700,000 blocks.
-- CreateIndex
CREATE INDEX "ip_country_ranges_network_idx" ON "ip_country_ranges" USING GIST ("network" inet_ops);

-- The one status row, so "never loaded" is a row saying so rather than an absence.
INSERT INTO "geo_datasets" ("id", "range_count", "sources", "updated_at")
VALUES ('rir', 0, '{}', NOW())
ON CONFLICT ("id") DO NOTHING;

-- Note for whoever runs `prisma migrate dev` next: Prisma's diff cannot see a GiST index on an
-- Unsupported column and will offer to "add" the index above again. That statement would fail
-- (it exists). Delete it from the generated migration; this one is the real one.
