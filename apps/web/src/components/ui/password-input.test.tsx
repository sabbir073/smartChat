import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordInput } from './password-input';

afterEach(cleanup);

const field = () => screen.getByLabelText('Password') as HTMLInputElement;
const toggle = () => screen.getByRole('button', { name: /password$/ }) as HTMLButtonElement;

describe('PasswordInput', () => {
  it('starts hidden', () => {
    render(<PasswordInput aria-label="Password" defaultValue="hunter2" />);
    expect(field().type).toBe('password');
    expect(toggle().getAttribute('aria-label')).toBe('Show password');
  });

  it('reveals and hides again', () => {
    render(<PasswordInput aria-label="Password" defaultValue="hunter2" />);

    fireEvent.click(toggle());
    expect(field().type).toBe('text');
    expect(toggle().getAttribute('aria-label')).toBe('Hide password');

    fireEvent.click(toggle());
    expect(field().type).toBe('password');
  });

  /**
   * The bug this exists for. A bare `<button>` inside a `<form>` defaults to `type="submit"`, so
   * a reveal control written without `type="button"` submits the form — signing you in with half
   * a password the moment you try to check what you typed.
   */
  it('does not submit the form it lives in', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput aria-label="Password" />
        <button type="submit">Sign in</button>
      </form>,
    );

    fireEvent.click(toggle());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field().type).toBe('text');
  });

  it('carries its state to a screen reader', () => {
    render(<PasswordInput aria-label="Password" />);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('aria-label')).toBe('Hide password');
  });

  it('keeps typing working while revealed', () => {
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <PasswordInput
          aria-label="Password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    render(<Harness />);

    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: 'correct horse' } });
    expect(field().value).toBe('correct horse');
  });

  it('passes through the attributes a password field needs', () => {
    render(<PasswordInput aria-label="Password" autoComplete="new-password" required invalid />);
    expect(field().getAttribute('autocomplete')).toBe('new-password');
    expect(field().required).toBe(true);
    expect(field().getAttribute('aria-invalid')).toBe('true');
  });

  it('disables the toggle along with the field', () => {
    render(<PasswordInput aria-label="Password" disabled />);
    expect(toggle().disabled).toBe(true);
    expect(field().disabled).toBe(true);
  });
});
