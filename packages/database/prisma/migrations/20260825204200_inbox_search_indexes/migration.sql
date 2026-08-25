-- CreateIndex
CREATE INDEX "conversations_subject_idx" ON "conversations" USING GIN ("subject" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "conversations_tags_idx" ON "conversations" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "messages_body_idx" ON "messages" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "visitors_name_idx" ON "visitors" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "visitors_email_idx" ON "visitors" USING GIN ("email" gin_trgm_ops);
