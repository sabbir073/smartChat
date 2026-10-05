import WebSocket from 'ws';
import type { VoiceLanguage } from '@smartchat/types';
import { Emitter } from './emitter.js';

/**
 * The speech service, as the agent uses it: a socket that listens and a request that speaks.
 *
 * `infrastructure/speech/README.md` is the contract. Listening is one WebSocket per call leg:
 * a `start` frame, then raw PCM16 frames in, and JSON events out - when the caller starts and
 * stops talking, and what they said, in which language. Speaking is one HTTP request per
 * sentence that answers with PCM16 as it is rendered, so the first chunk is read long before
 * the last one exists. Nothing here knows about calls or rooms; the session wires the two
 * together.
 */

export type ListenEvent =
  | { type: 'speech_start'; t: number }
  | { type: 'speech_cancel'; t: number }
  | { type: 'speech_end'; t: number; durationMs: number }
  | {
      type: 'transcript';
      text: string;
      language: VoiceLanguage;
      languageConfidence: number;
      durationMs: number;
      /** From the service's `speech_end` to this frame: what the caller waited for the words. */
      latencyMs: number;
      model: string;
      cut: boolean;
    }
  | { type: 'error'; message: string };

export interface ListenOptions {
  /** The language assumed until the service hears otherwise. */
  sticky: VoiceLanguage;
  callId: string;
  sampleRate?: number;
  /** `auto` lets the service identify the language per utterance; `bn`/`en` forces one. */
  language?: 'auto' | VoiceLanguage;
  minSilenceMs?: number;
  minSpeechMs?: number;
  maxSpeechMs?: number;
  prefixPaddingMs?: number;
}

export interface TtsRequest {
  text: string;
  language: VoiceLanguage;
  voice: string;
  speakerId?: number;
  speed?: number;
  sampleRate?: number;
}

export interface TtsStream {
  /** Whether the service had every sentence of this exact request already rendered. */
  cache: 'hit' | 'miss' | null;
  sentences: number | null;
  sampleRate: number;
  /** PCM16LE mono at `sampleRate`, in whatever pieces the network delivers. */
  chunks: AsyncIterable<Uint8Array>;
}

export interface SpeechHealth {
  ok: boolean;
  status: number;
  body: unknown;
}

/** What the client needs from a WebSocket; `ws` provides it, a test provides a fake. */
export interface SocketLike {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'unexpected-response',
    listener: (request: unknown, response: { statusCode?: number | undefined }) => void,
  ): unknown;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  readonly readyState: number;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface SpeechLog {
  (event: string, detail: Record<string, unknown>): void;
}

export interface SpeechClientOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  createSocket?: SocketFactory;
  log?: SpeechLog;
  /** How a reconnect waits between attempts. Injected so a test does not. */
  sleep?: (ms: number) => Promise<void>;
  reconnect?: { attempts: number; delaysMs: number[] };
}

export class SpeechError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SpeechError';
  }
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT = { attempts: 5, delaysMs: [250, 500, 1_000, 2_000, 4_000] };
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const defaultSocket: SocketFactory = (url, headers) => new WebSocket(url, { headers });

export class SpeechClient {
  private readonly http: string;
  private readonly socket: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: SocketFactory;
  private readonly log: SpeechLog;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reconnect: { attempts: number; delaysMs: number[] };

  constructor(options: SpeechClientOptions) {
    this.http = options.url.replace(/\/+$/, '');
    this.socket = this.http.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    this.headers = options.token ? { authorization: `Bearer ${options.token}` } : {};
    this.fetchImpl = options.fetch ?? fetch;
    this.createSocket = options.createSocket ?? defaultSocket;
    this.log = options.log ?? (() => undefined);
    this.sleep = options.sleep ?? defaultSleep;
    this.reconnect = options.reconnect ?? DEFAULT_RECONNECT;
  }

  /** `/health` is open without the token; 503 means the models are still loading. */
  async health(timeoutMs = 5_000): Promise<SpeechHealth> {
    const response = await this.fetchImpl(`${this.http}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  }

  /**
   * Wait for the models to be loaded, trying every interval until the attempts run out.
   * Resolves to the last answer either way; the caller decides what a cold service means.
   */
  async waitUntilReady(options: { attempts: number; intervalMs: number }): Promise<SpeechHealth> {
    let last: SpeechHealth = { ok: false, status: 0, body: null };
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      try {
        last = await this.health();
        if (last.ok) return last;
      } catch (error) {
        last = {
          ok: false,
          status: 0,
          body: error instanceof Error ? error.message : String(error),
        };
      }
      if (attempt < options.attempts) await this.sleep(options.intervalMs);
    }
    return last;
  }

  /** Open a listening socket. Resolves once the service said `ready`. */
  async listen(options: ListenOptions): Promise<ListenSocket> {
    const socket = new ListenSocket({
      dial: () => this.createSocket(`${this.socket}/v1/listen`, this.headers),
      options,
      log: this.log,
      sleep: this.sleep,
      reconnect: this.reconnect,
    });
    await socket.open();
    return socket;
  }

  /**
   * Render one piece of text. The promise resolves when the headers are in, which is when the
   * service has planned the sentences; the audio follows on `chunks` as each is rendered.
   */
  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsStream> {
    const sampleRate = request.sampleRate ?? 24_000;
    const response = await this.fetchImpl(`${this.http}/v1/tts`, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: request.text,
        language: request.language,
        voice: request.voice,
        speakerId: request.speakerId ?? 0,
        speed: request.speed ?? 1.0,
        sampleRate,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new SpeechError(
        `tts failed: ${response.status} ${detail.slice(0, 200)}`.trim(),
        response.status,
      );
    }
    const cacheHeader = response.headers.get('x-cache');
    const sentencesHeader = response.headers.get('x-sentences');
    const rateHeader = response.headers.get('x-sample-rate');
    return {
      cache: cacheHeader === 'hit' || cacheHeader === 'miss' ? cacheHeader : null,
      sentences: sentencesHeader === null ? null : Number.parseInt(sentencesHeader, 10),
      sampleRate: rateHeader ? Number.parseInt(rateHeader, 10) || sampleRate : sampleRate,
      chunks: readBody(response.body),
    };
  }
}

/** The response body as it arrives. An absent body (an empty reply) is an empty stream. */
async function* readBody(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ListenSocketEvents extends Record<string, unknown> {
  event: ListenEvent;
  /** The socket dropped and came back; audio sent in between was lost. */
  reconnected: { attempt: number };
  /** The socket dropped and could not come back. The session has to end. */
  failed: Error;
  /** Closed for good, by us or by the service after `stop`. */
  closed: { code: number; reason: string };
}

/** What a session needs from a listening socket; `ListenSocket` is the real one. */
export interface ListenerLike {
  readonly events: Emitter<ListenSocketEvents>;
  readonly droppedFrames: number;
  send(pcm: Uint8Array): boolean;
  setLanguage(language: VoiceLanguage): void;
  close(): void;
}

interface ListenSocketDeps {
  dial: () => SocketLike;
  options: ListenOptions;
  log: SpeechLog;
  sleep: (ms: number) => Promise<void>;
  reconnect: { attempts: number; delaysMs: number[] };
}

/** WebSocket readyState values; the same numbers in `ws` and in the browser. */
const OPEN = 1;

/**
 * One `/v1/listen` session that survives a dropped connection.
 *
 * The service runs in its own container and a restart in the middle of a call is a real event.
 * When the socket closes without our `stop`, a new one is dialled with the same `start` (the
 * sticky language updated to whatever the session had switched to), a few times with growing
 * pauses. Audio sent in the gap is dropped and counted - a stale second of speech replayed late
 * would only confuse the endpointer - and an utterance cut by the drop is simply lost, which the
 * caller experiences as the assistant not having heard them, and says again.
 */
export class ListenSocket implements ListenerLike {
  readonly events = new Emitter<ListenSocketEvents>();
  private socket: SocketLike | null = null;
  private sticky: VoiceLanguage;
  private closing = false;
  private closed = false;
  private reconnecting = false;
  private dropped = 0;

  constructor(private readonly deps: ListenSocketDeps) {
    this.sticky = deps.options.sticky;
  }

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN && !this.closed;
  }

  get droppedFrames(): number {
    return this.dropped;
  }

  async open(): Promise<void> {
    this.socket = await this.dial();
  }

  /** PCM16LE at the session's sample rate. Returns false when the frame had to be dropped. */
  send(pcm: Uint8Array): boolean {
    if (!this.isOpen || !this.socket) {
      this.dropped += 1;
      return false;
    }
    try {
      this.socket.send(pcm);
      return true;
    } catch {
      this.dropped += 1;
      return false;
    }
  }

  /** Tell the service which language to assume from now on. Remembered for a reconnect. */
  setLanguage(language: VoiceLanguage): void {
    this.sticky = language;
    this.control({ type: 'set', language });
  }

  /** Flush what is still being heard and let the service close the socket. */
  async stop(timeoutMs = 3_000): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      this.finish(1000, 'stopped');
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, timeoutMs);
      const off = this.events.on('closed', () => {
        clearTimeout(timer);
        off();
        resolve();
      });
      this.control({ type: 'stop' });
    });
  }

  /** Drop the socket at once. For an ending that cannot wait. */
  close(): void {
    if (this.closed) return;
    this.closing = true;
    this.socket?.terminate();
    this.finish(1000, 'closed');
  }

  private control(message: Record<string, unknown>): void {
    if (!this.isOpen || !this.socket) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.deps.log('speech.listen.send_failed', { error: String(error) });
    }
  }

  private startMessage(): Record<string, unknown> {
    const { options } = this.deps;
    return {
      type: 'start',
      sampleRate: options.sampleRate ?? 16_000,
      language: options.language ?? 'auto',
      sticky: this.sticky,
      callId: options.callId,
      ...(options.minSilenceMs !== undefined ? { minSilenceMs: options.minSilenceMs } : {}),
      ...(options.minSpeechMs !== undefined ? { minSpeechMs: options.minSpeechMs } : {}),
      ...(options.maxSpeechMs !== undefined ? { maxSpeechMs: options.maxSpeechMs } : {}),
      ...(options.prefixPaddingMs !== undefined
        ? { prefixPaddingMs: options.prefixPaddingMs }
        : {}),
    };
  }

  /** One connection attempt: resolves with the socket once the service answered `ready`. */
  private dial(): Promise<SocketLike> {
    return new Promise<SocketLike>((resolve, reject) => {
      const socket = this.deps.dial();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new SpeechError('speech service did not answer the start message in time'));
      }, HANDSHAKE_TIMEOUT_MS);
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
      };

      socket.on('open', () => socket.send(JSON.stringify(this.startMessage())));
      socket.on('unexpected-response', (_request, response) => {
        const status = response.statusCode;
        settle(() =>
          reject(new SpeechError(`speech service refused the socket (${status ?? '?'})`, status)),
        );
        socket.terminate();
      });
      socket.on('error', (error) => {
        if (settled) this.deps.log('speech.listen.error', { error: error.message });
        else settle(() => reject(error));
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        const message = parseMessage(data);
        if (!message) return;
        if (!settled) {
          if (message.type === 'ready') settle(() => resolve(socket));
          else if (message.type === 'error') {
            settle(() => reject(new SpeechError(String(message['message'] ?? 'bad start'))));
          }
          return;
        }
        if (socket === this.socket) this.onMessage(message);
      });
      socket.on('close', (code, reason) => {
        settle(() => reject(new SpeechError(`speech socket closed before ready (${code})`)));
        if (socket === this.socket) this.onClose(code, String(reason ?? ''));
      });
    });
  }

  private onMessage(message: Record<string, unknown>): void {
    const event = toListenEvent(message);
    if (event) this.events.emit('event', event);
  }

  private onClose(code: number, reason: string): void {
    if (this.closed) return;
    if (this.closing) {
      this.finish(code, reason);
      return;
    }
    this.socket = null;
    void this.recover(code, reason);
  }

  private async recover(code: number, reason: string): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.deps.log('speech.listen.dropped', { code, reason });
    const { attempts, delaysMs } = this.deps.reconnect;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attempts && !this.closing; attempt += 1) {
      await this.deps.sleep(delaysMs[Math.min(attempt, delaysMs.length) - 1] ?? 1_000);
      if (this.closing) break;
      try {
        this.socket = await this.dial();
        this.reconnecting = false;
        this.deps.log('speech.listen.reconnected', { attempt, dropped: this.dropped });
        this.events.emit('reconnected', { attempt });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // The token is wrong: no number of retries will fix that.
        if (error instanceof SpeechError && error.status === 401) break;
        this.deps.log('speech.listen.reconnect_failed', { attempt, error: lastError.message });
      }
    }
    this.reconnecting = false;
    if (this.closing) {
      this.finish(code, reason);
      return;
    }
    this.finish(code, reason);
    this.events.emit('failed', lastError ?? new SpeechError('speech socket lost'));
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = null;
    this.events.emit('closed', { code, reason });
  }
}

function parseMessage(data: unknown): Record<string, unknown> | null {
  try {
    const text =
      typeof data === 'string'
        ? data
        : data instanceof Uint8Array
          ? Buffer.from(data).toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data as Uint8Array[]).toString('utf8')
            : String(data);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The JSON frames the service sends, narrowed; anything unknown is dropped on the floor. */
export function toListenEvent(message: Record<string, unknown>): ListenEvent | null {
  switch (message['type']) {
    case 'speech_start':
      return { type: 'speech_start', t: num(message['t']) };
    case 'speech_cancel':
      return { type: 'speech_cancel', t: num(message['t']) };
    case 'speech_end':
      return { type: 'speech_end', t: num(message['t']), durationMs: num(message['durationMs']) };
    case 'transcript': {
      const language = message['language'] === 'bn' ? 'bn' : 'en';
      return {
        type: 'transcript',
        text: typeof message['text'] === 'string' ? message['text'] : '',
        language,
        languageConfidence: num(message['languageConfidence'], 1),
        durationMs: num(message['durationMs']),
        latencyMs: num(message['latencyMs']),
        model: typeof message['model'] === 'string' ? message['model'] : '',
        cut: message['cut'] === true,
      };
    }
    case 'error':
      return { type: 'error', message: String(message['message'] ?? 'unknown error') };
    default:
      return null;
  }
}
