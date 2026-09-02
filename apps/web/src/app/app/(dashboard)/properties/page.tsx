'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { useResource } from '@/lib/use-resource';
import { PageHeader } from '@/components/layout/page-header';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  TextInput,
  useToast,
} from '@/components/ui';
import type { PropertyDto } from '@/lib/types';

export default function PropertiesPage() {
  const { activeAccount } = useAuth();
  const toast = useToast();

  const properties = useResource<PropertyDto[]>(
    (signal) => api.get<PropertyDto[]>('/properties', { signal }).then((result) => result.data),
    [activeAccount?.id],
  );

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function reset() {
    setName('');
    setWebsiteUrl('');
    setFormError(null);
    setFieldErrors({});
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await api.post('/properties', {
        name,
        websiteUrl,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        locale: 'en',
      });
      toast.success(`${name} added`);
      setOpen(false);
      reset();
      properties.reload();
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors());
        setFormError(error.message);
      } else {
        setFormError('Something went wrong.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Websites"
        description="Every website is isolated: its own widget, agents, visitors and conversations."
        action={<Button onClick={() => setOpen(true)}>Add website</Button>}
      />

      <Card>
        {properties.loading ? (
          <div className="space-y-3 p-5">
            <div className="skeleton h-5 w-1/3" />
            <div className="skeleton h-5 w-1/2" />
            <div className="skeleton h-5 w-2/5" />
          </div>
        ) : properties.error ? (
          <div className="p-5">
            <Alert tone="danger" title="Could not load your websites">
              {properties.error.message}
              <div className="mt-3">
                <Button size="sm" variant="secondary" onClick={properties.reload}>
                  Try again
                </Button>
              </div>
            </Alert>
          </div>
        ) : (properties.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No websites yet"
            description="Add your first website to generate its chat widget and installation snippet."
            action={<Button onClick={() => setOpen(true)}>Add website</Button>}
          />
        ) : (
          <ul className="divide-y divide-border">
            {properties.data?.map((property) => (
              <li key={property.id}>
                <Link
                  href={`/app/properties/${property.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-surface-raised"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-ink">{property.name}</p>
                      {property.status === 'paused' && <Badge tone="neutral">Paused</Badge>}
                      {!property.serving && <Badge tone="danger">Outside your plan</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-[13px] text-ink-subtle">
                      {property.websiteUrl}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {property.installed ? (
                      <Badge tone="success" dot>
                        Installed
                      </Badge>
                    ) : (
                      <Badge tone="warning" dot>
                        Awaiting snippet
                      </Badge>
                    )}
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="size-4 text-ink-subtle"
                      aria-hidden="true"
                    >
                      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title="Add a website"
        description="We will generate a widget and an installation snippet for it."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Cancel
            </Button>
            <Button form="create-property" type="submit" loading={submitting}>
              Add website
            </Button>
          </>
        }
      >
        <form id="create-property" onSubmit={onCreate} className="space-y-4" noValidate>
          {formError && <Alert tone="danger">{formError}</Alert>}

          <Field label="Name" error={fieldErrors['name']} hint="Only your team sees this." required>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Main website"
              />
            )}
          </Field>

          <Field
            label="Website address"
            error={fieldErrors['websiteUrl']}
            hint="We add this domain to the allowed list automatically."
            required
          >
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                required
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                placeholder="example.com"
              />
            )}
          </Field>
        </form>
      </Modal>
    </>
  );
}
