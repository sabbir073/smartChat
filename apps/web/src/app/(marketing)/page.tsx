import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CallToAction,
  FeatureCard,
  Section,
  SectionHeading,
  Step,
  icons,
} from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'SmartChat — live chat you host yourself',
  description:
    'One inbox for every website you run. Live chat, a help centre, tickets and reporting, on your own servers and your own database.',
  robots: { index: true, follow: true },
};

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-28">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-border bg-canvas px-3 py-1 text-[12px] font-medium text-ink-muted">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              Self-hosted. Your servers, your database.
            </p>
            <h1 className="mt-5 text-balance text-[36px] font-semibold leading-[1.1] tracking-tight text-ink sm:text-[52px]">
              Talk to the people on your website, before they leave it.
            </h1>
            <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-muted">
              SmartChat is live chat, a help centre, a ticket queue and the reporting to go with
              them — for every website you run, in one inbox. You install it on your own
              infrastructure, so the conversations stay yours.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/register"
                className="rounded-[var(--radius-control)] bg-brand px-5 py-3 text-sm font-medium text-ink-inverted shadow-sm transition-colors hover:bg-brand-hover"
              >
                Start free — no card
              </Link>
              <Link
                href="/pricing"
                className="rounded-[var(--radius-control)] border border-border-strong px-5 py-3 text-sm font-medium text-ink transition-colors hover:bg-surface-raised"
              >
                See pricing
              </Link>
            </div>
            <p className="mt-4 text-[13px] text-ink-subtle">
              Fourteen days of everything, no card. Then a free plan you can stay on — one website,
              500 conversations a month.
            </p>
          </div>
        </div>
      </section>

      {/* What it is */}
      <Section>
        <SectionHeading
          eyebrow="What you get"
          title="Everything a support conversation touches, in one place."
          lead="Not a chat widget with an inbox bolted on. The conversation, the article that answers it, the ticket it becomes when nobody is around, and the numbers that tell you whether any of it is working."
        />

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard title="One live inbox" icon={icons.inbox}>
            Every website you run, in one queue. Assign, transfer, tag, add a private note, close
            and reopen. Messages arrive over a socket, so both sides see them without reloading.
          </FeatureCard>
          <FeatureCard title="Rules that start the conversation" icon={icons.bolt}>
            Greet somebody who has been on your pricing page for a minute. Route by department. Ask
            for an order number before the chat starts — and see the answer beside the message.
          </FeatureCard>
          <FeatureCard title="A help centre that answers first" icon={icons.book}>
            Write articles once, publish them on your own domain, and let people find the answer
            themselves. Full-text search, drafts that stay private until you publish.
          </FeatureCard>
          <FeatureCard title="Tickets for the quiet hours" icon={icons.ticket}>
            When nobody is online the widget takes a message and opens a ticket, numbered per
            account. Replies go by email; internal notes never do.
          </FeatureCard>
          <FeatureCard title="Reporting you can check" icon={icons.chart}>
            Volume, first response time, resolution time, per agent and per website — computed in
            your own timezone from your own rows, not sampled.
          </FeatureCard>
          <FeatureCard title="Webhooks and an API" icon={icons.plug}>
            Signed webhooks with retries and a delivery log, plus scoped API keys on the same
            routes the dashboard uses. No second, weaker API to keep in step.
          </FeatureCard>
        </div>
      </Section>

      {/* How it works */}
      <Section tone="surface">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
          <SectionHeading
            eyebrow="How it works"
            title="Installed in an afternoon, not a quarter."
            lead="Three steps, and the third one is the part that usually takes weeks somewhere else."
          />

          <ol className="space-y-8">
            <Step number={1} title="Add your website">
              Create an account and add the site you want to talk to people on. You get a public
              installation snippet — it carries an identifier and no credential, so it is safe to
              paste into a public page.
            </Step>
            <Step number={2} title="Paste one script tag">
              The widget loads in a shadow root, so it cannot inherit or disturb your page's
              styles, and the panel runs in its own frame on its own origin. Nothing about your
              site has to change.
            </Step>
            <Step number={3} title="Answer from one inbox">
              Conversations arrive live. Add your team, scope them to the websites they look after,
              and set the rules that greet people before anybody has to.
            </Step>
          </ol>
        </div>
      </Section>

      {/* Why self-hosted */}
      <Section>
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Why self-hosted"
              title="The conversations are your customers' words. Keep them."
              lead="A hosted chat tool means every message your customers write is stored on somebody else's infrastructure, under somebody else's retention policy, priced per seat."
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FeatureCard title="Your database" icon={icons.shield}>
              Postgres you run. Back it up on your schedule, restore it on your terms, delete what
              you choose to delete.
            </FeatureCard>
            <FeatureCard title="Your retention rules" icon={icons.shield}>
              Set how long conversations are kept per account. A nightly job removes what is past
              it — including the files, not just the rows.
            </FeatureCard>
            <FeatureCard title="Priced by usage" icon={icons.users}>
              Plans are limits on websites, conversations and storage. Adding a colleague to the
              inbox is not a line item.
            </FeatureCard>
            <FeatureCard title="No lock-in" icon={icons.plug}>
              Scoped API keys and signed webhooks on the same endpoints the product uses. Your data
              is reachable from your own systems.
            </FeatureCard>
          </div>
        </div>
      </Section>

      <Section tone="surface">
        <CallToAction
          title="Start on the free plan. Move up when it starts to hurt."
          lead="One website, two seats and 500 conversations a month, free and unlimited in time. No card, and nothing to cancel if you decide against it."
          secondary={{ href: '/pricing', label: 'Compare plans' }}
        />
      </Section>
    </>
  );
}
