import { describe, expect, it } from 'vitest';
import {
  HOST_TO_PANEL,
  PANEL_TO_HOST,
  isTrustedHostMessage,
  isTrustedPanelMessage,
} from './protocol.js';

const ORIGIN = 'https://cdn.smartchat.test';
const NONCE = 'nonce-123';

function event(data: unknown, origin = ORIGIN): MessageEvent {
  return { data, origin } as MessageEvent;
}

describe('isTrustedPanelMessage', () => {
  const valid = { type: PANEL_TO_HOST.READY, nonce: NONCE };

  it('accepts a well-formed message from the expected origin', () => {
    expect(isTrustedPanelMessage(event(valid), ORIGIN, NONCE)).toBe(true);
  });

  it('rejects a message from any other origin, however well-formed', () => {
    expect(isTrustedPanelMessage(event(valid, 'https://attacker.test'), ORIGIN, NONCE)).toBe(false);
    expect(isTrustedPanelMessage(event(valid, 'null'), ORIGIN, NONCE)).toBe(false);
  });

  it('rejects a message carrying the wrong nonce', () => {
    expect(isTrustedPanelMessage(event({ ...valid, nonce: 'guessed' }), ORIGIN, NONCE)).toBe(false);
    expect(isTrustedPanelMessage(event({ type: PANEL_TO_HOST.READY }), ORIGIN, NONCE)).toBe(false);
  });

  it('rejects an unknown message type', () => {
    expect(
      isTrustedPanelMessage(event({ type: 'sc:panel:evil', nonce: NONCE }), ORIGIN, NONCE),
    ).toBe(false);
  });

  it('rejects non-object payloads without throwing', () => {
    for (const payload of [null, undefined, 'string', 42, []]) {
      expect(isTrustedPanelMessage(event(payload), ORIGIN, NONCE)).toBe(false);
    }
  });

  it('does not accept a host message on the panel channel', () => {
    expect(
      isTrustedPanelMessage(event({ type: HOST_TO_PANEL.OPEN, nonce: NONCE }), ORIGIN, NONCE),
    ).toBe(false);
  });
});

describe('isTrustedHostMessage', () => {
  it('accepts host messages and rejects panel ones', () => {
    expect(
      isTrustedHostMessage(event({ type: HOST_TO_PANEL.OPEN, nonce: NONCE }), ORIGIN, NONCE),
    ).toBe(true);
    expect(
      isTrustedHostMessage(event({ type: PANEL_TO_HOST.READY, nonce: NONCE }), ORIGIN, NONCE),
    ).toBe(false);
  });
});
