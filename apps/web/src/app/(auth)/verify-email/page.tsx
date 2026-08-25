'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Alert, Button, Card, CardBody, Spinner } from '@/components/ui';

type State = 'pending' | 'verifying' | 'verified' | 'failed';

function VerifyEmail() {
  const params = useSearchParams();
  const token = params.get('token');
  const { user, refresh } = useAuth();

  const [state, setState] = useState<State>(token ? 'verifying' : 'pending');
  const [message, setMessage] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  // React 18+ mounts effects twice in development; the token is single-use, so a second call
  // would always fail and show an error for a verification that actually succeeded.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    void (async () => {
      try {
        await api.post('/auth/verify-email', { token });
        await refresh();
        setState('verified');
      } catch (error) {
        setMessage(error instanceof ApiError ? error.message : 'Something went wrong.');
        setState('failed');
      }
    })();
  }, [token, refresh]);

  async function resend() {
    if (!user?.email) return;
    try {
      await api.post('/auth/resend-verification', { email: user.email });
      setResent(true);
    } catch {
      setResent(true); // The endpoint is deliberately uniform; so is this.
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Verify your email</h1>

      <Card>
        <CardBody className="space-y-4">
          {state === 'verifying' && (
            <div className="flex items-center gap-3 text-sm text-ink-muted">
              <Spinner className="size-4" />
              Confirming your email address…
            </div>
          )}

          {state === 'verified' && (
            <>
              <Alert tone="success" title="Email confirmed">
                Your address is verified. You can start setting up your first website.
              </Alert>
              <Link href="/">
                <Button fullWidth>Go to dashboard</Button>
              </Link>
            </>
          )}

          {state === 'failed' && (
            <>
              <Alert tone="danger" title="We could not confirm this link">
                {message} Verification links expire after 24 hours and can only be used once.
              </Alert>
              <Button variant="secondary" fullWidth onClick={resend} disabled={resent}>
                {resent ? 'Sent - check your inbox' : 'Send a new link'}
              </Button>
            </>
          )}

          {state === 'pending' && (
            <>
              <Alert tone="info" title="Check your inbox">
                We sent a confirmation link{user?.email ? ` to ${user.email}` : ''}. Open it to
                finish setting up your account.
              </Alert>
              <Button variant="secondary" fullWidth onClick={resend} disabled={resent}>
                {resent ? 'Sent - check your inbox' : 'Resend the link'}
              </Button>
              <p className="text-center text-[13px] text-ink-subtle">
                In local development, every email is captured by Mailpit at{' '}
                <a href="http://localhost:8025" className="text-brand hover:underline">
                  localhost:8025
                </a>
                .
              </p>
            </>
          )}
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        <Link href="/" className="font-medium text-brand hover:underline">
          Continue to the dashboard
        </Link>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
