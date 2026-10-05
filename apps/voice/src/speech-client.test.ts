import { describe, expect, it } from 'vitest';
import {
  SpeechClient,
  SpeechError,
  toListenEvent,
  type ListenEvent,
  type SocketLike,
} from './speech-client.js';

/**
 * The speech client against a fake service: the TTS reader against a fetch that streams what
 * it is told to, and the listening socket against a socket that answers the handshake, sends
 * events and drops the line when asked. The real service has its own tests; what is pinned
 * here is that this side reads the contract right and comes back from a dropped socket.
 */

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('synthesize', () => {
  it('posts the request with the token and yields the PCM chunks as they arrive', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), {
        status: 200,
        headers: {
          'content-type': 'audio/pcm',
          'x-cache': 'miss',
          'x-sentences': '2',
          'x-sample-rate': '24000',
        },
      });
    }) as typeof fetch;
    const client = new SpeechClient({
      url: 'http://speech:3010/',
      token: 's3cret',
      fetch: fetchImpl,
    });

    const stream = await client.synthesize({
      text: 'Hello there. Bye.',
      language: 'en',
      voice: 'en_female',
    });
    expect(stream).toMatchObject({ cache: 'miss', sentences: 2, sampleRate: 24_000 });
    const received: number[] = [];
    for await (const chunk of stream.chunks) received.push(...chunk);
    expect(received).toEqual([1, 2, 3, 4, 5]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://speech:3010/v1/tts');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer s3cret');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      text: 'Hello there. Bye.',
      language: 'en',
      voice: 'en_female',
      speakerId: 0,
      speed: 1,
      sampleRate: 24_000,
    });
  });

  it('reads an empty reply as no chunks and a cache hit as such', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 200,
        headers: { 'x-cache': 'hit', 'x-sentences': '0' },
      })) as typeof fetch;
    const client = new SpeechClient({ url: 'http://speech:3010', fetch: fetchImpl });
    const stream = await client.synthesize({
      text: '',
      language: 'bn',
      voice: 'bn_bd',
      speakerId: 3,
    });
    expect(stream.cache).toBe('hit');
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.chunks) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });

  it('turns a refusal into an error with the status', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"unauthorised"}', { status: 401 })) as typeof fetch;
    const client = new SpeechClient({ url: 'http://speech:3010', fetch: fetchImpl });
    await expect(
      client.synthesize({ text: 'x', language: 'en', voice: 'en_female' }),
    ).rejects.toMatchObject({
      name: 'SpeechError',
      status: 401,
    });
  });
});

describe('health', () => {
  it('reports loading as not ok with the body', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 'loading', missing: ['tts'] }), {
        status: 503,
      })) as typeof fetch;
    const client = new SpeechClient({ url: 'http://speech:3010', fetch: fetchImpl });
    expect(await client.health()).toEqual({
      ok: false,
      status: 503,
      body: { status: 'loading', missing: ['tts'] },
    });
  });

  it('waits until ready, sleeping between attempts', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as typeof fetch;
    const client = new SpeechClient({
      url: 'http://speech:3010',
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const health = await client.waitUntilReady({ attempts: 5, intervalMs: 50 });
    expect(health.ok).toBe(true);
    expect(sleeps).toEqual([50, 50]);
  });
});

/** A socket the test drives: it answers `start` with `ready` unless told to refuse. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();

  constructor(private readonly behaviour: { refuse?: number; silent?: boolean } = {}) {
    queueMicrotask(() => {
      if (this.behaviour.refuse !== undefined) {
        this.fire('unexpected-response', {}, { statusCode: this.behaviour.refuse });
        return;
      }
      this.readyState = 1;
      this.fire('open');
    });
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (typeof data === 'string' && !this.behaviour.silent) {
      const message = JSON.parse(data) as { type: string };
      if (message.type === 'start')
        queueMicrotask(() => this.fire('message', JSON.stringify({ type: 'ready' }), false));
      if (message.type === 'stop') queueMicrotask(() => this.drop(1000, 'stopped'));
    }
  }

  close(): void {
    this.drop(1000, 'closed');
  }

  terminate(): void {
    this.drop(1006, 'terminated');
  }

  /** The service sends a frame. */
  push(payload: Record<string, unknown>): void {
    this.fire('message', JSON.stringify(payload), false);
  }

  /** The line goes dead. */
  drop(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', code, Buffer.from(reason));
  }

  controls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item) as Record<string, unknown>);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: unknown[]) => void)(...args);
  }
}

describe('listen', () => {
  /**
   * Sockets are made when dialled, not before: a real socket only fires `open` after it exists,
   * and a fake made ahead of time would have fired it into the void.
   */
  function clientWith(plan: Array<ConstructorParameters<typeof FakeSocket>[0]>): {
    client: SpeechClient;
    dialled: string[];
    sockets: FakeSocket[];
  } {
    const dialled: string[] = [];
    const sockets: FakeSocket[] = [];
    const client = new SpeechClient({
      url: 'http://speech:3010',
      token: 't',
      createSocket: (url, headers) => {
        dialled.push(`${url} ${headers['authorization'] ?? ''}`.trim());
        const behaviour = plan.shift();
        if (!behaviour) throw new Error('no more sockets');
        const socket = new FakeSocket(behaviour);
        sockets.push(socket);
        return socket;
      },
      sleep: async () => undefined,
      reconnect: { attempts: 2, delaysMs: [1, 1] },
    });
    return { client, dialled, sockets };
  }

  it('sends start, waits for ready, forwards audio and events, and stops cleanly', async () => {
    const { client, dialled, sockets } = clientWith([{}]);
    const session = await client.listen({ sticky: 'bn', callId: 'call-1', minSilenceMs: 500 });
    const socket = sockets[0]!;
    expect(dialled).toEqual(['ws://speech:3010/v1/listen Bearer t']);
    expect(socket.controls()[0]).toEqual({
      type: 'start',
      sampleRate: 16_000,
      language: 'auto',
      sticky: 'bn',
      callId: 'call-1',
      minSilenceMs: 500,
    });

    const events: ListenEvent[] = [];
    session.events.on('event', (event) => events.push(event));
    expect(session.send(new Uint8Array([1, 2]))).toBe(true);
    expect(socket.sent[1]).toEqual(new Uint8Array([1, 2]));

    socket.push({ type: 'speech_start', t: 100 });
    socket.push({
      type: 'transcript',
      text: 'hello',
      language: 'en',
      languageConfidence: 0.9,
      durationMs: 800,
      latencyMs: 300,
      model: 'parakeet',
      t: 900,
      startMs: 100,
      cut: false,
    });
    socket.push({ type: 'unknown_thing' });
    expect(events).toEqual([
      { type: 'speech_start', t: 100 },
      {
        type: 'transcript',
        text: 'hello',
        language: 'en',
        languageConfidence: 0.9,
        durationMs: 800,
        latencyMs: 300,
        model: 'parakeet',
        cut: false,
      },
    ]);

    session.setLanguage('en');
    expect(socket.controls()[1]).toEqual({ type: 'set', language: 'en' });

    const closed: unknown[] = [];
    session.events.on('closed', (detail) => closed.push(detail));
    await session.stop();
    expect(socket.controls()[2]).toEqual({ type: 'stop' });
    expect(closed).toEqual([{ code: 1000, reason: 'stopped' }]);
    expect(session.isOpen).toBe(false);
    expect(session.send(new Uint8Array([3]))).toBe(false);
  });

  it('dials again when the line drops, with the current sticky language, and counts what was lost', async () => {
    const { client, dialled, sockets } = clientWith([{}, {}]);
    const session = await client.listen({ sticky: 'en', callId: 'call-2' });
    session.setLanguage('bn');

    const reconnected: unknown[] = [];
    const failed: unknown[] = [];
    session.events.on('reconnected', (detail) => reconnected.push(detail));
    session.events.on('failed', (error) => failed.push(error));

    sockets[0]!.drop(1006, 'gone');
    expect(session.send(new Uint8Array([9]))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(dialled).toHaveLength(2);
    expect(reconnected).toEqual([{ attempt: 1 }]);
    expect(failed).toEqual([]);
    const second = sockets[1]!;
    expect(second.controls()[0]).toMatchObject({ type: 'start', sticky: 'bn' });
    expect(session.isOpen).toBe(true);
    expect(session.droppedFrames).toBe(1);
    expect(session.send(new Uint8Array([10]))).toBe(true);
    expect(second.sent[1]).toEqual(new Uint8Array([10]));
  });

  it('gives up after the attempts run out and says so', async () => {
    const { client, sockets } = clientWith([{}, { refuse: 503 }, { refuse: 503 }]);
    const session = await client.listen({ sticky: 'en', callId: 'call-3' });
    const failed: Error[] = [];
    const closed: unknown[] = [];
    session.events.on('failed', (error) => failed.push(error));
    session.events.on('closed', (detail) => closed.push(detail));

    sockets[0]!.drop(1011, 'internal error');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(SpeechError);
    expect(closed).toEqual([{ code: 1011, reason: 'internal error' }]);
    expect(session.isOpen).toBe(false);
  });

  it('does not retry a refused token', async () => {
    const { client, dialled, sockets } = clientWith([{}, { refuse: 401 }, {}]);
    const session = await client.listen({ sticky: 'en', callId: 'call-4' });
    const failed: Error[] = [];
    session.events.on('failed', (error) => failed.push(error));
    sockets[0]!.drop(1006, 'gone');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(dialled).toHaveLength(2);
    expect(failed[0]).toMatchObject({ status: 401 });
  });

  it('fails the handshake when the service refuses the socket', async () => {
    const { client } = clientWith([{ refuse: 503 }]);
    await expect(client.listen({ sticky: 'en', callId: 'call-5' })).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('toListenEvent', () => {
  it('fills in what a frame leaves out and ignores what it does not know', () => {
    expect(toListenEvent({ type: 'speech_end', t: 5 })).toEqual({
      type: 'speech_end',
      t: 5,
      durationMs: 0,
    });
    expect(toListenEvent({ type: 'transcript' })).toEqual({
      type: 'transcript',
      text: '',
      language: 'en',
      languageConfidence: 1,
      durationMs: 0,
      latencyMs: 0,
      model: '',
      cut: false,
    });
    expect(toListenEvent({ type: 'error', message: 'bad' })).toEqual({
      type: 'error',
      message: 'bad',
    });
    expect(toListenEvent({ type: 'ready' })).toBeNull();
  });
});
