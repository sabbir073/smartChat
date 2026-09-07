/**
 * One question, one answer.
 *
 * "Is anybody available" is asked in four places — the HTTP bootstrap, the visitor socket the
 * moment it connects, the agent socket when somebody changes status, and the automation rules that
 * fire when nobody is around. It was computed two different ways: from the persisted choice on the
 * membership row, and from Redis presence keys that only exist while an agent holds an open socket.
 *
 * The two did not merely disagree. The visitor socket's emit runs immediately after bootstrap and
 * overwrites it, so the wrong answer won every time: a panel was told somebody was there over HTTP
 * and corrected to nobody a moment later. Fixing three of the four call sites and missing the
 * fourth is exactly how this survived a fix once already, which is why it is checked rather than
 * remembered.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

const files = [...sourceFiles(join(root, 'apps')), ...sourceFiles(join(root, 'packages'))];

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

console.log('Availability has one source\n');

// --- nobody answers it from presence keys ------------------------------------
const fromPresence = files.filter((file) => {
  const text = readFileSync(file, 'utf8');
  return /presence\s*[\r\n\s]*\.\s*hasAvailableAgent|presence\.hasAvailableAgent/.test(text);
});

check(
  'nothing answers "is anybody available" from Redis presence',
  fromPresence.length === 0,
  fromPresence.map((f) => relative(root, f)).join(', '),
);

// --- the reader still exists and is what callers use --------------------------
const readerPath = join(root, 'packages/core/src/services/availability.ts');
const reader = readFileSync(readerPath, 'utf8');

check(
  'the one reader reads the persisted choice on the membership',
  /accountMember\s*\.findFirst/.test(reader) && /availability:\s*'online'/.test(reader),
  'it must read the status an agent actually chose, not whether a socket is open',
);

check(
  'the one reader excludes members who are suspended or removed',
  /status:\s*'active'/.test(reader) && /deletedAt:\s*null/.test(reader),
);

const callers = files.filter((file) =>
  /agentAvailabilityReader\s*\(/.test(readFileSync(file, 'utf8')),
);

// The API bootstrap, the visitor socket, the agent socket, the automation rules - and the module
// that defines it.
check(
  'every place that asks the question uses that one reader',
  callers.length >= 4,
  `found ${callers.length} call sites; expected the API bootstrap, both socket namespaces and the automation rules`,
);

for (const expected of [
  'apps/api/src/container.ts',
  'apps/realtime/src/namespaces/visitor.ts',
  'apps/realtime/src/namespaces/agent.ts',
  'apps/realtime/src/lib/automation-session.ts',
]) {
  check(
    `${expected} asks through the shared reader`,
    callers.some((file) => relative(root, file).split('\\').join('/') === expected),
  );
}

console.log('\n' + '-'.repeat(70));
if (failed > 0) {
  console.log(`${failed} problem(s): availability is being answered more than one way.`);
  process.exit(1);
}
console.log('One reader, and everybody uses it.');
