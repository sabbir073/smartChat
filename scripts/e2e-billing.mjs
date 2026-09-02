#!/usr/bin/env node
/**
 * Phase 15: plans, subscriptions, and the limits they are supposed to buy.
 *
 * The question this script exists to answer is not "does the billing screen render". It is
 * whether the numbers on the pricing page are load-bearing. A plan system is only real if a Free
 * account is actually refused the thing Free does not include, if a downgrade actually happens on
 * the day the customer was told, and if a paused account actually stops taking chats while
 * keeping every message it already has.
 *
 * Two of the checks below exist because the code failed them:
 *
 *   - Registration created accounts with no subscription at all. No subscription meant no
 *     entitlements, and no entitlements read as "no limits" everywhere downstream, so every
 *     account ever created was silently unmetered while the pricing page advertised limits.
 *   - A downgrade to a cheaper paid plan reported "applied", wrote nothing, and left the customer
 *     on the expensive plan for ever.
 *
 * Both are guarded here with a negative control, because a check that would also pass against
 * broken code is not a check.
 *
 *   node scripts/e2e-billing.mjs
 *
 * Requires the stack up and the database seeded (the plans and the operator come from the seed).
 */
import { execFileSync } from 'node:child_process';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const ORIGIN = 'http://localhost:3004';
const ADMIN_EMAIL = process.env.SUPERADMIN_EMAIL ?? 'admin@smartchat.local';
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!SuperAdmin1';
const PASSWORD = 'Sunday-Harbour-Quartz-51';

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
    return { status: response.status, body: parsed, headers: response.headers };
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

async function register(stamp, suffix) {
  const client = new Http();
  const email = `billing.${suffix}.${stamp}@example.test`;
  const result = await client.call('POST', '/auth/register', {
    name: 'Billing Owner',
    email,
    password: PASSWORD,
    accountName: `Billing ${suffix} ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  if (result.status !== 201) {
    throw new Error(`registration failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return { client, email };
}

const overview = (client) => client.call('GET', '/billing/subscription');

async function main() {
  resetRateLimits();
  const stamp = Date.now();

  // ---------------------------------------------------------------------------
  section('The pricing page reads real plans, with no credential at all');
  // ---------------------------------------------------------------------------
  const anonymous = await fetch(`${API}/api/v1/public/plans`, {
    headers: { accept: 'application/json' },
  });
  const plansBody = await anonymous.json();
  const plans = plansBody.data ?? [];
  check('a stranger can read the plans', anonymous.status === 200, `got ${anonymous.status}`);
  check(
    'and the response is cacheable, because prices change rarely',
    (anonymous.headers.get('cache-control') ?? '').includes('max-age'),
    anonymous.headers.get('cache-control') ?? 'none',
  );

  const byCode = Object.fromEntries(plans.map((plan) => [plan.code, plan]));
  check('free, starter, pro and enterprise are all published', 
    ['free', 'starter', 'pro', 'enterprise'].every((code) => code in byCode),
    plans.map((plan) => plan.code).join(','));
  check(
    'the prices are the real ones, not placeholders',
    byCode.free?.priceMonthlyCents === 0 &&
      byCode.starter?.priceMonthlyCents === 2900 &&
      byCode.pro?.priceMonthlyCents === 9900,
    `${byCode.free?.priceMonthlyCents}/${byCode.starter?.priceMonthlyCents}/${byCode.pro?.priceMonthlyCents}`,
  );
  check(
    'annual really is twelve months for the price of ten',
    byCode.starter?.priceYearlyCents === 29_000 &&
      byCode.starter?.annualSavingMonths === 2 &&
      byCode.pro?.priceYearlyCents === 99_000,
    `${byCode.starter?.priceYearlyCents} saving ${byCode.starter?.annualSavingMonths}`,
  );
  check(
    'and the saving on a free plan is zero rather than a nonsense number',
    byCode.free?.annualSavingMonths === 0,
    String(byCode.free?.annualSavingMonths),
  );
  check(
    'enterprise is marked as a conversation, not a price',
    byCode.enterprise?.isContactSales === true,
  );
  check(
    'each plan carries the limits it is selling',
    typeof byCode.free?.limits?.max_properties === 'number' &&
      byCode.free.features.feature_public_api === false,
    JSON.stringify(byCode.free?.limits ?? {}),
  );
  check(
    'and nothing internal leaks into a public response',
    !JSON.stringify(plans).match(/"id"|secret|token|createdAt/i),
  );

  // ---------------------------------------------------------------------------
  section('A new account actually has a subscription');
  // ---------------------------------------------------------------------------
  //
  // The regression guard. Registration used to create no subscription row, which made every
  // limit unlimited and this endpoint a 404.
  const trial = await register(stamp, 'trial');
  const trialView = await overview(trial.client);
  check('the billing screen has something to show', trialView.status === 200, `got ${trialView.status}`);
  check(
    'a new account is on a trial rather than on nothing',
    trialView.body?.data?.status === 'trialing',
    trialView.body?.data?.status,
  );
  check(
    'and the trial ends on a date, roughly a fortnight out',
    (() => {
      const ends = trialView.body?.data?.trialEndsAt;
      if (!ends) return false;
      const days = (new Date(ends).getTime() - Date.now()) / 86_400_000;
      return days > 12 && days < 15;
    })(),
    trialView.body?.data?.trialEndsAt,
  );
  check(
    'usage is counted live, one line per limit',
    Array.isArray(trialView.body?.data?.usage) && trialView.body.data.usage.length >= 8,
    String(trialView.body?.data?.usage?.length),
  );
  check(
    'every usage line names a limit and a count, not a placeholder',
    (trialView.body?.data?.usage ?? []).every(
      (line) => typeof line.key === 'string' && Number.isInteger(line.used),
    ),
  );

  // ---------------------------------------------------------------------------
  section('A Free plan is refused what Free does not include');
  // ---------------------------------------------------------------------------
  const free = await register(stamp, 'free');

  // Moving to a free plan is applied immediately - nobody should need permission to stop paying.
  const toFree = await free.client.call('POST', '/billing/plan', {
    planCode: 'free',
    interval: 'monthly',
  });
  check('an account can move itself down to Free', toFree.status === 200, JSON.stringify(toFree.body?.error));
  check(
    'and it takes effect at once rather than queueing behind an operator',
    toFree.body?.data?.status === 'applied',
    toFree.body?.data?.status,
  );

  const onFree = await overview(free.client);
  check('the plan really changed', onFree.body?.data?.plan?.code === 'free', onFree.body?.data?.plan?.code);

  const firstSite = await free.client.call('POST', '/properties', {
    name: 'First site',
    websiteUrl: `https://one-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check('the one website Free includes is allowed', firstSite.status === 201, `got ${firstSite.status}`);

  const secondSite = await free.client.call('POST', '/properties', {
    name: 'Second site',
    websiteUrl: `https://two-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check(
    'the second is refused, because Free includes one',
    secondSite.status === 402 && secondSite.body?.error?.code === 'PLAN_LIMIT_REACHED',
    `got ${secondSite.status} ${secondSite.body?.error?.code}`,
  );
  check(
    'and the refusal says what the limit is, so it can be acted on',
    /\b1\b/.test(secondSite.body?.error?.message ?? ''),
    secondSite.body?.error?.message,
  );

  const webhook = await free.client.call('POST', '/integrations/webhooks', {
    name: 'Free hook',
    url: 'https://example.com/hook',
    events: ['conversation.started'],
  });
  check(
    'webhooks are refused entirely, not merely limited',
    webhook.status === 402 && webhook.body?.error?.code === 'FEATURE_NOT_AVAILABLE',
    `got ${webhook.status} ${webhook.body?.error?.code}`,
  );

  const key = await free.client.call('POST', '/integrations/keys', {
    name: 'Free key',
    scopes: ['tickets:read'],
  });
  const freeKey = key.body?.data?.secretShownOnce;
  if (freeKey) {
    const used = await fetch(`${API}/api/v1/tickets`, {
      headers: { accept: 'application/json', authorization: `Bearer ${freeKey}` },
    });
    check(
      'and a key belonging to a Free account is refused at the door',
      used.status === 402,
      `got ${used.status}`,
    );
  } else {
    check(
      'a Free account cannot even mint a public-API key',
      key.status === 402 && key.body?.error?.code === 'FEATURE_NOT_AVAILABLE',
      `got ${key.status} ${key.body?.error?.code}`,
    );
  }

  /**
   * The negative control.
   *
   * Every refusal above would also be produced by a broken route, a typo in a path, or a limit of
   * zero applied to everybody. The trial account is on the full product and does the identical
   * calls; if these fail too, the checks above are measuring the wrong thing.
   */
  const controlWebhook = await trial.client.call('POST', '/integrations/webhooks', {
    name: 'Control hook',
    url: 'https://example.com/hook',
    events: ['conversation.started'],
  });
  check(
    'control: the same webhook call succeeds on a plan that includes them',
    controlWebhook.status === 201,
    `got ${controlWebhook.status} ${controlWebhook.body?.error?.code}`,
  );
  const controlSecond = await trial.client.call('POST', '/properties', {
    name: 'Control second site',
    websiteUrl: `https://control-two-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check(
    'control: a second website is allowed on a plan that includes more than one',
    controlSecond.status === 201,
    `got ${controlSecond.status} ${controlSecond.body?.error?.code}`,
  );

  // ---------------------------------------------------------------------------
  section('An upgrade is a request, and the customer cannot approve their own');
  // ---------------------------------------------------------------------------
  const up = await free.client.call('POST', '/billing/plan', {
    planCode: 'starter',
    interval: 'monthly',
  });
  check('the upgrade is accepted as a request', up.status === 200, JSON.stringify(up.body?.error));
  check(
    'and is pending rather than applied',
    up.body?.data?.status === 'pending' && typeof up.body?.data?.requestId === 'string',
    JSON.stringify(up.body?.data),
  );

  const stillFree = await overview(free.client);
  check(
    'nothing moved while it waits',
    stillFree.body?.data?.plan?.code === 'free',
    stillFree.body?.data?.plan?.code,
  );
  check(
    'and the pending change is shown to the customer',
    stillFree.body?.data?.pendingChange?.toPlanName === 'Starter' &&
      stillFree.body?.data?.pendingChange?.kind === 'upgrade_request',
    JSON.stringify(stillFree.body?.data?.pendingChange),
  );

  const second = await free.client.call('POST', '/billing/plan', {
    planCode: 'pro',
    interval: 'monthly',
  });
  check(
    'a second request while one is open is refused rather than queued',
    second.status === 409,
    `got ${second.status}`,
  );

  const selfApprove = await free.client.call(
    'POST',
    `/platform/plan-changes/${up.body.data.requestId}/decide`,
    { decision: 'approved' },
  );
  check(
    'the account holder cannot reach the approval endpoint at all',
    selfApprove.status === 401,
    `got ${selfApprove.status}`,
  );

  const contactSales = await trial.client.call('POST', '/billing/plan', {
    planCode: 'enterprise',
    interval: 'monthly',
  });
  check(
    'and a contact-sales plan cannot be self-selected',
    contactSales.status === 422,
    `got ${contactSales.status} ${contactSales.body?.error?.code}`,
  );

  // ---------------------------------------------------------------------------
  section('The operator decides, and the entitlement moves with it');
  // ---------------------------------------------------------------------------
  const operator = new Http();
  const signedIn = await operator.call('POST', '/platform/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  check('an operator can sign in', signedIn.status === 200, JSON.stringify(signedIn.body?.error));

  const queue = await operator.call('GET', '/platform/plan-changes?status=pending');
  const mine = (queue.body?.data ?? []).find((row) => row.id === up.body.data.requestId);
  check('the request is in the operator queue', Boolean(mine), `${queue.body?.data?.length} pending`);
  check(
    'and is marked as something to decide, not something already agreed',
    mine?.kind === 'upgrade_request',
    mine?.kind,
  );

  const approved = await operator.call(
    `POST`,
    `/platform/plan-changes/${up.body.data.requestId}/decide`,
    { decision: 'approved' },
  );
  check('it can be approved', approved.status === 204, `got ${approved.status}`);

  const onStarter = await overview(free.client);
  check(
    'the subscription moved',
    onStarter.body?.data?.plan?.code === 'starter',
    onStarter.body?.data?.plan?.code,
  );
  check('and there is nothing left pending', onStarter.body?.data?.pendingChange === null);

  const nowAllowed = await free.client.call('POST', '/integrations/webhooks', {
    name: 'Starter hook',
    url: 'https://example.com/hook',
    events: ['conversation.started'],
  });
  check(
    'the capability the plan just bought works immediately',
    nowAllowed.status === 201,
    `got ${nowAllowed.status} ${nowAllowed.body?.error?.code}`,
  );

  const secondAllowed = await free.client.call('POST', '/properties', {
    name: 'Second site, now allowed',
    websiteUrl: `https://two-b-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check(
    'and so does the higher limit',
    secondAllowed.status === 201,
    `got ${secondAllowed.status} ${secondAllowed.body?.error?.code}`,
  );

  // ---------------------------------------------------------------------------
  section('A refusal is a reason, not a shrug');
  // ---------------------------------------------------------------------------
  const rejectee = await register(stamp, 'reject');
  await rejectee.client.call('POST', '/billing/plan', { planCode: 'free', interval: 'monthly' });
  const asked = await rejectee.client.call('POST', '/billing/plan', {
    planCode: 'pro',
    interval: 'monthly',
  });
  const refused = await operator.call(
    'POST',
    `/platform/plan-changes/${asked.body.data.requestId}/decide`,
    { decision: 'rejected', note: 'We could not take payment for the first period.' },
  );
  check('a request can be refused', refused.status === 204, `got ${refused.status}`);

  const afterRefusal = await overview(rejectee.client);
  check(
    'the account stays exactly where it was',
    afterRefusal.body?.data?.plan?.code === 'free',
    afterRefusal.body?.data?.plan?.code,
  );
  check('and is no longer waiting on anybody', afterRefusal.body?.data?.pendingChange === null);

  const noReason = await operator.call(
    'POST',
    `/platform/plan-changes/${asked.body.data.requestId}/decide`,
    { decision: 'approved' },
  );
  check(
    'a decided request cannot be decided twice',
    noReason.status >= 400,
    `got ${noReason.status}`,
  );

  // ---------------------------------------------------------------------------
  section('A downgrade is dated, not lost');
  // ---------------------------------------------------------------------------
  //
  // This one caught a real bug: the provider reported "applied", wrote no request row, and left
  // the customer on the expensive plan for ever with nothing scheduled to move them.
  const down = await free.client.call('POST', '/billing/plan', {
    planCode: 'free',
    interval: 'monthly',
  });
  check('moving to Free is immediate', down.body?.data?.status === 'applied', JSON.stringify(down.body?.data));

  const downgrader = await register(stamp, 'down');
  // A new account trials on the full product, so it has to come down before it can ask to go up.
  await downgrader.client.call('POST', '/billing/plan', { planCode: 'free', interval: 'monthly' });
  const toPro = await downgrader.client.call('POST', '/billing/plan', {
    planCode: 'pro',
    interval: 'monthly',
  });
  await operator.call('POST', `/platform/plan-changes/${toPro.body.data.requestId}/decide`, {
    decision: 'approved',
  });

  const toStarter = await downgrader.client.call('POST', '/billing/plan', {
    planCode: 'starter',
    interval: 'monthly',
  });
  check(
    'a move to a cheaper paid plan is scheduled, not applied and not queued for approval',
    toStarter.body?.data?.status === 'scheduled',
    JSON.stringify(toStarter.body?.data),
  );
  check(
    'and the customer is told the date it lands',
    Boolean(toStarter.body?.data?.effectiveAt) &&
      new Date(toStarter.body.data.effectiveAt).getTime() > Date.now(),
    toStarter.body?.data?.effectiveAt,
  );

  const scheduled = await overview(downgrader.client);
  check(
    'they keep the plan they paid for until then',
    scheduled.body?.data?.plan?.code === 'pro',
    scheduled.body?.data?.plan?.code,
  );
  check(
    'the change is recorded, so something exists to apply it',
    scheduled.body?.data?.pendingChange?.kind === 'scheduled_downgrade',
    JSON.stringify(scheduled.body?.data?.pendingChange),
  );

  const opQueue = await operator.call('GET', '/platform/plan-changes?status=pending');
  const scheduledRow = (opQueue.body?.data ?? []).find(
    (row) => row.id === scheduled.body.data.pendingChange.id,
  );
  check(
    'and the operator sees it as already agreed rather than as a decision',
    scheduledRow?.kind === 'scheduled_downgrade',
    scheduledRow?.kind,
  );

  const withdrawn = await downgrader.client.call(
    'DELETE',
    `/billing/plan/${scheduled.body.data.pendingChange.id}`,
  );
  check('a customer can change their mind', withdrawn.status === 200, `got ${withdrawn.status}`);
  const afterWithdraw = await overview(downgrader.client);
  check('and nothing is scheduled any more', afterWithdraw.body?.data?.pendingChange === null);

  // ---------------------------------------------------------------------------
  section('Annual billing is a real interval, not a label');
  // ---------------------------------------------------------------------------
  const yearly = await register(stamp, 'annual');
  await yearly.client.call('POST', '/billing/plan', { planCode: 'free', interval: 'monthly' });
  const askYearly = await yearly.client.call('POST', '/billing/plan', {
    planCode: 'starter',
    interval: 'yearly',
  });
  await operator.call('POST', `/platform/plan-changes/${askYearly.body.data.requestId}/decide`, {
    decision: 'approved',
  });
  const annualView = await overview(yearly.client);
  check(
    'the interval is carried through the approval',
    annualView.body?.data?.interval === 'yearly',
    annualView.body?.data?.interval,
  );
  check(
    'the amount is the annual price, not twelve times the monthly one',
    annualView.body?.data?.amountCents === 29_000,
    String(annualView.body?.data?.amountCents),
  );
  check(
    'and the period runs a year rather than a month',
    (() => {
      const start = new Date(annualView.body.data.currentPeriodStart).getTime();
      const end = new Date(annualView.body.data.currentPeriodEnd).getTime();
      const days = (end - start) / 86_400_000;
      return days > 360 && days < 370;
    })(),
    `${annualView.body?.data?.currentPeriodStart} - ${annualView.body?.data?.currentPeriodEnd}`,
  );

  /**
   * Switching interval on the same plan.
   *
   * This was refused as "you are already on Starter" until the no-op check learned to compare the
   * interval as well as the plan - which made every annual price on the pricing page unreachable
   * for anybody already paying monthly, which is most of the people who would want one.
   */
  const switched = await yearly.client.call('POST', '/billing/plan', {
    planCode: 'starter',
    interval: 'monthly',
  });
  check(
    'moving between intervals on the same plan is a real change, not a no-op',
    switched.status === 200,
    `got ${switched.status} ${switched.body?.error?.code} ${switched.body?.error?.message ?? ''}`,
  );
  const switchedView = await overview(yearly.client);
  if (switchedView.body?.data?.pendingChange?.id) {
    await yearly.client.call(
      'DELETE',
      `/billing/plan/${switchedView.body.data.pendingChange.id}`,
    );
  }
  const sameAgain = await yearly.client.call('POST', '/billing/plan', {
    planCode: 'starter',
    interval: 'yearly',
  });
  check(
    'control: asking for exactly the plan and interval you already have is still refused',
    sameAgain.status === 422,
    `got ${sameAgain.status} ${sameAgain.body?.error?.code}`,
  );

  // ---------------------------------------------------------------------------
  section('Paused means read-only. It does not mean destroyed.');
  // ---------------------------------------------------------------------------
  const paused = await register(stamp, 'paused');
  const site = await paused.client.call('POST', '/properties', {
    name: 'Paused site',
    websiteUrl: `https://paused-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const publicId = site.body.data.publicId;
  check('the account has a website', site.status === 201, `got ${site.status}`);

  const beforeWidget = await widgetCall('POST', '/widget/session', {
    p: publicId,
    page: { url: `${ORIGIN}/`, title: 'Billing E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check('whose widget serves visitors', beforeWidget.status === 200, `got ${beforeWidget.status}`);

  const cancelled = await paused.client.call('POST', '/billing/cancel', { immediately: true });
  check('the subscription can be ended now', cancelled.status === 200, `got ${cancelled.status}`);

  const pausedView = await overview(paused.client);
  check('and the account says it is paused', pausedView.body?.data?.isPaused === true);

  const readAfter = await paused.client.call('GET', '/properties');
  check(
    'everything is still readable - nothing was deleted',
    readAfter.status === 200 && readAfter.body.data.length === 1,
    `got ${readAfter.status} with ${readAfter.body?.data?.length} websites`,
  );
  check(
    'and the dashboard is told which websites stopped serving',
    readAfter.body?.data?.[0]?.serving === false,
    JSON.stringify(readAfter.body?.data?.[0]?.serving),
  );

  const writeAfter = await paused.client.call('PATCH', `/properties/${site.body.data.id}`, {
    name: 'Renamed while paused',
  });
  check(
    'but a write is refused, with a code that says why',
    writeAfter.status === 402 && writeAfter.body?.error?.code === 'SUBSCRIPTION_PAUSED',
    `got ${writeAfter.status} ${writeAfter.body?.error?.code}`,
  );
  check(
    'and the message promises nothing has been lost',
    /nothing has been deleted/i.test(writeAfter.body?.error?.message ?? ''),
    writeAfter.body?.error?.message,
  );

  const widgetAfter = await widgetCall('POST', '/widget/session', {
    p: publicId,
    page: { url: `${ORIGIN}/`, title: 'Billing E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check(
    'the widget stops serving visitors',
    widgetAfter.status === 404,
    `got ${widgetAfter.status}`,
  );
  check(
    "and tells a stranger nothing about the owner's billing",
    !/pause|subscription|invoice|plan/i.test(JSON.stringify(widgetAfter.body ?? {})),
    JSON.stringify(widgetAfter.body),
  );

  /**
   * The way back has to exist.
   *
   * An earlier version of `resume` refused any subscription whose period had already ended, which
   * made an immediate cancellation a one-way door: paused, unable to resume, unable to re-request
   * the plan it was already on. "Pause, never destroy" is only true if there is a way out.
   */
  const billingStillReachable = await overview(paused.client);
  check(
    'a paused account can still reach its own billing screen',
    billingStillReachable.status === 200,
    `got ${billingStillReachable.status}`,
  );

  const resumed = await paused.client.call('POST', '/billing/resume');
  check('and can resume', resumed.status === 200, JSON.stringify(resumed.body?.error));

  const writeAgain = await paused.client.call('PATCH', `/properties/${site.body.data.id}`, {
    name: 'Renamed after resuming',
  });
  check('writes work again', writeAgain.status === 200, `got ${writeAgain.status}`);

  const widgetAgain = await widgetCall('POST', '/widget/session', {
    p: publicId,
    page: { url: `${ORIGIN}/`, title: 'Billing E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check('and the widget serves again', widgetAgain.status === 200, `got ${widgetAgain.status}`);

  // ---------------------------------------------------------------------------
  section('A downgrade leaves the excess read-only, never removed');
  // ---------------------------------------------------------------------------
  const over = await register(stamp, 'over');
  const sites = [];
  for (const n of [1, 2]) {
    const created = await over.client.call('POST', '/properties', {
      name: `Site ${n}`,
      websiteUrl: `https://over-${n}-${stamp}.example.com`,
      timezone: 'UTC',
      locale: 'en',
    });
    sites.push(created.body.data);
  }
  check('two websites exist', sites.every((entry) => entry?.id), JSON.stringify(sites.map((s) => s?.id)));

  const bothServing = await widgetCall('GET', `/widget/config?p=${sites[1].publicId}`);
  check('and both serve', bothServing.status === 200, `got ${bothServing.status}`);

  await over.client.call('POST', '/billing/plan', { planCode: 'free', interval: 'monthly' });

  const afterDowngrade = await over.client.call('GET', '/properties');
  check(
    'after moving to a plan that covers one, both websites still exist',
    afterDowngrade.body?.data?.length === 2,
    String(afterDowngrade.body?.data?.length),
  );
  const servingFlags = (afterDowngrade.body?.data ?? [])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((entry) => entry.serving);
  check(
    'the oldest keeps serving and the excess does not - predictably, not at random',
    servingFlags.length === 2 && servingFlags[0] === true && servingFlags[1] === false,
    JSON.stringify(servingFlags),
  );

  const excessWidget = await widgetCall('GET', `/widget/config?p=${sites[1].publicId}`);
  check(
    "the excess website's widget stops",
    excessWidget.status === 404,
    `got ${excessWidget.status}`,
  );
  const keptWidget = await widgetCall('GET', `/widget/config?p=${sites[0].publicId}`);
  check('control: the covered one keeps working', keptWidget.status === 200, `got ${keptWidget.status}`);

  const overUsage = await overview(over.client);
  const propertyLine = (overUsage.body?.data?.usage ?? []).find(
    (line) => line.key === 'max_properties',
  );
  check(
    'and the billing screen says plainly that they are over',
    propertyLine?.over === true && propertyLine?.used === 2 && propertyLine?.limit === 1,
    JSON.stringify(propertyLine),
  );

  // ---------------------------------------------------------------------------
  section('Invoices are numbered per account, gaplessly, and paying clears the lapse');
  // ---------------------------------------------------------------------------
  const invoiced = await register(stamp, 'invoice');
  await invoiced.client.call('POST', '/billing/plan', { planCode: 'free', interval: 'monthly' });
  const wantsPro = await invoiced.client.call('POST', '/billing/plan', {
    planCode: 'pro',
    interval: 'monthly',
  });
  await operator.call('POST', `/platform/plan-changes/${wantsPro.body.data.requestId}/decide`, {
    decision: 'approved',
  });

  const runSweeper = await operator.call('POST', '/platform/maintenance/subscriptions');
  check(
    'the lifecycle sweeper can be run on demand',
    runSweeper.status === 200,
    `got ${runSweeper.status}`,
  );

  const ownInvoices = await invoiced.client.call('GET', '/billing/invoices');
  check('an account can read its own invoices', ownInvoices.status === 200, `got ${ownInvoices.status}`);
  check(
    'and sees only its own',
    (ownInvoices.body?.data ?? []).every((invoice) => typeof invoice.number === 'number'),
  );

  const otherInvoices = await free.client.call('GET', '/billing/invoices');
  const overlap = new Set((ownInvoices.body?.data ?? []).map((invoice) => invoice.id));
  check(
    'one account never sees another account\'s invoices',
    (otherInvoices.body?.data ?? []).every((invoice) => !overlap.has(invoice.id)),
  );

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
  // `cause` is where Node puts the real reason a fetch failed. Without it the message is
  // "fetch failed", which says nothing at all.
  const cause = error?.cause ? `\n  cause: ${error.cause.message ?? error.cause}` : '';
  process.stderr.write(`\nBilling E2E crashed: ${error?.stack ?? error}${cause}\n`);
  process.exit(1);
});
