/**
 * Run every verification suite against a running stack and report one verdict.
 *
 * Two reasons this exists rather than a shell loop. First, the suites read their target from
 * `SMOKE_*` environment variables and shells differ wildly in how reliably they pass those
 * through - on Windows a `set X=Y && node …` inside a nested `cmd /c` silently does not, and the
 * result is a suite that hangs against a stack that is working perfectly. Node sets the child's
 * environment itself and there is nothing to get wrong.
 *
 * Second, thirteen suites printing their own totals is thirteen things to read. This prints one.
 *
 *   node scripts/qa-all.mjs                 # everything
 *   node scripts/qa-all.mjs smoke e2e-kb    # just these
 *   HOST=127.0.0.1 node scripts/qa-all.mjs  # when localhost resolves to ::1 first
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Defaults to 127.0.0.1 rather than localhost.
 *
 * On a host where `localhost` resolves to ::1 first and Docker publishes only on IPv4, every
 * request hangs until it times out - which reads exactly like a broken application and is not.
 * IPv4 is unambiguous and correct everywhere the stack runs.
 */
const HOST = process.env.HOST ?? '127.0.0.1';

const env = {
  ...process.env,
  SMOKE_API_URL: process.env.SMOKE_API_URL ?? `http://${HOST}:3001`,
  SMOKE_WEB_URL: process.env.SMOKE_WEB_URL ?? `http://${HOST}:3000`,
  SMOKE_REALTIME_URL: process.env.SMOKE_REALTIME_URL ?? `http://${HOST}:3002`,
  SMOKE_MAILPIT_URL: process.env.SMOKE_MAILPIT_URL ?? `http://${HOST}:8025`,
  API_URL: process.env.API_URL ?? `http://${HOST}:3001`,
};

/**
 * Order matters in one place only: `e2e-isolation` is the suite that blocks a release, so it runs
 * early rather than after twenty minutes of everything else.
 */
const ALL = [
  'qa-route-coverage',
  'qa-single-availability-source',
  'qa-edge-config',
  'smoke',
  'e2e-isolation',
  'qa-error-surface',
  'e2e-realtime',
  'e2e-team',
  'e2e-automation',
  'e2e-files',
  'e2e-kb',
  'e2e-tickets',
  'e2e-reports',
  'e2e-integrations',
  'e2e-platform',
  'e2e-abuse',
  'e2e-retention',
];

const suites = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL;

/** The suites print "N checks passed."; capture it so the summary can add them up. */
const countChecks = (output) => {
  let total = 0;
  for (const m of output.matchAll(/(\d+) checks passed/g)) total += Number(m[1]);
  for (const m of output.matchAll(/(\d+) provoked failures/g)) total += Number(m[1]);
  return total;
};

function run(name) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [resolve(root, 'scripts', `${name}.mjs`)], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      done({ name, code, output, checks: countChecks(output), ms: Date.now() - started });
    });
  });
}

const results = [];
console.log(`Verifying against ${env.SMOKE_API_URL}\n`);

for (const name of suites) {
  process.stdout.write(`  ${name.padEnd(20)} `);
  const result = await run(name);
  results.push(result);
  const seconds = (result.ms / 1000).toFixed(0).padStart(3);
  if (result.code === 0) {
    console.log(`ok    ${String(result.checks).padStart(4)} checks  ${seconds}s`);
  } else {
    console.log(`FAIL  exit ${result.code}${' '.repeat(12)}${seconds}s`);
  }
}

const failed = results.filter((r) => r.code !== 0);
const checks = results.reduce((sum, r) => sum + r.checks, 0);

console.log('\n' + '-'.repeat(66));
if (failed.length === 0) {
  console.log(`${results.length} suites, ${checks} checks, nothing failed.`);
  process.exit(0);
}

console.log(`${failed.length} of ${results.length} suites failed.\n`);
for (const r of failed) {
  console.log(`===== ${r.name}`);
  // The tail is where a suite says what went wrong; the head is setup noise.
  console.log(
    r.output
      .split('\n')
      .filter((l) => /FAIL|Error|error|✗|crashed|failed/i.test(l))
      .slice(0, 12)
      .join('\n') || r.output.split('\n').slice(-15).join('\n'),
  );
  console.log('');
}
process.exit(1);
