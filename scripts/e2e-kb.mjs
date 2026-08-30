#!/usr/bin/env node
/**
 * Phase 8: the knowledge base, and the strangers who read it.
 *
 * The exit criterion for this phase is one sentence - "a published article is reachable publicly
 * and searchable" - and most of these checks exist because that sentence has a dangerous half.
 * "Publicly" means an endpoint with no authentication, keyed by an identifier that is printed in
 * every customer's page source. So the claims under test are:
 *
 *   - a published article really is readable by somebody with no session at all, and searchable;
 *   - a draft is not, and answers a stranger exactly as a non-existent article does;
 *   - the public shapes carry nothing internal - no ids, no author, no counters;
 *   - the public id authorises nothing: it cannot be used to reach another account's articles,
 *     and a paused website's help centre closes with it;
 *   - inside the account, a restricted agent still cannot reach a website they do not work on;
 *   - a slug is an address, so it is unique and it does not move by itself;
 *   - and an article body is text, not markup: what an author writes is escaped before it reaches
 *     a reader's browser.
 *
 *   node scripts/e2e-kb.mjs
 *
 * Requires the stack to be up (`docker compose up -d`).
 */
import { execFileSync } from 'node:child_process';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const WEB = process.env.SMOKE_WEB_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.SMOKE_MAILPIT_URL ?? 'http://localhost:8025';

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

/**
 * A reader off the street.
 *
 * No cookie jar, no CSRF token, no Authorization header - deliberately a different function from
 * `Http.call` so that nothing can leak an identity into a request that is supposed to have none.
 */
async function anonymous(path, query = {}) {
  const url = new URL(`${API}/api/v1${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
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

async function invitationTokenFor(email, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      if (response.ok) {
        const found = await response.json();
        const latest = found.messages?.[0];
        if (latest) {
          const detail = await fetch(`${MAILPIT}/api/v1/message/${latest.ID}`).then((r) => r.json());
          const text = `${detail.Text ?? ''} ${detail.HTML ?? ''}`;
          const match = /accept-invitation\?token=([A-Za-z0-9._~%-]+)/.exec(text);
          if (match) return decodeURIComponent(match[1]);
        }
      }
    } catch {
      /* Mailpit may not be up yet on the first attempt. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

const HOSTILE_TITLE = 'Escaping <script>alert(1)</script>';
const HOSTILE_BODY = [
  '## Sanitising',
  '',
  'An author may write `<img src=x onerror=alert(1)>` and it stays text.',
  '',
  '<script>window.__pwned = true;</script>',
  '',
  '[a bad link](javascript:alert(1)) and [a good one](https://example.com/docs).',
].join('\n');

async function main() {
  resetRateLimits();
  const stamp = Date.now();
  const owner = new Http();

  section('Setup');
  const register = await owner.call('POST', '/auth/register', {
    name: 'Docs Owner',
    email: `kb.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Docs ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('owner registered', register.status === 201, `got ${register.status}`);

  const siteA = await owner.call('POST', '/properties', {
    name: 'Depot',
    websiteUrl: `https://depot-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const siteB = await owner.call('POST', '/properties', {
    name: 'Warehouse',
    websiteUrl: `https://warehouse-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check('two websites were created', siteA.status === 201 && siteB.status === 201);
  const propertyA = siteA.body.data;
  const propertyB = siteB.body.data;

  section('Sections');
  const billing = await owner.call('POST', `/kb/${propertyA.id}/categories`, {
    name: 'Billing',
    description: 'Invoices, refunds and receipts.',
    position: 0,
  });
  check('a section was created', billing.status === 201, JSON.stringify(billing.body?.error));
  check(
    'and its address was suggested from its name',
    billing.body.data.slug === 'billing',
    billing.body.data?.slug,
  );

  const clashingCategory = await owner.call('POST', `/kb/${propertyA.id}/categories`, {
    name: 'Billing again',
    slug: 'billing',
  });
  check(
    'two sections cannot share one address',
    clashingCategory.status === 409 || clashingCategory.body?.error?.code === 'DUPLICATE_SLUG',
    `got ${clashingCategory.status} ${JSON.stringify(clashingCategory.body?.error)}`,
  );

  const shouting = await owner.call('POST', `/kb/${propertyA.id}/categories`, {
    name: 'Shipping',
    slug: 'Not A Slug',
  });
  check(
    'an address that is not an address is refused',
    shouting.status === 422,
    `got ${shouting.status}`,
  );

  section('Writing');
  const draft = await owner.call('POST', `/kb/${propertyA.id}/articles`, {
    title: 'Internal pricing notes',
    body: 'Do not publish this. Our margin on the Growth plan is 62%.',
    status: 'draft',
  });
  check('a draft was created', draft.status === 201, JSON.stringify(draft.body?.error));
  check('a draft has no publication date', draft.body.data.publishedAt === null);

  const article = await owner.call('POST', `/kb/${propertyA.id}/articles`, {
    title: 'How refunds work',
    excerpt: 'We refund card payments within 14 days.',
    body: [
      '## Getting a refund',
      '',
      'Open your receipt and choose **Refund**. Card payments are returned within 14 days.',
      '',
      '- Card: 14 days',
      '- Bank transfer: 5 working days',
    ].join('\n'),
    categoryId: billing.body.data.id,
    status: 'published',
  });
  check('an article was published', article.status === 201, JSON.stringify(article.body?.error));
  check(
    'its address was suggested from its title',
    article.body.data.slug === 'how-refunds-work',
    article.body.data?.slug,
  );
  check('and publishing stamped a date on it', typeof article.body.data.publishedAt === 'string');

  const clashingArticle = await owner.call('POST', `/kb/${propertyA.id}/articles`, {
    title: 'Another refunds page',
    body: 'Duplicate address.',
    slug: 'how-refunds-work',
  });
  check(
    'two articles cannot share one address',
    clashingArticle.body?.error?.code === 'DUPLICATE_SLUG',
    `got ${clashingArticle.status} ${JSON.stringify(clashingArticle.body?.error)}`,
  );

  const foreignSection = await owner.call('POST', `/kb/${propertyB.id}/articles`, {
    title: 'Wrong section',
    body: 'This section belongs to the other website.',
    categoryId: billing.body.data.id,
  });
  check(
    "an article cannot be filed under another website's section",
    foreignSection.status === 422 && foreignSection.body?.error?.code === 'VALIDATION_FAILED',
    `got ${foreignSection.status} ${JSON.stringify(foreignSection.body?.error)}`,
  );

  section('A published article is reachable publicly');
  const index = await anonymous(`/public/kb/${propertyA.publicId}`);
  check('the help centre answers a reader with no session', index.status === 200, `got ${index.status}`);
  check(
    'it names the website',
    index.body.data.property.name === 'Depot',
    JSON.stringify(index.body.data?.property),
  );
  check(
    'it lists the published article',
    index.body.data.articles.some((entry) => entry.slug === 'how-refunds-work'),
    JSON.stringify(index.body.data?.articles?.map((a) => a.slug)),
  );
  check(
    'and it does not list the draft',
    !index.body.data.articles.some((entry) => entry.title === 'Internal pricing notes'),
  );
  check(
    'the section carries a count of what is actually published in it',
    index.body.data.categories.find((entry) => entry.slug === 'billing')?.articleCount === 1,
    JSON.stringify(index.body.data?.categories),
  );

  const read = await anonymous(`/public/kb/${propertyA.publicId}/articles/how-refunds-work`);
  check('the article itself is readable', read.status === 200, `got ${read.status}`);
  check('with its body', read.body.data.body.includes('Card payments are returned within 14 days'));
  check(
    'and it is cacheable, because it is identical for every reader',
    /max-age=\d+/.test(read.headers.get('cache-control') ?? ''),
    read.headers.get('cache-control'),
  );

  const publicKeys = Object.keys(read.body.data).sort().join(',');
  check(
    'the public shape carries nothing internal',
    publicKeys === 'body,category,excerpt,publishedAt,slug,title,updatedAt',
    publicKeys,
  );
  check(
    'no id, author or view counter leaks in the serialised response',
    !JSON.stringify(read.body.data).includes(article.body.data.id) &&
      !/"(viewCount|authorMemberId|accountId|propertyId)"/.test(JSON.stringify(read.body.data)),
  );

  section('...and searchable');
  const byTitle = await anonymous(`/public/kb/${propertyA.publicId}/search`, { q: 'refunds' });
  check('a title word finds it', byTitle.status === 200 && byTitle.body.data.length === 1, `got ${byTitle.status}`);
  check('and the result is the right article', byTitle.body.data[0]?.slug === 'how-refunds-work');

  const byBody = await anonymous(`/public/kb/${propertyA.publicId}/search`, { q: 'working days' });
  check(
    'a phrase that only appears in the body finds it too',
    byBody.body.data?.some((entry) => entry.slug === 'how-refunds-work'),
    JSON.stringify(byBody.body.data?.map((a) => a.slug)),
  );

  const bySection = await anonymous(`/public/kb/${propertyA.publicId}/search`, { category: 'billing' });
  check('a section can be browsed on its own', bySection.body.data?.length === 1, `${bySection.status}`);

  const secret = await anonymous(`/public/kb/${propertyA.publicId}/search`, { q: 'margin' });
  check(
    'and searching for a word that only exists in a draft finds nothing',
    secret.status === 200 && secret.body.data.length === 0,
    JSON.stringify(secret.body.data),
  );

  const tooShort = await anonymous(`/public/kb/${propertyA.publicId}/search`, { q: 'a' });
  check(
    'a one-character search is refused rather than scanning everything',
    tooShort.status === 422,
    `got ${tooShort.status}`,
  );

  section('A draft answers a stranger exactly as a missing article does');
  const draftBySlug = await anonymous(
    `/public/kb/${propertyA.publicId}/articles/${draft.body.data.slug}`,
  );
  const neverExisted = await anonymous(
    `/public/kb/${propertyA.publicId}/articles/no-such-article-at-all`,
  );
  check('a draft is not readable publicly', draftBySlug.status === 404, `got ${draftBySlug.status}`);
  check(
    'and the answer is indistinguishable from one that never existed',
    draftBySlug.status === neverExisted.status &&
      draftBySlug.body.error?.code === neverExisted.body.error?.code,
    `${draftBySlug.body.error?.code} vs ${neverExisted.body.error?.code}`,
  );

  section('The public id authorises nothing');
  const wrongSite = await anonymous(
    `/public/kb/${propertyB.publicId}/articles/how-refunds-work`,
  );
  check(
    "another website's public id does not reach this article",
    wrongSite.status === 404,
    `got ${wrongSite.status}`,
  );

  const noSuchProperty = await anonymous('/public/kb/prp_0000000000000000');
  check('an invented public id is refused', noSuchProperty.status === 404, `got ${noSuchProperty.status}`);

  const malformed = await anonymous('/public/kb/../../accounts');
  check(
    'and a public id that is not one at all never reaches a query',
    malformed.status === 404 || malformed.status === 422,
    `got ${malformed.status}`,
  );

  section('Inside the account, a restricted agent is still restricted');
  const agentEmail = `kbagent.${stamp}@example.test`;
  const invite = await owner.call('POST', '/team/members', {
    email: agentEmail,
    baseRole: 'agent',
    restrictedToProperties: true,
    propertyIds: [propertyB.id],
  });
  check('an agent was invited, scoped to the other website', invite.status === 201, `got ${invite.status}`);

  const token = await invitationTokenFor(agentEmail);
  check('the invitation email arrived', typeof token === 'string' && token.length > 20);

  const agent = new Http();
  const accepted = await agent.call('POST', '/auth/accept-invitation', {
    token,
    name: 'Scoped Agent',
    password: 'Tuesday-Anchor-Marble-77',
  });
  check('the invitation was accepted', accepted.status === 200, `got ${accepted.status}`);

  const agentReadsOwn = await agent.call('GET', `/kb/${propertyB.id}/articles`);
  check('the agent can read their own website\'s help centre', agentReadsOwn.status === 200, `got ${agentReadsOwn.status}`);

  const agentReadsOther = await agent.call('GET', `/kb/${propertyA.id}/articles`);
  check(
    'but not the other website\'s',
    agentReadsOther.status === 404,
    `got ${agentReadsOther.status}`,
  );

  const agentReadsArticle = await agent.call('GET', `/kb/articles/${article.body.data.id}`);
  check(
    'and an article id from that website is a 404, not a 403',
    agentReadsArticle.status === 404,
    `got ${agentReadsArticle.status}`,
  );

  const agentWrites = await agent.call('POST', `/kb/${propertyB.id}/articles`, {
    title: 'Agents do not write the manual',
    body: 'Attempted by an agent.',
  });
  check(
    'an agent cannot write articles even on their own website',
    agentWrites.status === 403,
    `got ${agentWrites.status}`,
  );

  section("Another account's article is not reachable at all");
  const stranger = new Http();
  await stranger.call('POST', '/auth/register', {
    name: 'Other Owner',
    email: `other.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Other ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  const crossTenant = await stranger.call('GET', `/kb/articles/${article.body.data.id}`);
  check(
    'a signed-in stranger gets 404 for an article id they were told',
    crossTenant.status === 404,
    `got ${crossTenant.status}`,
  );

  section('A publication date is a fact, not a timestamp of the last edit');
  const originalPublishedAt = article.body.data.publishedAt;
  await owner.call('PATCH', `/kb/articles/${article.body.data.id}`, { status: 'draft' });
  const hidden = await anonymous(`/public/kb/${propertyA.publicId}/articles/how-refunds-work`);
  check('unpublishing removes it from the help centre', hidden.status === 404, `got ${hidden.status}`);

  const republished = await owner.call('PATCH', `/kb/articles/${article.body.data.id}`, {
    status: 'published',
    body: 'Rewritten after a correction. Card payments are returned within 14 days.',
  });
  check('it can be published again', republished.status === 200, `got ${republished.status}`);
  check(
    'and the original publication date is kept',
    republished.body.data.publishedAt === originalPublishedAt,
    `${republished.body.data.publishedAt} vs ${originalPublishedAt}`,
  );

  section('Removing a section keeps the writing in it');
  const before = await owner.call('GET', `/kb/${propertyA.id}/articles`);
  const filedCount = before.body.data.filter((entry) => entry.category?.slug === 'billing').length;
  check('the article is filed under the section', filedCount === 1, `${filedCount}`);

  const removed = await owner.call('DELETE', `/kb/categories/${billing.body.data.id}`);
  check('the section was removed', removed.status === 204, `got ${removed.status}`);

  const survivor = await anonymous(`/public/kb/${propertyA.publicId}/articles/how-refunds-work`);
  check('the article is still published and readable', survivor.status === 200, `got ${survivor.status}`);
  check('it simply has no section any more', survivor.body.data.category === null);

  section('Views are counted for readers, not for authors');
  const beforeViews = await owner.call('GET', `/kb/articles/${article.body.data.id}`);
  await anonymous(`/public/kb/${propertyA.publicId}/articles/how-refunds-work`);
  const afterViews = await owner.call('GET', `/kb/articles/${article.body.data.id}`);
  check(
    'a public read increments the counter',
    afterViews.body.data.viewCount > beforeViews.body.data.viewCount,
    `${beforeViews.body.data.viewCount} -> ${afterViews.body.data.viewCount}`,
  );

  const authorViewsBefore = afterViews.body.data.viewCount;
  await owner.call('GET', `/kb/articles/${article.body.data.id}`);
  const authorViewsAfter = await owner.call('GET', `/kb/articles/${article.body.data.id}`);
  check(
    'an author opening their own article does not',
    authorViewsAfter.body.data.viewCount === authorViewsBefore,
    `${authorViewsBefore} -> ${authorViewsAfter.body.data.viewCount}`,
  );

  section('An article body is text, not markup');
  const hostile = await owner.call('POST', `/kb/${propertyA.id}/articles`, {
    title: HOSTILE_TITLE,
    body: HOSTILE_BODY,
    slug: 'escaping',
    status: 'published',
  });
  check('an article containing markup can be saved', hostile.status === 201, JSON.stringify(hostile.body?.error));
  check(
    'and it is stored exactly as written, not silently rewritten',
    hostile.body.data.body === HOSTILE_BODY,
  );

  const rendered = await fetch(`${WEB}/help/${propertyA.publicId}/escaping`).catch(() => null);
  if (!rendered || !rendered.ok) {
    check(
      'the rendered help-centre page was reachable',
      false,
      `web app answered ${rendered ? rendered.status : 'not at all'} at ${WEB}`,
    );
  } else {
    const html = await rendered.text();
    check('the rendered help-centre page was reachable', true);
    check(
      'the author\'s script tag arrives as text, not as a tag',
      html.includes('&lt;script&gt;') && !html.includes('<script>window.__pwned'),
    );
    check(
      'an event-handler attribute cannot be smuggled through a code span',
      !/<img[^>]*onerror/i.test(html),
    );
    check(
      'a javascript: link is not turned into a link',
      !/href="javascript:/i.test(html),
    );
    check(
      'while an ordinary link still works',
      html.includes('href="https://example.com/docs"'),
    );
    check(
      'and the title is escaped in the page as well',
      !html.includes('<script>alert(1)</script>'),
    );
  }

  section('A paused website closes its help centre');
  const paused = await owner.call('PATCH', `/properties/${propertyA.id}`, { status: 'paused' });
  check('the website was paused', paused.status === 200, `got ${paused.status}`);
  const whilePaused = await anonymous(`/public/kb/${propertyA.publicId}`);
  check(
    'and the public help centre goes with it',
    whilePaused.status === 404,
    `got ${whilePaused.status}`,
  );
  await owner.call('PATCH', `/properties/${propertyA.id}`, { status: 'active' });
  const resumed = await anonymous(`/public/kb/${propertyA.publicId}`);
  check('resuming brings it back', resumed.status === 200, `got ${resumed.status}`);

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
  process.stderr.write(`\nKnowledge base E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
