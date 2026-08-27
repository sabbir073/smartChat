'use client';

import { Badge } from '@/components/ui';
import type { ConversationDto } from '@/lib/types';

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[12px] text-ink-subtle">{label}</dt>
      <dd className="truncate text-right text-[13px] text-ink">{value}</dd>
    </div>
  );
}

/** "order_number" reads as "Order number". The field key is not shown to an agent as-is. */
function humaniseKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * What the agent knows about the person they are talking to.
 *
 * Everything here is a claim the browser reported or the visitor typed. It is context, never
 * identity — which is why nothing in this panel is used for any authorisation decision.
 */
export function VisitorPanel({
  conversation,
  online,
  currentUrl,
}: {
  conversation: ConversationDto;
  online: boolean;
  currentUrl: string | null;
}) {
  const { visitor } = conversation;

  return (
    <div className="space-y-5 p-4">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold text-ink">
            {visitor.name ?? 'Unidentified visitor'}
          </h2>
          {online ? (
            <Badge tone="success" dot>
              Online
            </Badge>
          ) : (
            <Badge tone="neutral">Offline</Badge>
          )}
        </div>
        {visitor.email && (
          <p className="mt-0.5 truncate text-[13px] text-ink-muted">{visitor.email}</p>
        )}
      </div>

      <section>
        <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">
          Session
        </h3>
        <dl className="divide-y divide-border">
          <Row label="Currently on" value={currentUrl} />
          <Row label="Browser" value={visitor.browser} />
          <Row label="Operating system" value={visitor.os} />
          <Row label="Device" value={visitor.deviceType} />
          <Row label="Language" value={visitor.language} />
          <Row label="Country" value={visitor.country} />
          <Row label="Returning" value={visitor.isReturning ? 'Yes' : 'First visit'} />
        </dl>
      </section>

      {conversation.preChat.length > 0 && (
        <section>
          <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">
            {conversation.channel === 'offline_form' ? 'Offline form' : 'Before the chat'}
          </h3>
          {/*
            Shown with the visitor's own labels turned back into words. These are answers to
            questions the customer chose to ask, so they belong beside the browser facts rather
            than buried in the transcript - an agent should not have to scroll to find the order
            number somebody typed before they said hello.
          */}
          <dl className="divide-y divide-border">
            {conversation.preChat.map((entry) => (
              <Row key={entry.key} label={humaniseKey(entry.key)} value={entry.value} />
            ))}
          </dl>
        </section>
      )}

      <section>
        <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">
          Conversation
        </h3>
        <dl className="divide-y divide-border">
          <Row label="Status" value={conversation.status} />
          <Row label="Priority" value={conversation.priority} />
          <Row label="Channel" value={conversation.channel} />
          <Row label="Started" value={new Date(conversation.startedAt).toLocaleString()} />
        </dl>
      </section>
    </div>
  );
}
