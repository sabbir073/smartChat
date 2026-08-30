-- Two enum columns were created without an @map, so Prisma quoted them into the database in
-- camelCase while every other column in the schema is snake_case. Nothing was wrong with the data
-- and no Prisma query ever noticed - but raw SQL did, immediately and confusingly: the analytics
-- rollup failed with `column "sender_type" does not exist` against a table that plainly has a
-- sender type.
--
-- Written by hand as a RENAME. Prisma's own diff would express this as a DROP and an ADD, which
-- would silently discard every existing message's sender.
ALTER TABLE "messages" RENAME COLUMN "senderType" TO "sender_type";
ALTER TABLE "ticket_messages" RENAME COLUMN "authorType" TO "author_type";
