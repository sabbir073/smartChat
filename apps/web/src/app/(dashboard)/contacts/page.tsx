'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, Badge, Button, EmptyState, Spinner, TextInput } from '@/components/ui';
import type { ContactDto } from '@/lib/types';

/**
 * The people who have written in.
 *
 * One row per person, not per browser: somebody who chatted from their laptop last month and their
 * phone this morning is one entry here, joined by the address they gave us both times.
 */
export default function ContactsPage() {
  const { activeAccount, can } = useAuth();
  const canView = can('contact:view');

  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (term: string, after?: string | null) => {
      if (after) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '25' });
        if (term) params.set('search', term);
        if (after) params.set('cursor', after);
        const result = await api.get<ContactDto[]>(`/contacts?${params.toString()}`);
        const meta = result.meta as { cursor?: string | null } | undefined;
        setContacts((current) => (after ? [...current, ...result.data] : result.data));
        setCursor(meta?.cursor ?? null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Contacts could not be loaded.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return undefined;
    }
    // Debounced, so typing a name does not fire a request per keystroke.
    const timer = window.setTimeout(() => void load(search), search ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search, canView, activeAccount?.id]);

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader title="Contacts" />
        <EmptyState
          title="You do not have access to contacts"
          description="Ask an owner or administrator of this account if you need it."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Contacts"
        description="Everyone who has written in, and everything they have written."
        action={
          <Link href="/contacts/fields">
            <Button variant="secondary">Custom fields</Button>
          </Link>
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="mb-4 max-w-sm">
        <TextInput
          value={search}
          placeholder="Search names, emails and companies"
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search contacts"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : contacts.length === 0 ? (
        <EmptyState
          title={search ? 'Nobody matches that' : 'No contacts yet'}
          description={
            search
              ? 'Try a different name, address or company.'
              : 'A contact appears the first time somebody gives you their email address - through the pre-chat form, the offline form, or your own identify call.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-raised text-[12px] uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Email</th>
                <th className="px-4 py-2.5 font-semibold">Company</th>
                <th className="px-4 py-2.5 font-semibold">Visits</th>
                <th className="px-4 py-2.5 font-semibold">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contacts.map((contact) => (
                <tr key={contact.id} className="transition-colors hover:bg-surface-raised">
                  <td className="px-4 py-2.5">
                    <Link href={`/contacts/${contact.id}`} className="font-medium text-ink hover:text-brand">
                      {contact.name ?? 'Unnamed'}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">{contact.email ?? '—'}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{contact.company ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone="neutral">{contact.visitorCount}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">
                    {new Date(contact.lastSeenAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={loadingMore} onClick={() => void load(search, cursor)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
