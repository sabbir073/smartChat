# SmartChat — Backups and restore

> A backup that has never been restored is not considered reliable.

That sentence is the whole design. Everything below exists because every intermediate failure
between "we take backups" and "we can come back from this" **produces a file**:

- a truncated dump is a file;
- a dump of an empty database is a file;
- a dump taken before the last migration is a file that restores cleanly and then breaks the
  application on its first query;
- a dump with no object storage beside it restores to a system where every uploaded document is a
  broken link.

None of those are caught by checking that a backup exists, or that it is roughly the right size, or
that a cron job exited zero. They are caught by restoring and asking the restored copy questions.

## What is backed up

**Two things**, because losing either loses the product:

1. The **database** — `pg_dump --format=custom --compress=9`. Custom format rather than plain SQL:
   it restores in parallel, it can be restored selectively, and `pg_restore --list` can inspect it
   without a database to restore into.
2. The **object store** — every attachment. A dump without the files is a restore to broken links.

## What the backup script does that a `pg_dump` line would not

`infrastructure/backup/backup.sh`:

- **Writes to `<stamp>.incomplete` and renames at the end.** A partial backup that looks complete
  is worse than an obvious failure: an operator sees a directory with today's date and assumes it
  is usable.
- **Runs `pg_restore --list` on the dump immediately.** That parses the whole archive header and
  table of contents, so a truncated or corrupted file fails *in the backup window*, with the
  source database still healthy — rather than during an incident.
- **Says so, loudly, if the object store was not backed up.** A backup that quietly contains no
  files is the kind of thing discovered at the worst possible moment.
- **Writes `SHA256SUMS` and a manifest** recording the schema version, so a restore can tell
  whether the dump predates a migration.
- **Prunes only after a success, and only complete directories**, so a run of failures cannot
  silently erode the history that is still good.

## Restoring

`infrastructure/backup/restore.sh <backup-dir> [target-database]`

The target database **defaults to a scratch name**, not the live one. Restoring over production has
to be typed out in full and confirmed by name. The difference between a rehearsal and a catastrophe
is one argument, and it should not be the default.

It verifies the checksums first, and creates the Postgres extensions before restoring — the init
script only runs on a fresh volume, so a restore into an existing cluster would otherwise fail on
the first `citext` column.

## The rehearsal

```
node scripts/restore-rehearsal.mjs
```

Takes a real dump of the live database, restores it into a scratch database, and then asks the
restored copy questions:

| Check | Why |
| --- | --- |
| `PGDMP` magic bytes | "The file exists and has a size" is what a truncated dump looks like too |
| `pg_restore --list` parses it | Proves the archive is readable before anything is destroyed |
| Row counts match the source, table by table | A restore can succeed and still be missing data |
| A tenant-scoped join runs | Counts do not prove the constraints came back |
| A substring search runs | Proves the trigram indexes exist, not just the rows |
| Enum types are present | A restore missing them fails on the first insert, not the first select |
| A bad insert is **refused** | Asserting the refusal is the only way to know a foreign key is real |
| The ADR-034 column-list `SET NULL` constraints survived | They are hand-written in a migration and are exactly the sort of thing a restore can quietly lose |

The dump is piped as base64. `docker compose exec` mangles binary output on some platforms often
enough to make a rehearsal that fails intermittently — which is worse than no rehearsal, because
people learn to re-run it. Base64 costs a third more bytes and is exactly reproducible everywhere.

It cleans up after itself, and it is safe to run against a live development stack: it only ever
reads the real database and only ever writes to a scratch one it drops afterwards.

**Run it after every schema change, and on a schedule.** The failure this catches is not "the
backup broke" — it is "the backup has been subtly wrong since a migration three weeks ago".

## Retention is not backup

`Account.dataRetentionDays` deletes old conversations on purpose. Backups keep them. An account
that asked for 90-day retention and a backup set that goes back a year has not had its data
deleted — it has had it moved somewhere less visible.

If that matters for a deployment, the backup retention window has to be shorter than the shortest
data-retention policy any account has set, and that is a deployment decision rather than something
this code can make. It is stated here so it is a decision rather than an oversight.
