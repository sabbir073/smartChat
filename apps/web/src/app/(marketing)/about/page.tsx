import type { Metadata } from 'next';
import { CallToAction, Section } from '@/components/marketing/sections';
import { PageHero } from '@/components/marketing/hero';

export const metadata: Metadata = {
  title: 'About — SmartChat',
  description:
    'Why SmartChat is self-hosted, how it is built, and what it deliberately does not do.',
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title={
          <>
            Support software that does not{' '}
            <span className="mk-gradient-text">hold your conversations hostage.</span>
          </>
        }
        lead="SmartChat exists because the useful chat tools are hosted, metered by the seat, and store every word your customers write on infrastructure you have no say over."
      />

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
                You run it, so you pay for it: the server, the disk, the backups. There is nothing
                for us to meter and nothing to sell you, which is why the whole product is switched
                on for every account. Charging per seat quietly pushes teams to share one login,
                which is worse for everybody and terrible for an audit trail.
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
                No billing at all. There are no plans, no limits sold as tiers, and no payment
                screen anywhere in the product — not a disabled one, not a "coming soon" one. If
                that ever changes, it will be said here first.
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
          title="Put it on your own server."
          lead="Nothing here is a trial. Create an account, add a website, and keep using it for as long as it is useful."
          secondary={{ href: '/contact', label: 'Ask us something' }}
        />
      </Section>
    </>
  );
}
