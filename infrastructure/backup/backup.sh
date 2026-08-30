#!/usr/bin/env bash
#
# SmartChat — take a backup.
#
# Two things are backed up, because losing either one loses the product: the database, and the
# object store that the database's attachment rows point at. A dump without the files restores to
# a system where every uploaded document is a broken link.
#
# Usage on the server:
#   ./infrastructure/backup/backup.sh [destination-directory]
#
# Cron, daily at 02:15, keeping two weeks:
#   15 2 * * * cd /opt/smartchat && ./infrastructure/backup/backup.sh >> /var/log/smartchat-backup.log 2>&1
#
set -Eeuo pipefail

DEST="${1:-${BACKUP_DIR:-/var/backups/smartchat}}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${DEST}/${STAMP}"

# A partial backup that looks complete is worse than an obvious failure: an operator sees a
# directory with today's date and assumes it is usable. So the work happens in a temporary name and
# is only renamed into place at the very end.
STAGING="${WORK}.incomplete"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }
trap 'fail "aborted at line $LINENO"' ERR

mkdir -p "$STAGING"
log "backing up to ${STAGING}"

# ---------------------------------------------------------------------------
# The database
#
# Custom format (-Fc), not plain SQL: it restores in parallel, it can be restored selectively, and
# `pg_restore --list` can inspect it without a database to restore into. Compressed, because a
# transcript table is mostly text.
# ---------------------------------------------------------------------------
log "dumping postgres"
docker compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER:-smartchat}" \
  --dbname "${POSTGRES_DB:-smartchat}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  > "${STAGING}/database.dump"

test -s "${STAGING}/database.dump" || fail "the dump is empty"

# Proof the dump is readable, taken now rather than discovered during an incident. `pg_restore
# --list` parses the whole archive header and table of contents, so a truncated or corrupted file
# fails here - in the backup window, with the source database still healthy.
log "verifying the dump can be read"
docker compose exec -T postgres pg_restore --list /dev/stdin < "${STAGING}/database.dump" \
  > "${STAGING}/database.toc" || fail "the dump is not readable by pg_restore"

# ---------------------------------------------------------------------------
# The object store
# ---------------------------------------------------------------------------
log "mirroring the object store"
if command -v mc >/dev/null 2>&1; then
  mc mirror --overwrite --remove "${S3_ALIAS:-smartchat}/${S3_BUCKET:-smartchat}" \
    "${STAGING}/objects" || fail "object mirror failed"
else
  # Said out loud rather than skipped silently. A backup that quietly contains no files is the
  # kind of thing discovered at the worst possible moment.
  log "WARNING: the MinIO client (mc) is not installed - object storage was NOT backed up"
  echo "objects-not-backed-up" > "${STAGING}/objects.MISSING"
fi

# ---------------------------------------------------------------------------
# Checksums and the manifest
# ---------------------------------------------------------------------------
log "writing checksums"
( cd "$STAGING" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS )

cat > "${STAGING}/manifest.txt" <<MANIFEST
taken_at=${STAMP}
host=$(hostname)
database=${POSTGRES_DB:-smartchat}
dump_bytes=$(stat -c %s "${STAGING}/database.dump")
schema_version=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-smartchat}" \
  -d "${POSTGRES_DB:-smartchat}" -tAc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1" 2>/dev/null || echo unknown)
MANIFEST

mv "$STAGING" "$WORK"
log "backup complete: ${WORK}"

# ---------------------------------------------------------------------------
# Pruning
#
# Only ever removes directories that are complete, and only after a successful new backup - so a
# run of failures cannot silently erode the history that is still good.
# ---------------------------------------------------------------------------
log "pruning backups older than ${KEEP_DAYS} days"
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime "+${KEEP_DAYS}" -exec rm -rf {} +

log "done"
