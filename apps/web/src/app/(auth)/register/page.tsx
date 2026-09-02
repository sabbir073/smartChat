'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@smartchat/validation';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Alert, Button, Card, CardBody, Field, TextInput } from '@/components/ui';

export default function RegisterPage() {
  const router = useRouter();
  const { refresh } = useAuth();

  const [form, setForm] = useState({ name: '', email: '', accountName: '', password: '' });
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const { data } = await api.post<{ requiresEmailVerification: boolean }>('/auth/register', {
        ...form,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        locale: 'en',
        acceptTerms: accepted,
      });
      await refresh();
      router.replace(data.requiresEmailVerification ? '/verify-email?pending=1' : '/app');
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors());
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Create your account</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Set up your workspace and add chat to your first website.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Your name" error={fieldErrors['name']} required>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  autoComplete="name"
                  autoFocus
                  required
                  value={form.name}
                  onChange={update('name')}
                  placeholder="Mahedi Hasan"
                />
              )}
            </Field>

            <Field label="Work email" error={fieldErrors['email']} required>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="email"
                  autoComplete="username"
                  required
                  value={form.email}
                  onChange={update('email')}
                  placeholder="you@company.com"
                />
              )}
            </Field>

            <Field
              label="Company or team"
              error={fieldErrors['accountName']}
              hint="This names your workspace. You can change it later."
              required
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  autoComplete="organization"
                  required
                  value={form.accountName}
                  onChange={update('accountName')}
                  placeholder="ABC Digital"
                />
              )}
            </Field>

            <Field
              label="Password"
              error={fieldErrors['password']}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase beats a short password.`}
              required
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="password"
                  autoComplete="new-password"
                  required
                  value={form.password}
                  onChange={update('password')}
                />
              )}
            </Field>

            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-ink-muted">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
                className="mt-0.5 size-4 rounded border-border-strong accent-[var(--color-brand)]"
                aria-describedby={fieldErrors['acceptTerms'] ? 'terms-error' : undefined}
              />
              <span>I agree to the terms of service and privacy policy.</span>
            </label>
            {fieldErrors['acceptTerms'] && (
              <p id="terms-error" className="text-[13px] text-danger" role="alert">
                {fieldErrors['acceptTerms']}
              </p>
            )}

            <Button type="submit" fullWidth loading={submitting} disabled={!accepted}>
              Create account
            </Button>
          </form>
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
