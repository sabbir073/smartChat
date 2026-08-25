'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { useResource } from '@/lib/use-resource';
import { PageHeader } from '@/components/layout/page-header';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  TextInput,
  useToast,
} from '@/components/ui';

interface AccountResponse {
  account: { id: string; name: string; slug: string; timezone: string; locale: string };
  plan: { code: string; name: string };
  limits: Record<string, number | null>;
  permissions: string[];
  role: string;
}

interface SessionDto {
  id: string;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

function shortAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

export default function SettingsPage() {
  const { user, activeAccount, refresh } = useAuth();
  const toast = useToast();

  const account = useResource<AccountResponse>(
    (signal) => api.get<AccountResponse>('/account', { signal }).then((r) => r.data),
    [activeAccount?.id],
  );
  const sessions = useResource<{ sessions: SessionDto[] }>(
    (signal) =>
      api.get<{ sessions: SessionDto[] }>('/auth/sessions', { signal }).then((r) => r.data),
    [],
  );

  const [accountName, setAccountName] = useState('');
  const [savingAccount, setSavingAccount] = useState(false);

  const [profileName, setProfileName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (account.data) setAccountName(account.data.account.name);
  }, [account.data]);

  useEffect(() => {
    if (user) setProfileName(user.name);
  }, [user]);

  const canManageAccount = account.data?.permissions.includes('account:update') ?? false;

  async function saveAccount(event: FormEvent) {
    event.preventDefault();
    setSavingAccount(true);
    try {
      await api.patch('/account', { name: accountName });
      account.reload();
      toast.success('Workspace updated');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save.');
    } finally {
      setSavingAccount(false);
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await api.patch('/auth/profile', { name: profileName });
      await refresh();
      toast.success('Profile updated');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setSavingPassword(true);
    setPasswordError(null);
    setPasswordErrors({});
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      sessions.reload();
      toast.success('Password changed. Other devices were signed out.');
    } catch (error) {
      if (error instanceof ApiError) {
        setPasswordErrors(error.fieldErrors());
        setPasswordError(error.message);
      } else {
        setPasswordError('Could not change your password.');
      }
    } finally {
      setSavingPassword(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api.delete(`/auth/sessions/${id}`);
      sessions.reload();
      toast.success('Session signed out');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not sign that session out.');
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Your workspace, your profile and your security." />

      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Workspace"
            description={
              account.data
                ? `Plan: ${account.data.plan.name} · Your role: ${account.data.role}`
                : undefined
            }
          />
          <form onSubmit={saveAccount}>
            <CardBody className="space-y-4">
              <Field
                label="Workspace name"
                hint={canManageAccount ? undefined : 'Only owners and admins can change this.'}
              >
                {({ id, describedBy }) => (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    value={accountName}
                    onChange={(event) => setAccountName(event.target.value)}
                    disabled={!canManageAccount || account.loading}
                  />
                )}
              </Field>
            </CardBody>
            {canManageAccount && (
              <CardFooter>
                <Button type="submit" size="sm" loading={savingAccount}>
                  Save changes
                </Button>
              </CardFooter>
            )}
          </form>
        </Card>

        <Card>
          <CardHeader title="Your profile" description={user?.email} />
          <form onSubmit={saveProfile}>
            <CardBody className="space-y-4">
              <Field label="Display name">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                  />
                )}
              </Field>
              {user && !user.emailVerified && (
                <Alert tone="warning">Your email address is not verified yet.</Alert>
              )}
            </CardBody>
            <CardFooter>
              <Button type="submit" size="sm" loading={savingProfile}>
                Save profile
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Password"
            description="Changing your password signs out every other device immediately."
          />
          <form onSubmit={changePassword}>
            <CardBody className="space-y-4">
              {passwordError && <Alert tone="danger">{passwordError}</Alert>}
              <Field label="Current password" error={passwordErrors['currentPassword']} required>
                {({ id, describedBy, invalid }) => (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    type="password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                )}
              </Field>
              <Field label="New password" error={passwordErrors['newPassword']} required>
                {({ id, describedBy, invalid }) => (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    type="password"
                    autoComplete="new-password"
                    required
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                )}
              </Field>
            </CardBody>
            <CardFooter>
              <Button type="submit" size="sm" loading={savingPassword}>
                Change password
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Active sessions"
            description="Every device currently signed in to your account."
          />
          {sessions.loading ? (
            <CardBody className="space-y-2">
              <div className="skeleton h-5 w-2/3" />
              <div className="skeleton h-5 w-1/2" />
            </CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {sessions.data?.sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex items-center justify-between gap-4 px-5 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink">
                      {shortAgent(session.userAgent)}
                      {session.current && <Badge tone="brand">This device</Badge>}
                    </p>
                    <p className="mt-0.5 text-[13px] text-ink-subtle">
                      {session.ip ?? 'Unknown address'} · last active{' '}
                      {new Date(session.lastSeenAt).toLocaleString()}
                    </p>
                  </div>
                  {!session.current && (
                    <Button variant="ghost" size="sm" onClick={() => void revoke(session.id)}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
