import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallDto } from '@smartchat/types';
import type { CallsContextValue } from './call-provider';
import { CallDock } from './call-dock';

/**
 * The corner of the screen where a call is answered, with the provider stood in for: what a
 * ringing call looks like as a card, what happens when the buttons are pressed, and what is left
 * behind when somebody else was quicker.
 */

const answer = vi.fn(async () => undefined);
const decline = vi.fn(async () => undefined);
let value: CallsContextValue;

vi.mock('./call-provider', () => ({
  useCalls: () => value,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/app/settings',
}));

function call(overrides: Partial<CallDto> = {}): CallDto {
  return {
    id: 'call-1',
    propertyId: 'prop-1',
    conversationId: 'conv-1',
    visitorId: 'visitor-1',
    status: 'ringing',
    answeredByMemberId: null,
    answeredByName: null,
    handledByAi: false,
    pending: null,
    queuedAt: null,
    visitor: { name: 'Rahim', email: 'rahim@example.com' },
    language: 'bn',
    startedAt: '2026-10-05T10:00:00.000Z',
    answeredAt: null,
    endedAt: null,
    endReason: null,
    durationSeconds: 0,
    ...overrides,
  };
}

function context(overrides: Partial<CallsContextValue> = {}): CallsContextValue {
  return {
    calls: new Map(),
    me: 'member-me',
    incoming: [],
    notices: new Map(),
    active: null,
    openConversationId: null,
    openRequest: null,
    soundOn: true,
    setSoundOn: vi.fn(),
    propertyName: (id) => (id === 'prop-1' ? 'Bike Shop' : id),
    ingest: vi.fn(),
    setFeedLive: vi.fn(),
    setOpenConversation: vi.fn(),
    requestOpen: vi.fn(),
    answer,
    decline,
    hangUp: vi.fn(async () => undefined),
    transfer: vi.fn(async () => undefined),
    setMuted: vi.fn(async () => undefined),
    unblockAudio: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CallDock', () => {
  it('renders nothing when there is nothing to show', () => {
    value = context();
    const { container } = render(<CallDock />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a ringing call as a card with the caller, the website and the two buttons', () => {
    value = context({ incoming: [call()] });
    render(<CallDock />);
    expect(screen.getByText('Incoming call')).toBeTruthy();
    expect(screen.getByText('Rahim')).toBeTruthy();
    expect(screen.getByText('rahim@example.com')).toBeTruthy();
    expect(screen.getByText('Bike Shop')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    expect(answer).toHaveBeenCalledWith('call-1');
    // Both buttons wait for the answer to settle, so a double press cannot answer and decline at once.
    expect((screen.getByRole('button', { name: /decline/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('declines from the card', () => {
    value = context({ incoming: [call()] });
    render(<CallDock />);
    fireEvent.click(screen.getByRole('button', { name: /decline/i }));
    expect(decline).toHaveBeenCalledWith('call-1');
  });

  it('names the colleague handing a call over', () => {
    value = context({
      incoming: [
        call({
          answeredByMemberId: 'member-sabbir',
          answeredByName: 'Sabbir',
          pending: { kind: 'member', memberId: 'member-me', name: 'Me' },
        }),
      ],
    });
    render(<CallDock />);
    expect(screen.getByText('Transfer from Sabbir')).toBeTruthy();
  });

  it('will not offer Answer while this tab is already on a call', () => {
    value = context({
      incoming: [call({ id: 'call-2', conversationId: 'conv-2' })],
      active: {
        callId: 'call-1',
        conversationId: 'conv-1',
        phase: 'connected',
        muted: false,
        audioBlocked: false,
        micError: null,
      },
      calls: new Map([
        [
          'call-1',
          call({
            status: 'active',
            answeredByMemberId: 'member-me',
            answeredByName: 'Me',
            answeredAt: '2026-10-05T10:00:05.000Z',
          }),
        ],
      ]),
    });
    render(<CallDock />);
    expect((screen.getByRole('button', { name: /^answer$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // And the call I am on has its own controls, since its conversation is not on screen.
    expect(screen.getByRole('button', { name: /hang up/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^mute$/i })).toBeTruthy();
  });

  it('hides the pill while the inbox is showing that very conversation', () => {
    value = context({
      active: {
        callId: 'call-1',
        conversationId: 'conv-1',
        phase: 'connected',
        muted: false,
        audioBlocked: false,
        micError: null,
      },
      openConversationId: 'conv-1',
    });
    const { container } = render(<CallDock />);
    expect(container.innerHTML).toBe('');
  });

  it('leaves a short notice where a card was when somebody else took the call', () => {
    value = context({ notices: new Map([['call-1', 'Taken by Sabbir']]) });
    render(<CallDock />);
    expect(screen.getByRole('status').textContent).toContain('Taken by Sabbir');
    expect(screen.queryByRole('button', { name: /answer/i })).toBeNull();
  });
});
