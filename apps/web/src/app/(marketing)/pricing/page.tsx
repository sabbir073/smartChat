import type { Metadata } from 'next';
import { CallToAction, Section, SectionHeading } from '@/components/marketing/sections';
import { PricingTable } from '@/components/marketing/pricing-table';
import { fetchPublicPlans } from '@/lib/public-api';

export const metadata: Metadata = {
  title: 'Pricing — SmartChat',
  description:
    'Plans priced by websites, conversations and storage rather than per seat. Start free and move up when you outgrow it.',
  robots: { index: true, follow: true },
};

const FAQ = [
  {
    q: 'What do I get when I sign up?',
    a: 'Fourteen days of Pro, with everything switched on and no card asked for. When the trial ends the account moves to Free rather than starting to charge you — nothing you built during the trial is deleted, and anything past the Free limits becomes read-only until you choose a plan.',
  },
  {
    q: 'What happens when I reach a limit?',
    a: 'You are told, at the moment you try to go past it, which limit it was. Nothing is deleted and nothing stops working — you simply cannot add another one until you upgrade or make room.',
  },
  {
    q: 'What happens if I downgrade while I am over the new limit?',
    a: 'Nothing is destroyed. Moving to a cheaper paid plan takes effect at the end of the period you have already paid for — moving to Free happens straight away, because nobody should wait for permission to stop paying. Either way, anything past the new allowance becomes read-only rather than disappearing: your oldest websites keep serving and the excess stop taking new conversations until you are back within the plan.',
  },
  {
    q: 'What happens if an invoice goes unpaid?',
    a: 'Service continues for fourteen days while we chase it. After that the account becomes read-only: everything is still there and still readable, the widget stops taking new conversations, and settling the invoice restores it immediately. We never delete a customer’s data over a bill.',
  },
  {
    q: 'Do you charge per agent?',
    a: 'No. Plans include a number of team members, but adding a colleague within that number costs nothing extra. The limits that scale with the plan are websites, conversations and storage — the things that actually cost us something to run.',
  },
  {
    q: 'How do I pay?',
    a: 'Choose a plan in your billing settings and we set it up, then invoice you for each period. Card payment is not wired up yet, and we would rather say so than show you a checkout button that does not take money.',
  },
  {
    q: 'Can I cancel?',
    a: 'At any time, from your billing settings. You keep everything until the end of the period you have paid for, and after that the account becomes read-only rather than being deleted — so you can come back, or export, whenever you want.',
  },
];

export default async function PricingPage() {
  const plans = await fetchPublicPlans();

  return (
    <>
      <Section tone="surface" className="border-b border-border">
        <SectionHeading
          centered
          eyebrow="Pricing"
          title="Priced by what it costs to run, not by how many people you hire."
          lead="Every number below is read from the same table that enforces it. If a plan says 500 conversations, that is the limit the server applies."
        />
        <PricingTable plans={plans} />
      </Section>

      <Section>
        <SectionHeading centered title="The questions people actually ask" />
        <dl className="mx-auto mt-10 max-w-3xl divide-y divide-border border-y border-border">
          {FAQ.map((item) => (
            <div key={item.q} className="py-6">
              <dt className="text-[15px] font-semibold text-ink">{item.q}</dt>
              <dd className="mt-2 text-[14px] leading-relaxed text-ink-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section tone="surface">
        <CallToAction
          title="Start free, today."
          lead="One website, two seats, 500 conversations a month. No card, and no time limit on the free plan."
          secondary={{ href: '/contact', label: 'Talk to us first' }}
        />
      </Section>
    </>
  );
}
