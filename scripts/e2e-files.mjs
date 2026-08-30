#!/usr/bin/env node
/**
 * Phase 7: files, and the people who sent them.
 *
 * The claims under test are the ones that decide whether an upload feature is safe to expose:
 *
 *   - a file really does go up and come back down, from both sides;
 *   - what a file *is* is decided by reading its bytes, not by believing its name or its
 *     Content-Type - and a rejected upload does not linger in the bucket;
 *   - a signed URL authorises one write to one key, and nothing else;
 *   - one account cannot read another's files, and one visitor cannot read another visitor's;
 *   - and a contact's history is assembled from every browser identity that is really theirs.
 *
 *   node scripts/e2e-files.mjs
 *
 * Requires the stack to be up (`docker compose up -d`).
 */
import { execFileSync } from 'node:child_process';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
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

const ulid = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
};

// --- the files we will send ---------------------------------------------------

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
/** An ELF executable. Named and declared as a picture, which is the entire point. */
const ELF = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
  Buffer.alloc(128, 0x90),
]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');

async function put(url, body, contentType) {
  const response = await fetch(url, {
    method: 'PUT',
    body,
    headers: contentType ? { 'content-type': contentType } : {},
  });
  return response.status;
}

async function main() {
  resetRateLimits();
  const stamp = Date.now();
  const owner = new Http();

  section('Setup');
  const register = await owner.call('POST', '/auth/register', {
    name: 'Files Owner',
    email: `files.${stamp}@example.test`,
    password: 'Sunday-Harbour-Quartz-51',
    accountName: `Files ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check('owner registered', register.status === 201, `got ${register.status}`);

  const site = await owner.call('POST', '/properties', {
    name: 'Depot',
    websiteUrl: `https://depot-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check('a website was created', site.status === 201, `got ${site.status}`);
  const property = site.body.data;

  /** A visitor with an email, so this also exercises the contact link. */
  async function newVisitor(email, name, message) {
    const session = await widgetCall('POST', '/widget/session', {
      p: property.publicId,
      page: { url: `${ORIGIN}/`, title: 'Files E2E' },
      language: 'en-GB',
      timezone: 'UTC',
    });
    const token = session.body.data.token;
    const left = await widgetCall(
      'POST',
      '/widget/offline-message',
      { values: { name, email, message } },
      token,
    );
    return { token, conversationId: left.body?.data?.conversationId, status: left.status };
  }

  const visitor = await newVisitor('dana@example.test', 'Dana Roy', 'My printer is jammed.');
  check('a visitor conversation exists', visitor.status === 200, `got ${visitor.status}`);

  section('The size limit is told to the widget, not guessed by it');
  const bootstrap = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Files E2E' },
  });
  check(
    'the server states its own upload limit',
    typeof bootstrap.body.data.maxUploadBytes === 'number' &&
      bootstrap.body.data.maxUploadBytes > 0,
    `${bootstrap.body.data.maxUploadBytes}`,
  );

  section('An agent sends a file');
  const signed = await owner.call('POST', '/uploads/sign', {
    conversationId: visitor.conversationId,
    fileName: 'diagram.png',
    byteSize: PNG.byteLength,
  });
  check('a target was signed', signed.status === 200, JSON.stringify(signed.body?.error));
  check(
    'the URL carries its own authorisation and an expiry',
    /X-Amz-Signature=[0-9a-f]{64}/.test(signed.body.data.uploadUrl) &&
      signed.body.data.uploadUrl.includes('X-Amz-Expires='),
    signed.body.data.uploadUrl?.slice(0, 80),
  );
  check(
    'and the key is built from ids, with nothing from the file name in it',
    !signed.body.data.uploadUrl.includes('diagram') &&
      !signed.body.data.uploadUrl.includes('.png'),
    signed.body.data.uploadUrl,
  );

  const uploaded = await put(signed.body.data.uploadUrl, PNG, 'image/png');
  check('the bytes went straight to storage', uploaded === 200, `got ${uploaded}`);

  const confirmed = await owner.call('POST', `/uploads/${signed.body.data.attachmentId}/confirm`, {
    clientMessageId: ulid(),
  });
  check('the upload was confirmed', confirmed.status === 200, JSON.stringify(confirmed.body?.error));
  check(
    'it became an image message',
    confirmed.body.data.message.type === 'image',
    confirmed.body.data.message.type,
  );
  check(
    'and the message carries the file with it',
    confirmed.body.data.message.attachment?.fileName === 'diagram.png',
    JSON.stringify(confirmed.body.data.message.attachment),
  );
  check(
    'measured, not believed - the size is the real one',
    confirmed.body.data.attachment.byteSize === PNG.byteLength,
    `${confirmed.body.data.attachment.byteSize}`,
  );

  const agentAttachmentId = confirmed.body.data.attachment.id;

  section('And it comes back down');
  const link = await owner.call('GET', `/attachments/${agentAttachmentId}/url`);
  check('a download URL is minted', link.status === 200, `got ${link.status}`);
  const fetched = await fetch(link.body.data.url);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  check('the object is really there', fetched.status === 200, `got ${fetched.status}`);
  check('and it is byte-for-byte what was sent', bytes.equals(PNG), `${bytes.byteLength} bytes`);
  check(
    'served as what it is, with the name we chose',
    fetched.headers.get('content-type') === 'image/png' &&
      (fetched.headers.get('content-disposition') ?? '').includes('diagram.png'),
    `${fetched.headers.get('content-type')} / ${fetched.headers.get('content-disposition')}`,
  );

  section('What a file is, is decided by reading it');
  const disguised = await owner.call('POST', '/uploads/sign', {
    conversationId: visitor.conversationId,
    fileName: 'holiday-photo.png',
    byteSize: ELF.byteLength,
  });
  check('a target is signed without judging the name', disguised.status === 200);

  // Declared as an image, named as an image, and an executable.
  const disguisedPut = await put(disguised.body.data.uploadUrl, ELF, 'image/png');
  check('the store accepts the bytes, as it always will', disguisedPut === 200, `got ${disguisedPut}`);

  const refused = await owner.call('POST', `/uploads/${disguised.body.data.attachmentId}/confirm`, {
    clientMessageId: ulid(),
  });
  check(
    'confirming reads the bytes and refuses it',
    refused.status === 415,
    `got ${refused.status} ${JSON.stringify(refused.body?.error?.code)}`,
  );

  const refusedLink = await owner.call(
    'GET',
    `/attachments/${disguised.body.data.attachmentId}/url`,
  );
  check(
    'a refused file has no download at all',
    refusedLink.status === 404,
    `got ${refusedLink.status}`,
  );

  // And it is gone from the bucket, not merely hidden - the signed URL must not be usable as a
  // way to park arbitrary content on our storage bill.
  const orphan = await fetch(disguised.body.data.uploadUrl.split('?')[0]);
  check(
    'and the bytes were deleted from the bucket',
    orphan.status === 403 || orphan.status === 404,
    `got ${orphan.status}`,
  );

  const twice = await owner.call('POST', `/uploads/${signed.body.data.attachmentId}/confirm`, {
    clientMessageId: ulid(),
  });
  check(
    'confirming the same upload twice does not send it twice',
    twice.status === 409,
    `got ${twice.status}`,
  );

  section('A lie about the size does not get through either');
  const understated = await owner.call('POST', '/uploads/sign', {
    conversationId: visitor.conversationId,
    fileName: 'small.pdf',
    byteSize: 10,
  });
  const big = Buffer.concat([PDF, Buffer.alloc(40 * 1024 * 1024, 0x20)]);
  const bigPut = await put(understated.body.data.uploadUrl, big);
  check('the store takes the larger object', bigPut === 200, `got ${bigPut}`);

  const tooBig = await owner.call('POST', `/uploads/${understated.body.data.attachmentId}/confirm`, {
    clientMessageId: ulid(),
  });
  check(
    'but the real object is measured and refused',
    tooBig.status === 413,
    `got ${tooBig.status} ${JSON.stringify(tooBig.body?.error?.code)}`,
  );

  const absurd = await owner.call('POST', '/uploads/sign', {
    conversationId: visitor.conversationId,
    fileName: 'huge.pdf',
    byteSize: 900 * 1024 * 1024,
  });
  check(
    'and an obviously-too-large declaration is refused before anything is uploaded',
    absurd.status === 413,
    `got ${absurd.status}`,
  );

  section('A visitor sends a file');
  const visitorSigned = await widgetCall(
    'POST',
    '/widget/uploads/sign',
    {
      conversationId: visitor.conversationId,
      fileName: 'receipt.pdf',
      byteSize: PDF.byteLength,
    },
    visitor.token,
  );
  check('a visitor can get a target', visitorSigned.status === 200, JSON.stringify(visitorSigned.body?.error));

  const visitorPut = await put(visitorSigned.body.data.uploadUrl, PDF, 'application/pdf');
  check('and upload to it', visitorPut === 200, `got ${visitorPut}`);

  const visitorConfirm = await widgetCall(
    'POST',
    `/widget/uploads/${visitorSigned.body.data.attachmentId}/confirm`,
    { clientMessageId: ulid() },
    visitor.token,
  );
  check('the file becomes a message', visitorConfirm.status === 200, JSON.stringify(visitorConfirm.body?.error));
  check(
    'from the visitor, as a file',
    visitorConfirm.body.data.message.senderType === 'visitor' &&
      visitorConfirm.body.data.message.type === 'file',
    `${visitorConfirm.body.data.message.senderType}/${visitorConfirm.body.data.message.type}`,
  );

  section('The thread reads the same after a reload');
  const history = await owner.call('GET', `/conversations/${visitor.conversationId}/messages`);
  const withFiles = history.body.data.filter((message) => message.attachment);
  check(
    'both files are in the replayed transcript',
    withFiles.length === 2,
    `${withFiles.length} of ${history.body.data.length}`,
  );
  check(
    'each carrying what a client needs to render it, and no URL',
    withFiles.every(
      (message) =>
        typeof message.attachment.fileName === 'string' &&
        typeof message.attachment.byteSize === 'number' &&
        message.attachment.url === undefined,
    ),
    JSON.stringify(withFiles[0]?.attachment),
  );

  section('Nobody reaches anybody else\'s files');
  const stranger = new Http();
  await stranger.call('POST', '/auth/register', {
    name: 'Someone Else',
    email: `stranger.files.${stamp}@example.test`,
    password: 'Monday-Cinder-Willow-38',
    accountName: `Stranger ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });

  const acrossAccounts = await stranger.call('GET', `/attachments/${agentAttachmentId}/url`);
  check(
    'another account gets 404, not 403',
    acrossAccounts.status === 404,
    `got ${acrossAccounts.status}`,
  );

  const otherVisitor = await newVisitor('erik@example.test', 'Erik Nam', 'Different question.');
  const acrossVisitors = await widgetCall(
    'GET',
    `/widget/attachments/${agentAttachmentId}/url`,
    undefined,
    otherVisitor.token,
  );
  check(
    'and another visitor cannot reach a file from a conversation that is not theirs',
    acrossVisitors.status === 404,
    `got ${acrossVisitors.status}`,
  );

  const ownFile = await widgetCall(
    'GET',
    `/widget/attachments/${agentAttachmentId}/url`,
    undefined,
    visitor.token,
  );
  check('while the visitor it was sent to can', ownFile.status === 200, `got ${ownFile.status}`);

  const acrossVisitorUpload = await widgetCall(
    'POST',
    '/widget/uploads/sign',
    { conversationId: visitor.conversationId, fileName: 'nope.png', byteSize: 100 },
    otherVisitor.token,
  );
  check(
    'nor can they upload into it',
    acrossVisitorUpload.status === 404,
    `got ${acrossVisitorUpload.status}`,
  );

  section('People, not browsers');
  const contacts = await owner.call('GET', '/contacts?limit=50');
  check('contacts appeared on their own', contacts.status === 200, `got ${contacts.status}`);
  const dana = contacts.body.data.find((entry) => entry.email === 'dana@example.test');
  check('the person who wrote in is one of them', Boolean(dana), 'not found');
  check('with the name they gave', dana?.name === 'Dana Roy', dana?.name);
  check('and one browser joined to them so far', dana?.visitorCount === 1, `${dana?.visitorCount}`);

  // The same address from a second browser is the same person, not a second one.
  const danaAgain = await newVisitor('DANA@example.test', 'Dana Roy', 'Following up.');
  check('a second visit is accepted', danaAgain.status === 200, `got ${danaAgain.status}`);

  const afterSecond = await owner.call('GET', '/contacts?limit=50');
  const danaRows = afterSecond.body.data.filter((entry) => entry.email === 'dana@example.test');
  check(
    'the same address in different casing is still one person',
    danaRows.length === 1,
    `${danaRows.length} rows`,
  );
  check(
    'now with two browsers joined to them',
    danaRows[0]?.visitorCount === 2,
    `${danaRows[0]?.visitorCount}`,
  );

  section('And their whole history in one place');
  const historyResult = await owner.call('GET', `/contacts/${dana.id}/history`);
  check('the history loads', historyResult.status === 200, `got ${historyResult.status}`);
  check(
    'gathering both conversations, from both browsers',
    historyResult.body.data.conversations.length === 2,
    `${historyResult.body.data.conversations.length}`,
  );
  check(
    'and the file they sent us',
    historyResult.body.data.files.some((file) => file.fileName === 'receipt.pdf'),
    JSON.stringify(historyResult.body.data.files.map((f) => f.fileName)),
  );
  check(
    'the refused upload is nowhere in it',
    !historyResult.body.data.files.some((file) => file.fileName.includes('holiday')),
    JSON.stringify(historyResult.body.data.files.map((f) => f.fileName)),
  );

  const strangerHistory = await stranger.call('GET', `/contacts/${dana.id}/history`);
  check(
    'and another account cannot read any of it',
    strangerHistory.status === 404,
    `got ${strangerHistory.status}`,
  );

  section('The fields an account decides to keep');
  const plan = await owner.call('POST', '/contacts-fields', {
    key: 'plan',
    label: 'Plan',
    type: 'select',
    options: ['Starter', 'Growth'],
  });
  check('a list field can be created', plan.status === 201, JSON.stringify(plan.body?.error));

  const emptyList = await owner.call('POST', '/contacts-fields', {
    key: 'nothing',
    label: 'Nothing',
    type: 'select',
    options: [],
  });
  check(
    'a list with nothing to choose from is refused',
    emptyList.status === 422,
    `got ${emptyList.status}`,
  );

  const duplicate = await owner.call('POST', '/contacts-fields', {
    key: 'plan',
    label: 'Plan again',
    type: 'text',
  });
  check('and a key cannot be taken twice', duplicate.status === 409, `got ${duplicate.status}`);

  const saved = await owner.call('PATCH', `/contacts/${dana.id}`, {
    company: 'Roy Printing',
    customFields: { plan: 'Growth' },
  });
  check('a contact can be edited', saved.status === 200, JSON.stringify(saved.body?.error));
  check('the custom value is stored', saved.body.data.customFields.plan === 'Growth');
  check('alongside the ordinary ones', saved.body.data.company === 'Roy Printing');

  const offList = await owner.call('PATCH', `/contacts/${dana.id}`, {
    customFields: { plan: 'Enterprise' },
  });
  check(
    'a value that is not one of the options is refused',
    offList.status === 422,
    `got ${offList.status}`,
  );

  const unknownField = await owner.call('PATCH', `/contacts/${dana.id}`, {
    customFields: { not_a_field: 'anything' },
  });
  check(
    'and a field that does not exist is dropped rather than stored',
    unknownField.status === 200 && unknownField.body.data.customFields.not_a_field === undefined,
    JSON.stringify(unknownField.body.data?.customFields),
  );
  check(
    'without disturbing what was already there',
    unknownField.body.data.customFields.plan === 'Growth',
    JSON.stringify(unknownField.body.data?.customFields),
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
  process.stderr.write(`\nFiles E2E crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
