'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiError, api } from '@/lib/api-client';
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
  cn,
  useToast,
} from '@/components/ui';
import type { PropertyDto } from '@/lib/types';
import { AI_MODES, type AiMode, type AiSettingsView } from '@/lib/ai';

/**
 * The AI agent, per website.
 *
 * Three things on one page, in the order an owner meets them: the switch (who answers), what the
 * assistant knows (key facts and the help centre, with the state of the index), and how it
 * speaks (name, instructions, the sentences it says when it cannot help). The switch is the only
 * part gated by the plan; everything else can be prepared on any plan.
 */

const TEXTAREA =
  'w-full resize-y rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink disabled:bg-surface-raised';

type Draft = Pick<
  AiSettingsView,
  | 'assistantName'
  | 'instructions'
  | 'keyFacts'
  | 'ticketOfferText'
  | 'handoffText'
  | 'maxRepliesPerConversation'
>;

export default function AiAgentPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const property = useResource<PropertyDto>(
    (signal) => api.get<PropertyDto>(`/properties/${id}`, { signal }).then((r) => r.data),
    [id],
  );
  const settings = useResource<AiSettingsView>(
    (signal) => api.get<AiSettingsView>(`/properties/${id}/ai`, { signal }).then((r) => r.data),
    [id],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setDraft({
      assistantName: settings.data.assistantName,
      instructions: settings.data.instructions,
      keyFacts: settings.data.keyFacts,
      ticketOfferText: settings.data.ticketOfferText,
      handoffText: settings.data.handoffText,
      maxRepliesPerConversation: settings.data.maxRepliesPerConversation,
    });
  }, [settings.data]);

  // While the index is catching up, poll: the owner has just saved facts and wants to see them land.
  useEffect(() => {
    if (!settings.data || settings.data.knowledge.pending === 0) return;
    const timer = window.setTimeout(() => settings.reload(), 2000);
    return () => window.clearTimeout(timer);
  }, [settings, settings.data]);

  async function setMode(mode: AiMode) {
    if (!settings.data || settings.data.mode === mode) return;
    setSwitching(true);
    try {
      await api.patch(`/properties/${id}/ai`, { mode });
      toast.success(
        mode === 'team'
          ? 'Your team answers new messages.'
          : mode === 'ai'
            ? 'The AI assistant answers new messages first.'
            : 'The AI assistant covers while nobody is online.',
      );
      settings.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the mode.');
    } finally {
      setSwitching(false);
    }
  }

  async function save() {
    if (!draft || !settings.data) return;
    const changed: Partial<Draft> = {};
    for (const key of Object.keys(draft) as Array<keyof Draft>) {
      if (draft[key] !== settings.data[key]) (changed as Record<string, unknown>)[key] = draft[key];
    }
    if (Object.keys(changed).length === 0) {
      toast.success('Nothing to save.');
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      await api.patch(`/properties/${id}/ai`, changed);
      toast.success(changed.keyFacts !== undefined ? 'Saved. Indexing the key facts…' : 'Saved.');
      settings.reload();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors());
        toast.error(error.message);
      } else {
        toast.error('Could not save.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function reindex() {
    setReindexing(true);
    try {
      const result = await api.post<{ queued: number }>(`/properties/${id}/ai/reindex`);
      toast.success(`Re-indexing ${result.data.queued} document${result.data.queued === 1 ? '' : 's'}.`);
      settings.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the re-index.');
    } finally {
      setReindexing(false);
    }
  }

  if (property.error || settings.error) {
    return (
      <Alert tone="danger" title="Could not load the AI agent">
        {(property.error ?? settings.error)?.message}
      </Alert>
    );
  }
  if (!property.data || !settings.data || !draft) {
    return <p className="text-sm text-ink-muted">Loading…</p>;
  }

  const view = settings.data;
  const dirty = (Object.keys(draft) as Array<keyof Draft>).some((k) => draft[k] !== view[k]);

  return (
    <>
      <PageHeader
        title="AI agent"
        description={`${property.data.name} · answers visitors from your key facts and help centre, and hands anything else to your team.`}
        action={
          view.mode === 'team' ? (
            <Badge tone="neutral">Team answers</Badge>
          ) : (
            <Badge tone="success" dot>
              {view.mode === 'ai' ? 'AI answers first' : 'AI covers when offline'}
            </Badge>
          )
        }
      />

      <div className="space-y-6">
        {!view.plan.includesAi && (
          <Alert tone="info" title={`The AI agent is not included in the ${view.plan.planName} plan`}>
            You can write the key facts and set up the assistant now; switching it on needs a plan that
            includes it.{' '}
            <Link href="/app/billing" className="font-medium underline">
              See plans
            </Link>
          </Alert>
        )}

        <Card>
          <CardHeader
            title="Who answers new messages"
            description="Changes apply to the next message. A person replying or being assigned always takes a conversation over from the AI."
          />
          <CardBody>
            <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Answering mode">
              {AI_MODES.map((option) => {
                const active = view.mode === option.value;
                const disabled = switching || (!view.plan.includesAi && option.value !== 'team');
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={disabled}
                    onClick={() => void setMode(option.value)}
                    className={cn(
                      'rounded-[var(--radius-card)] border p-4 text-left transition-colors',
                      active
                        ? 'border-brand bg-brand-soft/40 ring-1 ring-brand'
                        : 'border-border hover:border-ink-subtle',
                      disabled && !active && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <span className="block text-sm font-semibold text-ink">{option.label}</span>
                    <span className="mt-1 block text-[13px] text-ink-muted">{option.description}</span>
                  </button>
                );
              })}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="What the assistant knows"
            description="It answers only from what is here. Anything it cannot find becomes a ticket for your team."
            action={
              <Button size="sm" variant="secondary" loading={reindexing} onClick={() => void reindex()}>
                Re-index
              </Button>
            }
          />
          <CardBody className="space-y-5">
            <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <Stat label="Help-centre articles" value={String(view.knowledge.articles)} hint="Published ones are indexed automatically." />
              <Stat label="Passages indexed" value={String(view.knowledge.chunks)} />
              <Stat
                label="Last indexed"
                value={view.knowledge.lastIndexedAt ? new Date(view.knowledge.lastIndexedAt).toLocaleString() : 'Never'}
              />
              <Stat
                label="Status"
                value={
                  view.knowledge.failures.length > 0
                    ? `${view.knowledge.failures.length} failed`
                    : view.knowledge.pending > 0
                      ? `Indexing ${view.knowledge.pending}…`
                      : 'Up to date'
                }
              />
            </dl>
            {view.knowledge.failures.length > 0 && (
              <Alert tone="warning" title="Some content could not be indexed">
                <ul className="mt-1 list-disc pl-5">
                  {view.knowledge.failures.map((failure) => (
                    <li key={failure.documentId}>
                      <span className="font-medium">{failure.title}</span>: {failure.error}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <Field
              label="Key facts"
              hint="Opening hours, phone numbers, addresses, prices, policies - anything you would rather type than have the assistant guess. Headings (# like this) keep it organised. Searched first, always."
              error={errors['keyFacts']}
            >
              {({ id: fieldId }) => (
                <textarea
                  id={fieldId}
                  rows={10}
                  value={draft.keyFacts}
                  maxLength={20_000}
                  onChange={(event) => setDraft({ ...draft, keyFacts: event.target.value })}
                  className={TEXTAREA}
                  placeholder={'# Opening hours\nSaturday to Thursday, 10:00 to 20:00. Closed Friday.\n\n# Delivery\nFree above 5,000 BDT inside Dhaka.'}
                />
              )}
            </Field>
            <p className="text-[13px] text-ink-subtle">
              Your published help-centre articles are indexed as they are published, and removed when they are unpublished.{' '}
              <Link href="/app/kb" className="font-medium underline">
                Manage the help centre
              </Link>
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="How it speaks" description="The name visitors see, and what it says when it cannot help." />
          <CardBody className="space-y-5">
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="Assistant name" hint="Shown as the sender on every reply, marked as AI." error={errors['assistantName']}>
                {({ id: fieldId, invalid }) => (
                  <TextInput
                    id={fieldId}
                    invalid={invalid}
                    value={draft.assistantName}
                    maxLength={40}
                    onChange={(event) => setDraft({ ...draft, assistantName: event.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Replies per conversation"
                hint="A loop guard, not a limit on use: after this many AI replies in one chat it offers a ticket."
                error={errors['maxRepliesPerConversation']}
              >
                {({ id: fieldId, invalid }) => (
                  <TextInput
                    id={fieldId}
                    type="number"
                    min={1}
                    max={500}
                    invalid={invalid}
                    value={draft.maxRepliesPerConversation}
                    onChange={(event) =>
                      setDraft({ ...draft, maxRepliesPerConversation: Number(event.target.value) || 1 })
                    }
                  />
                )}
              </Field>
            </div>
            <Field
              label="About your business"
              hint="A few sentences on what you do and how to talk to customers. Goes straight into the assistant's instructions - keep it public."
              error={errors['instructions']}
            >
              {({ id: fieldId }) => (
                <textarea
                  id={fieldId}
                  rows={3}
                  value={draft.instructions}
                  maxLength={2_000}
                  onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                  className={TEXTAREA}
                  placeholder="We are a bicycle shop in Dhanmondi. Be warm and brief; say BDT for prices."
                />
              )}
            </Field>
            <Field label="When it cannot help" hint="Said before the Create a ticket button." error={errors['ticketOfferText']}>
              {({ id: fieldId }) => (
                <textarea
                  id={fieldId}
                  rows={2}
                  value={draft.ticketOfferText}
                  maxLength={500}
                  onChange={(event) => setDraft({ ...draft, ticketOfferText: event.target.value })}
                  className={TEXTAREA}
                />
              )}
            </Field>
            <Field label="When it hands over to a person" hint="Said when a visitor asks for a person and someone is online." error={errors['handoffText']}>
              {({ id: fieldId }) => (
                <textarea
                  id={fieldId}
                  rows={2}
                  value={draft.handoffText}
                  maxLength={500}
                  onChange={(event) => setDraft({ ...draft, handoffText: event.target.value })}
                  className={TEXTAREA}
                />
              )}
            </Field>
          </CardBody>
          <CardFooter>
            {dirty && <span className="mr-auto text-[13px] text-ink-subtle">Unsaved changes</span>}
            <Button loading={saving} disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader title="This month" description="What the assistant did on this website." />
          <CardBody>
            <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
              <Stat label="Replies" value={String(view.usage.replies)} />
              <Stat label="Answered" value={String(view.usage.answers)} />
              <Stat label="Offered a ticket" value={String(view.usage.tickets)} />
              <Stat label="Handed to a person" value={String(view.usage.handoffs)} />
              <Stat label="Could not answer" value={String(view.usage.failed)} hint="The model failed; the visitor still got the ticket offer." />
            </dl>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[12px] uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-semibold text-ink">{value}</dd>
      {hint && <dd className="text-[12px] text-ink-subtle">{hint}</dd>}
    </div>
  );
}
