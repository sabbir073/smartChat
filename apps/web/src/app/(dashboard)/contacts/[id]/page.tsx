'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Select,
  Spinner,
  TextInput,
  useToast,
} from '@/components/ui';
import { formatBytes } from '@/components/inbox/attachment';
import type { ContactDto, ContactFieldDto, ContactHistoryDto } from '@/lib/types';

/**
 * One person, and everything they have ever done with us.
 *
 * The history is assembled across every browser identity joined to this contact - which is the
 * point of contacts existing at all. An agent who cannot see that somebody wrote in twice before
 * asks them to explain it all over again.
 */
export default function ContactPage() {
  const params = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('contact:update');

  const [history, setHistory] = useState<ContactHistoryDto | null>(null);
  const [fields, setFields] = useState<ContactFieldDto[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [profile, setProfile] = useState<Partial<ContactDto>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [historyResult, fieldResult] = await Promise.all([
        api.get<ContactHistoryDto>(`/contacts/${params.id}/history`),
        api.get<ContactFieldDto[]>('/contacts-fields'),
      ]);
      setHistory(historyResult.data);
      setFields(fieldResult.data);
      setDraft(historyResult.data.contact.customFields ?? {});
      setProfile({
        name: historyResult.data.contact.name,
        email: historyResult.data.contact.email,
        phone: historyResult.data.contact.phone,
        company: historyResult.data.contact.company,
        notes: historyResult.data.contact.notes,
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That contact could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const result = await api.patch<ContactDto>(`/contacts/${params.id}`, {
        ...profile,
        customFields: draft,
      });
      setHistory((current) => (current ? { ...current, contact: result.data } : current));
      toast.success('Contact saved');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  if (error || !history) {
    return (
      <div className="p-6">
        <PageHeader title="Contact" />
        <Alert tone="danger">{error ?? 'Not found'}</Alert>
      </div>
    );
  }

  const { contact, conversations, files } = history;

  return (
    <div className="p-6">
      <PageHeader
        title={contact.name ?? contact.email ?? 'Unnamed contact'}
        description={contact.email ?? undefined}
        action={
          canEdit ? (
            <Button onClick={() => void save()} loading={saving}>
              Save changes
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <Card>
            <CardBody>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">
                Conversations
              </h2>
              {conversations.length === 0 ? (
                <p className="text-[13px] text-ink-muted">Nothing on the websites you can see.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {conversations.map((conversation) => (
                    <li key={conversation.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <Link
                          href={`/inbox?conversation=${conversation.id}`}
                          className="text-[13.5px] font-medium text-ink hover:text-brand"
                        >
                          {conversation.subject ?? 'No subject'}
                        </Link>
                        <p className="text-[12px] text-ink-subtle">
                          {conversation.channel === 'offline_form' ? 'Offline message' : 'Chat'} ·{' '}
                          {conversation.messageCount} message
                          {conversation.messageCount === 1 ? '' : 's'} ·{' '}
                          {new Date(conversation.startedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge tone={conversation.status === 'closed' ? 'neutral' : 'success'}>
                        {conversation.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">
                Files they sent
              </h2>
              {files.length === 0 ? (
                <p className="text-[13px] text-ink-muted">None yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {files.map((file) => (
                    <li key={file.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0 truncate text-[13.5px] text-ink">{file.fileName}</span>
                      <span className="shrink-0 text-[12px] text-ink-subtle">
                        {formatBytes(file.byteSize)} ·{' '}
                        {new Date(file.createdAt).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardBody className="space-y-4">
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">
                Details
              </h2>
              {(
                [
                  ['name', 'Name'],
                  ['email', 'Email'],
                  ['phone', 'Phone'],
                  ['company', 'Company'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  {({ id }) => (
                    <TextInput
                      id={id}
                      disabled={!canEdit}
                      value={(profile[key] as string | null) ?? ''}
                      onChange={(event) =>
                        setProfile((current) => ({ ...current, [key]: event.target.value }))
                      }
                    />
                  )}
                </Field>
              ))}

              <Field label="Notes" hint="About the person, not about one conversation.">
                {({ id }) => (
                  <textarea
                    id={id}
                    rows={4}
                    disabled={!canEdit}
                    value={profile.notes ?? ''}
                    onChange={(event) =>
                      setProfile((current) => ({ ...current, notes: event.target.value }))
                    }
                    className="w-full resize-y rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink disabled:bg-surface-raised"
                  />
                )}
              </Field>
            </CardBody>
          </Card>

          {fields.length > 0 && (
            <Card>
              <CardBody className="space-y-4">
                <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">
                  Your fields
                </h2>
                {fields.map((field) => (
                  <Field key={field.id} label={field.label}>
                    {({ id }) =>
                      field.type === 'select' ? (
                        <Select
                          id={id}
                          disabled={!canEdit}
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                        >
                          <option value="">Not set</option>
                          {field.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </Select>
                      ) : field.type === 'boolean' ? (
                        <Select
                          id={id}
                          disabled={!canEdit}
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                        >
                          <option value="">Not set</option>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </Select>
                      ) : (
                        <TextInput
                          id={id}
                          disabled={!canEdit}
                          type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                        />
                      )
                    }
                  </Field>
                ))}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody>
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">
                Identities
              </h2>
              {/* Stated plainly, because it is the claim the whole page rests on. */}
              <p className="text-[13px] text-ink-muted">
                {contact.visitorCount} browser{contact.visitorCount === 1 ? '' : 's'} joined to this
                person by their email address, across {contact.propertyIds.length} website
                {contact.propertyIds.length === 1 ? '' : 's'}.
              </p>
              <p className="mt-2 text-[12px] text-ink-subtle">
                First seen {new Date(contact.firstSeenAt).toLocaleDateString()}
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
