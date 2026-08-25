'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@smartchat/validation';
import { ApiError, api } from '@/lib/api-client';
import { Alert, Button, Card, CardBody, Field, TextInput } from '@/components/ui';

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

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
      await api.post('/auth/reset-password', { token, password });
      router.replace('/login?reset=1');
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
          <Alert tone="danger" title="This link is not valid">
            The reset link is missing or incomplete. Request a new one and use the most recent
            email.
          </Alert>
          <Link href="/forgot-password" className="text-sm font-medium text-brand hover:underline">
            Request a new link
          </Link>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Choose a new password</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Setting a new password signs out every other device.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field
              label="New password"
              error={fieldErrors['password']}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
              required
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit" fullWidth loading={submitting}>
              Update password
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
