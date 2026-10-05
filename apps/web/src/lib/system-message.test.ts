import { describe, expect, it } from 'vitest';
import type { SystemMessageEvent } from './realtime';
import { formatCallDuration, systemText } from './system-message';

/** The transcript's own words for each milestone, told from the team's side. */
describe('systemText', () => {
  const line = (event: SystemMessageEvent, body = 'server wording') => systemText({ body, event });

  it('keeps the chat wording as it was', () => {
    expect(line({ kind: 'conversation.closed', by: 'visitor' })).toBe(
      'The visitor ended this chat',
    );
    expect(line({ kind: 'conversation.reopened', by: 'agent', actorName: 'Nayeem' })).toBe(
      'Nayeem reopened this chat',
    );
    expect(line({ kind: 'conversation.closed', by: 'agent' })).toBe('An agent ended this chat');
  });

  it('says who started, answered and received a call', () => {
    expect(line({ kind: 'call.started', by: 'visitor' })).toBe('The visitor started a call');
    expect(line({ kind: 'call.answered', by: 'agent', actorName: 'Sabbir' })).toBe(
      'Sabbir answered the call',
    );
    expect(line({ kind: 'call.answered', by: 'agent' })).toBe('An agent answered the call');
    expect(line({ kind: 'call.answered', by: 'ai', actorName: 'Mira' })).toBe(
      'Mira (AI) answered the call',
    );
    expect(line({ kind: 'call.answered', by: 'ai' })).toBe('The AI assistant answered the call');
    expect(line({ kind: 'call.transferred', by: 'agent', targetName: 'Nayeem' })).toBe(
      'Transferred to Nayeem',
    );
    expect(line({ kind: 'call.transferred', by: 'ai' })).toBe('Transferred to a team member');
  });

  it('says how a call ended', () => {
    expect(line({ kind: 'call.missed', by: 'system' })).toBe('Missed call');
    expect(
      line({ kind: 'call.ended', by: 'agent', actorName: 'Sabbir', durationSeconds: 130 }),
    ).toBe('Call ended · 2 min 10 s');
    expect(line({ kind: 'call.ended', by: 'visitor', durationSeconds: 42 })).toBe(
      'Call ended · 42 s',
    );
    expect(line({ kind: 'call.ended', by: 'system', durationSeconds: 0 })).toBe('Call ended');
  });

  it('falls back to the body for a message without structure, or a kind it does not know', () => {
    expect(systemText({ body: 'Something happened' })).toBe('Something happened');
    expect(
      systemText({
        body: 'Future thing',
        event: { kind: 'call.recorded' as SystemMessageEvent['kind'], by: 'system' },
      }),
    ).toBe('Future thing');
  });
});

describe('formatCallDuration', () => {
  it('spells durations the way the server does', () => {
    expect(formatCallDuration(0)).toBe('0 s');
    expect(formatCallDuration(59)).toBe('59 s');
    expect(formatCallDuration(60)).toBe('1 min 0 s');
    expect(formatCallDuration(130.4)).toBe('2 min 10 s');
  });
});
