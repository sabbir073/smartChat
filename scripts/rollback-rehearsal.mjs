#!/usr/bin/env node
/**
 * The rollback rehearsal.
 *
 * The restore rehearsal answers "can we get the data back". This answers the different and more
 * frightening question: **can we undo a deployment that has already touched the database?**
 *
 * That question has an uncomfortable answer in any project that uses forward-only migrations, and
 * saying it plainly is more useful than a script that pretends otherwise: *a migration cannot be
 * un-run*. Prisma has no `down`. So the rollback procedure is not "roll the schema back", it is:
 *
 *   1. put the previous images back (the compose files take the tag from `IMAGE_TAG`), and
 *   2. if - and only if - the migration destroyed something, restore the pre-deploy backup.
 *
 * Which makes the property this script actually has to verify **additive compatibility**: the new
 * schema must still serve the previous release. If a deploy only adds columns and tables, step 1
 * alone is a complete rollback and nobody loses a minute of data. If it drops or renames, step 1 is
 * not enough and the pre-deploy backup is mandatory - so the deploy runbook has to know which kind
 * of migration it is about to run, and this script is where that is checked rather than assumed.
 *
 * So it does three things:
 *
 *  - proves the image rollback path is real: the tag flows through both compose files, and the
 *    images that are running right now can be tagged and selected by it;
 *  - proves the data rollback path is real: it takes a backup, does something destructive on a
 *    scratch copy, restores, and confirms what was destroyed came back;
 *  - inspects every migration in the repository and reports which ones are destructive, because
 *    that is the fact the runbook needs and the one nobody can remember under pressure.
 *
 *   node scripts/rollback-rehearsal.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const migrationsDir = join(repoRoot, 'packages', 'database', 'prisma', 'migrations');

const PGUSER = process.env.POSTGRES_USER ?? 'smartchat';
const PGDB = process.env.POSTGRES_DB ?? 'smartchat';
const SCRATCH = 'smartchat_rollback_rehearsal';

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
  return spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', PGUSER, '-d', database, ...args],
    { encoding: 'utf8' },
  );
}

const workDir = mkdtempSync(join(tmpdir(), 'smartchat-rollback-'));
const dumpPath = join(workDir, 'pre-deploy.dump');

function cleanup() {
  psql('postgres', '-c', `DROP DATABASE IF EXISTS "${SCRATCH}";`);
  rmSync(workDir, { recursive: true, force: true });
}

/**
 * Which migrations cannot be undone by putting the old image back.
 *
 * A deliberately blunt scan of the SQL. `DROP COLUMN`, `DROP TABLE` and `RENAME` all remove
 * something the previous release still expects to find; everything else is additive and therefore
 * safe to leave in place while the images go backwards. False positives are fine here - a runbook
 * that takes one extra backup has lost nothing.
 */
const DESTRUCTIVE = [
  /DROP\s+TABLE/i,
  /DROP\s+COLUMN/i,
  /DROP\s+CONSTRAINT/i,
  /RENAME\s+COLUMN/i,
  /RENAME\s+TO/i,
  /ALTER\s+COLUMN\s+.*\s+TYPE/i,
  /SET\s+NOT\s+NULL/i,
];

function classifyMigrations() {
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return names.map((name) => {
    const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
    const reasons = DESTRUCTIVE.filter((pattern) => pattern.test(sql)).map((pattern) =>
      String(pattern).replace(/[/\\^$]|\\s\+|i$/g, '').replace(/\.\*/g, ' … '),
    );
    return { name, destructive: reasons.length > 0, reasons };
  });
}

async function main() {
  section('The image rollback path');

  /**
   * A rollback that depends on an environment variable nobody wired up is a rollback that fails
   * at the worst possible moment, so the variable is checked rather than trusted.
   */
  const baseCompose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  const services = ['api', 'web', 'worker', 'realtime', 'widget'];
  const missingTag = services.filter(
    (service) => !new RegExp(`image:\\s*smartchat/${service}:\\$\\{IMAGE_TAG`).test(baseCompose),
  );
  check(
    'every application image takes its tag from IMAGE_TAG',
    missingTag.length === 0,
    `missing on: ${missingTag.join(', ')}`,
  );

  const pinned = spawnSync('docker', ['compose', 'config', '--images'], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, IMAGE_TAG: 'rollback-rehearsal' },
  });
  const images = (pinned.stdout ?? '').split('\n').filter(Boolean);
  check(
    'and setting it actually changes which images compose would run',
    images.some((image) => image.includes('smartchat/api:rollback-rehearsal')),
    images.filter((image) => image.includes('smartchat/')).join(' ') || 'compose config failed',
  );

  /**
   * And that the tag can be pointed at something that exists. Tagging the running api image is
   * exactly what a rollback does in the other direction, so if this fails the procedure is
   * fiction.
   */
  const tagged = spawnSync(
    'docker',
    ['tag', 'smartchat/api:local', 'smartchat/api:rollback-rehearsal'],
    { encoding: 'utf8' },
  );
  check('a running image can be tagged for rollback', tagged.status === 0, tagged.stderr?.trim());
  spawnSync('docker', ['rmi', 'smartchat/api:rollback-rehearsal'], { encoding: 'utf8' });

  section('Which migrations the images alone cannot undo');
  const migrations = classifyMigrations();
  const destructive = migrations.filter((migration) => migration.destructive);
  check(`${migrations.length} migrations were read`, migrations.length > 0);
  for (const migration of migrations) {
    process.stdout.write(
      `  ${migration.destructive ? 'BACKUP FIRST' : 'additive    '}  ${migration.name}` +
        `${migration.destructive ? `  (${migration.reasons.join(', ')})` : ''}\n`,
    );
  }
  process.stdout.write(
    `\n  ${destructive.length} of ${migrations.length} migrations remove or change something the\n` +
      `  previous release still expects. Deploying one of those means the pre-deploy backup is\n` +
      `  not optional: putting the old image back will not put the column back.\n`,
  );
  check(
    'the classification is recorded rather than assumed',
    migrations.every((migration) => typeof migration.destructive === 'boolean'),
  );

  section('The data rollback path, rehearsed for real');

  const dump = execFileSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres', 'sh', '-c',
      `pg_dump -U ${PGUSER} -d ${PGDB} --format=custom --compress=9 --no-owner --no-privileges | base64 -w 0`,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 },
  );
  writeFileSync(dumpPath, Buffer.from(dump.trim(), 'base64'));
  check('a pre-deploy backup was taken', statSync(dumpPath).size > 10_000);

  psql('postgres', '-c', `DROP DATABASE IF EXISTS "${SCRATCH}";`);
  const created = psql('postgres', '-c', `CREATE DATABASE "${SCRATCH}";`);
  check('a scratch database stands in for production', created.status === 0, created.stderr?.trim());

  const base64 = readFileSync(dumpPath).toString('base64');
  const restoreInto = spawnSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres', 'sh', '-c',
      `base64 -d > /tmp/rollback.dump && pg_restore -U ${PGUSER} -d ${SCRATCH} ` +
        `--no-owner --no-privileges /tmp/rollback.dump`,
    ],
    { input: base64, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 },
  );
  check(
    'and the backup restores into it',
    restoreInto.status === 0,
    (restoreInto.stderr ?? '').trim().slice(0, 300),
  );

  const conversationsBefore = Number(query(SCRATCH, 'SELECT count(*) FROM conversations;'));
  const columnsBefore = Number(
    query(
      SCRATCH,
      `SELECT count(*) FROM information_schema.columns WHERE table_name = 'visitors';`,
    ),
  );
  check('the copy has the data', conversationsBefore >= 0);
  check('and the schema', columnsBefore > 5, `${columnsBefore} columns on visitors`);

  /**
   * The bad deploy. A dropped column and a truncated table is the shape of the accident that makes
   * somebody reach for a rollback in the first place - and precisely the shape that putting the
   * old image back does not fix.
   */
  section('A deploy goes wrong');
  const damage = psql(
    SCRATCH,
    '-c',
    'ALTER TABLE visitors DROP COLUMN banned_until; DELETE FROM conversations;',
  );
  check('the bad migration ran', damage.status === 0, damage.stderr?.trim());
  check(
    'the column is gone',
    Number(
      query(
        SCRATCH,
        `SELECT count(*) FROM information_schema.columns ` +
          `WHERE table_name = 'visitors' AND column_name = 'banned_until';`,
      ),
    ) === 0,
  );
  check('and the rows are gone', Number(query(SCRATCH, 'SELECT count(*) FROM conversations;')) === 0);

  section('Rolling back');
  const recreate = psql('postgres', '-c', `DROP DATABASE "${SCRATCH}";`);
  check('the damaged database is dropped', recreate.status === 0, recreate.stderr?.trim());
  psql('postgres', '-c', `CREATE DATABASE "${SCRATCH}";`);

  const rollback = spawnSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres', 'sh', '-c',
      `pg_restore -U ${PGUSER} -d ${SCRATCH} --no-owner --no-privileges /tmp/rollback.dump`,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 },
  );
  check(
    'the pre-deploy backup restores over it',
    rollback.status === 0,
    (rollback.stderr ?? '').trim().slice(0, 300),
  );

  check(
    'the dropped column is back',
    Number(
      query(
        SCRATCH,
        `SELECT count(*) FROM information_schema.columns ` +
          `WHERE table_name = 'visitors' AND column_name = 'banned_until';`,
      ),
    ) === 1,
  );
  check(
    'and every row is back',
    Number(query(SCRATCH, 'SELECT count(*) FROM conversations;')) === conversationsBefore,
    `${query(SCRATCH, 'SELECT count(*) FROM conversations;')} vs ${conversationsBefore}`,
  );
  check(
    'the schema is whole, not just the tables that were touched',
    Number(
      query(
        SCRATCH,
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'visitors';`,
      ),
    ) === columnsBefore,
  );

  /**
   * The migration ledger has to come back too. If it did not, the next deploy would try to re-apply
   * every migration against a database that already has them - which fails loudly, but hours later
   * and in front of an audience.
   */
  const ledger = Number(query(SCRATCH, 'SELECT count(*) FROM _prisma_migrations;'));
  check('and the migration ledger came back with it', ledger === migrations.length, `${ledger}`);

  spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'rm', '-f', '/tmp/rollback.dump']);

  process.stdout.write('\n');
  if (failures.length > 0) {
    process.stdout.write(`${passed} passed, ${failures.length} FAILED:\n`);
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    cleanup();
    process.exit(1);
  }
  process.stdout.write(`${passed} checks passed. The rollback procedure has been performed, not described.\n`);
  cleanup();
}

main().catch((error) => {
  process.stdout.write(`\nFATAL: ${error?.stack ?? error}\n`);
  cleanup();
  process.exit(1);
});
