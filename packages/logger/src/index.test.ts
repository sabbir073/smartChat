import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACT_PATHS, addLogContext, getLogContext, withLogContext } from './index.js';

function capture(): { stream: Writable; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)));
      cb();
    },
  });
  return { stream, lines };
}

describe('log context', () => {
  it('is empty outside a scope', () => {
    expect(getLogContext()).toEqual({});
  });

  it('propagates through async boundaries', async () => {
    await withLogContext({ requestId: 'req-1', accountId: 'acc-1' }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(getLogContext()).toMatchObject({ requestId: 'req-1', accountId: 'acc-1' });
    });
    expect(getLogContext()).toEqual({});
  });

  it('merges nested scopes without leaking outward', () => {
    withLogContext({ requestId: 'req-1' }, () => {
      withLogContext({ conversationId: 'conv-9' }, () => {
        expect(getLogContext()).toEqual({ requestId: 'req-1', conversationId: 'conv-9' });
      });
      expect(getLogContext()).toEqual({ requestId: 'req-1' });
    });
  });

  it('supports adding fields to the current scope', () => {
    withLogContext({ requestId: 'req-2' }, () => {
      addLogContext({ userId: 'user-3' });
      expect(getLogContext()).toEqual({ requestId: 'req-2', userId: 'user-3' });
    });
  });
});

describe('redaction', () => {
  it('never writes a password, token or authorization header to the sink', () => {
    const { stream, lines } = capture();
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream);

    logger.info(
      {
        password: 'hunter2',
        apiKey: 'sc_live_abc',
        nested: { token: 'tok_123' },
        headers: { authorization: 'Bearer abc', cookie: 'sid=1' },
        keep: 'visible',
      },
      'attempt',
    );

    const line = lines[0]!;
    const serialised = JSON.stringify(line);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('sc_live_abc');
    expect(serialised).not.toContain('tok_123');
    expect(serialised).not.toContain('Bearer abc');
    expect(serialised).not.toContain('sid=1');
    expect(line['keep']).toBe('visible');
  });
});
