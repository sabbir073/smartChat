'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api-client';
import { Alert, Button, Card, CardBody, Field, TextInput } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Reset your password</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Enter your email and we will send you a link to choose a new one.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-4">
          {/* Deliberately identical whether or not the address exists - the response must not
              reveal which emails are registered. */}
          {sent ? (
            <Alert tone="success" title="Check your inbox">
              If an account exists for {email}, a reset link is on its way. The link expires in one
              hour and can only be used once.
            </Alert>
          ) : (
            <>
              {error && <Alert tone="danger">{error}</Alert>}
              <form onSubmit={onSubmit} className="space-y-4" noValidate>
                <Field label="Email" required>
                  {({ id, describedBy }) => (
                    <TextInput
                      id={id}
                      aria-describedby={describedBy}
                      type="email"
                      autoComplete="username"
                      autoFocus
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@company.com"
                    />
                  )}
                </Field>
                <Button type="submit" fullWidth loading={submitting}>
                  Send reset link
                </Button>
              </form>
            </>
          )}
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        <Link href="/login" className="font-medium text-brand hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
