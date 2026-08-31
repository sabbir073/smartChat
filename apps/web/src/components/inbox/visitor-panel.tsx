'use client';

import { useState } from 'react';
import { Badge, Button, Field, Modal, Select, TextInput, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import type { ConversationDto } from '@/lib/types';

/** Offered lengths. "Permanent" is the absence of an end, not a date a century away. */
const BAN_LENGTHS = [
  { value: '24', label: '24 hours' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
  { value: '', label: 'Permanently' },
];

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
  onVisitorChanged,
}: {
  conversation: ConversationDto;
  online: boolean;
  currentUrl: string | null;
  /** Lets the inbox refresh, so the badge and the button agree with the server. */
  onVisitorChanged?: () => void;
}) {
  const { visitor } = conversation;
  const { can } = useAuth();
  const toast = useToast();
  const [banOpen, setBanOpen] = useState(false);
  const [hours, setHours] = useState('24');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // The same right that lets somebody edit a person's record. An agent handling a queue does not
  // get to decide who is allowed to come back; a manager does. See ADR-083.
  const mayModerate = can('contact:update');

  async function submitBan() {
    setBusy(true);
    try {
      const until =
        hours === '' ? null : new Date(Date.now() + Number(hours) * 3_600_000).toISOString();
      await api.post(`/visitors/${visitor.id}/ban`, {
        until,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success(until ? 'Visitor banned until that time' : 'Visitor banned permanently');
      setBanOpen(false);
      setReason('');
      onVisitorChanged?.();
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : 'That visitor could not be banned.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function lift() {
    setBusy(true);
    try {
      await api.delete(`/visitors/${visitor.id}/ban`);
      toast.success('Ban lifted');
      onVisitorChanged?.();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'The ban could not be lifted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 p-4">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold text-ink">
            {visitor.name ?? 'Unidentified visitor'}
          </h2>
          {visitor.isBanned ? (
            <Badge tone="danger">Banned</Badge>
          ) : online ? (
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

      {mayModerate && (
        <section>
          <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">
            Moderation
          </h3>
          {visitor.isBanned ? (
            <>
              <p className="mb-2 text-[13px] text-ink-muted">
                {visitor.bannedUntil
                  ? `Banned until ${new Date(visitor.bannedUntil).toLocaleString()}.`
                  : 'Banned permanently.'}
              </p>
              <Button variant="secondary" onClick={lift} disabled={busy}>
                Lift ban
              </Button>
            </>
          ) : (
            <>
              <p className="mb-2 text-[13px] text-ink-muted">
                A banned visitor cannot start or continue a chat from this browser. It takes effect
                on their next request, and it is recorded in the audit log.
              </p>
              <Button variant="danger" onClick={() => setBanOpen(true)} disabled={busy}>
                Ban visitor
              </Button>
            </>
          )}
        </section>
      )}

      <Modal
        open={banOpen}
        onClose={() => setBanOpen(false)}
        title="Ban this visitor"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBanOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submitBan} disabled={busy}>
              {busy ? 'Banning…' : 'Ban visitor'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="For how long">
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              >
                {BAN_LENGTHS.map((option) => (
                  <option key={option.label} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Reason (optional)"
            hint="Recorded in the audit log. The visitor is never told why."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                placeholder="Abusive language"
              />
            )}
          </Field>
        </div>
      </Modal>
    </div>
  );
}
