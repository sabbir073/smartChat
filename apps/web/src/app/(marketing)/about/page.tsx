import type { Metadata } from 'next';
import { CallToAction, Section, SectionHeading } from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'About — SmartChat',
  description:
    'Why SmartChat is self-hosted, how it is built, and what it deliberately does not do.',
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  return (
    <>
      <Section tone="surface" className="border-b border-border">
        <SectionHeading
          eyebrow="About"
          title="Support software that does not hold your conversations hostage."
          lead="SmartChat exists because the useful chat tools are hosted, priced per seat, and store every word your customers write on infrastructure you have no say over."
        />
      </Section>

      <Section>
        <div className="mx-auto max-w-3xl space-y-10">
          <div>
            <h2 className="text-[20px] font-semibold tracking-tight text-ink">What we believe</h2>
            <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-muted">
              <p>
                A support conversation is one of the most revealing things a customer will ever give
                you. It contains their problem, their order number, sometimes their frustration.
                That belongs in your database, under your backup schedule and your retention policy
                — not in a vendor's, under theirs.
              </p>
              <p>
                Pricing should follow what costs something to run. Websites, conversations and
                storage cost us something; a colleague joining your inbox does not. Charging per
                seat quietly pushes teams to share one login, which is worse for everybody and
                terrible for an audit trail.
              </p>
              <p>
                And a product should do what it says. If a button exists, it works. If a feature is
                not built, we say so on the page rather than showing a control that does nothing.
              </p>
            </div>
          </div>

          <div>
            <h2 className="text-[20px] font-semibold tracking-tight text-ink">How it is built</h2>
            <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-muted">
              <p>
                One Postgres database, shared by every account, with the tenant identifier on every
                row and composite foreign keys that make a cross-tenant reference impossible in the
                schema itself. Reading somebody else's record returns 404 rather than 403, because
                "you may not see conversation X" confirms that conversation X exists.
              </p>
              <p>
                Chat runs over Socket.IO with Redis behind it, so the gateway scales horizontally.
                Files go to S3-compatible storage over signed URLs and are identified by their real
                leading bytes rather than by what the browser claimed. Email, webhooks, analytics
                and retention run as queued jobs whose records live in the database, so a queue
                restart cannot lose one.
              </p>
              <p>
                It ships as Docker images with an edge proxy, health and readiness endpoints,
                Prometheus metrics, and backup and restore scripts that are exercised on every
                change — because a backup nobody has restored is not a backup.
              </p>
            </div>
          </div>

          <div>
            <h2 className="text-[20px] font-semibold tracking-tight text-ink">
              What it deliberately does not do
            </h2>
            <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-muted">
              <p>
                No card payments yet. Plans are chosen in the product and invoiced by us; there is
                no checkout button, because a checkout button that does not take money is worse
                than none.
              </p>
              <p>
                No AI answering, no voice or video, and no mobile apps. Each has an obvious place to
                attach, and none is half-built behind a "coming soon" label.
              </p>
              <p>
                No third-party analytics or tracking script on any surface — not on this site, not
                in the dashboard, and not in the widget that runs on your customers' pages.
              </p>
            </div>
          </div>
        </div>
      </Section>

      <Section tone="surface">
        <CallToAction
          title="Try it on one website."
          lead="The free plan is not a trial. If it does what you need at that size, stay on it."
          secondary={{ href: '/contact', label: 'Ask us something' }}
        />
      </Section>
    </>
  );
}
