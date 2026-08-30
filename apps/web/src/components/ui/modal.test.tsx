import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Modal } from './modal';

afterEach(cleanup);

/**
 * A dialog exactly as every caller in this app writes one: the close handler is an inline arrow,
 * so its identity changes on every render, and typing in a field re-renders the parent.
 */
function Harness() {
  const [open, setOpen] = useState(true);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');

  if (!open) return <p>closed</p>;

  return (
    <Modal open onClose={() => setOpen(false)} title="Edit">
      <input
        aria-label="first"
        value={first}
        onChange={(event) => setFirst(event.target.value)}
      />
      <textarea
        aria-label="second"
        value={second}
        onChange={(event) => setSecond(event.target.value)}
      />
    </Modal>
  );
}

describe('Modal', () => {
  it('moves focus into the dialog when it opens', () => {
    render(<Harness />);
    expect(document.activeElement).toBe(screen.getByLabelText('first'));
  });

  /**
   * The regression this file exists for.
   *
   * The focus effect used to list `onClose` as a dependency. Callers pass an inline arrow, so
   * every keystroke changed its identity, re-ran the effect, and pulled focus back to the first
   * field - a person typing into the third field of a dialog got two characters in and watched
   * the rest of the sentence appear in the first one.
   */
  it('leaves focus where the person put it while they type', () => {
    render(<Harness />);
    const second = screen.getByLabelText('second');

    second.focus();
    expect(document.activeElement).toBe(second);

    fireEvent.change(second, { target: { value: '#' } });
    expect(document.activeElement).toBe(second);

    fireEvent.change(second, { target: { value: '## Adding the snippet' } });
    expect(document.activeElement).toBe(second);
    expect((second as HTMLTextAreaElement).value).toBe('## Adding the snippet');
  });

  it('still closes on Escape after the parent has re-rendered', () => {
    render(<Harness />);
    const second = screen.getByLabelText('second');
    // A re-render replaces the `onClose` the effect captured; the ref must follow it.
    fireEvent.change(second, { target: { value: 'edited' } });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('closed')).toBeTruthy();
  });
});
