import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisitorPanel } from './visitor-panel';
import type * as UiModule from '@/components/ui';
import type { ConversationDto } from '@/lib/types';

/**
 * The moderation control, at the layer where its bugs actually live.
 *
 * Everything the *server* does about a ban is covered by `scripts/e2e-abuse.mjs` against the real
 * stack. What that suite cannot see is the half of the feature that lives in a browser: whether a
 * manager is offered the right button, whether an agent is offered one at all, and whether the
 * request that leaves the page carries what the person chose. Those are exactly the kind of bug
 * that a passing server test sits happily beside - see modal.test.tsx for the last one.
 */

const post = vi.fn();
const del = vi.fn();
const can = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    post: (...args: unknown[]) => post(...args),
    delete: (...args: unknown[]) => del(...args),
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ can }),
}));

vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof UiModule>();
  // Toasts are a side effect, not the behaviour under test; the rest of the kit is the real thing,
  // because a mocked Modal would not tell us whether the dialog opens.
  return { ...actual, useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) };
});

function conversation(visitor: Partial<ConversationDto['visitor']> = {}): ConversationDto {
  return {
    id: 'c1',
    propertyId: 'p1',
    status: 'open',
    priority: 'normal',
    channel: 'chat',
    subject: null,
    tags: [],
    assignedMemberId: null,
    lastMessageAt: new Date('2026-08-31T10:05:00Z').toISOString(),
    startedAt: new Date('2026-08-31T10:00:00Z').toISOString(),
    closedAt: null,
    agentUnreadCount: 0,
    messageSeq: 3,
    preChat: [],
    visitor: {
      id: 'v1',
      name: 'Dana',
      email: null,
      browser: 'Firefox',
      os: 'Linux',
      deviceType: 'desktop',
      country: null,
      language: 'en',
      isReturning: false,
      isBanned: false,
      bannedUntil: null,
      ...visitor,
    },
  };
}

beforeEach(() => {
  post.mockReset().mockResolvedValue({ data: {} });
  del.mockReset().mockResolvedValue({ data: {} });
  can.mockReset().mockReturnValue(true);
});
afterEach(cleanup);

describe('VisitorPanel moderation', () => {
  it('offers nothing to somebody without the permission', () => {
    can.mockReturnValue(false);
    render(<VisitorPanel conversation={conversation()} online currentUrl={null} />);
    expect(screen.queryByRole('button', { name: /ban visitor/i })).toBeNull();
    expect(screen.queryByText(/moderation/i)).toBeNull();
  });

  it('asks for the permission by name rather than by role', () => {
    render(<VisitorPanel conversation={conversation()} online currentUrl={null} />);
    expect(can).toHaveBeenCalledWith('contact:update');
  });

  it('sends the length the manager chose, and the reason they typed', async () => {
    render(<VisitorPanel conversation={conversation()} online currentUrl={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ban visitor$/i }));

    fireEvent.change(screen.getByLabelText(/for how long/i), { target: { value: '168' } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Abusive language' } });
    // The dialog's confirm button, not the one behind it that opened the dialog.
    fireEvent.click(
      screen.getAllByRole('button', { name: /^ban visitor$/i }).at(-1) as HTMLElement,
    );

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0] as [string, { until: string | null; reason?: string }];
    expect(path).toBe('/visitors/v1/ban');
    expect(body.reason).toBe('Abusive language');
    // Seven days, sent as an instant rather than as "168" - the server must never have to guess
    // which unit a number was in.
    const hours = (new Date(body.until as string).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(167);
    expect(hours).toBeLessThan(169);
  });

  it('sends no end date when the ban is permanent', async () => {
    render(<VisitorPanel conversation={conversation()} online currentUrl={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ban visitor$/i }));
    fireEvent.change(screen.getByLabelText(/for how long/i), { target: { value: '' } });
    fireEvent.click(
      screen.getAllByRole('button', { name: /^ban visitor$/i }).at(-1) as HTMLElement,
    );

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0] as [string, { until: string | null }];
    expect(body.until).toBeNull();
  });

  it('omits the reason entirely rather than sending an empty one', async () => {
    render(<VisitorPanel conversation={conversation()} online currentUrl={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ban visitor$/i }));
    fireEvent.click(
      screen.getAllByRole('button', { name: /^ban visitor$/i }).at(-1) as HTMLElement,
    );

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect('reason' in body).toBe(false);
  });

  /**
   * The state the panel must not get wrong: offering "Ban" to somebody already banned, or "Lift"
   * to somebody who is not, sends the manager down a path that ends in a confusing error.
   */
  it('offers to lift the ban, not to apply one, when the visitor is banned', async () => {
    render(
      <VisitorPanel
        conversation={conversation({ isBanned: true, bannedUntil: null })}
        online={false}
        currentUrl={null}
      />,
    );
    expect(screen.getByText('Banned')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^ban visitor$/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /lift ban/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/visitors/v1/ban'));
  });

  it('says when a temporary ban ends rather than just that one exists', () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    render(
      <VisitorPanel
        conversation={conversation({ isBanned: true, bannedUntil: until })}
        online={false}
        currentUrl={null}
      />,
    );
    expect(screen.getByText(/banned until/i)).toBeTruthy();
  });

  it('tells the caller to re-read from the server after a change', async () => {
    const onVisitorChanged = vi.fn();
    render(
      <VisitorPanel
        conversation={conversation({ isBanned: true })}
        online={false}
        currentUrl={null}
        onVisitorChanged={onVisitorChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /lift ban/i }));
    await waitFor(() => expect(onVisitorChanged).toHaveBeenCalled());
  });
});
