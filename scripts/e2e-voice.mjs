#!/usr/bin/env node
/**
 * Voice calls, end to end, against a live stack: the API, the realtime gateway, the worker, the
 * media server, the speech service and the voice agent.
 *
 * Nothing here is mocked except the language model (the local run points the brain at a stub
 * that answers in the contract's shape; on the server it is the real one). The visitor and the
 * answering agent are real media-room participants through the Node media SDK: the visitor
 * "speaks" by publishing synthesised speech, and what the AI says back is captured from its
 * audio track and transcribed by the speech service - so "the AI said it would hold on" is a
 * fact about audio, not about a log line.
 *
 *   node scripts/e2e-voice.mjs
 *
 * Environment: SMOKE_API_URL, SMOKE_REALTIME_URL, SPEECH_URL (default http://localhost:3010),
 * SUPERADMIN_EMAIL/PASSWORD for the plan upgrade.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');
const rtc = createRequire(new URL('../apps/voice/package.json', import.meta.url))(
  '@livekit/rtc-node',
);

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const REALTIME = process.env.SMOKE_REALTIME_URL ?? 'http://localhost:3002';
const SPEECH = process.env.SPEECH_URL ?? 'http://localhost:3010';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    if (this.cookies.size > 0)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
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

function connect(namespace, ticket) {
  return new Promise((resolve, reject) => {
    const socket = io(`${REALTIME}${namespace}`, {
      transports: ['websocket'],
      auth: { ticket },
      reconnection: false,
      timeout: 10_000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(new Error(`${namespace}: ${error.message}`)));
  });
}
function emit(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (transportError, ack) => {
      if (transportError) return reject(transportError);
      if (!ack?.success) return reject(new Error(ack?.error?.message ?? 'no ack'));
      return resolve(ack.data);
    });
  });
}
/** Every `call:updated` a socket sees, kept, so a state can be asserted after the fact. */
function recorder(socket) {
  const seen = [];
  const waiters = [];
  socket.on('call:updated', (payload) => {
    seen.push(payload.call);
    for (const waiter of [...waiters]) {
      if (waiter.matches(payload.call)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(payload.call);
      }
    }
  });
  return {
    seen,
    waitFor(matches, timeoutMs = 20_000, label = 'call state') {
      const already = seen.find(matches);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          if (waiters.includes(waiter)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(
              new Error(
                `timed out waiting for ${label}; last seen ${JSON.stringify(seen.at(-1) ?? null)}`,
              ),
            );
          }
        }, timeoutMs);
      });
    },
  };
}

// --- speech helpers ----------------------------------------------------------------------------

/** Synthesise an utterance for the fake visitor, as 24 kHz PCM, then resample to 48 kHz. */
async function synthesise(text, language) {
  const response = await fetch(`${SPEECH}/v1/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, language, sampleRate: 48000 }),
  });
  if (!response.ok) throw new Error(`tts failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

/** What the speech service hears in a buffer of 16 kHz PCM. */
async function transcribe(pcm16k, language = 'auto') {
  const wav = toWav(pcm16k, 16000);
  const response = await fetch(`${SPEECH}/v1/transcribe?language=${language}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
  });
  if (!response.ok) throw new Error(`transcribe failed: ${response.status}`);
  return response.json();
}

function toWav(samples, rate) {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]);
}

// --- a party in the media room ---------------------------------------------------------------

/**
 * A fake browser: joins the room with a grant, publishes a microphone that is silent until
 * `say` is called, and records everything the other side says at 16 kHz for transcription.
 */
class Party {
  constructor(label) {
    this.label = label;
    this.room = new rtc.Room();
    this.source = new rtc.AudioSource(48000, 1);
    this.heard = [];
    this.heardFrom = new Map();
    this.pumping = null;
    this.lastSpeechFrom = new Map();
    this.room.on(rtc.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind !== rtc.TrackKind.KIND_AUDIO) return;
      const stream = new rtc.AudioStream(track, { sampleRate: 16000, numChannels: 1 });
      const chunks = [];
      this.heardFrom.set(participant.identity, chunks);
      (async () => {
        for await (const frame of stream) {
          const samples = new Int16Array(frame.data);
          chunks.push(samples);
          // A track carries silence between words, so "still talking" is judged by loudness.
          if (loudness(samples) > 300) this.lastSpeechFrom.set(participant.identity, Date.now());
        }
      })().catch(() => undefined);
    });
  }
  async join(grant) {
    await this.room.connect(grant.url, grant.token, { autoSubscribe: true, dynacast: false });
    const track = rtc.LocalAudioTrack.createAudioTrack(`${this.label}-mic`, this.source);
    const options = new rtc.TrackPublishOptions();
    options.source = rtc.TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant.publishTrack(track, options);
    // Keep the microphone "open": one pump, 20 ms frames at 48 kHz, speech when there is some
    // queued and silence otherwise. One pump, because the source accepts one capture at a time.
    this.queue = [];
    this.silenceOn = true;
    this.pumping = (async () => {
      const silence = new Int16Array(960);
      while (this.silenceOn) {
        const frame = this.queue.length > 0 ? this.queue.shift() : silence;
        await this.source.captureFrame(new rtc.AudioFrame(frame, 48000, 1, 960));
        if (this.queue.length === 0 && this.spoken) {
          this.spoken();
          this.spoken = null;
        }
      }
    })();
  }
  /** Speak: queue the synthesised frames and resolve once the pump has sent the last of them. */
  async say(text, language) {
    const pcm = await synthesise(text, language);
    for (let offset = 0; offset < pcm.length; offset += 960) {
      const frame = new Int16Array(960);
      frame.set(pcm.subarray(offset, Math.min(offset + 960, pcm.length)));
      this.queue.push(frame);
    }
    await new Promise((resolve) => {
      this.spoken = resolve;
    });
  }
  /** Everything heard from a participant so far, as one 16 kHz buffer. */
  heardFromIdentity(prefix) {
    const chunks = [...this.heardFrom.entries()]
      .filter(([identity]) => identity.startsWith(prefix))
      .flatMap(([, list]) => list);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Int16Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
  /** When the other side last said something (0 when never). */
  lastSpeech(prefix) {
    return (
      [...this.lastSpeechFrom.entries()]
        .filter(([identity]) => identity.startsWith(prefix))
        .map(([, at]) => at)
        .sort()
        .at(-1) ?? 0
    );
  }
  /**
   * Wait for a reply: speech from the other side that starts after `since`, followed by
   * `quietMs` of quiet. Returns false when nothing was said within the timeout.
   */
  async waitForReply(prefix, since, quietMs = 1500, timeoutMs = 60_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const last = this.lastSpeech(prefix);
      if (last > since && Date.now() - last >= quietMs) return true;
      await sleep(200);
    }
    return false;
  }
  participants() {
    return [...this.room.remoteParticipants.values()].map((participant) => participant.identity);
  }
  async leave() {
    this.silenceOn = false;
    await this.pumping?.catch(() => undefined);
    await this.room.disconnect();
  }
}

/** The audio a party heard, trimmed to speech (the speech service ignores leading silence anyway). */
function loudness(pcm) {
  let sum = 0;
  for (const sample of pcm) sum += Math.abs(sample);
  return pcm.length ? sum / pcm.length : 0;
}

// --- the run -----------------------------------------------------------------------------------

async function main() {
  const stamp = Date.now();
  const owner = new Http();

  section('Setup');
  const registered = await owner.call('POST', '/auth/register', {
    name: 'Voice Owner',
    email: `voice.${stamp}@example.test`,
    password: 'Thursday-Lantern-Opal-77',
    accountName: `Voice ${stamp}`,
    timezone: 'UTC',
    locale: 'en',
    acceptTerms: true,
  });
  check(
    'account registered',
    registered.status === 201,
    `${registered.status} ${JSON.stringify(registered.body?.error ?? {})}`,
  );
  const account = await owner.call('GET', '/account');
  const accountId = account.body.data.account.id;

  const operator = new Http();
  const signedIn = await operator.call('POST', '/platform/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  check('operator signed in', signedIn.status === 200, `${signedIn.status}`);
  const upgraded = await operator.call('PUT', `/platform/accounts/${accountId}/plan`, {
    planKey: 'growth',
    note: 'voice suite fixture',
  });
  check(
    'account put on the growth plan (voice included)',
    upgraded.status === 200,
    `${upgraded.status} ${JSON.stringify(upgraded.body?.error ?? {})}`,
  );

  const created = await owner.call('POST', '/properties', {
    name: 'Voice Site',
    websiteUrl: `https://voice-${stamp}.example.com`,
    timezone: 'UTC',
    locale: 'en',
  });
  check('property created', created.status === 201, `${created.status}`);
  const property = created.body.data;

  const ai = await owner.call('PATCH', `/properties/${property.id}/ai`, {
    mode: 'ai',
    assistantName: 'Mira',
    keyFacts:
      'Opening hours: we are open every weekday from morning until evening. We are closed on Fridays.',
  });
  check(
    'AI assistant configured with key facts',
    ai.status === 200,
    `${ai.status} ${JSON.stringify(ai.body?.error ?? {})}`,
  );

  const voiceBefore = await owner.call('GET', `/properties/${property.id}/voice`);
  check(
    'voice settings readable, plan includes voice',
    voiceBefore.status === 200 &&
      voiceBefore.body.data.planIncludesVoice === true &&
      voiceBefore.body.data.available === true,
    JSON.stringify(voiceBefore.body?.data ?? voiceBefore.body),
  );
  const voice = await owner.call('PATCH', `/properties/${property.id}/voice`, {
    enabled: true,
    ringSeconds: 6,
    aiAnswers: true,
    defaultLanguage: 'en',
    voiceEn: 'en_piper',
    voiceBn: 'bn_bd',
  });
  check(
    'calling switched on for the website',
    voice.status === 200 && voice.body.data.enabled === true,
    `${voice.status} ${JSON.stringify(voice.body?.error ?? {})}`,
  );

  // The key facts are indexed by the worker; the brain needs a passage to cite.
  let indexed = false;
  for (let i = 0; i < 40 && !indexed; i += 1) {
    await sleep(500);
    const status = await owner.call('GET', `/properties/${property.id}/ai`);
    indexed =
      (status.body?.data?.knowledge?.chunks ?? 0) > 0 &&
      (status.body?.data?.knowledge?.pending ?? 1) === 0;
  }
  check('key facts indexed', indexed);

  // The owner is the one agent; they go online so the team can be rung.
  const online = await owner.call('PUT', '/team/availability', { availability: 'online' });
  check('owner available to answer', online.status === 200, `${online.status}`);

  const session = await widgetCall('POST', '/widget/session', {
    p: property.publicId,
    page: { url: `${ORIGIN}/`, title: 'Voice' },
    language: 'en-GB',
    timezone: 'UTC',
  });
  check(
    'visitor session created, calling offered',
    session.status === 200 && session.body.data.voice?.enabled === true,
    JSON.stringify(session.body?.data?.voice),
  );
  const visitorToken = session.body.data.token;
  await widgetCall(
    'POST',
    '/widget/identify',
    { name: 'Rahim', email: `rahim.${stamp}@example.test` },
    visitorToken,
  );

  const visitorTicket = await widgetCall('POST', '/widget/realtime-ticket', {}, visitorToken);
  const visitorSocket = await connect('/visitor', visitorTicket.body.data.ticket);
  const agentTicket = await owner.call('POST', '/realtime/ticket');
  const agentSocket = await connect('/agent', agentTicket.body.data.ticket);
  await emit(agentSocket, 'inbox:subscribe', { propertyIds: [property.id] });
  const visitorSeen = recorder(visitorSocket);
  const agentSeen = recorder(agentSocket);
  check('both sockets connected', visitorSocket.connected && agentSocket.connected);

  // -------------------------------------------------------------------------------------------
  section('A person answers, talks, transfers to the AI');
  const started = await widgetCall('POST', '/widget/calls', { language: 'en' }, visitorToken);
  check(
    'visitor started a call',
    started.status === 200 && started.body.data.call.status === 'ringing',
    `${started.status} ${JSON.stringify(started.body?.error ?? started.body?.data?.call?.status)}`,
  );
  const callA = started.body.data.call;
  check(
    'visitor received a room key',
    typeof started.body.data.join?.token === 'string' &&
      started.body.data.join.identity.startsWith('visitor:'),
  );

  const rang = await agentSeen.waitFor(
    (c) => c.id === callA.id && c.status === 'ringing',
    10_000,
    'the inbox to ring',
  );
  check(
    'the inbox rang with the visitor named',
    rang.visitor.name === 'Rahim' && rang.visitor.email === `rahim.${stamp}@example.test`,
    JSON.stringify(rang.visitor),
  );
  check(
    'the visitor was told it is ringing',
    (await visitorSeen.waitFor((c) => c.id === callA.id && c.status === 'ringing', 5_000))
      .status === 'ringing',
  );

  const visitorParty = new Party('visitor');
  await visitorParty.join(started.body.data.join);
  await widgetCall('POST', `/widget/calls/${callA.id}/joined`, {}, visitorToken);

  const answered = await owner.call('POST', `/calls/${callA.id}/answer`);
  check(
    'owner answered',
    answered.status === 200 &&
      answered.body.data.call.status === 'connecting' &&
      answered.body.data.call.answeredByMemberId,
    `${answered.status} ${JSON.stringify(answered.body?.error ?? {})}`,
  );
  const again = await owner.call('POST', `/calls/${callA.id}/answer`);
  check('a second answer is refused as taken', again.status === 409, `${again.status}`);

  const agentParty = new Party('agent');
  await agentParty.join(answered.body.data.join);
  await owner.call('POST', `/calls/${callA.id}/joined`);
  const active = await agentSeen.waitFor(
    (c) => c.id === callA.id && c.status === 'active',
    15_000,
    'the call to become active',
  );
  check(
    'call active once both are in the room',
    active.status === 'active' && active.answeredAt !== null,
  );

  await visitorParty.say('Hello, can you hear me?', 'en');
  await sleep(1500);
  check(
    'the agent hears the visitor',
    loudness(agentParty.heardFromIdentity('visitor:')) > 50,
    `loudness ${loudness(agentParty.heardFromIdentity('visitor:')).toFixed(1)}`,
  );

  const targets = await owner.call('GET', `/calls/${callA.id}/targets`);
  check(
    'transfer targets list the AI and no colleague',
    targets.status === 200 &&
      targets.body.data.ai === true &&
      targets.body.data.members.length === 0,
    JSON.stringify(targets.body?.data),
  );

  const transferred = await owner.call('POST', `/calls/${callA.id}/transfer`, { to: 'ai' });
  check(
    'transfer to the AI accepted',
    transferred.status === 200 &&
      transferred.body.data.handledByAi === true &&
      transferred.body.data.pending?.kind === 'ai',
    `${transferred.status} ${JSON.stringify(transferred.body?.error ?? transferred.body?.data)}`,
  );
  const aiActive = await visitorSeen.waitFor(
    (c) => c.id === callA.id && c.status === 'active' && c.handledByAi && c.pending === null,
    40_000,
    'the AI to take the call',
  );
  check('the AI is on the call and the person has left', aiActive.answeredByName === 'Mira');
  await sleep(1500);
  check(
    'the agent was removed from the room',
    !visitorParty.participants().some((identity) => identity.startsWith('member:')),
    JSON.stringify(visitorParty.participants()),
  );
  check(
    'the AI is in the room',
    visitorParty.participants().some((identity) => identity.startsWith('ai:')),
    JSON.stringify(visitorParty.participants()),
  );

  check('the AI spoke a greeting', await visitorParty.waitForReply('ai:', 0, 1500, 30_000));
  const greeting = await transcribe(visitorParty.heardFromIdentity('ai:'), 'en');
  check(
    'the AI greeted the visitor (heard and transcribed)',
    /mira|help|hello|voice site/i.test(greeting.text),
    JSON.stringify(greeting.text),
  );

  const heardBefore = visitorParty.heardFromIdentity('ai:').length;
  const askedAt = Date.now();
  await visitorParty.say('What are your opening hours?', 'en');
  // The brain is slowed to 2.5 s in the local run, so the hold-on line comes first; wait for the
  // whole reply, which is the hold-on, the answer, and silence after both.
  check('the AI replied', await visitorParty.waitForReply('ai:', askedAt, 4000, 60_000));
  const answerAudio = visitorParty.heardFromIdentity('ai:').subarray(heardBefore);
  const answer = await transcribe(answerAudio, 'en');
  check(
    'the AI answered the question from the key facts',
    /weekday|open|morning|evening/i.test(answer.text),
    JSON.stringify(answer.text),
  );
  check(
    'a hold-on line was spoken while the brain took its time',
    /hold on|let me check|thank you for waiting/i.test(answer.text),
    JSON.stringify(answer.text),
  );

  const transcript = await owner.call(
    'GET',
    `/conversations/${callA.conversationId}/messages?limit=50`,
  );
  const messages = transcript.body?.data ?? [];
  check(
    "the visitor's words are in the conversation, marked as spoken",
    messages.some(
      (m) =>
        m.senderType === 'visitor' && m.voice?.callId === callA.id && /opening hours/i.test(m.body),
    ),
    JSON.stringify(
      messages.map((m) => [m.senderType, m.body.slice(0, 40), m.voice?.callId ?? null]),
    ),
  );
  check(
    "the AI's answer is in the conversation, marked as spoken",
    messages.some(
      (m) => m.senderType === 'bot' && m.voice?.callId === callA.id && /weekday|open/i.test(m.body),
    ),
  );
  check(
    'the call milestones are in the conversation',
    messages.filter((m) => m.type === 'system' && m.event?.kind?.startsWith('call.')).length >= 3,
    JSON.stringify(messages.filter((m) => m.type === 'system').map((m) => m.event?.kind)),
  );

  const heardBeforeBye = visitorParty.heardFromIdentity('ai:').length;
  const byeAt = Date.now();
  await visitorParty.say('Thank you, that is all, goodbye.', 'en');
  check(
    'the AI replied to the goodbye',
    await visitorParty.waitForReply('ai:', byeAt, 1500, 60_000),
  );
  const endedA = await visitorSeen.waitFor(
    (c) => c.id === callA.id && c.status === 'ended',
    45_000,
    'the AI to say goodbye and hang up',
  );
  check(
    'the AI ended the call after the goodbye',
    endedA.endReason === 'ai_ended' && endedA.durationSeconds > 0,
    JSON.stringify({ reason: endedA.endReason, duration: endedA.durationSeconds }),
  );
  const bye = await transcribe(
    visitorParty.heardFromIdentity('ai:').subarray(heardBeforeBye),
    'en',
  );
  check(
    'a goodbye was spoken',
    /goodbye|great day|thank you|welcome/i.test(bye.text),
    JSON.stringify(bye.text),
  );
  await visitorParty.leave();
  await agentParty.leave();

  // -------------------------------------------------------------------------------------------
  section('Nobody answers: the AI picks up after the ring time, in Bengali');
  const startedB = await widgetCall('POST', '/widget/calls', { language: 'bn' }, visitorToken);
  check(
    'second call started',
    startedB.status === 200 && startedB.body.data.call.status === 'ringing',
    `${startedB.status} ${JSON.stringify(startedB.body?.error ?? {})}`,
  );
  const callB = startedB.body.data.call;
  const partyB = new Party('visitor');
  await partyB.join(startedB.body.data.join);
  await widgetCall('POST', `/widget/calls/${callB.id}/joined`, {}, visitorToken);
  const declined = await owner.call('POST', `/calls/${callB.id}/decline`);
  check(
    'the only agent declined, so the AI takes it at once',
    declined.status === 200 && declined.body.data.handledByAi === true,
    `${declined.status} ${JSON.stringify(declined.body?.data)}`,
  );
  const aiB = await visitorSeen.waitFor(
    (c) => c.id === callB.id && c.status === 'active' && c.handledByAi,
    40_000,
    'the AI to pick up',
  );
  check('AI on the second call', aiB.answeredByName === 'Mira');
  check(
    'the AI spoke a greeting on the second call',
    await partyB.waitForReply('ai:', 0, 1500, 30_000),
  );
  const greetingB = await transcribe(partyB.heardFromIdentity('ai:'), 'bn');
  check(
    'the AI greeted in Bengali',
    greetingB.language === 'bn' && greetingB.text.length > 5,
    JSON.stringify(greetingB),
  );

  const beforeQ = partyB.heardFromIdentity('ai:').length;
  const askedB = Date.now();
  await partyB.say('আপনারা কখন খোলা থাকেন?', 'bn');
  check(
    'the AI replied in the second call',
    await partyB.waitForReply('ai:', askedB, 2500, 60_000),
  );
  const answerB = await transcribe(partyB.heardFromIdentity('ai:').subarray(beforeQ), 'bn');
  check(
    'the AI answered in Bengali',
    answerB.language === 'bn' && answerB.text.length > 5,
    JSON.stringify(answerB),
  );
  const transcriptB = await owner.call(
    'GET',
    `/conversations/${callB.conversationId}/messages?limit=50`,
  );
  check(
    'the Bengali question is in the transcript',
    (transcriptB.body?.data ?? []).some(
      (m) => m.senderType === 'visitor' && m.voice?.callId === callB.id && /খোল/.test(m.body),
    ),
  );

  const hungUp = await widgetCall('POST', `/widget/calls/${callB.id}/end`, {}, visitorToken);
  check(
    'the visitor hung up',
    hungUp.status === 200 &&
      hungUp.body.data.status === 'ended' &&
      hungUp.body.data.endReason === 'visitor_left',
    JSON.stringify(hungUp.body?.data),
  );
  await partyB.leave();

  // -------------------------------------------------------------------------------------------
  section('The record');
  const list = await owner.call('GET', `/calls?propertyId=${property.id}&status=ended&limit=10`);
  check(
    'both calls are listed as ended with durations',
    list.status === 200 &&
      list.body.data.length >= 2 &&
      list.body.data.every((c) => c.durationSeconds > 0),
    JSON.stringify(list.body?.data?.map((c) => [c.status, c.durationSeconds, c.endReason])),
  );
  const usage = await owner.call('GET', `/properties/${property.id}/voice`);
  check(
    'minutes were counted',
    usage.body.data.usage.minutesUsed >= 2,
    JSON.stringify(usage.body?.data?.usage),
  );

  const missed = await owner.call('PUT', '/team/availability', { availability: 'offline' });
  const voiceOff = await owner.call('PATCH', `/properties/${property.id}/voice`, {
    aiAnswers: false,
  });
  check('AI answering switched off', missed.status === 200 && voiceOff.status === 200);
  const startedC = await widgetCall('POST', '/widget/calls', {}, visitorToken);
  check(
    'with nobody available and no AI, the call is missed on the spot',
    startedC.status === 200 &&
      startedC.body.data.call.status === 'ended' &&
      startedC.body.data.call.endReason === 'no_answer' &&
      startedC.body.data.join === null,
    JSON.stringify(startedC.body?.data?.call),
  );

  visitorSocket.disconnect();
  agentSocket.disconnect();
}

main()
  .then(() => {
    process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    process.stdout.write(
      `\nABORTED: ${error.stack ?? error}\n${passed} passed, ${failures.length} failed before the abort\n`,
    );
    process.exit(1);
  });
