import type { Metadata } from 'next';
import Link from 'next/link';
import { Clause, LegalPage } from '@/components/marketing/legal';

export const metadata: Metadata = {
  title: 'Privacy — SmartChat',
  description: 'What SmartChat stores, why, for how long, and what it deliberately does not do.',
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="9 September 2026">
      <Clause title="Two different relationships">
        <p>
          SmartChat sits between two of them, and conflating the two is how privacy pages become
          useless. <strong>You</strong> are our customer. <strong>Your visitors</strong> are yours —
          for their data you are the controller and this software is the processor. What follows
          says which is which.
        </p>
      </Clause>

      <Clause title="What we store about you">
        <p>
          Your name, email address and hashed password; the account and websites you create; your
          team's membership and roles; and an audit log of significant actions — who signed in, who
          changed a role, who revoked a key.
        </p>
        <p>Passwords are hashed with Argon2id and are never recoverable, by us or by anybody.</p>
      </Clause>

      <Clause title="What is stored about your visitors">
        <p>
          The messages they send, anything they type into a pre-chat or offline form, and files they
          attach. Alongside that: a browser and operating system name, device type, language,
          country, and the pages they visited on your site while the widget was loaded.
        </p>
        <p>
          Country only — never a finer location. The browser's own claims about itself are recorded
          as claims and are never used to decide what anybody is allowed to see.
        </p>
        <p>
          A visitor is identified by a token stored in the widget's own origin, not by a cookie on
          your domain, and not by any cross-site identifier.
        </p>
      </Clause>

      <Clause title="The AI assistant">
        <p>
          A website owner can switch on an AI assistant that answers visitors from that site's own
          published content — its help-centre articles and the facts the owner typed in. Every reply
          it writes is labelled as written by an AI assistant in the chat. It has no access to
          accounts, orders, tickets or any other conversation; what it cannot answer, it offers to
          pass to a person as a ticket.
        </p>
        <p>
          Replies are generated on our own servers by default. If our local model is unavailable or
          overloaded, the visitor's recent messages in that chat and the passages of the site's
          public content being answered from are sent to a third-party model provider (OpenAI or
          DeepSeek, as configured by the operator) to generate the reply. Nothing else about the
          visitor — no email address, IP address or contact record — is sent, and these providers
          do not use API traffic to train their models. A record of each AI reply, including which
          provider answered, is kept with the conversation for as long as the conversation is.
        </p>
      </Clause>

      <Clause title="What we do not do">
        <p>
          No third-party analytics or tracking script runs on this site, in the dashboard, or in the
          widget on your customers' pages. Nothing here is sold, shared with advertisers, or used to
          train a model. There is no advertising identifier and no cross-site profile.
        </p>
      </Clause>

      <Clause title="How long it is kept">
        <p>
          You set a retention window per account. A nightly job removes conversations past it along
          with their messages and the files behind them — the objects in storage, not merely the
          rows pointing at them.
        </p>
        <p>
          Tickets, contacts and the audit log are kept deliberately: a ticket is a commercial
          record, and an audit log that erased the record of its own operation would be pointless.
        </p>
      </Clause>

      <Clause title="Erasure and export">
        <p>
          Being straight about a gap: self-service erasure and account export are not built into the
          product yet. A request for either is handled by whoever operates this installation,
          directly against the database. If that matters to you, ask before you commit — the{' '}
          <Link href="/contact" className="font-medium text-brand hover:underline">
            contact page
          </Link>{' '}
          says where to write.
        </p>
      </Clause>

      <Clause title="Where it lives">
        <p>
          Wherever this installation runs. SmartChat is self-hosted: there is no central service and
          no vendor holding a copy. The operator of this deployment can tell you the jurisdiction,
          and should state it here.
        </p>
      </Clause>

      <Clause title="Security">
        <p>
          Encryption in transit, tenant isolation enforced in the schema as well as in the code,
          scoped credentials, and a Content Security Policy on every surface. To report something,
          use the security address on the contact page — we would much rather hear from you.
        </p>
      </Clause>
    </LegalPage>
  );
}
