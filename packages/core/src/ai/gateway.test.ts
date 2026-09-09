import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@smartchat/types';
import { AiGateway } from './gateway.js';
import type { OllamaProvider } from './ollama.js';
import { AiProviderError, AiTimeoutError, type ChatProvider, type ChatRequest, type ChatResult } from './provider.js';

const request = { messages: [{ role: 'user' as const, content: 'hi' }], schema: {}, maxTokens: 10, temperature: 0 };

function result(model: string): ChatResult {
  return { content: '{}', model, promptTokens: 1, completionTokens: 1 };
}

function fakeLocal(chat: (r: ChatRequest) => Promise<ChatResult>): OllamaProvider {
  return { kind: 'local', model: 'qwen', chat } as unknown as OllamaProvider;
}

function fakeFallback(chat: (r: ChatRequest) => Promise<ChatResult> = async () => result('gpt')): ChatProvider {
  return { kind: 'openai', model: 'gpt', chat };
}

function clockAt(start = 0) {
  let now = start;
  return {
    now: () => new Date(now),
    timestamp: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function gateway(overrides: Partial<ConstructorParameters<typeof AiGateway>[0]>) {
  return new AiGateway({
    local: null,
    fallback: async () => null,
    config: async () => ({ localTimeoutMs: 1_000, routing: 'local_first' }),
    ...overrides,
  });
}

describe('AiGateway', () => {
  it('answers locally when the local model works', async () => {
    const g = gateway({ local: fakeLocal(async () => result('qwen')), fallback: async () => fakeFallback() });
    const outcome = await g.complete(request);
    expect(outcome).toMatchObject({ provider: 'local', fellBack: false });
  });

  /**
   * The operator's rule: local first, hosted only when local cannot. A timeout is the case that
   * matters most on a CPU box, and the visitor must not pay for it twice.
   */
  it('falls back on a local failure or timeout and says why', async () => {
    const local = fakeLocal(async () => {
      throw new AiTimeoutError('local', 1_000);
    });
    const g = gateway({ local, fallback: async () => fakeFallback() });
    const outcome = await g.complete(request);
    expect(outcome).toMatchObject({ provider: 'openai', fellBack: true });
    expect(outcome.fallbackReason).toContain('local failed');
  });

  it('surfaces the local failure when there is no fallback', async () => {
    const local = fakeLocal(async () => {
      throw new AiProviderError('local', 'HTTP 500');
    });
    const g = gateway({ local });
    await expect(g.complete(request)).rejects.toBeInstanceOf(AiProviderError);
  });

  it('opens the breaker after repeated failures and closes it later', async () => {
    const clock = clockAt();
    let calls = 0;
    const local = fakeLocal(async () => {
      calls += 1;
      throw new AiProviderError('local', 'down');
    });
    const g = gateway({
      local,
      fallback: async () => fakeFallback(),
      breakerThreshold: 2,
      breakerOpenMs: 10_000,
      clock,
    });
    await g.complete(request);
    await g.complete(request);
    expect(g.breakerState().open).toBe(true);
    // Open: the local model is not even asked.
    await g.complete(request);
    expect(calls).toBe(2);
    expect((await g.complete(request)).fallbackReason).toBe('local breaker open');
    clock.advance(10_001);
    await g.complete(request);
    expect(calls).toBe(3);
  });

  it('overflows to the fallback when the local model is busy', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = fakeLocal(async () => {
      await gate;
      return result('qwen');
    });
    const g = gateway({ local, fallback: async () => fakeFallback(), localParallel: 1 });
    const first = g.complete(request);
    const second = await g.complete(request);
    expect(second).toMatchObject({ provider: 'openai', fellBack: true });
    expect(second.fallbackReason).toContain('busy');
    release();
    expect((await first).provider).toBe('local');
  });

  it('waits for the local model when busy and there is no fallback', async () => {
    let inFlight = 0;
    const local = fakeLocal(async () => {
      inFlight += 1;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return result('qwen');
    });
    const g = gateway({ local, localParallel: 1 });
    const outcomes = await Promise.all([g.complete(request), g.complete(request)]);
    expect(outcomes.every((o) => o.provider === 'local')).toBe(true);
    expect(inFlight).toBe(0);
  });

  it('honours fallback-only routing', async () => {
    const localChat = vi.fn(async () => result('qwen'));
    const g = gateway({
      local: fakeLocal(localChat),
      fallback: async () => fakeFallback(),
      config: async () => ({ localTimeoutMs: 1_000, routing: 'fallback_only' }),
    });
    expect((await g.complete(request)).provider).toBe('openai');
    expect(localChat).not.toHaveBeenCalled();
  });

  it('reports AI_UNAVAILABLE when nothing is configured', async () => {
    const g = gateway({});
    await expect(g.complete(request)).rejects.toMatchObject({ code: ErrorCode.AI_UNAVAILABLE });
  });
});

/**
 * Bring your own key: the account's provider replaces the platform fallback, and with
 * `own_only` replaces the local model too. Accounts without a key see no difference.
 */
describe('AiGateway with an account route', () => {
  const own: ChatProvider = { kind: 'anthropic', model: 'claude', chat: async () => result('claude') };

  it('uses the account provider instead of the platform fallback when local fails', async () => {
    const local = fakeLocal(async () => {
      throw new AiProviderError('local', 'down');
    });
    const g = gateway({
      local,
      fallback: async () => fakeFallback(),
      accountRoute: async (accountId) => (accountId === 'acc-own' ? { provider: own, routing: 'local_first' } : null),
    });
    expect(await g.complete(request, { accountId: 'acc-own' })).toMatchObject({ provider: 'anthropic', fellBack: true });
    expect(await g.complete(request, { accountId: 'acc-other' })).toMatchObject({ provider: 'openai', fellBack: true });
    expect(await g.complete(request)).toMatchObject({ provider: 'openai', fellBack: true });
  });

  it('keeps local first for the account by default, and skips it with own_only', async () => {
    const localChat = vi.fn(async () => result('qwen'));
    const g = gateway({
      local: fakeLocal(localChat),
      accountRoute: async (accountId) => ({ provider: own, routing: accountId === 'acc-only' ? 'own_only' : 'local_first' }),
    });
    expect(await g.complete(request, { accountId: 'acc-first' })).toMatchObject({ provider: 'local', fellBack: false });
    expect(localChat).toHaveBeenCalledTimes(1);
    const only = await g.complete(request, { accountId: 'acc-only' });
    expect(only).toMatchObject({ provider: 'anthropic', fellBack: true });
    expect(only.fallbackReason).toContain('own_only');
    expect(localChat).toHaveBeenCalledTimes(1);
  });
});

