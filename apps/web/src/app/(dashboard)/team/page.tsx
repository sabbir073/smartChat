'use client';

import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { useResource } from '@/lib/use-resource';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, Badge, Card } from '@/components/ui';
import type { MemberDto } from '@/lib/types';

const ROLE_TONE: Record<string, 'brand' | 'neutral'> = {
  owner: 'brand',
  admin: 'brand',
};

export default function TeamPage() {
  const { activeAccount } = useAuth();

  const members = useResource<{ members: MemberDto[] }>(
    (signal) =>
      api.get<{ members: MemberDto[] }>('/account/members', { signal }).then((r) => r.data),
    [activeAccount?.id],
  );

  return (
    <>
      <PageHeader title="Team" description="Everyone with access to this workspace." />

      <div className="mb-6">
        <Alert tone="info" title="Invitations arrive in Phase 5">
          You can see the current team here now. Inviting agents, editing roles and scoping people
          to individual websites are the next steps in the roadmap - they are not shown as controls
          until they actually work.
        </Alert>
      </div>

      <Card>
        {members.loading ? (
          <div className="space-y-3 p-5">
            <div className="skeleton h-5 w-1/3" />
            <div className="skeleton h-5 w-1/2" />
          </div>
        ) : members.error ? (
          <div className="p-5">
            <Alert tone="danger" title="Could not load the team">
              {members.error.message}
            </Alert>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {members.data?.members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand">
                    {member.name
                      .split(' ')
                      .slice(0, 2)
                      .map((part) => part.charAt(0).toUpperCase())
                      .join('')}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {member.displayName ?? member.name}
                    </p>
                    <p className="truncate text-[13px] text-ink-subtle">{member.email}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {member.status !== 'active' && <Badge tone="neutral">{member.status}</Badge>}
                  <Badge tone={ROLE_TONE[member.role] ?? 'neutral'}>{member.role}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
