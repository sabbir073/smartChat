import type { Metadata } from 'next';
import { Clause, LegalPage } from '@/components/marketing/legal';

export const metadata: Metadata = {
  title: 'Terms — SmartChat',
  description: 'The terms under which SmartChat is provided.',
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="31 August 2026">
      <Clause title="1. What this covers">
        <p>
          These terms cover your use of this SmartChat installation: the dashboard, the chat widget
          you place on your own websites, the help centre it publishes, and the API and webhooks it
          exposes.
        </p>
      </Clause>

      <Clause title="2. Your account">
        <p>
          You are responsible for who you invite and what permissions you give them. Permissions are
          enforced on our side on every request, but we cannot know that somebody should no longer
          have access — removing them is yours to do.
        </p>
        <p>
          Keep your credentials to yourself. API keys are shown once and stored hashed; if one
          leaks, revoke it in the dashboard rather than asking us to.
        </p>
      </Clause>

      <Clause title="3. Plans, invoices and what happens if one goes unpaid">
        <p>
          Plans are limits on websites, conversations, storage and related resources. The limits on
          the pricing page are the ones the software applies.
        </p>
        <p>
          Each period is invoiced at its start. If an invoice is unpaid, service continues for
          fourteen days. After that the account becomes read-only: everything you have created
          remains present and readable, the widget stops accepting new conversations, and settling
          the invoice restores full service immediately. We do not delete your data because of an
          unpaid invoice.
        </p>
        <p>
          Moving to a cheaper plan takes effect at the end of the period you have already paid for.
          Moving to a more expensive one takes effect immediately.
        </p>
      </Clause>

      <Clause title="4. Acceptable use">
        <p>
          Do not use this service to send unsolicited messages, to harass anybody, to host or
          distribute malware, or to collect data you have no lawful basis to collect. Do not attempt
          to reach another account's data — and if you find a way to, tell us; see the security
          address on the contact page.
        </p>
      </Clause>

      <Clause title="5. Your content">
        <p>
          Conversations, articles, tickets, contacts and files you or your visitors create remain
          yours. We store and process them to provide the service and for no other purpose: they are
          not used to train anything, and they are not sold or shared.
        </p>
      </Clause>

      <Clause title="6. Availability">
        <p>
          We aim to keep the service running and to be honest when it is not. This template carries
          no uptime commitment; a deployment offering one should state it here.
        </p>
      </Clause>

      <Clause title="7. Ending it">
        <p>
          You can cancel at any time from your billing settings. You keep full service until the end
          of the period you have paid for, after which the account becomes read-only rather than
          being deleted, so you can export or come back.
        </p>
        <p>
          We may suspend an account that breaches section 4, and will say why. Suspension is not
          deletion.
        </p>
      </Clause>

      <Clause title="8. Changes">
        <p>
          If these terms change in a way that affects you materially, we will tell you by email
          before the change takes effect rather than quietly updating this page.
        </p>
      </Clause>
    </LegalPage>
  );
}
