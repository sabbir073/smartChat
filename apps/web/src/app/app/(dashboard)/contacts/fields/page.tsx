'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Modal,
  Select,
  Spinner,
  TextInput,
  useToast,
} from '@/components/ui';
import type { ContactFieldDto } from '@/lib/types';

const TYPES: { value: ContactFieldDto['type']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'url', label: 'Web address' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'A list to choose from' },
  { value: 'boolean', label: 'Yes or no' },
];

interface Draft {
  key: string;
  label: string;
  type: ContactFieldDto['type'];
  options: string;
}

/**
 * What this account wants to record about people.
 *
 * Configuration rather than code: adding a field is a row, not a deploy, and the values are
 * validated against these definitions every time a contact is saved.
 */
export default function ContactFieldsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can('contact:update');

  const [fields, setFields] = useState<ContactFieldDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<ContactFieldDto[]>('/contacts-fields');
      setFields(result.data);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Fields could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setFormError(null);
    try {
      await api.post('/contacts-fields', {
        key: draft.key,
        label: draft.label,
        type: draft.type,
        options:
          draft.type === 'select'
            ? draft.options
                .split('\n')
                .map((option) => option.trim())
                .filter(Boolean)
            : [],
      });
      setDraft(null);
      await load();
      toast.success('Field added');
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(field: ContactFieldDto): Promise<void> {
    try {
      await api.delete(`/contacts-fields/${field.id}`);
      setFields((current) => current.filter((entry) => entry.id !== field.id));
      // Said out loud, because it is the surprising and reassuring part.
      toast.success(`"${field.label}" removed. The values stay on your contacts.`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That could not be removed.');
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Custom fields"
        description="Extra things you want to record about the people who write in."
        action={
          canManage ? (
            <div className="flex gap-2">
              <Link href="/app/contacts">
                <Button variant="secondary">Back to contacts</Button>
              </Link>
              <Button
                onClick={() => {
                  setFormError(null);
                  setDraft({ key: '', label: '', type: 'text', options: '' });
                }}
              >
                New field
              </Button>
            </div>
          ) : (
            <Link href="/app/contacts">
              <Button variant="secondary">Back to contacts</Button>
            </Link>
          )
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : fields.length === 0 ? (
        <EmptyState
          title="No custom fields yet"
          description="Add one for anything your team keeps asking about - an account number, a plan, a renewal date."
        />
      ) : (
        <div className="space-y-3">
          {fields.map((field) => (
            <Card key={field.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-ink">{field.label}</h2>
                      <Badge tone="neutral">
                        {TYPES.find((type) => type.value === field.type)?.label ?? field.type}
                      </Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-[12px] text-ink-subtle">{field.key}</p>
                    {field.options.length > 0 && (
                      <p className="mt-1 text-[13px] text-ink-muted">{field.options.join(' · ')}</p>
                    )}
                  </div>
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => void remove(field)}>
                      Remove
                    </Button>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {draft && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title="New field"
          description="It appears on every contact, and can be filled in by any agent who can edit them."
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void create()} loading={saving}>
                Add field
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            {formError && (
              <p className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {formError}
              </p>
            )}

            <Field label="Label" hint="What an agent sees beside the box." required>
              {({ id }) => (
                <TextInput
                  id={id}
                  value={draft.label}
                  maxLength={60}
                  placeholder="Account number"
                  onChange={(event) => {
                    const label = event.target.value;
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            label,
                            // The key follows the label until somebody edits it themselves, which
                            // saves a step without taking the choice away.
                            key: current.key === slug(current.label) ? slug(label) : current.key,
                          }
                        : current,
                    );
                  }}
                />
              )}
            </Field>

            <Field
              label="Key"
              hint="Used in exports and the API. Cannot be changed later."
              required
            >
              {({ id }) => (
                <TextInput
                  id={id}
                  className="font-mono"
                  value={draft.key}
                  maxLength={40}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, key: event.target.value.toLowerCase() } : current,
                    )
                  }
                />
              )}
            </Field>

            <Field label="Kind">
              {({ id }) => (
                <Select
                  id={id}
                  value={draft.type}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? { ...current, type: event.target.value as ContactFieldDto['type'] }
                        : current,
                    )
                  }
                >
                  {TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {draft.type === 'select' && (
              <Field label="Options" hint="One per line." required>
                {({ id }) => (
                  <textarea
                    id={id}
                    rows={4}
                    value={draft.options}
                    placeholder={'Starter\nGrowth\nEnterprise'}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, options: event.target.value } : current,
                      )
                    }
                    className="w-full resize-y rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
                  />
                )}
              </Field>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** "Account number" -> "account_number". */
function slug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
