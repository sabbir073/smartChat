import { describe, expect, it } from 'vitest';
import { viewAfterInboundMessage } from './view.js';

describe('viewAfterInboundMessage', () => {
  it('shows the conversation when a trigger greets somebody on the pre-chat form', () => {
    // The bug this pins: the message arrived, the badge appeared, and opening the panel showed
    // a form. Verified in a browser before it was fixed.
    expect(viewAfterInboundMessage('prechat', 'bot')).toBe('chat');
  });

  it('does the same for an agent reply and from either form', () => {
    expect(viewAfterInboundMessage('prechat', 'agent')).toBe('chat');
    expect(viewAfterInboundMessage('offline', 'bot')).toBe('chat');
    expect(viewAfterInboundMessage('offline_sent', 'agent')).toBe('chat');
  });

  it('leaves the visitor alone when the message is their own', () => {
    expect(viewAfterInboundMessage('prechat', 'visitor')).toBe('prechat');
    expect(viewAfterInboundMessage('offline', 'visitor')).toBe('offline');
  });

  it('does not drag somebody out of a screen a message has nothing to do with', () => {
    expect(viewAfterInboundMessage('loading', 'bot')).toBe('loading');
    expect(viewAfterInboundMessage('unavailable', 'bot')).toBe('unavailable');
    expect(viewAfterInboundMessage('chat', 'bot')).toBe('chat');
  });
});
