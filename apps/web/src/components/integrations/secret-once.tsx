'use client';

import { useState } from 'react';
import { Alert, Button, Modal } from '@/components/ui';

/**
 * A secret, shown exactly once.
 *
 * Two things this deliberately does not do. It does not offer to email the secret, and it does not
 * keep it anywhere the page can be reloaded into - the value lives in React state and is gone the
 * moment this closes. The copy button uses the clipboard API and falls back to selecting the text,
 * because a "copy" that silently does nothing on a page where the value is unrecoverable is a
 * genuinely expensive failure.
 */
export function SecretOnce({
  title,
  secret,
  onClose,
}: {
  title: string;
  secret: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // Not available over plain http, or refused by permissions. Say so instead of pretending.
      setCopyFailed(true);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description="This is the only time it will be shown. Copy it somewhere safe now."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={onClose}>I have saved it</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <code className="block w-full select-all break-all rounded-[var(--radius-control)] border border-border-strong bg-surface-raised px-3 py-2.5 font-mono text-[13px] text-ink">
          {secret}
        </code>
        {copyFailed && (
          <Alert tone="warning">
            Your browser would not let us use the clipboard. Select the text above and copy it
            manually.
          </Alert>
        )}
        <Alert tone="info">
          We store only a hash of this, so we cannot show it to you again or recover it for you. If
          it is lost, revoke it and make another.
        </Alert>
      </div>
    </Modal>
  );
}
