'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import type { MessageAttachment } from '@/lib/realtime';
import { cn } from '@/components/ui';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function signedUrl(attachmentId: string): Promise<string> {
  const result = await api.get<{ url: string }>(`/attachments/${attachmentId}/url`);
  return result.data.url;
}

/**
 * A file in the agent's thread.
 *
 * The URL is fetched when it is needed and not stored anywhere, because it is short-lived and
 * minted against this agent's own access. Images resolve on render so the picture appears;
 * everything else resolves on click, so opening a thread with twenty attachments does not sign
 * twenty URLs that nobody uses.
 */
export function AttachmentCard({
  attachment,
  fromAgent,
}: {
  attachment: MessageAttachment;
  fromAgent: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!attachment.isImage) return undefined;
    let cancelled = false;
    signedUrl(attachment.id)
      .then((resolved) => !cancelled && setUrl(resolved))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [attachment.id, attachment.isImage]);

  async function open(): Promise<void> {
    try {
      const resolved = url ?? (await signedUrl(attachment.id));
      setUrl(resolved);
      window.open(resolved, '_blank', 'noopener,noreferrer');
    } catch {
      setFailed(true);
    }
  }

  if (attachment.isImage) {
    return (
      <button
        type="button"
        onClick={() => void open()}
        aria-label={`Open ${attachment.fileName}`}
        className="block max-w-[260px] overflow-hidden rounded-xl border border-border"
      >
        {url ? (
          /* A plain img, not next/image: the URL is signed and expires in minutes, so the image
             pipeline cannot fetch or cache it - it would be caching a link that is already dead. */
          <img src={url} alt={attachment.fileName} className="block h-auto w-full" />
        ) : (
          <span className="flex h-28 w-48 items-center justify-center text-[12.5px] text-ink-subtle">
            {failed ? 'Could not load' : 'Loading…'}
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      className={cn(
        'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
        fromAgent
          ? 'border-ink-inverted/25 hover:bg-ink-inverted/10'
          : 'border-border hover:bg-surface',
      )}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
        <path
          d="M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13.5px]">{attachment.fileName}</span>
        <span className="text-[11.5px] opacity-70">
          {failed ? 'Could not open' : formatBytes(attachment.byteSize)}
        </span>
      </span>
    </button>
  );
}
