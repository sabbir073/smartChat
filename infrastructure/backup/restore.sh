#!/usr/bin/env bash
#
# SmartChat — restore a backup.
#
# Usage:
#   ./infrastructure/backup/restore.sh /var/backups/smartchat/20260830T021500Z [target-database]
#
# The target database defaults to a SCRATCH name, not the live one. Restoring over production has
# to be typed out in full, because the difference between a rehearsal and a catastrophe is one
# argument and it should not be the default.
#
set -Eeuo pipefail

SOURCE="${1:?usage: restore.sh <backup-directory> [target-database]}"
TARGET="${2:-smartchat_restore_check}"
PGUSER="${POSTGRES_USER:-smartchat}"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }
trap 'fail "aborted at line $LINENO"' ERR

test -f "${SOURCE}/database.dump" || fail "no database.dump in ${SOURCE}"

if [ "$TARGET" = "${POSTGRES_DB:-smartchat}" ]; then
  log "*** RESTORING OVER THE LIVE DATABASE ***"
  log "Every row written since this backup will be lost."
  read -r -p "Type the database name to continue: " CONFIRM
  [ "$CONFIRM" = "$TARGET" ] || fail "not confirmed"
fi

log "verifying checksums"
if [ -f "${SOURCE}/SHA256SUMS" ]; then
  ( cd "$SOURCE" && sha256sum --quiet --check SHA256SUMS ) || fail "checksums do not match"
else
  log "WARNING: no SHA256SUMS in this backup - integrity not verified"
fi

# ---------------------------------------------------------------------------
# The manifest.
#
# It records the migration this dump was taken at, and until now nothing read it - so a dump taken
# before a migration restored silently into a schema that expected the migration, and the first
# sign of trouble was a query failing hours later. Reading it is the whole point of writing it.
# ---------------------------------------------------------------------------
if [ -f "${SOURCE}/manifest.txt" ]; then
  DUMP_MIGRATION=$(sed -n 's/^schema_version=//p' "${SOURCE}/manifest.txt")
  LIVE_MIGRATION=$(docker compose exec -T postgres psql -U "$PGUSER" \
    -d "${POSTGRES_DB:-smartchat}" -tAc \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1" \
    2>/dev/null | tr -d '[:space:]' || echo unknown)

  log "backup was taken at migration: ${DUMP_MIGRATION:-unknown}"
  log "this cluster is at migration:  ${LIVE_MIGRATION:-unknown}"

  if [ -n "$DUMP_MIGRATION" ] && [ "$DUMP_MIGRATION" != unknown ] \
     && [ -n "$LIVE_MIGRATION" ] && [ "$LIVE_MIGRATION" != unknown ] \
     && [ "$DUMP_MIGRATION" != "$LIVE_MIGRATION" ]; then
    log "WARNING: this dump predates the migrations this cluster has applied."
    log "Restore it, then run 'pnpm db:deploy' against ${TARGET} before using it."
  fi
else
  log "WARNING: no manifest.txt in this backup - cannot tell which migration it was taken at"
fi

log "creating ${TARGET}"
docker compose exec -T postgres psql -U "$PGUSER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${TARGET}\";" \
  -c "CREATE DATABASE \"${TARGET}\";"

# The extensions are created by the init script on a fresh volume, which a restore into an existing
# cluster does not run. Without them the restore fails on the first citext column.
log "enabling extensions"
docker compose exec -T postgres psql -U "$PGUSER" -d "$TARGET" \
  -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gin;'

log "restoring"
docker compose exec -T postgres pg_restore \
  --username "$PGUSER" \
  --dbname "$TARGET" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --jobs 4 \
  /dev/stdin < "${SOURCE}/database.dump"

log "restored into ${TARGET}"

if [ -d "${SOURCE}/objects" ] && command -v mc >/dev/null 2>&1; then
  log "restoring objects"
  mc mirror --overwrite "${SOURCE}/objects" "${S3_ALIAS:-smartchat}/${S3_BUCKET:-smartchat}"
else
  log "objects not restored (no mirror in this backup, or mc is not installed)"
fi

log "done"
