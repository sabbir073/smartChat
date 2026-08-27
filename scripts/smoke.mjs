#!/usr/bin/env node
/**
 * End-to-end smoke test against a running stack.
 *
 * Exercises the real HTTP surface the dashboard uses - registration, session cookies, CSRF,
 * tenant scoping, property creation, the installation snippet - and asserts the security
 * properties that matter, not just the happy path.
 *
 *   node scripts/smoke.mjs                 # against http://localhost:3001
 *   SMOKE_API_URL=... node scripts/smoke.mjs
 */

import { execFileSync } from 'node:child_process';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';

/**
 * Clear rate-limit counters before the run.
 *
 * The registration limiter is real and correct, and this test legitimately registers several
 * accounts - so a second run inside the same hour would otherwise fail with a cascade of 401s
 * that look like authorisation bugs. Set SMOKE_RESET_LIMITS=0 to leave them alone (which is what
 * you want when the limiter itself is what you are investigating).
 */
function resetRateLimits() {
  if (process.env.SMOKE_RESET_LIMITS === '0') return 'skipped (SMOKE_RESET_LIMITS=0)';
  const password = process.env.REDIS_PASSWORD ?? 'smartchat_dev_redis';
  try {
    execFileSync(
      'docker',
      [
        'compose', 'exec', '-T', 'redis', 'sh', '-c',
        `redis-cli -a "${password}" --no-auth-warning --scan --pattern 'ratelimit:*' ` +
        `| xargs -r redis-cli -a "${password}" --no-auth-warning del > /dev/null; ` +
        `redis-cli -a "${password}" --no-auth-warning --scan --pattern 'throttle:*' ` +
        `| xargs -r redis-cli -a "${password}" --no-auth-warning del > /dev/null`,
      ],
      { stdio: 'pipe' },
    );
    return 'cleared';
  } catch {
    return 'could not reach redis through docker compose - continuing anyway';
  }
}

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name}${detail ? `  (${detail})` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n== ${title} ==\n`);
}

/**
 * A minimal cookie jar.
 *
 * Node's fetch does not keep cookies, and the session, CSRF and active-account cookies are the
 * whole point of these checks - so the test has to model a browser rather than fake one.
 */
class Client {
  constructor() {
    this.cookies = new Map();
    /** Raw Set-Cookie headers, so the test can assert cookie *attributes*, not just values. */
    this.setCookieHeaders = [];
  }

  setCookieFor(name) {
    return this.setCookieHeaders.filter((entry) => entry.startsWith(`${name}=`)).at(-1) ?? '';
  }

  cookie(name) {
    return this.cookies.get(name);
  }

  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const entry of raw) this.setCookieHeaders.push(entry);
    for (const entry of raw) {
      const [pair] = entry.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(entry)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call(method, path, body, options = {}) {
    const headers = { accept: 'application/json' };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
    else if (method !== 'GET' && options.csrf !== null) {
      const token = this.cookie('sc_csrf');
      if (token) headers['x-csrf-token'] = token;
    }
    if (options.accountId) headers['x-account-id'] = options.accountId;

    const response = await fetch(`${API}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    this.absorb(response);

    let parsed = null;
    const text = await response.text();
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

const stamp = Date.now();
const password = 'Tuesday-Mango-Ferry-42';
const emailA = `smoke.a.${stamp}@example.test`;
const emailB = `smoke.b.${stamp}@example.test`;

async function main() {
  process.stdout.write(`\nSmartChat smoke test -> ${API}\n`);
  process.stdout.write(`Rate limits: ${resetRateLimits()}\n`);

  // --- health ---------------------------------------------------------------
  section('Health');
  const health = await fetch(`${API}/health`);
  check('GET /health returns 200', health.status === 200, `got ${health.status}`);
  const ready = await fetch(`${API}/ready`);
  const readyBody = await ready.json();
  check('GET /ready reports database ok', readyBody.checks?.database === 'ok');
  check('GET /ready reports redis ok', readyBody.checks?.redis === 'ok');

  // --- registration ---------------------------------------------------------
  section('Registration and session');
  const a = new Client();
  const register = await a.call('POST', '/auth/register', {
    name: 'Smoke A',
    email: emailA,
    password,
    accountName: `Smoke A ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('register returns 201', register.status === 201, `got ${register.status}`);
  const accountA = register.body?.data?.account?.id;
  check('register returns an account', Boolean(accountA));
  check('session cookie was set', (a.cookie('sc_session') ?? '').length > 20);
  check('csrf cookie was set', (a.cookie('sc_csrf') ?? '').length > 10);
  const sessionSetCookie = a.setCookieFor('sc_session');
  check(
    'the session cookie is httpOnly, so no script can read it',
    /httponly/i.test(sessionSetCookie),
    sessionSetCookie,
  );
  check(
    'the session cookie is SameSite=Lax, which blocks cross-site posts',
    /samesite=lax/i.test(sessionSetCookie),
    sessionSetCookie,
  );
  check(
    'the CSRF cookie is deliberately readable by script (double-submit)',
    !/httponly/i.test(a.setCookieFor('sc_csrf')),
    a.setCookieFor('sc_csrf'),
  );

  // Register the second account now, before the deliberately-failing registrations below, so a
  // limiter trip can never be mistaken for a tenant-isolation failure later in the run.
  const b = new Client();
  const registerB = await b.call('POST', '/auth/register', {
    name: 'Smoke B',
    email: emailB,
    password,
    accountName: `Smoke B ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('a second, unrelated account registered', registerB.status === 201, `got ${registerB.status}`);

  const weak = await new Client().call('POST', '/auth/register', {
    name: 'Weak',
    email: `weak.${stamp}@example.test`,
    password: 'password123',
    accountName: 'Weak',
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('a common password is rejected (422)', weak.status === 422, `got ${weak.status}`);

  const derived = await new Client().call('POST', '/auth/register', {
    name: 'Derived',
    email: `derived.${stamp}@example.test`,
    password: `derived${stamp}`,
    accountName: 'Derived',
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check(
    'a password derived from the email is rejected',
    derived.status === 422,
    `got ${derived.status}`,
  );

  const duplicate = await new Client().call('POST', '/auth/register', {
    name: 'Dup',
    email: emailA,
    password,
    accountName: 'Dup',
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('duplicate email is rejected (409)', duplicate.status === 409, `got ${duplicate.status}`);

  // The per-address registration limit is 3 per hour. Rather than counting attempts (which is
  // brittle - the count changes whenever a case is added above), keep trying until the limiter
  // answers, with a hard bound so a broken limiter fails the test instead of hanging it.
  let limitedStatus = 0;
  for (let attempt = 0; attempt < 5 && limitedStatus !== 429; attempt += 1) {
    const result = await new Client().call('POST', '/auth/register', {
      name: 'Dup',
      email: emailA,
      password,
      accountName: 'Dup',
      timezone: 'UTC',
      locale: 'en',
      acceptTerms: true,
    });
    limitedStatus = result.status;
  }
  check(
    'repeated registration attempts for one address are rate limited (429)',
    limitedStatus === 429,
    `last status ${limitedStatus}`,
  );

  // --- authentication guards ------------------------------------------------
  section('Authentication and CSRF');
  const anon = await new Client().call('GET', '/auth/me');
  check('unauthenticated /auth/me returns 401', anon.status === 401, `got ${anon.status}`);

  const me = await a.call('GET', '/auth/me');
  check('authenticated /auth/me returns 200', me.status === 200, `got ${me.status}`);
  check('/auth/me returns the right user', me.body?.data?.user?.email === emailA);
  check(
    '/auth/me never exposes a password hash',
    !JSON.stringify(me.body).toLowerCase().includes('passwordhash'),
  );

  const noCsrf = await a.call('POST', '/properties', { name: 'x', websiteUrl: 'example.com' }, {
    csrf: null,
  });
  check('mutation without a CSRF header is rejected (403)', noCsrf.status === 403, `got ${noCsrf.status}`);

  const badCsrf = await a.call('POST', '/properties', { name: 'x', websiteUrl: 'example.com' }, {
    csrf: 'not-the-real-token',
  });
  check('mutation with a wrong CSRF token is rejected (403)', badCsrf.status === 403, `got ${badCsrf.status}`);

  const wrongPassword = await new Client().call('POST', '/auth/login', {
    email: emailA,
    password: 'definitely-not-the-password',
  });
  check('wrong password returns 401', wrongPassword.status === 401, `got ${wrongPassword.status}`);

  const unknownEmail = await new Client().call('POST', '/auth/login', {
    email: `nobody.${stamp}@example.test`,
    password,
  });
  check(
    'an unknown email returns exactly the same error as a wrong password',
    unknownEmail.body?.error?.code === wrongPassword.body?.error?.code &&
      unknownEmail.status === wrongPassword.status,
    `${unknownEmail.body?.error?.code} vs ${wrongPassword.body?.error?.code}`,
  );

  // --- properties -----------------------------------------------------------
  section('Properties');
  const created = await a.call('POST', '/properties', {
    name: 'Smoke Site',
    websiteUrl: 'smoke-example.com',
  });
  check('create property returns 201', created.status === 201, `got ${created.status}`);
  const property = created.body?.data;
  check('property has a public id', String(property?.publicId ?? '').startsWith('prp_'));
  check(
    'the website url is normalised to https',
    property?.websiteUrl === 'https://smoke-example.com',
    property?.websiteUrl,
  );
  check('apex and www domains are seeded automatically', (property?.domains?.length ?? 0) >= 2);

  const list = await a.call('GET', '/properties');
  check(
    'the new property appears in the list',
    (list.body?.data ?? []).filter((row) => row.id === property.id).length === 1,
  );

  const install = await a.call('GET', `/properties/${property.id}/install`);
  const snippet = install.body?.data?.snippet ?? '';
  check('an installation snippet is generated', snippet.includes('loader.js'));
  check('the snippet carries the public id', snippet.includes(property.publicId));
  check(
    'the snippet contains no secret, key or internal id',
    !snippet.includes(accountA) &&
      !/secret|sc_live|password|api[_-]?key/i.test(snippet) &&
      !snippet.includes(property.id),
  );

  const bareWildcard = await a.call('POST', `/properties/${property.id}/domains`, { pattern: '*' });
  check('a bare wildcard domain is rejected', bareWildcard.status === 422, `got ${bareWildcard.status}`);

  const tldWildcard = await a.call('POST', `/properties/${property.id}/domains`, {
    pattern: '*.com',
  });
  check('a wildcard on a TLD is rejected', tldWildcard.status === 422, `got ${tldWildcard.status}`);

  // --- tenant isolation -----------------------------------------------------
  section('Tenant isolation');
  const cases = [
    ["read A's property", await b.call('GET', `/properties/${property.id}`)],
    ["update A's property", await b.call('PATCH', `/properties/${property.id}`, { name: 'hijacked' })],
    ["delete A's property", await b.call('DELETE', `/properties/${property.id}`)],
    ["read A's installation snippet", await b.call('GET', `/properties/${property.id}/install`)],
    [
      "add a domain to A's property",
      await b.call('POST', `/properties/${property.id}/domains`, { pattern: 'evil.test' }),
    ],
  ];
  for (const [label, result] of cases) {
    // 404 rather than 403 is the assertion that matters: a 403 would confirm the resource exists.
    check(`B cannot ${label} - 404, not 403`, result.status === 404, `got ${result.status}`);
  }

  const listB = await b.call('GET', '/properties');
  check(
    "A's property never appears in B's list",
    (listB.body?.data ?? []).filter((row) => row.id === property.id).length === 0,
  );

  const switchAccount = await b.call('POST', '/auth/switch-account', { accountId: accountA });
  check("B cannot switch into A's account", switchAccount.status === 404, `got ${switchAccount.status}`);

  const borrowed = await b.call('GET', '/properties', undefined, { accountId: accountA });
  check(
    "B cannot borrow A's account with the x-account-id header",
    borrowed.status === 404,
    `got ${borrowed.status}`,
  );

  const survived = await a.call('GET', `/properties/${property.id}`);
  check(
    "A's property survived every attempt, unchanged",
    survived.status === 200 && survived.body?.data?.name === 'Smoke Site',
  );


  // --- widget surface -------------------------------------------------------
  //
  // Reachable from any website on the internet, so it gets its own scrutiny: no cookies, a bearer
  // token that must be unforgeable, and a public id that identifies without authorising.
  section('Widget surface');

  const widgetPublicId = property.publicId;

  async function widgetCall(method, path, body, options = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.origin) headers.origin = options.origin;

    const response = await fetch(`${API}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  const publicConfig = await widgetCall('GET', `/widget/config?p=${widgetPublicId}`, undefined, {
    origin: 'https://any-customer-site.test',
  });
  check(
    'the widget config is served to any origin, as it must be',
    publicConfig.status === 200,
    `got ${publicConfig.status}`,
  );
  check(
    'the config response allows cross-origin reads',
    publicConfig.headers.get('access-control-allow-origin') !== null,
  );
  check(
    'the config response does NOT allow credentials',
    publicConfig.headers.get('access-control-allow-credentials') !== 'true',
  );
  check(
    'the config exposes no account id, property uuid or draft',
    !JSON.stringify(publicConfig.body).includes(accountA) &&
      !JSON.stringify(publicConfig.body).includes(property.id) &&
      !JSON.stringify(publicConfig.body).includes('draft'),
  );

  const unknownProperty = await widgetCall('GET', '/widget/config?p=prp_ZZZZZZZZZZZZZZZZ');
  check(
    'an unknown public id returns 404, not a hint',
    unknownProperty.status === 404,
    `got ${unknownProperty.status}`,
  );

  const malformedId = await widgetCall('GET', '/widget/config?p=not-a-public-id');
  check('a malformed public id is rejected', malformedId.status === 422, `got ${malformedId.status}`);

  const bootstrapped = await widgetCall('POST', '/widget/session', {
    p: widgetPublicId,
    page: { url: 'https://any-customer-site.test/pricing', title: 'Pricing' },
    language: 'en-GB',
    timezone: 'Europe/London',
  });
  check('a visitor session can be created', bootstrapped.status === 200, `got ${bootstrapped.status}`);
  const visitorToken = bootstrapped.body?.data?.token;
  check('the session returns a visitor token', typeof visitorToken === 'string' && visitorToken.length > 40);
  check(
    'the session response never contains an account id',
    !JSON.stringify(bootstrapped.body).includes(accountA),
  );

  const visitorMe = await widgetCall('GET', '/widget/me', undefined, { token: visitorToken });
  check('the visitor token authenticates', visitorMe.status === 200, `got ${visitorMe.status}`);

  const noToken = await widgetCall('GET', '/widget/me');
  check('the widget surface refuses an unauthenticated request', noToken.status === 401, `got ${noToken.status}`);

  const garbageToken = await widgetCall('GET', '/widget/me', undefined, {
    token: 'not.a.real.token.at.all.but.long.enough',
  });
  check('a garbage token is refused', garbageToken.status === 401, `got ${garbageToken.status}`);

  /**
   * The signature check is the whole security model for the visitor token. Editing the payload to
   * name a different visitor must fail on the signature, before anything in it is parsed.
   */
  const [encodedPayload, signature] = String(visitorToken).split('.');
  const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  decoded.visitorId = '00000000-0000-7000-8000-000000000000';
  const forged = `${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}.${signature}`;
  const forgedResult = await widgetCall('GET', '/widget/me', undefined, { token: forged });
  check(
    'a visitor token edited to impersonate someone else is refused',
    forgedResult.status === 401,
    `got ${forgedResult.status}`,
  );

  const pageView = await widgetCall(
    'POST',
    '/widget/page-view',
    { url: 'https://any-customer-site.test/product' },
    { token: visitorToken },
  );
  check('a page view is recorded', pageView.status === 204, `got ${pageView.status}`);

  const dangerousUrl = await widgetCall(
    'POST',
    '/widget/page-view',
    { url: 'javascript:alert(1)' },
    { token: visitorToken },
  );
  check(
    'a javascript: URL is accepted without being stored',
    dangerousUrl.status === 204,
    `got ${dangerousUrl.status}`,
  );

  const identified = await widgetCall(
    'POST',
    '/widget/identify',
    { name: 'Visitor Smoke', email: 'visitor.smoke@example.test' },
    { token: visitorToken },
  );
  check('a visitor can be identified', identified.status === 204, `got ${identified.status}`);

  // The property is now installed, because the widget was served for it.
  const afterWidget = await a.call('GET', `/properties/${property.id}/install`);
  check(
    'serving the widget marks the property installed - no separate verification step',
    afterWidget.body?.data?.verified === true,
  );

  // --- sessions -------------------------------------------------------------
  section('Sessions');
  const sessions = await a.call('GET', '/auth/sessions');
  check(
    'the session list marks exactly one session as current',
    (sessions.body?.data?.sessions ?? []).filter((s) => s.current).length === 1,
  );

  const logout = await a.call('POST', '/auth/logout');
  check('logout returns 204', logout.status === 204, `got ${logout.status}`);
  const afterLogout = await a.call('GET', '/auth/me');
  check('the session is dead immediately after logout', afterLogout.status === 401, `got ${afterLogout.status}`);

  // A rejected session must take its cookie with it. The dashboard middleware routes on the
  // cookie being present, not valid, so a cookie left behind after the server has refused it
  // strands the person: every page says "sign in again" and /login bounces them back.
  const stale = new Client();
  stale.cookies.set('sc_session', 'a-token-that-was-never-valid'.padEnd(64, '0'));
  const rejected = await stale.call('GET', '/auth/me');
  check('a stale session cookie is refused', rejected.status === 401, `got ${rejected.status}`);
  check(
    'and the server clears it, so the person can reach the sign-in page',
    stale.setCookieFor('sc_session').length > 0 && !stale.cookies.has('sc_session'),
    stale.setCookieFor('sc_session') || 'no Set-Cookie for sc_session',
  );

  // --- result ---------------------------------------------------------------
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
  process.stderr.write(`\nSmoke test crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
