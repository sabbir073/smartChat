#!/usr/bin/env node
/**
 * The restore rehearsal.
 *
 * "A backup that has never been restored is not considered reliable." So this does not check that
 * a backup file exists, or that it is the right size, or that a script exits zero. It takes a real
 * dump of the live database, restores it into a scratch database, and then **asks the restored
 * copy questions** - row counts against the original, a tenant-scoped join, a trigram search that
 * needs an index, and a foreign key that must still refuse a bad write.
 *
 * The distinction matters because every intermediate failure produces a file. A truncated dump is
 * a file. A dump of an empty database is a file. A dump taken before the last migration is a file
 * that restores cleanly and then breaks the application on its first query. None of those are
 * caught by anything except restoring and looking.
 *
 *   node scripts/restore-rehearsal.mjs
 *
 * Runs against the development stack. On a server, the same two shell scripts do the same work:
 * infrastructure/backup/backup.sh and infrastructure/backup/restore.sh.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PGUSER = process.env.POSTGRES_USER ?? 'smartchat';
const PGDB = process.env.POSTGRES_DB ?? 'smartchat';
const SCRATCH = 'smartchat_restore_rehearsal';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
    return;
  }
  failures.push(name);
  process.stdout.write(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n== ${title} ==\n`);
}

/** One value out of a database, as text. */
function query(database, sql) {
  const result = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', PGUSER, '-d', database, '-tAc', sql],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`query failed on ${database}: ${(result.stderr || '').trim().slice(0, 400)}`);
  }
  return result.stdout.trim();
}

function psql(database, ...args) {
  const result = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', PGUSER, '-d', database, ...args],
    { encoding: 'utf8' },
  );
  return result;
}

const workDir = mkdtempSync(join(tmpdir(), 'smartchat-rehearsal-'));
const dumpPath = join(workDir, 'database.dump');

function cleanup() {
  psql('postgres', '-c', `DROP DATABASE IF EXISTS "${SCRATCH}";`);
  rmSync(workDir, { recursive: true, force: true });
}

async function main() {
  section('Take a backup of the live database');

  /**
   * The dump is written as base64 and decoded here.
   *
   * `docker compose exec` allocates a pseudo-terminal by default and mangles binary output; `-T`
   * disables that, but Windows' pipe handling still corrupts a compressed stream often enough to
   * make a rehearsal that fails intermittently - which is worse than no rehearsal, because people
   * learn to re-run it. Base64 costs a third more bytes and is exactly reproducible everywhere.
   */
  const dump = execFileSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres', 'sh', '-c',
      `pg_dump -U ${PGUSER} -d ${PGDB} --format=custom --compress=9 --no-owner --no-privileges | base64 -w 0`,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 },
  );
  writeFileSync(dumpPath, Buffer.from(dump.trim(), 'base64'));

  const size = statSync(dumpPath).size;
  check('a dump was produced', size > 0, `${size} bytes`);
  check('and it is not suspiciously small', size > 10_000, `${size} bytes`);

  /**
   * The magic bytes of a custom-format archive.
   *
   * Checked because "the file exists and has a size" is exactly what a truncated or
   * transport-mangled dump also looks like.
   */
  const header = readFileSync(dumpPath).subarray(0, 5).toString('latin1');
  check('it really is a pg_dump custom archive', header === 'PGDMP', JSON.stringify(header));

  section('Read it back without restoring, the way the backup script does');
  const toc = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'base64 -d | pg_restore --list'],
    { input: dump, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 },
  );
  check('pg_restore can parse the archive', toc.status === 0, (toc.stderr || '').slice(0, 200));
  check(
    'and its table of contents names the tables we expect',
    toc.stdout.includes('conversations') &&
      toc.stdout.includes('messages') &&
      toc.stdout.includes('accounts'),
  );

  section('What the original contains');
  const before = {
    accounts: Number(query(PGDB, 'SELECT count(*) FROM accounts')),
    conversations: Number(query(PGDB, 'SELECT count(*) FROM conversations')),
    messages: Number(query(PGDB, 'SELECT count(*) FROM messages')),
    tickets: Number(query(PGDB, 'SELECT count(*) FROM tickets')),
    articles: Number(query(PGDB, 'SELECT count(*) FROM kb_articles')),
    migrations: Number(
      query(PGDB, 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL'),
    ),
  };
  process.stdout.write(`  ${JSON.stringify(before)}\n`);
  check(
    'the source database has something in it to lose',
    before.accounts > 0 && before.messages > 0,
    JSON.stringify(before),
  );

  section('Restore into a scratch database');
  psql('postgres', '-c', `DROP DATABASE IF EXISTS "${SCRATCH}";`);
  const createdScratch = psql('postgres', '-c', `CREATE DATABASE "${SCRATCH}";`);
  check('a scratch database was created', createdScratch.status === 0, createdScratch.stderr);

  // The init script only runs on a fresh volume, so a restore into an existing cluster has to
  // create the extensions itself. Without them the restore fails on the first citext column -
  // which is precisely the kind of thing a rehearsal exists to find *before* an incident.
  const extensions = psql(
    SCRATCH,
    '-c',
    'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gin;',
  );
  check('extensions were enabled', extensions.status === 0, extensions.stderr);

  const restored = spawnSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres', 'sh', '-c',
      `base64 -d | pg_restore -U ${PGUSER} -d ${SCRATCH} --no-owner --no-privileges --exit-on-error`,
    ],
    { input: dump, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 },
  );
  check(
    'the restore completed with no errors at all',
    restored.status === 0,
    (restored.stderr || '').split('\n').slice(0, 4).join(' | '),
  );

  section('Ask the restored copy questions');
  const after = {
    accounts: Number(query(SCRATCH, 'SELECT count(*) FROM accounts')),
    conversations: Number(query(SCRATCH, 'SELECT count(*) FROM conversations')),
    messages: Number(query(SCRATCH, 'SELECT count(*) FROM messages')),
    tickets: Number(query(SCRATCH, 'SELECT count(*) FROM tickets')),
    articles: Number(query(SCRATCH, 'SELECT count(*) FROM kb_articles')),
    migrations: Number(
      query(SCRATCH, 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL'),
    ),
  };
  for (const key of Object.keys(before)) {
    check(`${key}: ${before[key]} rows restored`, after[key] === before[key], `got ${after[key]}`);
  }

  /**
   * A real query, not a count.
   *
   * A dump can restore every row and still be useless if a constraint, an index or an enum did not
   * come with it. So the rehearsal runs the shape of query the application actually depends on.
   */
  const joined = query(
    SCRATCH,
    `SELECT count(*) FROM messages m
     JOIN conversations c ON c.account_id = m.account_id AND c.id = m.conversation_id
     WHERE m.deleted_at IS NULL`,
  );
  check('a tenant-scoped join runs on the restored copy', Number(joined) >= 0, joined);

  const search = query(
    SCRATCH,
    `SELECT count(*) FROM messages WHERE body ILIKE '%the%'`,
  );
  check('a substring search runs', Number(search) >= 0, search);

  const indexes = Number(
    query(
      SCRATCH,
      `SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%gin%'`,
    ),
  );
  check('the trigram indexes came with it', indexes >= 4, `${indexes} gin indexes`);

  const enums = Number(
    query(SCRATCH, `SELECT count(*) FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace`),
  );
  check('so did the enum types', enums >= 15, `${enums} enums`);

  /**
   * The constraint that ADR-034 is about.
   *
   * A restored database whose composite foreign keys did not come back would accept a row that
   * belongs to no tenant. Asserting the *refusal* is the only way to know the constraint is real
   * rather than merely listed.
   */
  const badWrite = psql(
    SCRATCH,
    '-c',
    `INSERT INTO conversations (id, account_id, property_id, visitor_id, message_seq)
     VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0)`,
  );
  check(
    'and the foreign keys still refuse a row that belongs to no tenant',
    badWrite.status !== 0 && /foreign key|violates/i.test(badWrite.stderr),
    (badWrite.stderr || '').slice(0, 120),
  );

  const setNullColumns = Number(
    query(
      SCRATCH,
      `SELECT count(*) FROM pg_constraint WHERE confdelsetcols IS NOT NULL AND array_length(confdelsetcols, 1) = 1`,
    ),
  );
  check(
    'including the column-list SET NULL constraints from ADR-034',
    setNullColumns >= 6,
    `${setNullColumns}`,
  );

  section('Clean up');
  cleanup();
  const gone = query('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${SCRATCH}'`);
  check('the scratch database was removed', gone === '0', gone);

  process.stdout.write('\n');
  if (failures.length === 0) {
    process.stdout.write(`${passed} checks passed. The backup is restorable.\n\n`);
    process.exit(0);
  }
  process.stdout.write(`${passed} passed, ${failures.length} FAILED:\n`);
  for (const name of failures) process.stdout.write(`  - ${name}\n`);
  process.stdout.write('\n');
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`\nRestore rehearsal crashed: ${error?.stack ?? error}\n`);
  try {
    cleanup();
  } catch {
    /* nothing more to do */
  }
  process.exit(1);
});
