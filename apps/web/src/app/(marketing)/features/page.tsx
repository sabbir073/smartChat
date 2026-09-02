import type { Metadata } from 'next';
import {
  CallToAction,
  FeatureCard,
  Section,
  SectionHeading,
  icons,
} from '@/components/marketing/sections';

export const metadata: Metadata = {
  title: 'Features — SmartChat',
  description:
    'Live chat, automation, a help centre, tickets, reporting, integrations and a team model — what each one actually does.',
  robots: { index: true, follow: true },
};

/**
 * The features page.
 *
 * Written as "what it does and what that means for you" rather than as a checklist. Every claim
 * here corresponds to something the product does today; nothing on this page is a roadmap item
 * written in the present tense.
 */

const GROUPS = [
  {
    eyebrow: 'The inbox',
    title: 'One queue, however many websites you run.',
    lead: 'The place your team lives. Built for somebody handling six conversations at once, not for a demo.',
    features: [
      {
        title: 'Live, both directions',
        icon: icons.inbox,
        body: 'Messages travel over a socket and are acknowledged only once they are committed, so "sent" means durable rather than "it left the browser". A reconnecting visitor is replayed exactly what they missed.',
      },
      {
        title: 'Assignment and transfer',
        icon: icons.users,
        body: 'Take a conversation, hand it to a colleague, or route it to a department. Filters for what is yours, what is unassigned, and what nobody has answered.',
      },
      {
        title: 'Private notes',
        icon: icons.book,
        body: 'Notes are stored as a different kind of message and are never sent to the visitor — not filtered out on the way, simply never in the stream they receive.',
      },
      {
        title: 'Search that reaches the words',
        icon: icons.chart,
        body: 'Search message bodies, not just subjects, with a trigram index behind it. Tags, priority and status narrow rather than widen.',
      },
    ],
  },
  {
    eyebrow: 'Automation',
    title: 'Start the conversation before somebody has to.',
    lead: 'Rules that fire on what a visitor actually did, evaluated on your server rather than in their browser.',
    features: [
      {
        title: 'Triggers',
        icon: icons.bolt,
        body: 'Greet somebody who has been on a page for a minute, or who arrived from a campaign. Add a tag, set a priority, send a message. Once per visit, or every time.',
      },
      {
        title: 'Pre-chat and offline forms',
        icon: icons.ticket,
        body: 'Ask for what you need before the chat starts, and take a message when nobody is online. Answers appear beside the conversation, not buried in it.',
      },
      {
        title: 'Saved replies',
        icon: icons.book,
        body: 'Type a short key and get the paragraph you write forty times a week. Shared across the team.',
      },
    ],
  },
  {
    eyebrow: 'Help centre and tickets',
    title: 'Answer it once, then let people find it.',
    lead: 'The two halves of support that are not live chat, and that most chat tools leave you to buy separately.',
    features: [
      {
        title: 'Public help centre',
        icon: icons.book,
        body: 'Categories and articles, published on your own domain, searchable. Drafts stay invisible to strangers — by index and by direct link.',
      },
      {
        title: 'Tickets with real numbers',
        icon: icons.ticket,
        body: 'Numbered per account and gapless, so "ticket 412" means exactly one thing. Public replies go to the requester by email; internal ones never leave.',
      },
      {
        title: 'Email that arrives',
        icon: icons.plug,
        body: 'Every notification is recorded as a delivery with an outcome, so "did they get it?" is a question with an answer rather than a shrug.',
      },
    ],
  },
  {
    eyebrow: 'Team and access',
    title: 'The right people, on the right websites.',
    lead: 'Permissions are data, checked on the server, on every request.',
    features: [
      {
        title: 'Roles you can shape',
        icon: icons.users,
        body: 'Owner, admin, manager and agent out of the box, plus custom roles on paid plans. Nobody can grant a permission they do not hold themselves.',
      },
      {
        title: 'Scoped to a website',
        icon: icons.shield,
        body: 'Restrict a member to the sites they look after. They see those in the list, by direct link, in search and in replies — and the others answer as though they do not exist.',
      },
      {
        title: 'Departments and availability',
        icon: icons.users,
        body: 'Group your team, route to a group, and let agents set whether they are taking chats right now.',
      },
    ],
  },
  {
    eyebrow: 'Numbers and integrations',
    title: 'Check the work, then connect it to everything else.',
    lead: 'Reporting from your own rows, and the two integration surfaces a real deployment needs.',
    features: [
      {
        title: 'Reports you can trust',
        icon: icons.chart,
        body: 'Volume, first response, resolution, per agent and per website — bucketed in your account’s own timezone, from sums and counts rather than stored averages.',
      },
      {
        title: 'Signed webhooks',
        icon: icons.plug,
        body: 'HMAC-signed with the timestamp in the signature, retried with backoff, and every attempt visible in a delivery log. The queue is the database, so a Redis restart cannot lose one.',
      },
      {
        title: 'Scoped API keys',
        icon: icons.shield,
        body: 'The same routes the dashboard uses, reached with fewer permissions. Shown once, stored hashed, revocable — and the revoked key is kept, because "which key was that" is an incident question.',
      },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <>
      <Section tone="surface" className="border-b border-border">
        <SectionHeading
          centered
          eyebrow="Features"
          title="What it does, and what that gets you."
          lead="Everything on this page works today. Anything we have not built is on the pricing page's FAQ or in the docs, said plainly, rather than written here in the present tense."
        />
      </Section>

      {GROUPS.map((group, index) => (
        <Section key={group.eyebrow} tone={index % 2 === 1 ? 'surface' : 'canvas'}>
          <SectionHeading eyebrow={group.eyebrow} title={group.title} lead={group.lead} />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.features.map((feature) => (
              <FeatureCard key={feature.title} title={feature.title} icon={feature.icon}>
                {feature.body}
              </FeatureCard>
            ))}
          </div>
        </Section>
      ))}

      <Section tone="surface">
        <CallToAction
          title="See it on your own website."
          lead="Create an account, paste one script tag, and watch a conversation arrive in your inbox."
          secondary={{ href: '/pricing', label: 'See pricing' }}
        />
      </Section>
    </>
  );
}
