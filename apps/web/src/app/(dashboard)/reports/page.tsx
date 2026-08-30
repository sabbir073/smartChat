'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import { BarChart } from '@/components/reports/bar-chart';
import {
  Alert,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Select,
  Spinner,
} from '@/components/ui';
import type {
  PropertyDto,
  ReportAgentDto,
  ReportArticleDto,
  ReportOverviewDto,
} from '@/lib/types';

const RANGES = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
] as const;

/** `YYYY-MM-DD`, n days back from today. Days, not instants — the API asks for days. */
function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A duration a person can read.
 *
 * Deliberately coarse: "4m 12s" is useful, "252 seconds" makes the reader do arithmetic, and
 * "4.2 minutes" implies a precision that an average over eleven conversations does not have.
 */
function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
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

export default function ReportsPage() {
  const { activeAccount, can } = useAuth();
  const canView = can('report:view');

  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30');
  const [propertyId, setPropertyId] = useState('');
  const [properties, setProperties] = useState<PropertyDto[]>([]);
  const [overview, setOverview] = useState<ReportOverviewDto | null>(null);
  const [agents, setAgents] = useState<ReportAgentDto[]>([]);
  const [articles, setArticles] = useState<ReportArticleDto[]>([]);
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
    const from = dayOffset(Number(range) - 1);
    const to = dayOffset(0);
    try {
      const [overviewResult, agentResult, articleResult] = await Promise.all([
        api.get<ReportOverviewDto>('/reports/overview', {
          query: { from, to, ...(propertyId ? { propertyId } : {}) },
        }),
        api.get<ReportAgentDto[]>('/reports/agents', { query: { from, to } }),
        api.get<ReportArticleDto[]>('/reports/articles', {
          query: { limit: 5, ...(propertyId ? { propertyId } : {}) },
        }),
      ]);
      setOverview(overviewResult.data);
      setAgents(agentResult.data);
      setArticles(articleResult.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Reports could not be loaded.');
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
    () =>
      (overview?.series ?? []).map((point) => ({
        label: point.day,
        values: [point.conversationsStarted, point.ticketsOpened],
      })),
    [overview],
  );

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader title="Reports" />
        <EmptyState
          title="You do not have access to reports"
          description="Ask an owner or administrator of this account if you need it."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Reports"
        description={
          overview
            ? `${overview.from} to ${overview.to}, in ${overview.timezone}.`
            : 'How much came in, how fast it was answered, and by whom.'
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
      ) : !overview ? (
        <EmptyState title="Nothing to report yet" />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Conversations"
              value={String(overview.totals.conversationsStarted)}
              hint={`${overview.totals.conversationsClosed} closed`}
            />
            <Metric
              label="First reply"
              value={duration(overview.totals.averageFirstResponseSeconds)}
              hint={
                overview.totals.firstResponseCount > 0
                  ? `across ${overview.totals.firstResponseCount} answered`
                  : 'nothing answered in this range'
              }
            />
            <Metric
              label="Tickets"
              value={String(overview.totals.ticketsOpened)}
              hint={`${overview.totals.ticketsResolved} resolved`}
            />
            <Metric
              label="New visitors"
              value={String(overview.totals.newVisitors)}
              hint={`${overview.totals.engagedVisitors} started a chat`}
            />
          </div>

          <Card>
            <CardHeader
              title="By day"
              description="Every day in the range, including the quiet ones."
            />
            <CardBody>
              <BarChart
                bars={bars}
                seriesNames={['conversations', 'tickets']}
                colours={['var(--color-brand)', 'var(--color-warning)']}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="By person"
              description="Replies sent, conversations closed, and how quickly each first answer came."
            />
            <CardBody className="px-0 py-0">
              {agents.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-muted">
                  Nobody sent anything in this range.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[13px] text-ink-muted">
                      <th className="px-5 py-2.5 font-medium">Person</th>
                      <th className="px-5 py-2.5 text-right font-medium">Replies</th>
                      <th className="px-5 py-2.5 text-right font-medium">Ticket replies</th>
                      <th className="px-5 py-2.5 text-right font-medium">Closed</th>
                      <th className="px-5 py-2.5 text-right font-medium">First reply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((agent) => (
                      <tr key={agent.memberId} className="border-b border-border last:border-0">
                        <td className="px-5 py-2.5 text-ink">{agent.name}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-ink-muted">
                          {agent.messagesSent}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-ink-muted">
                          {agent.ticketRepliesSent}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-ink-muted">
                          {agent.conversationsClosed}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-ink-muted">
                          {duration(agent.averageFirstResponseSeconds)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Most-read articles"
              description="Counted on public reads only, for the whole life of the article rather than this range."
            />
            <CardBody className="px-0 py-0">
              {articles.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-muted">
                  No articles yet. The help centre is where a question gets answered once.
                </p>
              ) : (
                <ul>
                  {articles.map((article) => (
                    <li
                      key={article.id}
                      className="flex items-center justify-between gap-4 border-b border-border px-5 py-2.5 last:border-0"
                    >
                      <span className="min-w-0 truncate text-sm text-ink">
                        {article.title}
                        {article.status !== 'published' && (
                          <span className="ml-2 text-[12px] text-ink-subtle">draft</span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-sm text-ink-muted">
                        {article.viewCount}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <p className="text-[13px] text-ink-subtle">
            Figures are rebuilt from the underlying conversations every fifteen minutes, so the
            last few minutes of today may not be counted yet.
          </p>
        </div>
      )}
    </div>
  );
}
