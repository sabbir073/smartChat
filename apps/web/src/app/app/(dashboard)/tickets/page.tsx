'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge, PriorityBadge } from '@/components/tickets/badges';
import {
  Alert,
  Button,
  Card,
  CardBody,
  EmptyState,
  Select,
  Spinner,
  TextInput,
  cn,
} from '@/components/ui';
import type { TicketDto } from '@/lib/types';

const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;

/** "3 days ago" beats a timestamp in a queue: the age is the thing an agent is judging. */
function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export default function TicketsPage() {
  const { activeAccount, can } = useAuth();
  const canView = can('ticket:view');

  const [tickets, setTickets] = useState<TicketDto[]>([]);
  const [status, setStatus] = useState<'' | (typeof STATUSES)[number]>('');
  const [assigned, setAssigned] = useState<'' | 'me' | 'unassigned'>('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<TicketDto[]>('/tickets', {
        query: {
          ...(status ? { status } : {}),
          ...(assigned ? { assigned } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
          limit: 50,
        },
      });
      setTickets(result.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Tickets could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [status, assigned, search]);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return undefined;
    }
    const timer = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, canView, search, activeAccount?.id]);

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader title="Tickets" />
        <EmptyState
          title="You do not have access to tickets"
          description="Ask an owner or administrator of this account if you need it."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Tickets"
        description="Requests that outlive a chat. Answered by email, so nobody has to be online at the same time."
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="w-80">
          <TextInput
            value={search}
            placeholder="Search subject, email, or #number"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="w-40">
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="">Any status</option>
            {STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry[0]?.toUpperCase()}
                {entry.slice(1)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select
            value={assigned}
            onChange={(event) => setAssigned(event.target.value as typeof assigned)}
          >
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : tickets.length === 0 ? (
        <EmptyState
          title={search || status || assigned ? 'Nothing matched' : 'No tickets yet'}
          description={
            search || status || assigned
              ? 'Try clearing the filters.'
              : 'A message left through the offline form becomes a ticket, so it can be answered by email later.'
          }
          action={
            search || status || assigned ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                  setAssigned('');
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {tickets.map((ticket) => (
            <Link key={ticket.id} href={`/app/tickets/${ticket.id}`} className="block">
              <Card className={cn('transition-colors hover:border-border-strong')}>
                <CardBody className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] text-ink-subtle">
                        #{ticket.number}
                      </span>
                      <h2 className="truncate text-[15px] font-semibold text-ink">
                        {ticket.subject}
                      </h2>
                      <StatusBadge status={ticket.status} />
                      <PriorityBadge priority={ticket.priority} />
                    </div>
                    <p className="mt-1 text-[13px] text-ink-subtle">
                      {ticket.requesterName ?? ticket.requesterEmail}
                      {' · '}
                      {age(ticket.lastMessageAt)}
                      {ticket.assignedMemberName ? ` · ${ticket.assignedMemberName}` : ' · nobody'}
                    </p>
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
