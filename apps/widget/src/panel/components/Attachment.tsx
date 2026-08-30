import { useEffect, useState } from 'react';
import type { MessageAttachment } from '../lib/types.js';

/** 1 234 567 -> "1.2 MB". Sizes are for a person, not for a machine. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file in a chat bubble.
 *
 * The URL is fetched when the bubble is rendered rather than carried in the message, because a
 * download link is short-lived and minted against whoever is asking. A transcript full of URLs
 * would be a transcript full of links that stop working - or, worse, ones that keep working after
 * the person should no longer have them.
 */
export function AttachmentBubble({
  attachment,
  resolveUrl,
}: {
  attachment: MessageAttachment;
  resolveUrl: (attachmentId: string) => Promise<string>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Images resolve immediately so the picture appears; other files resolve on click, so a
    // thread with twenty attachments does not mint twenty signed URLs nobody uses.
    if (!attachment.isImage) return undefined;
    resolveUrl(attachment.id)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, attachment.isImage, resolveUrl]);

  async function open(): Promise<void> {
    try {
      const resolved = url ?? (await resolveUrl(attachment.id));
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
        className="attachment-image"
        onClick={() => void open()}
        aria-label={`Open ${attachment.fileName}`}
      >
        {url ? (
          <img src={url} alt={attachment.fileName} loading="lazy" />
        ) : (
          <span className="attachment-placeholder">
            {failed ? 'Could not load this image' : 'Loading…'}
          </span>
        )}
      </button>
    );
  }

  return (
    <button type="button" className="attachment-file" onClick={() => void open()}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
        <path
          d="M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span className="attachment-meta">
        <span className="attachment-name">{attachment.fileName}</span>
        <span className="attachment-size">
          {failed ? 'Could not open this file' : formatBytes(attachment.byteSize)}
        </span>
      </span>
    </button>
  );
}

/** The bubble while the bytes are still going up. */
export function UploadingBubble({ fileName, byteSize }: { fileName: string; byteSize: number }) {
  return (
    <span className="attachment-file" aria-live="polite">
      <span className="spinner spinner-sm" aria-hidden="true" />
      <span className="attachment-meta">
        <span className="attachment-name">{fileName}</span>
        <span className="attachment-size">Sending… {formatBytes(byteSize)}</span>
      </span>
    </span>
  );
}
