'use client';

import { forwardRef, useState } from 'react';
import { cn } from './cn';
import { TextInput, type TextInputProps } from './field';

/**
 * A password field you can look at.
 *
 * Typing a password you cannot see, into a form that will only tell you it was wrong after you
 * submit it, is the reason people paste passwords into the email field to check them. Every
 * password input in this product uses this one, so the affordance cannot be present on four
 * screens and missing on the fifth.
 *
 * The button is `type="button"` — the detail that matters most here, because a bare `<button>`
 * inside a form submits it, and a reveal control that signs you in with a half-typed password is
 * worse than no control at all. It is a real focusable button rather than an icon with a click
 * handler, so it is reachable by keyboard, and `aria-pressed` carries the state to a screen
 * reader instead of leaving it in the picture.
 *
 * The field reverts to hidden on every mount: revealing is a deliberate act for one moment, not a
 * preference to remember on a shared screen.
 */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<TextInputProps, 'type'>>(
  function PasswordInput({ className, disabled, ...props }, ref) {
    const [visible, setVisible] = useState(false);

    return (
      <div className="relative">
        <TextInput
          ref={ref}
          type={visible ? 'text' : 'password'}
          disabled={disabled}
          // Room for the button, so a long password does not run underneath it.
          className={cn('pr-11', className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((shown) => !shown)}
          disabled={disabled}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          // Not a tab stop between the field and the submit button: somebody filling the form with
          // the keyboard is going to the next field, not to this.
          tabIndex={-1}
          className={cn(
            'absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-[var(--radius-control)]',
            'text-ink-subtle transition-colors hover:text-ink',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    );
  },
);

function EyeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.2 12S5.8 5.5 12 5.5 21.8 12 21.8 12 18.2 18.5 12 18.5 2.2 12 2.2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.6 6.7A7.9 7.9 0 0 1 12 6.6c6.2 0 9.8 6.5 9.8 6.5a17.6 17.6 0 0 1-3 3.9" />
      <path d="M6.6 7.6A17.4 17.4 0 0 0 2.2 13.1S5.8 19.6 12 19.6a8.9 8.9 0 0 0 4-.9" />
      <path d="M9.9 10.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3.5 3.5l17 17" />
    </svg>
  );
}
