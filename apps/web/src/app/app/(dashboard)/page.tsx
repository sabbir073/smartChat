'use client';

import Link from 'next/link';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { useResource } from '@/lib/use-resource';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/components/ui';
import type { MemberDto, PropertyDto } from '@/lib/types';

interface AccountResponse {
  account: { id: string; name: string; slug: string; timezone: string };
  plan: { code: string; name: string };
  limits: Record<string, number | null>;
  permissions: string[];
  role: string;
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardBody>
        <p className="text-[13px] font-medium text-ink-muted">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-ink tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-[12px] text-ink-subtle">{hint}</p>}
      </CardBody>
    </Card>
  );
}

export default function OverviewPage() {
  const { user, activeAccount } = useAuth();

  const account = useResource<AccountResponse>(
    (signal) => api.get<AccountResponse>('/account', { signal }).then((result) => result.data),
    [activeAccount?.id],
  );

  const properties = useResource<PropertyDto[]>(
    (signal) =>
      api.get<PropertyDto[]>('/properties', { signal, query: { limit: 5 } }).then((r) => r.data),
    [activeAccount?.id],
  );

  // Only what the caller is actually allowed to read. An agent has no MEMBER_VIEW permission, so
  // the tile below reports what it knows rather than showing an error for a stat.
  const members = useResource<{ members: MemberDto[] } | null>(
    (signal) =>
      api
        .get<{ members: MemberDto[] }>('/team/members', { signal })
        .then((result) => result.data)
        .catch(() => null),
    [activeAccount?.id],
  );

  /**
   * Three states, not two: a number, "unlimited", and "we were not allowed to ask".
   *
   * `/account` needs `account:view`, which an agent does not have, so for them this request is a
   * 403 and `account.data` is null. Collapsing that into `null` and printing "Unlimited on your
   * plan" told every agent in the product that their plan had no limit on websites — which is
   * both false and false in the expensive direction. The card now says nothing when it does not
   * know, which is the honest answer and the one the neighbouring "Only administrators can see
   * the team" hint already gives.
   */
  const limitsVisible = account.data !== null;
  const propertyLimit = account.data?.limits['max_properties'] ?? null;
  const memberCount = members.data?.members.length ?? null;
  const pendingCount =
    members.data?.members.filter((member) => member.status === 'invited').length ?? 0;
  const count = properties.data?.length ?? 0;
  const installed = properties.data?.filter((property) => property.installed).length ?? 0;

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.name?.split(' ')[0] ?? 'there'}`}
        description={
          activeAccount ? `${activeAccount.name} · ${account.data?.plan.name ?? ''}` : undefined
        }
      />

      {user && !user.emailVerified && (
        <div className="mb-6">
          <Alert tone="warning" title="Confirm your email address">
            Some actions stay locked until your address is verified.{' '}
            <Link href="/verify-email" className="font-medium text-brand hover:underline">
              Resend the link
            </Link>
            .
          </Alert>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Websites"
          value={properties.loading ? '—' : count}
          hint={
            !limitsVisible
              ? undefined
              : propertyLimit === null
                ? 'Unlimited on your plan'
                : `${propertyLimit} on your plan`
          }
        />
        <Stat
          label="Widgets installed"
          value={properties.loading ? '—' : installed}
          hint={installed < count ? `${count - installed} waiting for the snippet` : 'All verified'}
        />
        <Stat
          label="Team members"
          value={members.loading || memberCount === null ? '—' : memberCount}
          hint={
            memberCount === null
              ? 'Only administrators can see the team'
              : pendingCount > 0
                ? `${pendingCount} invitation${pendingCount === 1 ? '' : 's'} not accepted yet`
                : 'Everyone has accepted'
          }
        />
      </div>

      <Card>
        <CardHeader
          title="Your websites"
          description="Each website gets its own widget, agents and conversations."
          action={
            <Link href="/app/properties">
              <Button variant="secondary" size="sm">
                View all
              </Button>
            </Link>
          }
        />

        {properties.loading ? (
          <CardBody className="space-y-3">
            <div className="skeleton h-5 w-1/3" />
            <div className="skeleton h-5 w-1/2" />
          </CardBody>
        ) : properties.error ? (
          <CardBody>
            <Alert tone="danger" title="Could not load your websites">
              {properties.error.message}
            </Alert>
          </CardBody>
        ) : count === 0 ? (
          <EmptyState
            title="No websites yet"
            description="Add your first website to generate a chat widget and its installation snippet."
            action={
              <Link href="/app/properties">
                <Button>Add a website</Button>
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {properties.data?.map((property) => (
              <li key={property.id}>
                <Link
                  href={`/app/properties/${property.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-surface-raised"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{property.name}</p>
                    <p className="truncate text-[13px] text-ink-subtle">{property.websiteUrl}</p>
                  </div>
                  {property.installed ? (
                    <Badge tone="success" dot>
                      Installed
                    </Badge>
                  ) : (
                    <Badge tone="warning" dot>
                      Not installed
                    </Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
