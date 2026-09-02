'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import { SecretOnce } from '@/components/integrations/secret-once';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Modal,
  Spinner,
  TextInput,
  cn,
  useToast,
} from '@/components/ui';
import type { ApiKeyDto, WebhookDeliveryDto, WebhookDto } from '@/lib/types';

const SCOPES = [
  'conversations:read',
  'contacts:read',
  'contacts:write',
  'tickets:read',
  'tickets:write',
  'articles:read',
  'articles:write',
  'reports:read',
] as const;

const EVENTS = [
  'conversation.started',
  'conversation.closed',
  'ticket.created',
  'ticket.replied',
  'ticket.status_changed',
  'ping',
] as const;

function CheckList({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {options.map((option) => (
        <label key={option} className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            className="size-4"
            checked={selected.includes(option)}
            onChange={() => onToggle(option)}
          />
          <span className="font-mono">{option}</span>
        </label>
      ))}
    </div>
  );
}

export default function IntegrationsPage() {
  const { activeAccount, can } = useAuth();
  const toast = useToast();

  const canView = can('account:view');
  const canManage = can('account:update');

  const [tab, setTab] = useState<'keys' | 'webhooks'>('keys');
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookDto[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDeliveryDto[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [keyDraft, setKeyDraft] = useState<{ name: string; scopes: string[] } | null>(null);
  const [hookDraft, setHookDraft] = useState<{
    name: string;
    url: string;
    events: string[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ title: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [keyResult, hookResult] = await Promise.all([
        api.get<ApiKeyDto[]>('/integrations/keys'),
        api.get<WebhookDto[]>('/integrations/webhooks'),
      ]);
      setKeys(keyResult.data);
      setWebhooks(hookResult.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Integrations could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, canView, activeAccount?.id]);

  async function createKey(): Promise<void> {
    if (!keyDraft) return;
    setSaving(true);
    setFormError(null);
    try {
      const result = await api.post<ApiKeyDto & { secretShownOnce: string }>('/integrations/keys', {
        name: keyDraft.name,
        scopes: keyDraft.scopes,
      });
      setKeys((current) => [result.data, ...current]);
      setKeyDraft(null);
      setRevealed({ title: 'Your new API key', secret: result.data.secretShownOnce });
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'That could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function revokeKey(key: ApiKeyDto): Promise<void> {
    try {
      await api.delete(`/integrations/keys/${key.id}`);
      await load();
      toast.success(`"${key.name}" revoked`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be revoked.');
    }
  }

  async function createWebhook(): Promise<void> {
    if (!hookDraft) return;
    setSaving(true);
    setFormError(null);
    try {
      const result = await api.post<WebhookDto & { secretShownOnce: string }>(
        '/integrations/webhooks',
        hookDraft,
      );
      setWebhooks((current) => [result.data, ...current]);
      setHookDraft(null);
      setRevealed({ title: 'Your signing secret', secret: result.data.secretShownOnce });
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'That could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleWebhook(webhook: WebhookDto): Promise<void> {
    try {
      const result = await api.patch<WebhookDto>(`/integrations/webhooks/${webhook.id}`, {
        enabled: !webhook.enabled,
      });
      setWebhooks((current) =>
        current.map((entry) => (entry.id === result.data.id ? result.data : entry)),
      );
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be changed.');
    }
  }

  async function ping(webhook: WebhookDto): Promise<void> {
    try {
      await api.post(`/integrations/webhooks/${webhook.id}/ping`);
      toast.success('Test queued - show the deliveries in a moment to see how it went');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be sent.');
    }
  }

  async function showDeliveries(webhook: WebhookDto): Promise<void> {
    try {
      const result = await api.get<WebhookDeliveryDto[]>(
        `/integrations/webhooks/${webhook.id}/deliveries`,
        { query: { limit: 10 } },
      );
      setDeliveries((current) => ({ ...current, [webhook.id]: result.data }));
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Those could not be loaded.');
    }
  }

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader title="Integrations" />
        <EmptyState
          title="You do not have access to integrations"
          description="Ask an owner or administrator of this account if you need it."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Integrations"
        description="Let other systems read from SmartChat, and be told when something happens."
        action={
          canManage ? (
            <Button
              onClick={() => {
                setFormError(null);
                if (tab === 'keys') setKeyDraft({ name: '', scopes: [] });
                else setHookDraft({ name: '', url: '', events: [] });
              }}
            >
              {tab === 'keys' ? 'New API key' : 'New webhook'}
            </Button>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="mb-5 flex gap-1" role="tablist" aria-label="Integrations">
        {(['keys', 'webhooks'] as const).map((entry) => (
          <button
            key={entry}
            role="tab"
            aria-selected={tab === entry}
            onClick={() => setTab(entry)}
            className={cn(
              'rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors',
              tab === entry ? 'bg-ink text-ink-inverted' : 'text-ink-muted hover:bg-surface-raised',
            )}
          >
            {entry === 'keys' ? 'API keys' : 'Webhooks'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : tab === 'keys' ? (
        keys.length === 0 ? (
          <EmptyState
            title="No API keys yet"
            description="A key lets another system read and write through the same API your dashboard uses, with only the access you give it."
          />
        ) : (
          <div className="space-y-2">
            {keys.map((key) => (
              <Card key={key.id} className={cn(key.revokedAt && 'opacity-60')}>
                <CardBody className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold text-ink">{key.name}</h3>
                      {key.revokedAt && <Badge tone="danger">revoked</Badge>}
                    </div>
                    <p className="mt-1 font-mono text-[13px] text-ink-subtle">{key.prefix}...</p>
                    <p className="mt-1.5 text-[13px] text-ink-muted">{key.scopes.join(', ')}</p>
                    <p className="mt-1 text-[12px] text-ink-subtle">
                      {key.lastUsedAt
                        ? `last used ${new Date(key.lastUsedAt).toLocaleString()}`
                        : 'never used'}
                    </p>
                  </div>
                  {canManage && !key.revokedAt && (
                    <Button variant="ghost" onClick={() => void revokeKey(key)}>
                      Revoke
                    </Button>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        )
      ) : webhooks.length === 0 ? (
        <EmptyState
          title="No webhooks yet"
          description="A webhook tells another system when something happens here, so it does not have to keep asking."
        />
      ) : (
        <div className="space-y-3">
          {webhooks.map((webhook) => (
            <Card key={webhook.id}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {webhook.name}
                    <Badge tone={webhook.enabled ? 'success' : 'neutral'}>
                      {webhook.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                    {webhook.consecutiveFailures > 0 && (
                      <Badge tone="warning">{webhook.consecutiveFailures} failing</Badge>
                    )}
                  </span>
                }
                description={webhook.url}
                action={
                  canManage ? (
                    <div className="flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => void ping(webhook)}>
                        Send a test
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void toggleWebhook(webhook)}
                      >
                        {webhook.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
              <CardBody>
                <p className="text-[13px] text-ink-muted">{webhook.events.join(', ')}</p>
                {webhook.disabledReason && (
                  <Alert tone="warning" className="mt-3">
                    Turned off automatically: {webhook.disabledReason}. Fix the endpoint and enable
                    it again - the failure count resets when you do.
                  </Alert>
                )}

                <button
                  type="button"
                  onClick={() => void showDeliveries(webhook)}
                  className="mt-3 text-[13px] font-medium text-brand hover:underline"
                >
                  Show recent deliveries
                </button>

                {deliveries[webhook.id] && (
                  <ul className="mt-3 space-y-1.5">
                    {deliveries[webhook.id]?.length === 0 && (
                      <li className="text-[13px] text-ink-subtle">Nothing sent yet.</li>
                    )}
                    {deliveries[webhook.id]?.map((delivery) => (
                      <li
                        key={delivery.id}
                        className="flex flex-wrap items-center gap-2 text-[13px]"
                      >
                        <Badge
                          tone={
                            delivery.status === 'delivered'
                              ? 'success'
                              : delivery.status === 'failed'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {delivery.status}
                        </Badge>
                        <span className="font-mono text-ink-muted">{delivery.event}</span>
                        <span className="text-ink-subtle">
                          {delivery.responseStatus ?? delivery.error ?? '-'}
                          {delivery.attempts > 1 ? ` - attempt ${delivery.attempts}` : ''}
                          {' - '}
                          {new Date(delivery.createdAt).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {keyDraft && (
        <Modal
          open
          onClose={() => setKeyDraft(null)}
          title="New API key"
          description="You will see the key once. Store it somewhere safe before closing that message."
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setKeyDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={() => void createKey()}
                loading={saving}
                disabled={keyDraft.name.trim() === '' || keyDraft.scopes.length === 0}
              >
                Create key
              </Button>
            </div>
          }
        >
          <div className="space-y-5">
            {formError && (
              <p className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {formError}
              </p>
            )}
            <Field
              label="Name"
              hint="Once it exists, the name is how you tell it from the others."
              required
            >
              {({ id }) => (
                <TextInput
                  id={id}
                  value={keyDraft.name}
                  maxLength={80}
                  placeholder="Reporting sync"
                  onChange={(event) => setKeyDraft({ ...keyDraft, name: event.target.value })}
                />
              )}
            </Field>
            <div>
              <p className="mb-2 text-sm font-medium text-ink">
                What it may do
                <span className="ml-0.5 text-danger" aria-hidden="true">
                  *
                </span>
              </p>
              <CheckList
                options={SCOPES}
                selected={keyDraft.scopes}
                onToggle={(scope) =>
                  setKeyDraft({
                    ...keyDraft,
                    scopes: keyDraft.scopes.includes(scope)
                      ? keyDraft.scopes.filter((entry) => entry !== scope)
                      : [...keyDraft.scopes, scope],
                  })
                }
              />
              <p className="mt-2 text-[13px] text-ink-subtle">
                A key can never do more than you can, and never manages your team, your billing or
                other keys.
              </p>
            </div>
          </div>
        </Modal>
      )}

      {hookDraft && (
        <Modal
          open
          onClose={() => setHookDraft(null)}
          title="New webhook"
          description="We POST a signed JSON body to this address when the events you choose happen."
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setHookDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={() => void createWebhook()}
                loading={saving}
                disabled={hookDraft.url.trim() === '' || hookDraft.events.length === 0}
              >
                Create webhook
              </Button>
            </div>
          }
        >
          <div className="space-y-5">
            {formError && (
              <p className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {formError}
              </p>
            )}
            <Field label="Name" required>
              {({ id }) => (
                <TextInput
                  id={id}
                  value={hookDraft.name}
                  maxLength={80}
                  placeholder="Order system"
                  onChange={(event) => setHookDraft({ ...hookDraft, name: event.target.value })}
                />
              )}
            </Field>
            <Field
              label="Endpoint"
              hint="https only, on an address the internet can reach."
              required
            >
              {({ id }) => (
                <TextInput
                  id={id}
                  value={hookDraft.url}
                  maxLength={2000}
                  placeholder="https://example.com/hooks/smartchat"
                  onChange={(event) => setHookDraft({ ...hookDraft, url: event.target.value })}
                />
              )}
            </Field>
            <div>
              <p className="mb-2 text-sm font-medium text-ink">
                Events
                <span className="ml-0.5 text-danger" aria-hidden="true">
                  *
                </span>
              </p>
              <CheckList
                options={EVENTS}
                selected={hookDraft.events}
                onToggle={(event) =>
                  setHookDraft({
                    ...hookDraft,
                    events: hookDraft.events.includes(event)
                      ? hookDraft.events.filter((entry) => entry !== event)
                      : [...hookDraft.events, event],
                  })
                }
              />
            </div>
          </div>
        </Modal>
      )}

      {revealed && (
        <SecretOnce
          title={revealed.title}
          secret={revealed.secret}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}
