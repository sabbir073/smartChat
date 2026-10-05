import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransferTargets } from '@/lib/voice';
import { TransferPicker } from './transfer-picker';

/**
 * The picker asks the server who can take the call the moment it opens, and shows exactly that:
 * the colleagues by name, the AI only when it may, and an honest sentence when there is nobody.
 */

const targets = vi.fn<(callId: string) => Promise<TransferTargets>>();

vi.mock('@/lib/voice', () => ({
  callsApi: { targets: (callId: string) => targets(callId) },
}));

vi.mock('@/lib/api-client', () => ({
  ApiError: class ApiError extends Error {},
}));

function open(onPick = vi.fn(async () => undefined)) {
  const anchor = createRef<HTMLElement>();
  render(<TransferPicker callId="call-1" anchor={anchor} onPick={onPick} onClose={vi.fn()} />);
  return onPick;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TransferPicker', () => {
  it('asks who is available for this call and lists them', async () => {
    targets.mockResolvedValue({
      members: [
        { id: 'm-1', name: 'Nayeem' },
        { id: 'm-2', name: null },
      ],
      ai: true,
    });
    const onPick = open();
    expect(targets).toHaveBeenCalledWith('call-1');
    expect(screen.getByRole('status').textContent).toContain('Looking for colleagues');

    await waitFor(() => expect(screen.getByRole('menuitem', { name: /nayeem/i })).toBeTruthy());
    expect(screen.getByRole('menuitem', { name: /a colleague/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /ai assistant/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: /nayeem/i }));
    expect(onPick).toHaveBeenCalledWith({ to: 'member', memberId: 'm-1' });
  });

  it('says so when nobody is available, and offers the AI only when it may take the call', async () => {
    targets.mockResolvedValue({ members: [], ai: true });
    const onPick = open();
    await waitFor(() =>
      expect(screen.getByText('No colleague is available right now.')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /ai assistant/i }));
    expect(onPick).toHaveBeenCalledWith({ to: 'ai' });
  });

  it('hides the AI entry when the server says it cannot take a transfer', async () => {
    targets.mockResolvedValue({ members: [{ id: 'm-1', name: 'Nayeem' }], ai: false });
    open();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /nayeem/i })).toBeTruthy());
    expect(screen.queryByRole('menuitem', { name: /ai assistant/i })).toBeNull();
  });

  it('tells the person when the list could not be fetched', async () => {
    targets.mockRejectedValue(new Error('boom'));
    open();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not find out who is available.',
      ),
    );
  });
});
