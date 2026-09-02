'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import { PriorityBadge, StatusBadge } from '@/components/tickets/badges';
import { Alert, Button, Card, CardBody, Select, Spinner, cn, useToast } from '@/components/ui';
import type { MemberDto, TicketDto, TicketMessageDto } from '@/lib/types';

const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export default function TicketPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const toast = useToast();

  const id = params.id;
  const canManage = can('ticket:manage');

  const [ticket, setTicket] = useState<TicketDto | null>(null);
  const [messages, setMessages] = useState<TicketMessageDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [body, setBody] = useState('');
  /**
   * Which kind of message is being written.
   *
   * Deliberately a two-button choice that is always visible, never a checkbox tucked under the
   * composer. The difference between these two is "the customer reads this" and "the customer
   * never sees this", and an agent should be able to tell which one they are in without looking
   * for a tick.
   */
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [ticketResult, messageResult] = await Promise.all([
        api.get<TicketDto>(`/tickets/${id}`),
        api.get<TicketMessageDto[]>(`/tickets/${id}/messages`),
      ]);
      setTicket(ticketResult.data);
      setMessages(messageResult.data);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? 'That ticket does not exist, or is not yours to see.'
          : caught instanceof ApiError
            ? caught.message
            : 'The ticket could not be loaded.',
      );
    } finally {
      setLoading(false);
    }

    // Assignment needs the team list, which an agent may not be allowed to read. A refusal here
    // leaves the picker unavailable rather than breaking the page.
    void api
      .get<{ members: MemberDto[] }>('/account/members')
      .then((result) => setMembers(result.data.members))
      .catch(() => setMembers([]));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(input: Record<string, unknown>): Promise<void> {
    if (!ticket) return;
    try {
      const result = await api.patch<TicketDto>(`/tickets/${ticket.id}`, input);
      setTicket(result.data);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be changed.');
    }
  }

  async function send(): Promise<void> {
    if (!ticket || body.trim() === '') return;
    setSending(true);
    try {
      const result = await api.post<TicketMessageDto>(`/tickets/${ticket.id}/messages`, {
        body: body.trim(),
        visibility,
      });
      setMessages((current) => [...current, result.data]);
      setBody('');
      // Replying can move the status server-side, so the header is re-read rather than guessed.
      const refreshed = await api.get<TicketDto>(`/tickets/${ticket.id}`);
      setTicket(refreshed.data);
      toast.success(
        visibility === 'public'
          ? `Sent to ${ticket.requesterEmail}`
          : 'Note saved - not sent to the customer',
      );
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be sent.');
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center p-16">
        <Spinner />
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="p-6">
        <Alert tone="danger" className="mb-4">
          {error ?? 'The ticket could not be loaded.'}
        </Alert>
        <Button variant="secondary" onClick={() => router.push('/app/tickets')}>
          Back to tickets
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6">
      <Link href="/app/tickets" className="text-[13px] font-medium text-brand hover:underline">
        ← All tickets
      </Link>

      <PageHeader
        title={`#${ticket.number} ${ticket.subject}`}
        description={`${ticket.requesterName ? `${ticket.requesterName} · ` : ''}${ticket.requesterEmail}`}
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        {/*
          The badges are the read-only view of the same two facts the pickers below carry, so an
          agent who can change them sees the pickers instead. Showing both is a state and a control
          that always agree, which trains people to ignore the badge.
        */}
        {!canManage && (
          <>
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
          </>
        )}

        {canManage && (
          <>
            <div className="w-40">
              <Select
                aria-label="Status"
                value={ticket.status}
                onChange={(event) => void patch({ status: event.target.value })}
              >
                {STATUSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-36">
              <Select
                aria-label="Priority"
                value={ticket.priority}
                onChange={(event) => void patch({ priority: event.target.value })}
              >
                {PRIORITIES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            </div>
            {members.length > 0 && (
              <div className="w-56">
                <Select
                  aria-label="Assignee"
                  value={ticket.assignedMemberId ?? ''}
                  onChange={(event) => void patch({ assignedMemberId: event.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name ?? member.email}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </>
        )}

        {ticket.conversationId && (
          <Link
            href={`/app/inbox?conversation=${ticket.conversationId}`}
            className="text-[13px] font-medium text-brand hover:underline"
          >
            Open the original chat
          </Link>
        )}
      </div>

      <div className="space-y-3">
        {messages.map((message) => (
          <Card
            key={message.id}
            className={cn(message.visibility === 'internal' && 'border-warning/40 bg-warning-soft')}
          >
            <CardBody>
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-subtle">
                <span className="font-medium text-ink-muted">
                  {message.authorType === 'contact'
                    ? (ticket.requesterName ?? ticket.requesterEmail)
                    : message.authorType === 'agent'
                      ? 'Your team'
                      : 'SmartChat'}
                </span>
                <span>{new Date(message.createdAt).toLocaleString()}</span>
                {message.visibility === 'internal' && (
                  <span className="rounded-full bg-warning/20 px-2 py-0.5 font-medium text-warning">
                    internal note — not sent
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{message.body}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      {canManage && ticket.status !== 'closed' && (
        <Card className="mt-5">
          <CardBody>
            <div className="mb-3 flex gap-1" role="tablist" aria-label="Reply type">
              {(['public', 'internal'] as const).map((entry) => (
                <button
                  key={entry}
                  role="tab"
                  type="button"
                  aria-selected={visibility === entry}
                  onClick={() => setVisibility(entry)}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                    visibility === entry
                      ? entry === 'public'
                        ? 'bg-brand text-ink-inverted'
                        : 'bg-warning text-ink-inverted'
                      : 'text-ink-muted hover:bg-surface-raised',
                  )}
                >
                  {entry === 'public' ? 'Reply by email' : 'Internal note'}
                </button>
              ))}
            </div>

            <textarea
              rows={6}
              maxLength={20000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={
                visibility === 'public'
                  ? `This is emailed to ${ticket.requesterEmail}.`
                  : 'Only your team will ever see this.'
              }
              className={cn(
                'w-full resize-y rounded-[var(--radius-control)] border bg-surface px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-subtle',
                visibility === 'internal'
                  ? 'border-warning/50 bg-warning-soft'
                  : 'border-border-strong',
              )}
            />

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[13px] text-ink-subtle">
                {visibility === 'public'
                  ? `Goes to ${ticket.requesterEmail}.`
                  : 'Stays inside your account. Nothing is sent.'}
              </p>
              <Button onClick={() => void send()} loading={sending} disabled={body.trim() === ''}>
                {visibility === 'public' ? 'Send reply' : 'Save note'}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {ticket.status === 'closed' && (
        <Alert tone="info" className="mt-5">
          This ticket is closed. Reopen it to reply.
        </Alert>
      )}
    </div>
  );
}
