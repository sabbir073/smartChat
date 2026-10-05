import { describe, expect, it } from 'vitest';
import { systemText } from './MessageList.js';

describe('systemText', () => {
  it("writes the call milestones in the visitor's terms", () => {
    expect(
      systemText({ body: 'Call started', event: { kind: 'call.started', by: 'visitor' } }),
    ).toBe('You started a call');
    expect(
      systemText({ body: 'x', event: { kind: 'call.answered', by: 'agent', actorName: 'Sabbir' } }),
    ).toBe('Sabbir answered the call');
    expect(
      systemText({ body: 'x', event: { kind: 'call.answered', by: 'ai', actorName: 'Mira' } }),
    ).toBe('Mira answered the call');
    expect(systemText({ body: 'x', event: { kind: 'call.answered', by: 'ai' } })).toBe(
      'The assistant answered the call',
    );
    expect(
      systemText({
        body: 'x',
        event: { kind: 'call.transferred', by: 'agent', targetName: 'Mira' },
      }),
    ).toBe('Call transferred to Mira');
    expect(
      systemText({ body: 'x', event: { kind: 'call.missed', by: 'system', durationSeconds: 0 } }),
    ).toBe('Missed call');
    expect(
      systemText({ body: 'x', event: { kind: 'call.ended', by: 'agent', durationSeconds: 130 } }),
    ).toBe('Call ended · 2 min 10 s');
    expect(systemText({ body: 'x', event: { kind: 'call.ended', by: 'system' } })).toBe(
      'Call ended',
    );
  });

  it('still words the chat events as before, and falls back to the body for an unknown kind', () => {
    expect(systemText({ body: 'x', event: { kind: 'conversation.closed', by: 'visitor' } })).toBe(
      'You ended this chat',
    );
    expect(
      systemText({
        body: 'x',
        event: { kind: 'conversation.reopened', by: 'agent', actorName: 'Sabbir' },
      }),
    ).toBe('Sabbir reopened this chat');
    expect(systemText({ body: 'Something new happened' })).toBe('Something new happened');
  });
});
