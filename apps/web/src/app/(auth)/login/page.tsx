'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Alert, Button, Card, CardBody, Field, TextInput } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await api.post('/auth/login', { email, password, remember: true });
      await refresh();
      const next = params.get('next');
      // Only a path on this site, and only one inside the application. `startsWith('/')` alone
      // would accept `//evil.example`, which a browser reads as a protocol-relative URL to
      // another host - an open redirect on the one page where somebody has just typed a password.
      const safeNext = next && next.startsWith('/app') && !next.startsWith('//') ? next : '/app';
      router.replace(safeNext);
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
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Sign in</h1>
        <p className="mt-1 text-sm text-ink-muted">Welcome back. Pick up where you left off.</p>
      </div>

      <Card>
        <CardBody className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Email" error={fieldErrors['email']} required>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="email"
                  name="email"
                  autoComplete="username"
                  autoFocus
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                />
              )}
            </Field>

            <Field label="Password" error={fieldErrors['password']} required>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>

            <Button type="submit" fullWidth loading={submitting}>
              Sign in
            </Button>
          </form>

          <div className="text-center text-[13px]">
            <Link href="/forgot-password" className="text-brand hover:underline">
              Forgot your password?
            </Link>
          </div>
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        New here?{' '}
        <Link href="/register" className="font-medium text-brand hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
