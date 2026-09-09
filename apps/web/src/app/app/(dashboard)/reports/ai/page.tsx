'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import { BarChart } from '@/components/reports/bar-chart';
import { Alert, Card, CardBody, CardHeader, EmptyState, Select, Spinner } from '@/components/ui';
import type { PropertyDto } from '@/lib/types';
import type { AiReport } from '@/lib/ai';

const RANGES = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
] as const;

function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4">
      <div className="text-[13px] font-medium text-ink-muted">{label}</div>
      <div className="mt-1 text-[26px] font-semibold leading-none text-ink">{value}</div>
      {hint && <div className="mt-1.5 text-[12px] text-ink-subtle">{hint}</div>}
    </div>
  );
}

/**
 * How the AI assistant is doing.
 *
 * The number at the top is deflection: conversations the assistant handled that never needed a
 * person. The list at the bottom is the one that changes what the owner does next - the
 * questions it could not answer, most-asked first. Each of those is a paragraph to add to Key
 * facts or a page to write.
 */
export default function AiReportPage() {
  const { activeAccount, can } = useAuth();
  const canView = can('report:view');

  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30');
  const [propertyId, setPropertyId] = useState('');
  const [properties, setProperties] = useState<PropertyDto[]>([]);
  const [report, setReport] = useState<AiReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    void api
      .get<PropertyDto[]>('/properties')
      .then((result) => setProperties(result.data))
      .catch(() => setProperties([]));
  }, [canView, activeAccount?.id]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<AiReport>('/reports/ai', {
        query: { from: dayOffset(Number(range) - 1), to: dayOffset(0), ...(propertyId ? { propertyId } : {}) },
      });
      setReport(result.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The report could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [range, propertyId]);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, canView, activeAccount?.id]);

  const bars = useMemo(
    () => (report?.series ?? []).map((point) => ({ label: point.day, values: [point.answers, point.ticketOffers, point.handoffs] })),
    [report],
  );

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader title="AI assistant" />
        <EmptyState title="You do not have access to reports" description="Ask an owner or administrator of this account if you need it." />
      </div>
    );
  }

  const totals = report?.totals;

  return (
    <div className="p-6">
      <PageHeader
        title="AI assistant"
        description={report ? `${report.from} to ${report.to}, in ${report.timezone}.` : 'What the assistant answered, what it could not, and what visitors thought.'}
        action={
          <Link href="/app/reports" className="text-sm font-medium text-brand hover:underline">
            All reports
          </Link>
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="mb-5 flex flex-wrap gap-3">
        <div className="w-44">
          <Select value={range} onChange={(event) => setRange(event.target.value as typeof range)}>
            {RANGES.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-64">
          <Select value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
            <option value="">All websites</option>
            {properties.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !report || !totals ? (
        <EmptyState title="Nothing to report yet" />
      ) : totals.replies === 0 && totals.drafts === 0 ? (
        <EmptyState
          title="The assistant has not answered anything in this range"
          description="Switch a website to an AI mode on its AI agent page and the numbers appear here."
        />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Handled without a person"
              value={percent(totals.deflectionRate)}
              hint={`${totals.deflected} of ${totals.conversations} conversations: no reply from the team, no handoff, no ticket`}
            />
            <Metric
              label="Replies"
              value={String(totals.replies)}
              hint={`${totals.answers} answered from your content · ${totals.chats} chatted`}
            />
            <Metric
              label="Could not answer"
              value={String(totals.ticketOffers + totals.failed)}
              hint={`${totals.ticketOffers} offered a ticket · ${totals.handoffs} handed to a person${totals.failed ? ` · ${totals.failed} failed` : ''}`}
            />
            <Metric
              label="Rated helpful"
              value={
                totals.ratedUp + totals.ratedDown > 0
                  ? percent(totals.ratedUp / (totals.ratedUp + totals.ratedDown))
                  : '—'
              }
              hint={`${totals.ratedUp} up · ${totals.ratedDown} down · replies in ${seconds(totals.averageLatencyMs)}${totals.fellBack ? ` · ${totals.fellBack} by the fallback provider` : ''}${totals.drafts ? ` · ${totals.drafts} drafts for agents` : ''}`}
            />
          </div>

          <Card>
            <CardHeader title="By day" description="Answers from your content, ticket offers, and handoffs to a person." />
            <CardBody>
              <BarChart
                bars={bars}
                seriesNames={['answered', 'ticket offered', 'handed off']}
                colours={['var(--color-brand)', 'var(--color-warning)', 'var(--color-ink-subtle)']}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What it could not answer"
              description="The questions that ended in a ticket offer, most-asked first. Each one is something to add to Key facts, a page, or a file."
            />
            <CardBody className="px-0 py-0">
              {report.unanswered.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-muted">Nothing went unanswered in this range.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[13px] text-ink-muted">
                      <th className="px-5 py-2.5 font-medium">Question</th>
                      <th className="px-5 py-2.5 text-right font-medium">Asked</th>
                      <th className="px-5 py-2.5 text-right font-medium">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.unanswered.map((row, i) => (
                      <tr key={`${row.question}-${i}`} className="border-b border-border last:border-0">
                        <td className="px-5 py-2.5 text-ink">
                          {row.question}
                          {row.outcome === 'failed' && <span className="ml-2 text-[12px] text-danger">model failed</span>}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-ink-muted">{row.count}</td>
                        <td className="px-5 py-2.5 text-right text-[13px] text-ink-subtle">{new Date(row.lastAskedAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          {report.unhelpful.length > 0 && (
            <Card>
              <CardHeader title="Rated not helpful" description="Replies a visitor gave a thumbs down. Read the conversation to see why." />
              <CardBody className="px-0 py-0">
                <ul className="divide-y divide-border">
                  {report.unhelpful.map((row) => (
                    <li key={`${row.conversationId}-${row.at}`} className="px-5 py-3 text-sm">
                      <p className="text-ink">
                        <span className="text-ink-subtle">Visitor:</span> {row.question}
                      </p>
                      <p className="mt-1 text-ink-muted">
                        <span className="text-ink-subtle">Assistant:</span> {row.reply}
                      </p>
                      <p className="mt-1 text-[12px] text-ink-subtle">
                        {new Date(row.at).toLocaleString()} ·{' '}
                        <Link href={`/app/inbox?conversation=${row.conversationId}`} className="text-brand hover:underline">
                          Open the conversation
                        </Link>
                      </p>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
