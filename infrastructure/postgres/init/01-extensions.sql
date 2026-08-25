-- Extensions required by SmartChat.
-- Executed once, on first initialisation of the postgres data volume.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email/domain columns
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram indexes for search
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- composite GIN indexes for filtered search
