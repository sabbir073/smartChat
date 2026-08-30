'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
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
  Modal,
  TextInput,
  useToast,
} from '@/components/ui';
import type { InstallationDto, PropertyDto } from '@/lib/types';

export default function PropertyDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const id = params.id;

  const property = useResource<PropertyDto>(
    (signal) => api.get<PropertyDto>(`/properties/${id}`, { signal }).then((r) => r.data),
    [id],
  );
  const installation = useResource<InstallationDto>(
    (signal) =>
      api.get<InstallationDto>(`/properties/${id}/install`, { signal }).then((r) => r.data),
    [id],
  );

  const [copied, setCopied] = useState(false);
  const [domain, setDomain] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [supportEmailError, setSupportEmailError] = useState<string | null>(null);
  const [addingDomain, setAddingDomain] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function copySnippet() {
    if (!installation.data) return;
    try {
      await navigator.clipboard.writeText(installation.data.snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access can be denied; the snippet is on screen and selectable either way.
      toast.error('Could not copy automatically - select the snippet and copy it manually.');
    }
  }

  async function addDomain(event: FormEvent) {
    event.preventDefault();
    setAddingDomain(true);
    setDomainError(null);
    try {
      await api.post(`/properties/${id}/domains`, { pattern: domain });
      setDomain('');
      property.reload();
      toast.success('Domain added');
    } catch (error) {
      setDomainError(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setAddingDomain(false);
    }
  }

  async function removeDomain(domainId: string) {
    try {
      await api.delete(`/properties/${id}/domains/${domainId}`);
      property.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove that domain.');
    }
  }

  async function toggleEnforcement(enforce: boolean) {
    try {
      await api.patch(`/properties/${id}`, { enforceDomains: enforce });
      property.reload();
      toast.success(enforce ? 'Domain enforcement enabled' : 'Domain enforcement disabled');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the setting.');
    }
  }

  /**
   * Where a customer's reply to a ticket email should land.
   *
   * Saved on blur rather than behind a Save button, like the other single settings on this page.
   * The empty string is a real choice - it means "no monitored mailbox" - so it is sent as null
   * rather than skipped.
   */
  async function saveSupportEmail(value: string) {
    const next = value.trim() === '' ? null : value.trim();
    if (next === (property.data?.supportEmail ?? null)) return;
    setSupportEmailError(null);
    try {
      await api.patch(`/properties/${id}`, { supportEmail: next });
      property.reload();
      toast.success(next ? 'Reply address saved' : 'Reply address cleared');
    } catch (error) {
      setSupportEmailError(error instanceof ApiError ? error.message : 'Could not save that.');
    }
  }

  async function deleteProperty() {
    setDeleting(true);
    try {
      await api.delete(`/properties/${id}`);
      toast.success('Website removed');
      router.replace('/properties');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not delete this website.');
      setDeleting(false);
    }
  }

  if (property.loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-7 w-52" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  if (property.error || !property.data) {
    return (
      <Alert tone="danger" title="Website not found">
        {property.error?.message ?? 'This website does not exist, or you do not have access to it.'}
        <div className="mt-3">
          <Link href="/properties">
            <Button size="sm" variant="secondary">
              Back to websites
            </Button>
          </Link>
        </div>
      </Alert>
    );
  }

  const data = property.data;

  return (
    <>
      <PageHeader
        title={data.name}
        description={data.websiteUrl}
        action={
          <div className="flex items-center gap-3">
            {data.installed ? (
              <Badge tone="success" dot>
                Widget installed
              </Badge>
            ) : (
              <Badge tone="warning" dot>
                Awaiting installation
              </Badge>
            )}
            <Link href={`/properties/${id}/widget`}>
              <Button size="sm">Customise widget</Button>
            </Link>
          </div>
        }
      />

      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Installation"
            description="Paste this immediately before the closing body tag on every page."
          />
          <CardBody className="space-y-4">
            {installation.loading ? (
              <div className="skeleton h-32 w-full" />
            ) : installation.data ? (
              <>
                <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-border bg-surface-raised p-4 text-[12.5px] leading-relaxed text-ink">
                  <code>{installation.data.snippet}</code>
                </pre>

                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" onClick={copySnippet}>
                    {copied ? 'Copied' : 'Copy snippet'}
                  </Button>
                  <span className="text-[13px] text-ink-subtle">
                    Public key <code className="font-mono">{installation.data.publicId}</code> —
                    safe to expose; it identifies this website and authorises nothing.
                  </span>
                </div>

                {installation.data.verified ? (
                  <Alert tone="success" title="Installation verified">
                    We have served this widget from your site
                    {installation.data.lastRequestAt
                      ? `, most recently on ${new Date(installation.data.lastRequestAt).toLocaleString()}`
                      : ''}
                    .
                  </Alert>
                ) : (
                  <Alert tone="info" title="Not detected yet">
                    Once the snippet is live, load a page on your site and this will turn green
                    automatically - serving the widget from an allowed origin is the verification.
                  </Alert>
                )}
              </>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Allowed domains"
            description="Only these domains may load this widget when enforcement is on."
          />
          <CardBody className="space-y-4">
            {data.domains.length === 0 ? (
              <p className="text-sm text-ink-muted">No domains yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-[var(--radius-control)] border border-border">
                {data.domains.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <code className="font-mono text-[13px] text-ink">{entry.pattern}</code>
                    <Button variant="ghost" size="sm" onClick={() => void removeDomain(entry.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <form onSubmit={addDomain} className="flex flex-wrap items-end gap-3" noValidate>
              <div className="min-w-[240px] flex-1">
                <Field
                  label="Add a domain"
                  error={domainError ?? undefined}
                  hint="An exact host, or one leading wildcard: example.com or *.example.com"
                >
                  {({ id: fieldId, describedBy, invalid }) => (
                    <TextInput
                      id={fieldId}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={domain}
                      onChange={(event) => setDomain(event.target.value)}
                      placeholder="example.com"
                    />
                  )}
                </Field>
              </div>
              <Button type="submit" variant="secondary" loading={addingDomain} disabled={!domain}>
                Add
              </Button>
            </form>
          </CardBody>
          <CardFooter>
            <div className="mr-auto text-[13px] text-ink-muted">
              {data.enforceDomains
                ? 'Requests from other domains are rejected.'
                : 'Unknown domains are recorded but not blocked.'}
            </div>
            <Button
              variant={data.enforceDomains ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => void toggleEnforcement(!data.enforceDomains)}
            >
              {data.enforceDomains ? 'Disable enforcement' : 'Enable enforcement'}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader
            title="Ticket replies"
            description="Where a customer's reply to a ticket email goes. SmartChat does not receive mail, so this is your own mailbox."
          />
          <CardBody>
            <Field
              label="Reply-to address"
              error={supportEmailError ?? undefined}
              hint={
                data.supportEmail
                  ? 'Ticket emails tell the customer they can reply, and their reply goes here.'
                  : 'With no address, ticket emails say plainly that the mailbox is not monitored. A reply-to nobody reads is worse than none.'
              }
            >
              {({ id: fieldId, describedBy, invalid }) => (
                <TextInput
                  id={fieldId}
                  type="email"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  defaultValue={data.supportEmail ?? ''}
                  placeholder="support@yourcompany.com"
                  onBlur={(event) => void saveSupportEmail(event.target.value)}
                />
              )}
            </Field>
          </CardBody>
        </Card>

        <Card className="border-danger/30">
          <CardHeader
            title="Delete this website"
            description="Its widget stops working immediately. Conversation history is retained per your account's data policy."
          />
          <CardFooter>
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete website
            </Button>
          </CardFooter>
        </Card>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${data.name}?`}
        description="The widget will stop loading on this site straight away."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} onClick={() => void deleteProperty()}>
              Delete website
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Visitors on <span className="font-medium text-ink">{data.websiteUrl}</span> will no longer
          see the chat widget. This cannot be undone from the dashboard.
        </p>
      </Modal>
    </>
  );
}
