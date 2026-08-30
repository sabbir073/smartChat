#!/usr/bin/env node
/**
 * Phase 9: tickets, and the email that carries them.
 *
 * The exit criterion is "an offline message becomes a ticket and sends mail". Most of what is
 * below exists because the second half of that sentence is the dangerous half - this is the only
 * feature in the product that puts an agent's words in front of somebody outside the account, and
 * the failure that matters is not "the email did not arrive", it is "the wrong email arrived".
 *
 * So the claims under test are:
 *
 *   - a message left through the offline form becomes a ticket with a number a person can quote,
 *     and the person who left it is told so;
 *   - a public reply reaches them, with the words the agent actually wrote;
 *   - an internal note reaches nobody - asserted by counting what is in the mailbox before and
 *     after, not by trusting a flag;
 *   - ticket numbers are gapless and per-account, so #1 in one account is not #1 in another;
 *   - status timestamps record transitions rather than edits;
 *   - and a ticket is as tenant-scoped and property-scoped as everything else, with 404 rather
 *     than 403 for anything that is not yours.
 *
 *   node scripts/e2e-tickets.mjs
 *
 * Requires the stack up, including the worker and Mailpit.
 */
import { execFileSync } from 'node:child_process';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const MAILPIT = process.env.SMOKE_MAILPIT_URL ?? 'http://localhost:8025';
const ORIGIN = 'http://localhost:3004';

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

/** One value out of the database, for the claims that have no endpoint of their own. */
function sql(query) {
  try {
    return execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'smartchat', '-d', 'smartchat', '-tAc', query],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
      .toString()
      .trim();
  } catch {
    return null;
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

// --- Mailpit ------------------------------------------------------------------

async function inbox(email) {
  const response = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=50`,
  );
  if (!response.ok) return [];
  const found = await response.json();
  return found.messages ?? [];
}

/** Wait for the mailbox to reach a size. Sending is asynchronous; the assertion must not race it. */
async function waitForMail(email, atLeast, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const messages = await inbox(email);
    if (messages.length >= atLeast) return messages;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return inbox(email);
}

async function messageBody(id) {
  const detail = await fetch(`${MAILPIT}/api/v1/message/${id}`).then((r) => r.json());
  return `${detail.Text ?? ''}\n${detail.HTML ?? ''}`;
}

async function invitationTokenFor(email, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const messages = await inbox(email);
    if (messages[0]) {
      const text = await messageBody(messages[0].ID);
      const match = /accept-invitation\?token=([A-Za-z0-9._~%-]+)/.exec(text);
      if (match) return decodeURIComponent(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main() {
  resetRateLimits();
  const stamp = Date.now();
  const owner = new Http();

  section('Setup');
  const ownerEmail = `tickets.${stamp}@example.test`;
  const register = await owner.call('POST', '/auth/register', {
    name: 'Ticket Owner',
    email: ownerEmail,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Tickets ${stamp}`,
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

  section('An offline message becomes a ticket');
  const requester = `dana.${stamp}@example.test`;
  const session = await widgetCall('POST', '/widget/session', {
    p: propertyA.publicId,
    page: { url: `${ORIGIN}/`, title: 'Tickets E2E' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check('a visitor session was issued', session.status === 200, `got ${session.status}`);

  const left = await widgetCall(
    'POST',
    '/widget/offline-message',
    {
      values: {
        name: 'Dana Roy',
        email: requester,
        message: 'My invoice shows the wrong VAT rate.\nCan somebody check it?',
      },
    },
    session.body.data.token,
  );
  check('the offline message was accepted', left.status === 200, `got ${left.status}`);
  check(
    'and the visitor is told which ticket it became',
    typeof left.body.data.ticketNumber === 'number',
    JSON.stringify(left.body.data),
  );

  const listed = await owner.call('GET', '/tickets');
  check('the ticket is in the queue', listed.status === 200 && listed.body.data.length === 1, `got ${listed.status}`);
  const ticket = listed.body.data[0];
  check('the first ticket in an account is number 1', ticket?.number === 1, `${ticket?.number}`);
  check(
    'its subject is the first line of what the person wrote',
    ticket?.subject === 'My invoice shows the wrong VAT rate.',
    ticket?.subject,
  );
  check('the requester was captured', ticket?.requesterEmail === requester, ticket?.requesterEmail);
  check('it is open and unassigned', ticket?.status === 'open' && ticket?.assignedMemberId === null);
  check('and it remembers the chat it came from', ticket?.conversationId === left.body.data.conversationId);

  const thread = await owner.call('GET', `/tickets/${ticket.id}/messages`);
  check('the thread starts with what they wrote', thread.body.data?.[0]?.body.includes('wrong VAT rate'));
  check('attributed to them, not to us', thread.body.data?.[0]?.authorType === 'contact');

  section('...and sends mail');
  const receipt = await waitForMail(requester, 1);
  check('the requester was told we have it', receipt.length === 1, `${receipt.length} messages`);
  check(
    'the subject carries the number they can quote',
    receipt[0]?.Subject?.includes(`[#${ticket.number}]`),
    receipt[0]?.Subject,
  );
  const receiptBody = receipt[0] ? await messageBody(receipt[0].ID) : '';
  check('and their own words are quoted back', receiptBody.includes('wrong VAT rate'));
  check(
    'it is sent as the account, not as us',
    receiptBody.includes(`Tickets ${stamp}`),
    receiptBody.slice(0, 120),
  );
  check(
    'with no reply-to promise, because no support address is configured',
    receiptBody.includes('not monitored'),
  );

  const deliveries = sql(
    `SELECT status FROM email_deliveries WHERE ticket_id = '${ticket.id}' ORDER BY queued_at`,
  );
  check(
    'and the delivery was recorded as sent, not merely queued',
    deliveries === 'sent',
    `rows: ${deliveries}`,
  );

  section('A public reply reaches them');
  const reply = await owner.call('POST', `/tickets/${ticket.id}/messages`, {
    body: 'We have corrected the VAT rate and reissued the invoice. Sorry about that.',
    visibility: 'public',
  });
  check('the reply was accepted', reply.status === 201, JSON.stringify(reply.body?.error));

  const afterReply = await waitForMail(requester, 2);
  check('a second email arrived', afterReply.length === 2, `${afterReply.length} messages`);
  const replyBody = afterReply[0] ? await messageBody(afterReply[0].ID) : '';
  check('carrying the words the agent actually wrote', replyBody.includes('reissued the invoice'));

  const afterReplyTicket = await owner.call('GET', `/tickets/${ticket.id}`);
  check(
    'answering moves it to waiting-on-them',
    afterReplyTicket.body.data.status === 'pending',
    afterReplyTicket.body.data.status,
  );
  const firstResponseAt = afterReplyTicket.body.data.firstResponseAt;
  check('and the response clock started', typeof firstResponseAt === 'string', `${firstResponseAt}`);

  section('An internal note reaches nobody');
  const before = (await inbox(requester)).length;
  const note = await owner.call('POST', `/tickets/${ticket.id}/messages`, {
    body: 'Their account has been flagged twice for chargebacks. Do not offer a refund.',
    visibility: 'internal',
  });
  check('the note was saved', note.status === 201, JSON.stringify(note.body?.error));

  // Long enough that a queued email would have been delivered by now: the receipt and the reply
  // both arrived in well under this.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const after = (await inbox(requester)).length;
  check('nothing was sent', after === before, `${before} -> ${after}`);

  const everything = await inbox(requester);
  const bodies = await Promise.all(everything.map((message) => messageBody(message.ID)));
  check(
    'and the words of the note are in no mailbox anywhere',
    !bodies.some((body) => body.includes('chargebacks')),
  );

  const noteRow = sql(
    `SELECT count(*) FROM email_deliveries d JOIN ticket_messages m ON m.id = d.ticket_message_id ` +
    `WHERE m.visibility = 'internal'`,
  );
  check('no delivery was even created for an internal note', noteRow === '0', `rows: ${noteRow}`);

  const afterNote = await owner.call('GET', `/tickets/${ticket.id}`);
  check(
    'a note does not restart the response clock',
    afterNote.body.data.firstResponseAt === firstResponseAt,
  );
  check('and does not change the status', afterNote.body.data.status === 'pending');

  const thread2 = await owner.call('GET', `/tickets/${ticket.id}/messages`);
  check(
    'the note is visible to the team',
    thread2.body.data.some((entry) => entry.visibility === 'internal'),
  );

  section('A reply-to is only promised when there is a mailbox behind it');
  const supportAddress = `support.${stamp}@example.test`;
  const configured = await owner.call('PATCH', `/properties/${propertyA.id}`, {
    supportEmail: supportAddress,
  });
  check('a support address can be set', configured.status === 200, `got ${configured.status}`);
  check('and it is returned', configured.body.data.supportEmail === supportAddress);

  await owner.call('POST', `/tickets/${ticket.id}/messages`, {
    body: 'One more thing - your credit note is attached to the new invoice.',
    visibility: 'public',
  });
  const withReplyTo = await waitForMail(requester, 3);
  check('the follow-up arrived', withReplyTo.length === 3, `${withReplyTo.length}`);
  const followUpBody = withReplyTo[0] ? await messageBody(withReplyTo[0].ID) : '';
  check(
    'and now the footer names a real mailbox',
    followUpBody.includes(supportAddress) && !followUpBody.includes('not monitored'),
  );

  const badAddress = await owner.call('PATCH', `/properties/${propertyA.id}`, {
    supportEmail: 'not-an-address',
  });
  check('a support address that is not one is refused', badAddress.status === 422, `got ${badAddress.status}`);

  section('Status timestamps record transitions, not edits');
  const resolved = await owner.call('PATCH', `/tickets/${ticket.id}`, { status: 'resolved' });
  check('it can be resolved', resolved.status === 200 && resolved.body.data.status === 'resolved');
  const resolvedAt = resolved.body.data.resolvedAt;
  check('with a timestamp', typeof resolvedAt === 'string');

  const resolvedMail = await waitForMail(requester, 4);
  check('and the requester is told', resolvedMail.length === 4, `${resolvedMail.length}`);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const retagged = await owner.call('PATCH', `/tickets/${ticket.id}`, { tags: ['billing'] });
  check(
    'editing it later does not move the resolution date',
    retagged.body.data.resolvedAt === resolvedAt,
    `${retagged.body.data.resolvedAt} vs ${resolvedAt}`,
  );

  const reopened = await owner.call('PATCH', `/tickets/${ticket.id}`, { status: 'open' });
  check(
    'reopening clears it, because it is not resolved any more',
    reopened.body.data.resolvedAt === null,
    `${reopened.body.data.resolvedAt}`,
  );

  const closed = await owner.call('PATCH', `/tickets/${ticket.id}`, { status: 'closed' });
  check('it can be closed', closed.body.data.status === 'closed');
  const afterClose = await owner.call('POST', `/tickets/${ticket.id}/messages`, {
    body: 'Trying to reply to a closed ticket.',
    visibility: 'public',
  });
  check(
    'and a closed ticket refuses replies rather than silently accepting them',
    afterClose.status === 422,
    `got ${afterClose.status}`,
  );

  section('Numbers are per account, and gapless');
  const second = await owner.call('POST', '/tickets', {
    propertyId: propertyA.id,
    subject: 'Raised by an agent from a phone call',
    body: 'Customer called about delivery times.',
    requesterEmail: `caller.${stamp}@example.test`,
    requesterName: 'Sam Iyer',
    notifyRequester: false,
  });
  check('an agent can raise one', second.status === 201, JSON.stringify(second.body?.error));
  check('and it is number 2', second.body.data.number === 2, `${second.body.data.number}`);

  const silent = await inbox(`caller.${stamp}@example.test`);
  check('a ticket raised with notification off sends nothing', silent.length === 0, `${silent.length}`);

  const third = await owner.call('POST', '/tickets', {
    propertyId: propertyB.id,
    subject: 'A third one',
    body: 'Third.',
    requesterEmail: `third.${stamp}@example.test`,
    notifyRequester: false,
  });
  check('numbering keeps going across websites', third.body.data.number === 3, `${third.body.data.number}`);

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
  const otherSite = await stranger.call('POST', '/properties', {
    name: 'Elsewhere',
    websiteUrl: `https://elsewhere-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  const otherTicket = await stranger.call('POST', '/tickets', {
    propertyId: otherSite.body.data.id,
    subject: 'Somebody else entirely',
    body: 'Not yours.',
    requesterEmail: `elsewhere.${stamp}@example.test`,
    notifyRequester: false,
  });
  check(
    'another account starts its own numbering at 1',
    otherTicket.body.data.number === 1,
    `${otherTicket.body.data.number}`,
  );

  section('A ticket is as scoped as everything else');
  const crossTenant = await stranger.call('GET', `/tickets/${ticket.id}`);
  check(
    'a signed-in stranger gets 404 for an id they were told',
    crossTenant.status === 404,
    `got ${crossTenant.status}`,
  );

  const strangerList = await stranger.call('GET', '/tickets');
  check(
    "and their queue holds only their own",
    strangerList.body.data.length === 1,
    `${strangerList.body.data.length}`,
  );

  const agentEmail = `tagent.${stamp}@example.test`;
  const invite = await owner.call('POST', '/team/members', {
    email: agentEmail,
    baseRole: 'agent',
    restrictedToProperties: true,
    propertyIds: [propertyB.id],
  });
  check('an agent was invited, scoped to one website', invite.status === 201, `got ${invite.status}`);

  const token = await invitationTokenFor(agentEmail);
  const agent = new Http();
  const accepted = await agent.call('POST', '/auth/accept-invitation', {
    token,
    name: 'Scoped Agent',
    password: 'Tuesday-Anchor-Marble-77',
  });
  check('the invitation was accepted', accepted.status === 200, `got ${accepted.status}`);

  const agentQueue = await agent.call('GET', '/tickets');
  check('their queue holds only their website', agentQueue.body.data.length === 1, `${agentQueue.body.data.length}`);
  check('and it is the right one', agentQueue.body.data[0]?.number === 3);

  const agentReads = await agent.call('GET', `/tickets/${ticket.id}`);
  check(
    "a ticket on a website they do not work on is a 404, not a 403",
    agentReads.status === 404,
    `got ${agentReads.status}`,
  );

  const agentReplies = await agent.call('POST', `/tickets/${third.body.data.id}/messages`, {
    body: 'An agent trying to answer.',
    visibility: 'public',
  });
  check(
    'an agent can read tickets but not answer them',
    agentReplies.status === 403,
    `got ${agentReplies.status}`,
  );

  section('Assignment tells the person it is now theirs');
  const members = await owner.call('GET', '/account/members');
  const roster = members.body.data.members;
  const scoped = roster.find((entry) => entry.email === agentEmail);
  const assigned = await owner.call('PATCH', `/tickets/${third.body.data.id}`, {
    assignedMemberId: scoped.id,
  });
  check('the ticket was assigned', assigned.status === 200 && assigned.body.data.assignedMemberId === scoped.id);
  const agentMail = await waitForMail(agentEmail, 2);
  check('and the assignee was emailed', agentMail.length >= 2, `${agentMail.length}`);
  const assignmentBody = agentMail[0] ? await messageBody(agentMail[0].ID) : '';
  check(
    'the notification carries the subject but not the customer\'s message',
    assignmentBody.includes('A third one') && !assignmentBody.includes('Third.'),
  );

  const selfAssignBefore = (await inbox(ownerEmail)).length;
  const ownerMember = roster.find((entry) => entry.email === ownerEmail);
  await owner.call('PATCH', `/tickets/${second.body.data.id}`, {
    assignedMemberId: ownerMember.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const selfAssignAfter = (await inbox(ownerEmail)).length;
  check(
    'assigning work to yourself does not email you about it',
    selfAssignAfter === selfAssignBefore,
    `${selfAssignBefore} -> ${selfAssignAfter}`,
  );

  section('Finding one again');
  const byNumber = await owner.call('GET', '/tickets?search=%232');
  check('a ticket can be found by the number people quote', byNumber.body.data.length === 1, `${byNumber.body.data.length}`);
  check('and it is the right one', byNumber.body.data[0]?.number === 2);

  const bySubject = await owner.call('GET', '/tickets?search=phone%20call');
  check('or by a word in the subject', bySubject.body.data.some((entry) => entry.number === 2));

  const mine = await owner.call('GET', '/tickets?assigned=me');
  check('"assigned to me" resolves from the session, not the query', mine.body.data.length === 1, `${mine.body.data.length}`);

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
  process.stderr.write(`\nTicket E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
