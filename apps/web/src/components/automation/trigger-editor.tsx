'use client';

import { useMemo, useState } from 'react';
import { Button, Field, Modal, Select, TextInput, cn } from '@/components/ui';
import type {
  AutomationSchemaDto,
  PropertyDto,
  TriggerAction,
  TriggerCondition,
  TriggerDto,
} from '@/lib/types';

const EVENTS: { value: TriggerDto['event']; label: string; help: string }[] = [
  {
    value: 'visitor_arrived',
    label: 'A visitor arrives',
    help: 'The moment their chat widget connects.',
  },
  { value: 'page_viewed', label: 'A visitor opens a page', help: 'Every page they move to.' },
  {
    value: 'time_on_site',
    label: 'A visitor has been here a while',
    help: 'Measured from when their visit started.',
  },
  {
    value: 'conversation_started',
    label: 'A visitor starts a chat',
    help: 'Their first message, not a reply in an open chat.',
  },
];

const FREQUENCIES: { value: TriggerDto['frequency']; label: string }[] = [
  { value: 'once_per_session', label: 'Once per visit' },
  { value: 'once_per_visitor', label: 'Once ever, per person' },
  { value: 'every_time', label: 'Every time (with a cooldown)' },
];

const OPERATOR_LABELS: Record<string, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  is: 'is',
};

const FIELD_LABELS: Record<string, string> = {
  'page.url': 'Page address',
  'page.title': 'Page title',
  'page.referrer': 'Came from',
  'visitor.country': 'Country',
  'visitor.language': 'Language',
  'visitor.deviceType': 'Device',
  'visitor.isReturning': 'Has visited before',
  'visitor.isIdentified': 'We know who they are',
  'visitor.visitCount': 'Number of visits',
  'session.pageViewCount': 'Pages viewed this visit',
  'session.secondsOnSite': 'Seconds on the site',
  'agents.available': 'Somebody is available',
};

export interface TriggerDraft {
  id?: string;
  name: string;
  description: string;
  propertyId: string;
  event: TriggerDto['event'];
  enabled: boolean;
  match: 'all' | 'any';
  conditions: TriggerCondition[];
  actions: TriggerAction[];
  frequency: TriggerDto['frequency'];
  cooldownSeconds: number;
  afterSeconds: number;
}

export function emptyDraft(): TriggerDraft {
  return {
    name: '',
    description: '',
    propertyId: '',
    event: 'time_on_site',
    enabled: true,
    match: 'all',
    conditions: [],
    actions: [{ type: 'send_message', body: '' }],
    frequency: 'once_per_session',
    cooldownSeconds: 60,
    afterSeconds: 30,
  };
}

export function draftFrom(trigger: TriggerDto): TriggerDraft {
  return {
    id: trigger.id,
    name: trigger.name,
    description: trigger.description ?? '',
    propertyId: trigger.propertyId ?? '',
    event: trigger.event,
    enabled: trigger.enabled,
    match: trigger.match,
    conditions: trigger.conditions,
    actions: trigger.actions,
    frequency: trigger.frequency,
    cooldownSeconds: trigger.cooldownSeconds,
    afterSeconds: trigger.afterSeconds,
  };
}

/**
 * The rule builder.
 *
 * Its job is to make an impossible rule hard to express in the first place: the operator list
 * changes with the field, the wait only appears for the event that waits, and it says out loud
 * when tagging needs a message to have something to tag. The server refuses all of these too -
 * this is the half that explains why.
 */
export function TriggerEditor({
  open,
  draft,
  schema,
  properties,
  departments,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  draft: TriggerDraft;
  schema: AutomationSchemaDto | null;
  properties: PropertyDto[];
  departments: { id: string; name: string }[];
  saving: boolean;
  error: string | null;
  onChange: (draft: TriggerDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [showConditions, setShowConditions] = useState(draft.conditions.length > 0);

  const fields = useMemo(() => schema?.fields ?? [], [schema]);
  const operatorsFor = (field: string) =>
    fields.find((entry) => entry.field === field)?.operators ?? [];
  const typeOf = (field: string) => fields.find((entry) => entry.field === field)?.type ?? 'string';

  const set = (patch: Partial<TriggerDraft>) => onChange({ ...draft, ...patch });

  const hasAction = (type: TriggerAction['type']) => draft.actions.some((a) => a.type === type);
  const messageAction = draft.actions.find((a) => a.type === 'send_message');

  function toggleAction(type: TriggerAction['type']): void {
    if (hasAction(type)) {
      set({ actions: draft.actions.filter((a) => a.type !== type) });
      return;
    }
    const created: TriggerAction =
      type === 'send_message'
        ? { type: 'send_message', body: '' }
        : type === 'add_tag'
          ? { type: 'add_tag', tag: '' }
          : type === 'set_priority'
            ? { type: 'set_priority', priority: 'high' }
            : { type: 'route_to_department', departmentId: departments[0]?.id ?? '' };
    set({ actions: [...draft.actions, created] });
  }

  function patchAction(type: TriggerAction['type'], patch: Record<string, unknown>): void {
    set({
      actions: draft.actions.map((action) =>
        action.type === type ? ({ ...action, ...patch } as TriggerAction) : action,
      ),
    });
  }

  function addCondition(): void {
    const first = fields[0];
    if (!first) return;
    set({
      conditions: [
        ...draft.conditions,
        { field: first.field, operator: first.operators[0] ?? 'equals', value: '' },
      ],
    });
  }

  function patchCondition(index: number, next: TriggerCondition): void {
    const conditions = [...draft.conditions];
    conditions[index] = next;
    set({ conditions });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={draft.id ? 'Edit trigger' : 'New trigger'}
      description="Decide when SmartChat should reach out first."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} loading={saving}>
            {draft.id ? 'Save changes' : 'Create trigger'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {error && (
          <p className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <Field label="Name" required>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={draft.name}
              maxLength={80}
              placeholder="Offer help on the pricing page"
              onChange={(event) => set({ name: event.target.value })}
            />
          )}
        </Field>

        <Field label="Website" hint="Leave as every website to apply this account-wide.">
          {({ id }) => (
            <Select
              id={id}
              value={draft.propertyId}
              onChange={(event) => set({ propertyId: event.target.value })}
            >
              <option value="">Every website</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="When" hint={EVENTS.find((e) => e.value === draft.event)?.help} required>
          {({ id }) => (
            <Select
              id={id}
              value={draft.event}
              onChange={(event) => {
                const next = event.target.value as TriggerDraft['event'];
                // The wait belongs to exactly one event; carrying it across would be stored and
                // then refused, so it is cleared as the event changes.
                set({
                  event: next,
                  afterSeconds: next === 'time_on_site' ? draft.afterSeconds || 30 : 0,
                });
              }}
            >
              {EVENTS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {draft.event === 'time_on_site' && (
          <Field label="After how long" hint="Seconds since their visit started.">
            {({ id }) => (
              <TextInput
                id={id}
                type="number"
                min={1}
                max={3600}
                value={draft.afterSeconds}
                onChange={(event) => set({ afterSeconds: Number(event.target.value) })}
              />
            )}
          </Field>
        )}

        <div className="rounded-[var(--radius-control)] border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Only when…</p>
              <p className="text-[13px] text-ink-subtle">
                {showConditions
                  ? 'A condition whose answer we do not know never matches.'
                  : 'No conditions - this fires for everybody.'}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (showConditions) set({ conditions: [] });
                setShowConditions(!showConditions);
              }}
            >
              {showConditions ? 'Remove all' : 'Add conditions'}
            </Button>
          </div>

          {showConditions && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 text-[13px] text-ink-muted">
                Match
                <Select
                  className="h-8 w-auto text-[13px]"
                  value={draft.match}
                  onChange={(event) => set({ match: event.target.value as 'all' | 'any' })}
                >
                  <option value="all">all of these</option>
                  <option value="any">any of these</option>
                </Select>
              </div>

              {draft.conditions.map((condition, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <Select
                    className="h-9 w-auto min-w-40 text-[13px]"
                    value={condition.field}
                    onChange={(event) => {
                      const field = event.target.value;
                      patchCondition(index, {
                        field,
                        operator: operatorsFor(field)[0] ?? 'equals',
                        value: typeOf(field) === 'boolean' ? 'true' : '',
                      });
                    }}
                  >
                    {fields.map((entry) => (
                      <option key={entry.field} value={entry.field}>
                        {FIELD_LABELS[entry.field] ?? entry.field}
                      </option>
                    ))}
                  </Select>

                  <Select
                    className="h-9 w-auto text-[13px]"
                    value={condition.operator}
                    onChange={(event) =>
                      patchCondition(index, { ...condition, operator: event.target.value })
                    }
                  >
                    {operatorsFor(condition.field).map((operator) => (
                      <option key={operator} value={operator}>
                        {OPERATOR_LABELS[operator] ?? operator}
                      </option>
                    ))}
                  </Select>

                  {typeOf(condition.field) === 'boolean' ? (
                    <Select
                      className="h-9 w-auto text-[13px]"
                      value={condition.value}
                      onChange={(event) =>
                        patchCondition(index, { ...condition, value: event.target.value })
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <TextInput
                      className="h-9 w-auto flex-1 text-[13px]"
                      value={condition.value}
                      inputMode={typeOf(condition.field) === 'number' ? 'numeric' : 'text'}
                      placeholder={typeOf(condition.field) === 'number' ? '30' : '/pricing'}
                      onChange={(event) =>
                        patchCondition(index, { ...condition, value: event.target.value })
                      }
                    />
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Remove condition"
                    onClick={() =>
                      set({ conditions: draft.conditions.filter((_, i) => i !== index) })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}

              <Button
                size="sm"
                variant="secondary"
                onClick={addCondition}
                disabled={draft.conditions.length >= 10}
              >
                Add a condition
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-[var(--radius-control)] border border-border p-3">
          <p className="mb-2 text-sm font-medium text-ink">Then</p>

          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-1"
                checked={hasAction('send_message')}
                onChange={() => toggleAction('send_message')}
              />
              <span className="flex-1">
                Send a message
                {messageAction?.type === 'send_message' && (
                  <textarea
                    rows={2}
                    maxLength={1000}
                    value={messageAction.body}
                    placeholder="Hi - can I help you find the right plan?"
                    onChange={(event) => patchAction('send_message', { body: event.target.value })}
                    className="mt-1.5 w-full resize-none rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle"
                  />
                )}
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={hasAction('add_tag')}
                onChange={() => toggleAction('add_tag')}
              />
              <span className="flex flex-1 items-center gap-2">
                Tag the conversation
                {hasAction('add_tag') && (
                  <TextInput
                    className="h-9 w-40 text-[13px]"
                    maxLength={40}
                    placeholder="pricing"
                    value={
                      (
                        draft.actions.find((a) => a.type === 'add_tag') as
                          { tag: string } | undefined
                      )?.tag ?? ''
                    }
                    onChange={(event) => patchAction('add_tag', { tag: event.target.value })}
                  />
                )}
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={hasAction('set_priority')}
                onChange={() => toggleAction('set_priority')}
              />
              <span className="flex flex-1 items-center gap-2">
                Set priority to
                {hasAction('set_priority') && (
                  <Select
                    className="h-9 w-auto text-[13px]"
                    value={
                      (
                        draft.actions.find((a) => a.type === 'set_priority') as
                          { priority: string } | undefined
                      )?.priority ?? 'high'
                    }
                    onChange={(event) =>
                      patchAction('set_priority', { priority: event.target.value })
                    }
                  >
                    {['low', 'normal', 'high', 'urgent'].map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </Select>
                )}
              </span>
            </label>

            <label
              className={cn(
                'flex items-center gap-2 text-sm',
                departments.length === 0 ? 'text-ink-subtle' : 'text-ink',
              )}
            >
              <input
                type="checkbox"
                disabled={departments.length === 0}
                checked={hasAction('route_to_department')}
                onChange={() => toggleAction('route_to_department')}
              />
              <span className="flex flex-1 items-center gap-2">
                {departments.length === 0 ? 'Send to a department (none created yet)' : 'Send to'}
                {hasAction('route_to_department') && (
                  <Select
                    className="h-9 w-auto text-[13px]"
                    value={
                      (
                        draft.actions.find((a) => a.type === 'route_to_department') as
                          { departmentId: string } | undefined
                      )?.departmentId ?? ''
                    }
                    onChange={(event) =>
                      patchAction('route_to_department', { departmentId: event.target.value })
                    }
                  >
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </Select>
                )}
              </span>
            </label>
          </div>

          {draft.event !== 'conversation_started' &&
            !hasAction('send_message') &&
            draft.actions.length > 0 && (
              <p className="mt-3 text-[13px] text-ink-muted">
                This can fire before a conversation exists, so add a message - tagging, priority and
                routing need something to apply to.
              </p>
            )}
        </div>

        <Field label="How often">
          {({ id }) => (
            <Select
              id={id}
              value={draft.frequency}
              onChange={(event) =>
                set({ frequency: event.target.value as TriggerDraft['frequency'] })
              }
            >
              {FREQUENCIES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {draft.frequency === 'every_time' && (
          <Field label="Cooldown" hint="Seconds before the same person can see it again.">
            {({ id }) => (
              <TextInput
                id={id}
                type="number"
                min={30}
                max={86400}
                value={draft.cooldownSeconds}
                onChange={(event) => set({ cooldownSeconds: Number(event.target.value) })}
              />
            )}
          </Field>
        )}

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => set({ enabled: event.target.checked })}
          />
          Active
        </label>
      </div>
    </Modal>
  );
}
