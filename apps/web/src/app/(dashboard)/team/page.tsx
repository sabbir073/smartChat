'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  Select,
  TextInput,
  useToast,
} from '@/components/ui';
import type { DepartmentDto, InvitationDto, MemberDto, PropertyDto, RoleDto } from '@/lib/types';
import { CheckboxGroup } from '@/components/team/checkbox-group';
import { MemberScopeEditor } from '@/components/team/member-scope-editor';
import { DepartmentManager } from '@/components/team/department-manager';

const ROLES = ['owner', 'admin', 'manager', 'agent'] as const;
type BaseRole = (typeof ROLES)[number];

const ROLE_TONE: Record<string, 'brand' | 'neutral'> = { owner: 'brand', admin: 'brand' };

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export default function TeamPage() {
  const { activeAccount, user, can } = useAuth();
  const toast = useToast();

  // What this person may actually do. The API decides for real; this decides what to draw, so
  // nobody is offered a control that answers 403 when they press it.
  const canViewTeam = can('member:view');
  const canInvite = can('member:invite');
  const canEditMembers = can('member:update');

  const [members, setMembers] = useState<MemberDto[]>([]);
  const [invitations, setInvitations] = useState<InvitationDto[]>([]);
  const [properties, setProperties] = useState<PropertyDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<MemberDto | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!canViewTeam) {
        setLoading(false);
        return;
      }
      setError(null);
      try {
        const options = signal ? { signal } : {};
        const [memberResult, inviteResult, propertyResult, departmentResult, roleResult] =
          await Promise.all([
            api.get<{ members: MemberDto[] }>('/team/members', options),
            api.get<{ invitations: InvitationDto[] }>('/team/invitations', options),
            api.get<PropertyDto[]>('/properties', options),
            api.get<DepartmentDto[]>('/team/departments', options),
            api.get<{ roles: RoleDto[] }>('/team/roles', options),
          ]);
        setMembers(memberResult.data.members);
        setInvitations(inviteResult.data.invitations);
        setProperties(propertyResult.data);
        setDepartments(departmentResult.data);
        setRoles(roleResult.data.roles);
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return;
        setError(caught instanceof ApiError ? caught.message : 'The team could not be loaded');
      } finally {
        setLoading(false);
      }
    },
    [canViewTeam],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, activeAccount?.id]);

  async function act<T>(id: string, run: () => Promise<T>, failure: string) {
    setBusyId(id);
    try {
      await run();
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : failure);
    } finally {
      setBusyId(null);
    }
  }

  if (!canViewTeam) {
    return (
      <>
        <PageHeader title="Team" description="Who can reach this workspace." />
        <Card>
          <EmptyState
            title="Only administrators can see the team"
            description="Your account can work conversations but cannot see or change who else has access. Ask an owner or admin if you need that."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Team"
        description="Who can reach this workspace, what they may do, and which websites they see."
        action={
          canInvite ? (
            <Button onClick={() => setInviteOpen(true)}>Invite someone</Button>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      {invitations.length > 0 && (
        <Card className="mb-6">
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold text-ink">Pending invitations</h2>
            <p className="mt-0.5 text-[13px] text-ink-subtle">
              Nobody here has access yet. They join when they follow the link in their email.
            </p>
          </div>
          <ul className="divide-y divide-border">
            {invitations.map((invitation) => {
              const lapsed = invitation.expiresAt === '';
              return (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{invitation.email}</p>
                    <p className="text-[12px] text-ink-subtle">
                      Invited as {invitation.baseRole}
                      {invitation.invitedByName ? ` by ${invitation.invitedByName}` : ''}
                      {lapsed
                        ? ' · the link has expired'
                        : ` · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {lapsed && <Badge tone="warning">Expired</Badge>}
                    <Button
                      variant="secondary"
                      disabled={busyId === invitation.id}
                      onClick={() =>
                        void act(
                          invitation.id,
                          async () => {
                            await api.post(`/team/invitations/${invitation.id}/resend`);
                            toast.success('Invitation sent again');
                          },
                          'The invitation could not be resent',
                        )
                      }
                    >
                      Resend
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busyId === invitation.id}
                      onClick={() =>
                        void act(
                          invitation.id,
                          async () => {
                            await api.delete(`/team/invitations/${invitation.id}`);
                            toast.success('Invitation revoked');
                          },
                          'The invitation could not be revoked',
                        )
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="mb-6">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">Members</h2>
        </div>
        {loading ? (
          <div className="space-y-3 p-5">
            <div className="skeleton h-5 w-1/3" />
            <div className="skeleton h-5 w-1/2" />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {members.map((member) => {
              const scope = member.restrictedToProperties
                ? member.propertyIds.length === 0
                  ? 'No websites'
                  : member.propertyIds
                      .map(
                        (id) =>
                          properties.find((property) => property.id === id)?.name ?? 'Unknown',
                      )
                      .join(', ')
                : 'All websites';

              return (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand">
                      {initials(member.displayName ?? member.name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {member.displayName ?? member.name}
                        {member.userId === user?.id && (
                          <span className="ml-1.5 text-[12px] font-normal text-ink-subtle">
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="truncate text-[13px] text-ink-subtle">{member.email}</p>
                      <p className="mt-0.5 truncate text-[12px] text-ink-subtle">{scope}</p>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {member.status !== 'active' && (
                      <Badge tone={member.status === 'invited' ? 'warning' : 'neutral'}>
                        {member.status}
                      </Badge>
                    )}
                    {/* Only when it actually says something the base role does not. An account
                        whose custom role is simply called "Owner" should not read "Owner owner". */}
                    {member.customRole &&
                      member.customRole.name.toLowerCase() !== member.role.toLowerCase() && (
                        <Badge tone="neutral">{member.customRole.name}</Badge>
                      )}
                    <Badge tone={ROLE_TONE[member.role] ?? 'neutral'}>{member.role}</Badge>
                    {canEditMembers && (
                      <Button variant="secondary" onClick={() => setEditing(member)}>
                        Manage
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <DepartmentManager
        readOnly={!canEditMembers}
        departments={departments}
        onChanged={() => void load()}
        onError={(message) => toast.error(message)}
        onSuccess={(message) => toast.success(message)}
      />

      <InviteModal
        open={inviteOpen}
        properties={properties}
        departments={departments}
        roles={roles}
        onClose={() => setInviteOpen(false)}
        onInvited={() => {
          setInviteOpen(false);
          toast.success('Invitation sent');
          void load();
        }}
      />

      {editing && (
        <MemberScopeEditor
          member={editing}
          properties={properties}
          departments={departments}
          roles={roles}
          isSelf={editing.userId === user?.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('Member updated');
            void load();
          }}
          onRemoved={() => {
            setEditing(null);
            toast.success('Member removed');
            void load();
          }}
          onError={(message) => toast.error(message)}
        />
      )}
    </>
  );
}

function InviteModal({
  open,
  properties,
  departments,
  roles,
  onClose,
  onInvited,
}: {
  open: boolean;
  properties: PropertyDto[];
  departments: DepartmentDto[];
  roles: RoleDto[];
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [baseRole, setBaseRole] = useState<BaseRole>('agent');
  const [roleId, setRoleId] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setBaseRole('agent');
    setRoleId('');
    setRestricted(false);
    setPropertyIds([]);
    setDepartmentIds([]);
    setFormError(null);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post('/team/members', {
        email,
        baseRole,
        ...(roleId ? { roleId } : {}),
        restrictedToProperties: restricted,
        propertyIds: restricted ? propertyIds : [],
        departmentIds,
      });
      onInvited();
    } catch (caught) {
      setFormError(
        caught instanceof ApiError ? caught.message : 'The invitation could not be sent',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Invite someone">
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}

        <Field label="Email address" required>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              type="email"
              required
              autoComplete="off"
              value={email}
              aria-describedby={describedBy}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="colleague@example.com"
            />
          )}
        </Field>

        <Field label="Role" hint="What they can do across the whole workspace.">
          {({ id }) => (
            <Select
              id={id}
              value={baseRole}
              onChange={(event) => setBaseRole(event.target.value as BaseRole)}
            >
              {ROLES.map((role) => (
                <option key={role} value={role} className="capitalize">
                  {role}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {roles.length > 0 && (
          <Field
            label="Custom role"
            hint="Optional. Overrides the permissions the role above implies."
          >
            {({ id }) => (
              <Select id={id} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                <option value="">None</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={restricted}
            onChange={(event) => setRestricted(event.target.checked)}
            className="mt-0.5 size-4"
          />
          <span>
            Limit them to specific websites
            <span className="block text-[12px] text-ink-subtle">
              They will not see conversations from any other website, even by direct link.
            </span>
          </span>
        </label>

        {restricted && (
          <CheckboxGroup
            label="Websites"
            empty="You have no websites yet."
            options={properties.map((property) => ({ id: property.id, label: property.name }))}
            selected={propertyIds}
            onChange={setPropertyIds}
          />
        )}

        {departments.length > 0 && (
          <CheckboxGroup
            label="Departments"
            empty=""
            options={departments.map((department) => ({
              id: department.id,
              label: department.name,
            }))}
            selected={departmentIds}
            onChange={setDepartmentIds}
          />
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={email.trim() === ''}>
            Send invitation
          </Button>
        </div>
      </form>
    </Modal>
  );
}
