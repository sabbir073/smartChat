import type { Metadata } from 'next';
import Link from 'next/link';
import { Section, SectionHeading } from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'Contact — SmartChat',
  description: 'How to reach us about sales, support, security or anything else.',
  robots: { index: true, follow: true },
};

/**
 * The contact page.
 *
 * Deliberately not a form.
 *
 * A contact form has to post somewhere, and this deployment has no endpoint that receives one:
 * building the page around a form that silently discarded what somebody typed would be exactly the
 * kind of thing this product does not ship. A real address that reaches a real mailbox is more
 * useful anyway - the person writing gets a copy of what they sent, and a thread they can reply to.
 *
 * The addresses come from configuration so a deployment uses its own, with a working default.
 */
function addresses() {
  const domain = process.env['SUPPORT_DOMAIN'] ?? 'smartchat.local';
  return {
    support: process.env['SUPPORT_EMAIL'] ?? `support@${domain}`,
    sales: process.env['SALES_EMAIL'] ?? `sales@${domain}`,
    security: process.env['SECURITY_EMAIL'] ?? `security@${domain}`,
  };
}

export default function ContactPage() {
  const { support, sales, security } = addresses();

  const routes = [
    {
      title: 'Support',
      email: support,
      body: 'Something is not working, or you cannot find how to do something. Write from the address you signed up with and we can find you straight away.',
      hint: 'Include your account name and, if it is about one conversation, its link.',
    },
    {
      title: 'Sales and Enterprise',
      email: sales,
      body: 'Volume, procurement, an agreement written for you, or a plan that does not fit the ones on the pricing page. Enterprise is arranged this way on purpose rather than being a button.',
      hint: 'Tell us roughly how many websites and conversations a month you expect.',
    },
    {
      title: 'Security',
      email: security,
      body: 'Reporting a vulnerability. We would much rather hear from you than not, and we will not go looking for a reason to be difficult about it.',
      hint: 'Include steps to reproduce. We will confirm receipt within two working days.',
    },
  ];

  return (
    <>
      <Section tone="surface" className="border-b border-border">
        <SectionHeading
          eyebrow="Contact"
          title="Write to a person, not a form."
          lead="Three addresses, so your message starts in the right place. All of them reach somebody who can actually answer."
        />
      </Section>

      <Section>
        <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {routes.map((route) => (
            <div
              key={route.title}
              className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5"
            >
              <h2 className="text-[15px] font-semibold text-ink">{route.title}</h2>
              <p className="mt-2 flex-1 text-[14px] leading-relaxed text-ink-muted">{route.body}</p>
              <a
                href={`mailto:${route.email}`}
                className="mt-4 break-all text-[14px] font-medium text-brand hover:underline"
              >
                {route.email}
              </a>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-subtle">{route.hint}</p>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-10 max-w-4xl rounded-[var(--radius-card)] border border-border bg-surface-raised px-6 py-5">
          <h2 className="text-[14px] font-semibold text-ink">Already a customer?</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
            Write from the address you signed up with and name your account — that is enough for us
            to find you without a round trip. Your account name is at the top of your{' '}
            <Link href="/login" className="font-medium text-brand hover:underline">
              dashboard
            </Link>
            .
          </p>
        </div>
      </Section>
    </>
  );
}
