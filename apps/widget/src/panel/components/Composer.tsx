import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MESSAGE_MAX_LENGTH } from '@smartchat/validation';

/**
 * The message box.
 *
 * Enter sends, Shift+Enter makes a new line - the convention every chat product shares, and one
 * people notice immediately when it is missing.
 */
export function Composer({
  placeholder,
  disabled,
  onSend,
  onTyping,
}: {
  placeholder: string;
  disabled: boolean;
  onSend: (body: string) => void;
  onTyping: (typing: boolean) => void;
}) {
  const [value, setValue] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<number | null>(null);
  const isTyping = useRef(false);

  // Grow with the content, up to a limit, instead of scrolling a two-line box.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [value]);

  useEffect(
    () => () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    },
    [],
  );

  function signalTyping(): void {
    if (!isTyping.current) {
      isTyping.current = true;
      onTyping(true);
    }
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    // The server's typing key expires on its own, so this only has to stop refreshing it.
    typingTimer.current = window.setTimeout(() => {
      isTyping.current = false;
      onTyping(false);
    }, 2500);
  }

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    const body = value.trim();
    if (!body || disabled) return;

    onSend(body);
    setValue('');
    if (isTyping.current) {
      isTyping.current = false;
      onTyping(false);
    }
    textarea.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="sc-composer">
        Type your message
      </label>
      <textarea
        id="sc-composer"
        ref={textarea}
        value={value}
        rows={1}
        maxLength={MESSAGE_MAX_LENGTH}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          setValue(event.target.value);
          signalTyping();
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        disabled={disabled || value.trim().length === 0}
        aria-label="Send message"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path
            d="M4 12 20 4l-3.2 8L20 20 4 12Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </form>
  );
}
