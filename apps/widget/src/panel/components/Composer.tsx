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
  onAttach,
  maxBytes,
}: {
  placeholder: string;
  disabled: boolean;
  onSend: (body: string) => void;
  onTyping: (typing: boolean) => void;
  /** Absent when the property has no conversation yet, which is when there is nothing to attach to. */
  onAttach?: ((file: File) => void) | undefined;
  maxBytes: number;
}) {
  const [value, setValue] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
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

  /**
   * Refuse an obviously-too-large file here, before anything is uploaded.
   *
   * The server checks the real object anyway - this is not the enforcement, it is the courtesy of
   * saying so immediately instead of after a minute of uploading.
   */
  function handleFile(file: File | undefined): void {
    if (!file || !onAttach) return;
    if (file.size > maxBytes) {
      setFileError(`That file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`);
      return;
    }
    if (file.size === 0) {
      setFileError('That file is empty');
      return;
    }
    setFileError(null);
    onAttach(file);
  }

  return (
    <form
      className="composer"
      onSubmit={submit}
      onDragOver={(event) => {
        if (onAttach) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onAttach) return;
        event.preventDefault();
        handleFile(event.dataTransfer.files[0]);
      }}
    >
      <label className="sr-only" htmlFor="sc-composer">
        Type your message
      </label>

      {fileError && (
        <p className="composer-error" role="alert">
          {fileError}
        </p>
      )}

      {onAttach && (
        <>
          <input
            ref={filePicker}
            type="file"
            className="sr-only"
            onChange={(event) => {
              handleFile(event.target.files?.[0]);
              // Cleared so choosing the same file twice in a row still fires a change.
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className="composer-attach"
            disabled={disabled}
            aria-label="Attach a file"
            onClick={() => filePicker.current?.click()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <path
                d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 1 1 5 5l-8 8a2 2 0 1 1-3-3l7.5-7.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </>
      )}
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
