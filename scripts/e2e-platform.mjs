#!/usr/bin/env node
/**
 * Phase 12: the platform console.
 *
 * The exit criterion is "suspend an account and observe tenant access stop immediately", and the
 * word that carries the weight is *immediately*. A suspension that takes effect at the next login
 * is not a suspension - the agent already signed in keeps working, the widget keeps taking
 * messages, and the account keeps costing money. So this script signs somebody in first, suspends
 * them from the console while their session is live, and then tries every door: the dashboard API,
 * an API key, and the widget on their own website.
 *
 *   node scripts/e2e-platform.mjs
 *
 * Requires the stack up and the database seeded (the platform administrator comes from the seed).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const ORIGIN = 'http://localhost:3004';
const ADMIN_EMAIL = process.env.SUPERADMIN_EMAIL ?? 'admin@smartchat.local';
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!SuperAdmin1';

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

function resetRateLimits() {
  if (process.env.SMOKE_RESET_LIMITS === '0') return;
  const password = process.env.REDIS_PASSWORD ?? 'smartchat_dev_redis';
  try {
    execFileSync(
      'docker',
      [
        'compose', 'exec', '-T', 'redis', 'sh', '-c',
        `redis-cli -a "${password}" --no-auth-warning --scan --pattern 'ratelimit:*' ` +
        `| xargs -r redis-cli -a "${password}" --no-auth-warning del > /dev/null`,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    process.stdout.write('  note: could not clear rate-limit keys through docker compose\n');
  }
}

class Http {
  constructor() {
    this.cookies = new Map();
  }

  absorb(response) {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const [pair] = entry.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call(method, path, body) {
    const headers = { accept: 'application/json' };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = this.cookies.get('sc_csrf');
    if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;

    const response = await fetch(`${API}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    this.absorb(response);
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: response.status, body: parsed };
  }
}

async function widgetCall(method, path, body, token) {
  const headers = { accept: 'application/json', origin: ORIGIN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}/api/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function withKey(key, method, path, body) {
  const headers = { accept: 'application/json', authorization: `Bearer ${key}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API}/api/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  resetRateLimits();
  const stamp = Date.now();

  section('An ordinary account, working normally');
  const owner = new Http();
  const register = await owner.call('POST', '/auth/register', {
    name: 'Suspendable Owner',
    email: `suspend.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Suspendable ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('the account was created', register.status === 201, `got ${register.status}`);

  const site = await owner.call('POST', '/properties', {
    name: 'Depot',
    websiteUrl: `https://depot-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const property = site.body.data;
  check('with a website', site.status === 201, `got ${site.status}`);

  const keyResult = await owner.call('POST', '/integrations/keys', {
    name: 'Suspension test',
    scopes: ['tickets:read'],
  });
  const apiKey = keyResult.body.data?.secretShownOnce;
  check('and an API key', keyResult.status === 201, `got ${keyResult.status}`);

  const beforeDashboard = await owner.call('GET', '/properties');
  check('the dashboard works', beforeDashboard.status === 200, `got ${beforeDashboard.status}`);
  const beforeKey = await withKey(apiKey, 'GET', '/tickets');
  check('the key works', beforeKey.status === 200, `got ${beforeKey.status}`);
  const beforeWidget = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Platform E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check('and the widget serves visitors', beforeWidget.status === 200, `got ${beforeWidget.status}`);

  section('The console is a different door with a different key');
  const consoleClient = new Http();

  const asTenant = await owner.call('GET', '/platform/accounts');
  check(
    'a signed-in account holder cannot reach the console API',
    asTenant.status === 401,
    `got ${asTenant.status}`,
  );

  const wrongPassword = await consoleClient.call('POST', '/platform/auth/login', {
    email: ADMIN_EMAIL,
    password: 'not-the-password',
  });
  check('a wrong password is refused', wrongPassword.status === 401, `got ${wrongPassword.status}`);

  const unknownAdmin = await consoleClient.call('POST', '/platform/auth/login', {
    email: `nobody.${stamp}@example.test`,
    password: 'not-the-password',
  });
  check(
    'and an address that does not exist gets exactly the same answer',
    unknownAdmin.status === wrongPassword.status &&
      unknownAdmin.body.error?.code === wrongPassword.body.error?.code,
    `${unknownAdmin.body.error?.code} vs ${wrongPassword.body.error?.code}`,
  );

  const signedIn = await consoleClient.call('POST', '/platform/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  check('an operator can sign in', signedIn.status === 200, JSON.stringify(signedIn.body?.error));
  check(
    'and gets a session cookie of its own, not the tenant one',
    consoleClient.cookies.has('sc_platform') && !consoleClient.cookies.has('sc_session'),
    [...consoleClient.cookies.keys()].join(','),
  );

  const me = await consoleClient.call('GET', '/platform/auth/me');
  check('who they are is readable', me.status === 200 && me.body.data.email === ADMIN_EMAIL);

  const consoleAsTenant = await consoleClient.call('GET', '/properties');
  check(
    'and a platform session is not an account session - it reaches no tenant data',
    consoleAsTenant.status === 401 || consoleAsTenant.status === 404,
    `got ${consoleAsTenant.status}`,
  );

  section('Suspend an account, and watch access stop');
  const listed = await consoleClient.call('GET', `/platform/accounts?search=Suspendable ${stamp}`);
  check('the account is visible to the console', listed.body.data.length === 1, `${listed.body.data.length}`);
  const target = listed.body.data[0];
  check('with the counts an operator needs', target.propertyCount === 1 && target.memberCount === 1);

  const noReason = await consoleClient.call('POST', `/platform/accounts/${target.id}/suspend`, {});
  check(
    'suspending without a reason is refused - the reason is what the account is shown',
    noReason.status === 422,
    `got ${noReason.status}`,
  );

  const suspended = await consoleClient.call('POST', `/platform/accounts/${target.id}/suspend`, {
    reason: 'Non-payment since March. Contact billing to resume.',
  });
  check('it can be suspended', suspended.status === 200, JSON.stringify(suspended.body?.error));
  check('and says so', suspended.body.data.status === 'suspended');

  /**
   * The exit criterion, tested three ways.
   *
   * The session below was created *before* the suspension and was never signed out. If access
   * only stopped at the next sign-in, this request would succeed - which is exactly the failure
   * that makes a suspension feature worthless.
   */
  const afterDashboard = await owner.call('GET', '/properties');
  check(
    'a live dashboard session stops working on its very next request',
    afterDashboard.status === 403 || afterDashboard.status === 402 || afterDashboard.status === 404,
    `got ${afterDashboard.status} ${afterDashboard.body?.error?.code}`,
  );
  check(
    'and is told why, not merely refused',
    afterDashboard.body?.error?.code === 'ACCOUNT_SUSPENDED',
    afterDashboard.body?.error?.code,
  );

  const afterKey = await withKey(apiKey, 'GET', '/tickets');
  check(
    "the account's API keys stop at the same moment",
    afterKey.status === 401,
    `got ${afterKey.status}`,
  );

  const afterWidget = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Platform E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check(
    'and its widget stops serving visitors',
    afterWidget.status === 404,
    `got ${afterWidget.status}`,
  );

  /**
   * Signing in afresh does not get around it.
   *
   * The *user* is not suspended - their account is - so authentication itself may well succeed.
   * What must not succeed is reaching anything belonging to the suspended account, which is a
   * different check and the one that matters.
   */
  const fresh = new Http();
  await fresh.call('POST', '/auth/login', {
    email: `suspend.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
  });
  const freshAccess = await fresh.call('GET', '/properties');
  check(
    'and signing in again reaches nothing either',
    freshAccess.status !== 200,
    `got ${freshAccess.status} ${freshAccess.body?.error?.code}`,
  );

  section('And resuming puts it back');
  const resumed = await consoleClient.call('POST', `/platform/accounts/${target.id}/resume`);
  check('it can be resumed', resumed.status === 200 && resumed.body.data.status === 'active');

  const backDashboard = await owner.call('GET', '/properties');
  check(
    'the same live session works again - it was never signed out',
    backDashboard.status === 200,
    `got ${backDashboard.status}`,
  );
  const backWidget = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Platform E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check('and the widget serves again', backWidget.status === 200, `got ${backWidget.status}`);

  section('Feature flags are a closed list, and they really switch things off');
  const flags = await consoleClient.call('GET', '/platform/flags');
  check('the flags load', flags.status === 200, `got ${flags.status}`);
  check(
    'and are exactly the ones the code reads',
    flags.body.data.map((flag) => flag.key).sort().join(',') ===
      'public_help_centre,uploads,webhooks',
    flags.body.data.map((flag) => flag.key).join(','),
  );

  const invented = await consoleClient.call('PATCH', '/platform/flags/made_up_flag', {
    enabled: false,
  });
  check(
    'a flag nothing reads cannot be created - that is the point of the list being closed',
    invented.status === 404,
    `got ${invented.status}`,
  );

  // The help centre, on and then off, for this account only.
  const category = await owner.call('POST', `/kb/${property.id}/categories`, { name: 'Billing' });
  await owner.call('POST', `/kb/${property.id}/articles`, {
    title: 'Switchable article',
    body: 'Present while the help centre is on.',
    categoryId: category.body.data.id,
    status: 'published',
  });

  const publicOn = await fetch(`${API}/api/v1/public/kb/${property.publicId}`);
  check('the public help centre answers', publicOn.status === 200, `got ${publicOn.status}`);

  const off = await consoleClient.call('PATCH', '/platform/flags/public_help_centre', {
    disabledAccountIds: [target.id],
  });
  check('the flag can be turned off for one account', off.status === 200, `got ${off.status}`);

  // The flag cache is 30 seconds, and the console says so rather than pretending it is instant.
  await new Promise((resolve) => setTimeout(resolve, 31_000));

  const publicOff = await fetch(`${API}/api/v1/public/kb/${property.publicId}`);
  check(
    'and the public help centre stops answering for that account',
    publicOff.status === 503,
    `got ${publicOff.status}`,
  );

  const dashboardStillWorks = await owner.call('GET', `/kb/${property.id}/articles`);
  check(
    'while the account can still edit its own articles - a kill switch, not data loss',
    dashboardStillWorks.status === 200,
    `got ${dashboardStillWorks.status}`,
  );

  await consoleClient.call('PATCH', '/platform/flags/public_help_centre', {
    disabledAccountIds: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  const publicBack = await fetch(`${API}/api/v1/public/kb/${property.publicId}`);
  check('turning it back on restores it', publicBack.status === 200, `got ${publicBack.status}`);

  section('Everything an operator does is recorded');
  const audit = await consoleClient.call('GET', '/platform/audit?limit=50');
  check('the platform audit log loads', audit.status === 200, `got ${audit.status}`);
  const actions = audit.body.data.map((entry) => entry.action);
  check('the suspension is in it', actions.includes('account.suspended'), actions.slice(0, 6).join(','));
  check('so is the resume', actions.includes('account.resumed'));
  check('so is the flag change', actions.includes('flag.changed'));
  check('and the sign-in', actions.includes('platform.signed_in'));
  check(
    'each entry names the operator',
    audit.body.data.every((entry) => typeof entry.adminName === 'string' && entry.adminName !== ''),
  );

  const tenantAudit = await owner.call('GET', '/account/audit-logs');
  check(
    "an account's own audit log does not contain platform actions taken on it",
    tenantAudit.status !== 200 ||
      !JSON.stringify(tenantAudit.body.data).includes('account.suspended'),
  );

  section('Signing out of the console');
  await consoleClient.call('POST', '/platform/auth/logout');
  const afterLogout = await consoleClient.call('GET', '/platform/accounts');
  check('the session is gone', afterLogout.status === 401, `got ${afterLogout.status}`);

  process.stdout.write('\n');
  if (failures.length === 0) {
    process.stdout.write(`${passed} checks passed.\n\n`);
    process.exit(0);
  }
  process.stdout.write(`${passed} passed, ${failures.length} FAILED:\n`);
  for (const name of failures) process.stdout.write(`  - ${name}\n`);
  process.stdout.write('\n');
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`\nPlatform E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
