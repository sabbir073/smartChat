'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import {
  TriggerEditor,
  draftFrom,
  emptyDraft,
  type TriggerDraft,
} from '@/components/automation/trigger-editor';
import {
  ShortcutEditor,
  emptyShortcut,
  shortcutDraftFrom,
  type ShortcutDraft,
} from '@/components/automation/shortcut-editor';
import { Alert, Badge, Button, Card, CardBody, EmptyState, Spinner, cn, useToast } from '@/components/ui';
import type {
  AutomationSchemaDto,
  PropertyDto,
  ShortcutDto,
  TriggerAction,
  TriggerDto,
} from '@/lib/types';

const EVENT_LABELS: Record<TriggerDto['event'], string> = {
  visitor_arrived: 'when a visitor arrives',
  page_viewed: 'when a page is opened',
  time_on_site: 'after time on the site',
  conversation_started: 'when a chat starts',
};

/** One line of plain English per action, so the list is readable without opening anything. */
function describeAction(action: TriggerAction): string {
  switch (action.type) {
    case 'send_message':
      return `sends “${action.body.slice(0, 60)}${action.body.length > 60 ? '…' : ''}”`;
    case 'add_tag':
      return `tags it “${action.tag}”`;
    case 'set_priority':
      return `sets priority to ${action.priority}`;
    case 'route_to_department':
      return 'sends it to a department';
    default:
      return 'does something we no longer understand';
  }
}

export default function AutomationPage() {
  const { activeAccount, can } = useAuth();
  const toast = useToast();

  const canView = can('trigger:view') || can('shortcut:view');
  const canManageTriggers = can('trigger:manage');
  const canManageShortcuts = can('shortcut:manage');

  const [tab, setTab] = useState<'triggers' | 'shortcuts'>('triggers');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [triggers, setTriggers] = useState<TriggerDto[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutDto[]>([]);
  const [properties, setProperties] = useState<PropertyDto[]>([]);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [schema, setSchema] = useState<AutomationSchemaDto | null>(null);

  const [triggerDraft, setTriggerDraft] = useState<TriggerDraft | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [triggerResult, shortcutResult, propertyResult, schemaResult] = await Promise.all([
        can('trigger:view')
          ? api.get<TriggerDto[]>('/automation/triggers')
          : Promise.resolve({ data: [] as TriggerDto[] }),
        can('shortcut:view')
          ? api.get<ShortcutDto[]>('/automation/shortcuts')
          : Promise.resolve({ data: [] as ShortcutDto[] }),
        api.get<PropertyDto[]>('/properties'),
        api.get<AutomationSchemaDto>('/automation/schema'),
      ]);
      setTriggers(triggerResult.data);
      setShortcuts(shortcutResult.data);
      setProperties(propertyResult.data);
      setSchema(schemaResult.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Automation could not be loaded.');
    } finally {
      setLoading(false);
    }

    // Departments are only readable with team permission, so a refusal here leaves the routing
    // action unavailable rather than breaking the page for an agent.
    void api
      .get<{ id: string; name: string }[]>('/team/departments')
      .then((result) => setDepartments(result.data))
      .catch(() => setDepartments([]));
  }, [can]);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, canView, activeAccount?.id]);

  async function saveTrigger(): Promise<void> {
    if (!triggerDraft) return;
    setSaving(true);
    setFormError(null);
    const body = {
      name: triggerDraft.name,
      description: triggerDraft.description || null,
      propertyId: triggerDraft.propertyId || null,
      event: triggerDraft.event,
      enabled: triggerDraft.enabled,
      match: triggerDraft.match,
      conditions: triggerDraft.conditions,
      actions: triggerDraft.actions,
      frequency: triggerDraft.frequency,
      cooldownSeconds: triggerDraft.cooldownSeconds,
      afterSeconds: triggerDraft.afterSeconds,
    };
    try {
      if (triggerDraft.id) {
        const result = await api.patch<TriggerDto>(
          `/automation/triggers/${triggerDraft.id}`,
          body,
        );
        setTriggers((current) =>
          current.map((entry) => (entry.id === result.data.id ? result.data : entry)),
        );
      } else {
        const result = await api.post<TriggerDto>('/automation/triggers', body);
        setTriggers((current) => [...current, result.data]);
      }
      setTriggerDraft(null);
      toast.success('Trigger saved');
    } catch (caught) {
      // The server's own wording, not a generic failure: it explains which rule is impossible.
      setFormError(caught instanceof ApiError ? caught.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleTrigger(trigger: TriggerDto): Promise<void> {
    try {
      const result = await api.patch<TriggerDto>(`/automation/triggers/${trigger.id}`, {
        enabled: !trigger.enabled,
      });
      setTriggers((current) =>
        current.map((entry) => (entry.id === result.data.id ? result.data : entry)),
      );
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be changed.');
    }
  }

  async function deleteTrigger(trigger: TriggerDto): Promise<void> {
    try {
      await api.delete(`/automation/triggers/${trigger.id}`);
      setTriggers((current) => current.filter((entry) => entry.id !== trigger.id));
      toast.success(`“${trigger.name}” removed`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be removed.');
    }
  }

  async function saveShortcut(): Promise<void> {
    if (!shortcutDraft) return;
    setSaving(true);
    setFormError(null);
    const body = {
      key: shortcutDraft.key,
      title: shortcutDraft.title,
      body: shortcutDraft.body,
    };
    try {
      if (shortcutDraft.id) {
        const result = await api.patch<ShortcutDto>(
          `/automation/shortcuts/${shortcutDraft.id}`,
          body,
        );
        setShortcuts((current) =>
          current.map((entry) => (entry.id === result.data.id ? result.data : entry)),
        );
      } else {
        const result = await api.post<ShortcutDto>('/automation/shortcuts', body);
        setShortcuts((current) => [...current, result.data]);
      }
      setShortcutDraft(null);
      toast.success('Shortcut saved');
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteShortcut(shortcut: ShortcutDto): Promise<void> {
    try {
      await api.delete(`/automation/shortcuts/${shortcut.id}`);
      setShortcuts((current) => current.filter((entry) => entry.id !== shortcut.id));
      toast.success(`/${shortcut.key} removed`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be removed.');
    }
  }

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader title="Automation" />
        <EmptyState
          title="Only administrators can see automation"
          description="Ask an owner or administrator of this account if you need access."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Automation"
        description="Reach out first, and reuse the answers your team writes most."
        action={
          tab === 'triggers' && canManageTriggers ? (
            <Button
              onClick={() => {
                setFormError(null);
                setTriggerDraft(emptyDraft());
              }}
            >
              New trigger
            </Button>
          ) : tab === 'shortcuts' && canManageShortcuts ? (
            <Button
              onClick={() => {
                setFormError(null);
                setShortcutDraft(emptyShortcut());
              }}
            >
              New shortcut
            </Button>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="mb-5 flex gap-1" role="tablist" aria-label="Automation">
        {(['triggers', 'shortcuts'] as const).map((entry) => (
          <button
            key={entry}
            role="tab"
            aria-selected={tab === entry}
            onClick={() => setTab(entry)}
            className={cn(
              'rounded-full px-3.5 py-1.5 text-[13px] font-medium capitalize transition-colors',
              tab === entry ? 'bg-ink text-ink-inverted' : 'text-ink-muted hover:bg-surface-raised',
            )}
          >
            {entry}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : tab === 'triggers' ? (
        triggers.length === 0 ? (
          <EmptyState
            title="No triggers yet"
            description="A trigger lets SmartChat start the conversation - for example, offering help to somebody who has been reading your pricing page for half a minute."
          />
        ) : (
          <div className="space-y-3">
            {triggers.map((trigger) => (
              <Card key={trigger.id}>
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-[15px] font-semibold text-ink">
                          {trigger.name}
                        </h2>
                        {trigger.enabled ? (
                          <Badge tone="success" dot>
                            Active
                          </Badge>
                        ) : (
                          <Badge tone="neutral">Paused</Badge>
                        )}
                        {trigger.propertyId && (
                          <Badge tone="neutral">
                            {properties.find((p) => p.id === trigger.propertyId)?.name ??
                              'One website'}
                          </Badge>
                        )}
                      </div>

                      <p className="mt-1 text-[13px] text-ink-muted">
                        {EVENT_LABELS[trigger.event]}
                        {trigger.event === 'time_on_site' && ` (${trigger.afterSeconds}s)`}
                        {trigger.conditions.length > 0 &&
                          `, matching ${trigger.match} of ${trigger.conditions.length} condition${
                            trigger.conditions.length === 1 ? '' : 's'
                          }`}
                        {' — '}
                        {trigger.actions.map(describeAction).join(', ')}
                      </p>

                      {/*
                        A real counter, maintained on every firing. If it says zero, the rule has
                        genuinely never fired - which is the most useful thing this page can tell
                        somebody who thinks it should have.
                      */}
                      <p className="mt-1 text-[12px] text-ink-subtle">
                        Fired {trigger.fireCount} time{trigger.fireCount === 1 ? '' : 's'}
                        {trigger.lastFiredAt &&
                          `, last on ${new Date(trigger.lastFiredAt).toLocaleString()}`}
                      </p>
                    </div>

                    {canManageTriggers && (
                      <div className="flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void toggleTrigger(trigger)}>
                          {trigger.enabled ? 'Pause' : 'Activate'}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setFormError(null);
                            setTriggerDraft(draftFrom(trigger));
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void deleteTrigger(trigger)}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )
      ) : shortcuts.length === 0 ? (
        <EmptyState
          title="No shortcuts yet"
          description="Save a reply your team writes often, then type / in the composer to drop it in."
        />
      ) : (
        <div className="space-y-3">
          {shortcuts.map((shortcut) => (
            <Card key={shortcut.id}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[13px] text-brand">/{shortcut.key}</span>
                      <h2 className="truncate text-[15px] font-semibold text-ink">
                        {shortcut.title}
                      </h2>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-muted">
                      {shortcut.body}
                    </p>
                    <p className="mt-1 text-[12px] text-ink-subtle">
                      Used {shortcut.usageCount} time{shortcut.usageCount === 1 ? '' : 's'}
                    </p>
                  </div>

                  {canManageShortcuts && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setFormError(null);
                          setShortcutDraft(shortcutDraftFrom(shortcut));
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void deleteShortcut(shortcut)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {triggerDraft && (
        <TriggerEditor
          open
          draft={triggerDraft}
          schema={schema}
          properties={properties}
          departments={departments}
          saving={saving}
          error={formError}
          onChange={setTriggerDraft}
          onClose={() => setTriggerDraft(null)}
          onSave={() => void saveTrigger()}
        />
      )}

      {shortcutDraft && (
        <ShortcutEditor
          open
          draft={shortcutDraft}
          placeholders={schema?.placeholders ?? []}
          saving={saving}
          error={formError}
          onChange={setShortcutDraft}
          onClose={() => setShortcutDraft(null)}
          onSave={() => void saveShortcut()}
        />
      )}
    </div>
  );
}
