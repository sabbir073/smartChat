import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero } from '@/components/marketing/hero';
import { PricingTable } from '@/components/marketing/pricing';
import { Reveal } from '@/components/marketing/reveal';
import { CallToAction, Section, SectionHeading } from '@/components/marketing/sections';
import { loadPublicPlans } from '@/lib/public-plans';

export const metadata: Metadata = {
  title: 'Pricing — SmartChat',
  description:
    'Start free with one website and one seat. Paid plans add websites, team members, integrations and the AI agent; a custom plan for anything bigger.',
  robots: { index: true, follow: true },
};

// The plans come from the API on each request (cached a minute), never from the build.
export const dynamic = 'force-dynamic';

const QUESTIONS = [
  {
    q: 'What counts as a website?',
    a: 'One property in the dashboard: a site with its own widget, allowed domains and settings. Sub-pages of the same site are one website; a second domain with its own widget is another.',
  },
  {
    q: 'What counts as a team member?',
    a: 'Anybody who can sign in to your workspace, including invitations that have not been accepted yet. Departments and roles are unlimited on every plan.',
  },
  {
    q: 'What happens if I go over a limit?',
    a: 'Nothing is deleted. You will not be able to add another website or invite another person until you upgrade, and the page tells you exactly which limit you have reached.',
  },
  {
    q: 'Can I change or cancel later?',
    a: 'Yes, from the Billing page. Moving between paid plans is immediate and prorated. Cancelling keeps everything until the end of the period you paid for, then the account returns to the free plan.',
  },
  {
    q: 'What does the custom plan include?',
    a: 'Whatever you need that the other plans do not: more websites or people, an agreement written for you, or help running it at a size the docs do not cover. Tell us roughly what you have in mind and we will come back with a price.',
  },
  {
    q: 'Is there a free trial of the paid plans?',
    a: 'The free plan is the trial: every core feature, one website, one seat, for as long as you like. Upgrade when you need the second website or the second person.',
  },
];

export default async function PricingPage() {
  const plans = await loadPublicPlans();

  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Start free. Pay when you grow."
        lead="One website and one seat cost nothing, for as long as you like. Paid plans add websites, people, integrations and the AI agent. Nothing is priced per conversation."
      />

      <Section>
        {plans && plans.length > 0 ? (
          <Reveal>
            <PricingTable plans={plans} />
          </Reveal>
        ) : (
          <div className="mx-auto max-w-xl rounded-3xl border border-border bg-surface p-8 text-center">
            <p className="text-[16px] font-medium text-ink">
              The plans could not be loaded just now.
            </p>
            <p className="mt-2 text-[14.5px] text-ink-muted">
              Try again in a moment, or create a free account - it needs no card and you can see the
              plans from the Billing page.
            </p>
            <Link
              href="/register"
              className="mt-6 inline-block rounded-full bg-brand px-6 py-3 text-sm font-semibold text-ink-inverted hover:bg-brand-hover"
            >
              Create a free account
            </Link>
          </div>
        )}
      </Section>

      <Section tone="surface">
        <Reveal>
          <SectionHeading
            eyebrow="Questions"
            title="The things people ask before they choose."
            centered
          />
        </Reveal>
        <dl className="mx-auto mt-12 grid max-w-4xl gap-x-10 gap-y-8 sm:grid-cols-2">
          {QUESTIONS.map((item, index) => (
            <Reveal key={item.q} delay={index * 40}>
              <div>
                <dt className="text-[16px] font-semibold text-ink">{item.q}</dt>
                <dd className="mt-2 text-[14.5px] leading-relaxed text-ink-muted">{item.a}</dd>
              </div>
            </Reveal>
          ))}
        </dl>
      </Section>

      <Section>
        <Reveal>
          <CallToAction
            title="Start with the free plan this afternoon."
            lead="Create an account, add a website, paste one script tag. No card until you choose a paid plan."
            primary={{ href: '/register', label: 'Create a free account' }}
            secondary={{ href: '/contact', label: 'Ask about a custom plan' }}
          />
        </Reveal>
      </Section>
    </>
  );
}
