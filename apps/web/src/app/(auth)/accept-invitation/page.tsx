'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@smartchat/validation';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Alert, Button, Card, CardBody, Field, TextInput } from '@/components/ui';

/**
 * Accepting a team invitation.
 *
 * The page does not know whether this address already has a SmartChat login — only the server
 * does, and asking the browser would leak whether an address is registered. So it offers the
 * fields an already-registered person can simply leave blank, and the server decides: if a
 * password is genuinely required it says so, and the message lands on the field.
 */
function AcceptForm() {
  const { refresh } = useAuth();
  const token = useSearchParams().get('token') ?? '';

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post('/auth/accept-invitation', {
        token,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(password ? { password } : {}),
      });
      // The response set a session for a *different* person than whoever was signed in a moment
      // ago - often nobody, sometimes a colleague sharing a browser. `router.replace` would keep
      // the client-side auth context that mounted with the old identity, so the dashboard would
      // greet them by the wrong name until something forced a reload. Re-fetch, then hard-load.
      await refresh();
      window.location.assign('/');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('Something went wrong.');
      }
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <Alert tone="danger" title="This invitation link is not valid">
            The link is missing or incomplete. Ask whoever invited you to send it again — an
            invitation can be resent from their Team page.
          </Alert>
          <Link href="/login" className="text-sm font-medium text-brand hover:underline">
            Go to sign in
          </Link>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Join the team</h1>
        <p className="mt-1 text-sm text-ink-muted">
          You have been invited to a SmartChat workspace. Finish setting up and you will be taken
          straight there.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field
              label="Your name"
              error={fieldErrors['name']}
              hint="Shown to teammates and to visitors you talk to."
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  autoComplete="name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Alex Morgan"
                />
              )}
            </Field>

            <Field
              label="Choose a password"
              error={fieldErrors['password']}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters. Leave blank if you already have a SmartChat login.`}
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>

            <Button type="submit" fullWidth loading={submitting}>
              Accept invitation
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={null}>
      <AcceptForm />
    </Suspense>
  );
}
