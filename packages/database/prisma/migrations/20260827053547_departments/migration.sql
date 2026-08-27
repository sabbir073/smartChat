-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "department_id" UUID;

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key" CITEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_account_id_deleted_at_idx" ON "departments"("account_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "departments_account_id_id_key" ON "departments"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_account_id_key_key" ON "departments"("account_id", "key");

-- CreateIndex
CREATE INDEX "department_members_account_id_member_id_idx" ON "department_members"("account_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "department_members_department_id_member_id_key" ON "department_members"("department_id", "member_id");

-- CreateIndex
CREATE INDEX "conversations_account_id_department_id_status_last_message__idx" ON "conversations"("account_id", "department_id", "status", "last_message_at" DESC);

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_account_id_department_id_fkey" FOREIGN KEY ("account_id", "department_id") REFERENCES "departments"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_account_id_member_id_fkey" FOREIGN KEY ("account_id", "member_id") REFERENCES "account_members"("account_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_department_id_fkey" FOREIGN KEY ("account_id", "department_id") REFERENCES "departments"("account_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;
