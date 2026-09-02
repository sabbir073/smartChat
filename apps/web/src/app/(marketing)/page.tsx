import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CallToAction,
  FeatureCard,
  Figure,
  Pill,
  Section,
  SectionHeading,
  Step,
  icons,
} from '@/components/marketing/sections';
import { InboxPreview } from '@/components/marketing/inbox-preview';
import { Reveal } from '@/components/marketing/reveal';
import { WidgetPreview } from '@/components/marketing/widget-preview';

export const metadata: Metadata = {
  title: 'SmartChat — live chat you host yourself',
  description:
    'One inbox for every website you run. Live chat, a help centre, tickets and reporting, on your own servers and your own database.',
  robots: { index: true, follow: true },
};

/** Named in the marquee. Each one is a capability the product has, not a category it aspires to. */
const CAPABILITIES = [
  'Live chat over sockets',
  'One inbox, every website',
  'Help centre',
  'Tickets & email',
  'Automation rules',
  'Saved replies',
  'File attachments',
  'Signed webhooks',
  'Scoped API keys',
  'Departments & roles',
  'Reporting',
  'Data retention',
];

export default function HomePage() {
  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="mk-aurora mk-grid relative border-b border-border bg-canvas">
        <div className="relative mx-auto grid max-w-7xl gap-12 px-5 pb-20 pt-[calc(4rem+72px)] sm:pb-28 sm:pt-[calc(5rem+72px)] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-16">
          <div className="max-w-2xl">
            <Reveal>
              <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/80 px-3.5 py-1.5 text-[12.5px] font-medium text-ink-muted backdrop-blur">
                <span className="relative inline-flex size-1.5 text-success">
                  <span className="mk-pulse-ring absolute inset-0" />
                  <span className="relative size-1.5 rounded-full bg-success" />
                </span>
                Self-hosted — your servers, your database
              </p>
            </Reveal>

            <Reveal delay={80}>
              <h1 className="mt-6 text-balance text-[40px] font-semibold leading-[1.05] tracking-tight text-ink sm:text-[62px]">
                Talk to the people on your website,{' '}
                <span className="mk-gradient-text">before they leave it.</span>
              </h1>
            </Reveal>

            <Reveal delay={160}>
              <p className="mt-6 max-w-xl text-[17.5px] leading-relaxed text-ink-muted">
                Live chat, a help centre, a ticket queue and the reporting to go with them — for
                every website you run, in one inbox. You install it on your own infrastructure, so
                the conversations stay yours.
              </p>
            </Reveal>

            <Reveal delay={240}>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link
                  href="/register"
                  className="group relative overflow-hidden rounded-full bg-gradient-to-r from-brand to-accent-violet px-7 py-3.5 text-[15px] font-semibold text-ink-inverted shadow-lg shadow-brand/25 transition-transform hover:scale-[1.03]"
                >
                  <span className="relative">Start free — no card</span>
                </Link>
                <Link
                  href="/pricing"
                  className="rounded-full border border-border-strong bg-surface/70 px-7 py-3.5 text-[15px] font-medium text-ink backdrop-blur transition-colors hover:bg-surface-raised"
                >
                  See pricing
                </Link>
              </div>
            </Reveal>

            <Reveal delay={320}>
              <p className="mt-5 text-[13.5px] text-ink-subtle">
                Fourteen days of everything, no card. Then a free plan you can stay on — one
                website, 500 conversations a month.
              </p>
            </Reveal>
          </div>

          {/* The widget, playing. Decorative, and the page reads without it. */}
          <Reveal delay={200} className="mx-auto lg:mx-0">
            <div className="mk-float">
              <WidgetPreview />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Capability marquee                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="mk-marquee-wrap overflow-hidden border-b border-border bg-surface py-5">
        {/* Duplicated once so the -50% translation loops seamlessly. aria-hidden: it is decoration
            of the feature list that follows, and a screen reader should hear that list once. */}
        <div className="mk-marquee" aria-hidden>
          {[...CAPABILITIES, ...CAPABILITIES].map((capability, index) => (
            <Pill key={`${capability}-${index}`}>{capability}</Pill>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* What you get                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Section>
        <Reveal>
          <SectionHeading
            centered
            eyebrow="What you get"
            title="Everything a support conversation touches, in one place."
            lead="Not a chat widget with an inbox bolted on. The conversation, the article that answers it, the ticket it becomes when nobody is around, and the numbers that tell you whether any of it is working."
          />
        </Reveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: 'One live inbox',
              icon: icons.inbox,
              body: 'Every website you run, in one queue. Assign, transfer, tag, add a private note, close and reopen. Messages arrive over a socket, so both sides see them without reloading.',
            },
            {
              title: 'Rules that start the conversation',
              icon: icons.bolt,
              body: 'Greet somebody who has been on your pricing page for a minute. Route by department. Ask for an order number before the chat starts — and see the answer beside the message.',
            },
            {
              title: 'A help centre that answers first',
              icon: icons.book,
              body: 'Write articles once, publish them on your own domain, and let people find the answer themselves. Full-text search, drafts that stay private until you publish.',
            },
            {
              title: 'Tickets for the quiet hours',
              icon: icons.ticket,
              body: 'When nobody is online the widget takes a message and opens a ticket, numbered per account. Replies go by email; internal notes never do.',
            },
            {
              title: 'Reporting you can check',
              icon: icons.chart,
              body: 'Volume, first response time, resolution time, per agent and per website — computed in your own timezone from your own rows, not sampled.',
            },
            {
              title: 'Webhooks and an API',
              icon: icons.plug,
              body: 'Signed webhooks with retries and a delivery log, plus scoped API keys on the same routes the dashboard uses. No second, weaker API to keep in step.',
            },
          ].map((feature, index) => (
            <Reveal key={feature.title} delay={index * 60}>
              <FeatureCard title={feature.title} icon={feature.icon}>
                {feature.body}
              </FeatureCard>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* The inbox, on a dark band so it has something to glow against       */}
      {/* ------------------------------------------------------------------ */}
      <Section tone="night" backdrop="both" wide>
        <Reveal>
          <SectionHeading
            night
            centered
            eyebrow="The agent's side"
            title="Built for somebody handling six conversations at once."
            lead="Not for a demo. Filters that narrow rather than widen, search that reaches message bodies, and notes that are a different kind of message rather than a flag on an ordinary one."
          />
        </Reveal>

        <Reveal delay={120} className="mt-12">
          <InboxPreview />
        </Reveal>

        <div className="mt-14 grid gap-8 sm:grid-cols-3">
          {[
            { value: 'Sub-second', label: 'Delivery over a socket, both directions' },
            { value: 'Gapless', label: 'Sequence numbers, so a reconnect replays exactly what was missed' },
            { value: 'Never sent', label: 'Internal notes are not in the visitor’s stream at all' },
          ].map((figure, index) => (
            <Reveal key={figure.value} delay={index * 80}>
              <Figure night value={figure.value} label={figure.label} />
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* How it works                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Section tone="surface">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-start lg:gap-20">
          <Reveal>
            <SectionHeading
              eyebrow="How it works"
              title="Installed in an afternoon, not a quarter."
              lead="Three steps, and the third one is the part that usually takes weeks somewhere else."
            />
            <div className="mt-8 rounded-2xl border border-border bg-canvas p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                The whole installation
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-night p-4 text-[12.5px] leading-relaxed text-ink-inverted/90">
                <code>{`<script>
  window.SmartChat = { p: "your-public-id" };
</script>
<script async src="https://cdn.example.com/loader.js"></script>`}</code>
              </pre>
              <p className="mt-2.5 text-[12.5px] text-ink-subtle">
                A public identifier and no credential — safe to paste into a page anyone can read.
              </p>
            </div>
          </Reveal>

          <ol className="space-y-10">
            {[
              {
                title: 'Add your website',
                body: 'Create an account and add the site you want to talk to people on. You get the snippet above, generated for it.',
              },
              {
                title: 'Paste one script tag',
                body: 'The widget loads in a shadow root, so it cannot inherit or disturb your page’s styles, and the panel runs in its own frame on its own origin. Nothing about your site has to change.',
              },
              {
                title: 'Answer from one inbox',
                body: 'Conversations arrive live. Add your team, scope them to the websites they look after, and set the rules that greet people before anybody has to.',
              },
            ].map((step, index) => (
              <Reveal as="li" key={step.title} delay={index * 90}>
                <Step number={index + 1} title={step.title}>
                  {step.body}
                </Step>
              </Reveal>
            ))}
          </ol>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Why self-hosted                                                     */}
      {/* ------------------------------------------------------------------ */}
      <Section backdrop="aurora">
        <Reveal>
          <SectionHeading
            centered
            eyebrow="Why self-hosted"
            title="The conversations are your customers’ words. Keep them."
            lead="A hosted chat tool means every message your customers write is stored on somebody else’s infrastructure, under somebody else’s retention policy, priced per seat."
          />
        </Reveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              title: 'Your database',
              icon: icons.shield,
              body: 'Postgres you run. Back it up on your schedule, restore it on your terms, delete what you choose to delete.',
            },
            {
              title: 'Your retention rules',
              icon: icons.book,
              body: 'Set how long conversations are kept. A nightly job removes what is past the window — the transcripts, the files behind them, and the visitors.',
            },
            {
              title: 'Not priced per seat',
              icon: icons.users,
              body: 'Plans include a number of team members, and adding a colleague within that number costs nothing. Websites, conversations and storage are what scale.',
            },
            {
              title: 'One deployment',
              icon: icons.plug,
              body: 'Docker Compose, an edge proxy with TLS, health checks and a restore rehearsal that has actually been run rather than merely written down.',
            },
          ].map((item, index) => (
            <Reveal key={item.title} delay={index * 60}>
              <FeatureCard title={item.title} icon={item.icon}>
                {item.body}
              </FeatureCard>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Pricing teaser + CTA                                                */}
      {/* ------------------------------------------------------------------ */}
      <Section tone="surface">
        <div className="grid gap-10 rounded-3xl border border-border bg-canvas p-8 sm:p-12 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <SectionHeading
              eyebrow="Pricing"
              title="Start free. Move up when you outgrow it."
              lead="Every number on the pricing page is read from the same table the server enforces. If a plan says 500 conversations, that is the limit that applies."
            />
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/pricing"
                className="rounded-full bg-brand px-6 py-3 text-sm font-semibold text-ink-inverted transition-colors hover:bg-brand-hover"
              >
                Compare the plans
              </Link>
              <Link
                href="/features"
                className="rounded-full border border-border-strong px-6 py-3 text-sm font-medium text-ink transition-colors hover:bg-surface-raised"
              >
                See everything it does
              </Link>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-7">
              <Figure value="$0" label="Free forever — one website, 500 conversations a month" />
              <Figure value="14 days" label="Of the whole product, with no card asked for" />
              <Figure value="2 months" label="Free when you pay for a year up front" />
              <Figure value="Read-only" label="What being over a limit means. Nothing is ever deleted" />
            </dl>
          </Reveal>
        </div>
      </Section>

      <Section className="!pt-0">
        <Reveal>
          <CallToAction
            title="Put it on your own servers this afternoon."
            lead="Create an account, add a website, paste one script tag. The free plan does not expire and does not ask for a card."
            primary={{ href: '/register', label: 'Start free' }}
            secondary={{ href: '/features', label: 'See what it does' }}
          />
        </Reveal>
      </Section>
    </>
  );
}
