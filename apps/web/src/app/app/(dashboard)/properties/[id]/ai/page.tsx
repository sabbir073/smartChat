'use client';

import { useEffect, useRef, useState } from 'react';
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
import { AI_MODES, type AiMode, type AiSettingsView, type KnowledgeFileView } from '@/lib/ai';

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
  | 'crawlMaxPages'
> & { crawlExclude: string };

const ACCEPTED_FILES = '.pdf,.docx,.txt,.md,.markdown,.csv';
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

  const files = useResource<KnowledgeFileView[]>(
    (signal) => api.get<KnowledgeFileView[]>(`/properties/${id}/ai/files`, { signal }).then((r) => r.data),
    [id],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [removingFile, setRemovingFile] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settings.data) return;
    setDraft({
      assistantName: settings.data.assistantName,
      instructions: settings.data.instructions,
      keyFacts: settings.data.keyFacts,
      ticketOfferText: settings.data.ticketOfferText,
      handoffText: settings.data.handoffText,
      maxRepliesPerConversation: settings.data.maxRepliesPerConversation,
      crawlMaxPages: settings.data.crawlMaxPages,
      crawlExclude: settings.data.crawlExclude.join('\n'),
    });
  }, [settings.data]);

  // A file being read by the worker: poll until it is ready or has failed.
  useEffect(() => {
    if (!files.data?.some((file) => file.status === 'processing' || file.status === 'pending')) return;
    const timer = window.setTimeout(() => {
      files.reload();
      settings.reload();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [files, files.data, settings]);

  // While the index is catching up or the site is being read, poll: the owner has just pressed
  // the button and wants to see the count climb.
  useEffect(() => {
    if (!settings.data) return;
    if (settings.data.knowledge.pending === 0 && !settings.data.website.syncing) return;
    const timer = window.setTimeout(() => settings.reload(), 2500);
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

  function currentOf(view: AiSettingsView, key: keyof Draft): Draft[keyof Draft] {
    return key === 'crawlExclude' ? view.crawlExclude.join('\n') : view[key];
  }

  async function save() {
    if (!draft || !settings.data) return;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(draft) as Array<keyof Draft>) {
      if (draft[key] === currentOf(settings.data, key)) continue;
      changed[key] =
        key === 'crawlExclude'
          ? draft.crawlExclude.split('\n').map((line) => line.trim()).filter(Boolean)
          : draft[key];
    }
    if (Object.keys(changed).length === 0) {
      toast.success('Nothing to save.');
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      await api.patch(`/properties/${id}/ai`, changed);
      toast.success(changed['keyFacts'] !== undefined ? 'Saved. Indexing the key facts…' : 'Saved.');
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
      await api.post<{ queued: number; crawling: boolean }>(`/properties/${id}/ai/reindex`);
      toast.success('Reading your website now. Pages appear below as they are indexed.');
      settings.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the sync.');
    } finally {
      setReindexing(false);
    }
  }

  async function upload(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      toast.error('Files can be up to 10 MB.');
      return;
    }
    setUploading(file.name);
    try {
      const signed = await api.post<{ fileId: string; uploadUrl: string }>(`/properties/${id}/ai/files/sign`, {
        fileName: file.name,
        byteSize: file.size,
      });
      const put = await fetch(signed.data.uploadUrl, { method: 'PUT', body: file });
      if (!put.ok) throw new Error(`upload failed: ${put.status}`);
      await api.post(`/properties/${id}/ai/files/${signed.data.fileId}/confirm`);
      toast.success(`Reading ${file.name}…`);
      files.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The upload did not go through.');
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function removeFile(file: KnowledgeFileView) {
    setRemovingFile(file.id);
    try {
      await api.delete(`/properties/${id}/ai/files/${file.id}`);
      toast.success(`${file.fileName} removed.`);
      files.reload();
      settings.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove the file.');
    } finally {
      setRemovingFile(null);
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
  const dirty = (Object.keys(draft) as Array<keyof Draft>).some((k) => draft[k] !== currentOf(view, k));

  return (
    <>
      <PageHeader
        title="AI agent"
        description={`${property.data.name} · answers visitors from your website, key facts and help centre, and hands anything else to your team.`}
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
            title="Your website"
            description="The assistant reads the public pages of your site and answers from them. It is re-read every week, or whenever you press Sync."
            action={
              <Button size="sm" loading={reindexing || view.website.syncing} disabled={view.website.syncing} onClick={() => void reindex()}>
                {view.website.syncing ? 'Syncing…' : 'Sync website'}
              </Button>
            }
          />
          <CardBody className="space-y-5">
            <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <Stat label="Website" value={view.website.url.replace(/^https?:\/\//, '')} hint="Change it on the website's settings page." />
              <Stat label="Pages found" value={String(view.website.pagesFound)} />
              <Stat label="Pages indexed" value={String(view.website.syncing ? view.website.pagesIndexed : view.knowledge.pages)} />
              <Stat
                label="Last synced"
                value={view.website.syncing ? 'Reading now…' : view.website.lastSyncedAt ? new Date(view.website.lastSyncedAt).toLocaleString() : 'Never'}
              />
            </dl>
            {view.website.error && (
              <Alert tone="warning" title="The website could not be read">
                {view.website.error}
              </Alert>
            )}
            <Field
              label="Pages per sync"
              hint="The most pages one sync reads, starting from the sitemap and the home page. Raise it for a large site."
              error={errors['crawlMaxPages']}
            >
              {({ id: fieldId, invalid }) => (
                <TextInput
                  id={fieldId}
                  type="number"
                  min={1}
                  max={1000}
                  invalid={invalid}
                  value={draft.crawlMaxPages}
                  onChange={(event) => setDraft({ ...draft, crawlMaxPages: Number(event.target.value) || 1 })}
                  className="max-w-[10rem]"
                />
              )}
            </Field>
            <Field
              label="Pages to skip"
              hint="One path per line. /blog skips the blog and everything under it; /docs/*/draft and *.pdf use wildcards; ?add-to-cart skips shop action links. Takes effect on the next sync."
              error={errors['crawlExclude']}
            >
              {({ id: fieldId }) => (
                <textarea
                  id={fieldId}
                  rows={3}
                  value={draft.crawlExclude}
                  onChange={(event) => setDraft({ ...draft, crawlExclude: event.target.value })}
                  className={cn(TEXTAREA, 'font-mono text-[13px]')}
                  placeholder={'/blog\n/cart\n*.pdf'}
                  spellCheck={false}
                />
              )}
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Files"
            description="Price lists, brochures, prospectuses, policies - PDF, Word, text or Markdown, up to 10 MB each. The assistant reads them like pages of your site."
            action={
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPTED_FILES}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
                <Button size="sm" loading={uploading !== null} onClick={() => fileInput.current?.click()}>
                  {uploading ? `Uploading ${uploading}…` : 'Upload a file'}
                </Button>
              </>
            }
          />
          <CardBody>
            {files.error ? (
              <p className="text-sm text-danger">{files.error.message}</p>
            ) : !files.data ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : files.data.length === 0 ? (
              <p className="text-sm text-ink-muted">No files yet. A PDF price list is the quickest way to give the assistant your prices.</p>
            ) : (
              <ul className="divide-y divide-border">
                {files.data.map((file) => (
                  <li key={file.id} className="flex items-center gap-4 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{file.fileName}</p>
                      <p className="text-[13px] text-ink-subtle">
                        {formatBytes(file.byteSize)}
                        {file.status === 'ready' && ` · ${file.chunks} passage${file.chunks === 1 ? '' : 's'}`}
                        {' · '}
                        {new Date(file.createdAt).toLocaleDateString()}
                      </p>
                      {file.status === 'failed' && file.error && <p className="mt-1 text-[13px] text-danger">{file.error}</p>}
                    </div>
                    <Badge tone={file.status === 'ready' ? 'success' : file.status === 'failed' ? 'danger' : 'neutral'} dot={file.status === 'processing'}>
                      {file.status === 'ready' ? 'Indexed' : file.status === 'failed' ? 'Failed' : file.status === 'processing' ? 'Reading…' : 'Uploading…'}
                    </Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={removingFile === file.id}
                      onClick={() => void removeFile(file)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="What else the assistant knows"
            description="Facts you type, and your help centre. Anything it cannot find in any of this becomes a ticket for your team."
          />
          <CardBody className="space-y-5">
            <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <Stat label="Help-centre articles" value={String(view.knowledge.articles)} hint="Published ones are indexed automatically." />
              <Stat label="Passages indexed" value={String(view.knowledge.chunks)} hint="Across the website, files, articles and key facts." />
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
          <CardHeader
            title="This month"
            description="What the assistant did on this website."
            action={
              <Link href="/app/reports/ai" className="text-sm font-medium text-brand hover:underline">
                Full report
              </Link>
            }
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-6">
              <Stat label="Replies" value={String(view.usage.replies)} />
              <Stat label="Answered from content" value={String(view.usage.answers)} />
              <Stat label="Chatted" value={String(view.usage.chats)} hint="Greetings and general questions." />
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
