/**
 * The agent's side, drawn rather than screenshotted.
 *
 * A real screenshot would go stale the first time a padding value changes, and would have to carry
 * either invented customer names or a blurred-out mess. This is built from the same tokens the
 * dashboard uses, so it drifts only when the design system does, and every name in it is plainly
 * an example.
 *
 * A server component: there is nothing to interact with, so there is no reason to ship it as JS.
 */

const THREADS = [
  { name: 'Rowan T.', preview: 'My order says delivered but noth…', time: 'now', unread: 2, active: true },
  { name: 'Priya N.', preview: 'Can I change the delivery address?', time: '4m', unread: 0 },
  { name: 'Visitor · Pricing page', preview: 'Does the free plan include the h…', time: '11m', unread: 1 },
  { name: 'Marcus D.', preview: 'Thanks, that sorted it', time: '38m', unread: 0 },
];

const MESSAGES = [
  { from: 'visitor', text: 'My order says delivered but nothing arrived' },
  { from: 'agent', text: 'Sorry about that. Do you have the order number?' },
  { from: 'visitor', text: '#48120' },
  { from: 'agent', text: "Found it — it went to the depot. I've booked redelivery for Thursday." },
];

function Dot({ className }: { className: string }) {
  return <span className={`size-2.5 rounded-full ${className}`} />;
}

export function InboxPreview() {
  return (
    <div className="mk-glow overflow-hidden rounded-2xl border border-white/10 bg-surface">
      {/* Window chrome. Anchors it as "an application", without pretending to be a real OS. */}
      <div className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        <Dot className="bg-danger/60" />
        <Dot className="bg-warning/70" />
        <Dot className="bg-success/60" />
        <span className="ml-3 rounded-md bg-canvas px-2.5 py-1 text-[11px] text-ink-subtle">
          Inbox · 2 unassigned
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[210px_minmax(0,1fr)] lg:grid-cols-[210px_minmax(0,1fr)_180px]">
        {/* Thread list */}
        <aside className="hidden border-r border-border bg-surface-raised/60 sm:block">
          <div className="flex gap-1.5 border-b border-border px-3 py-2.5 text-[11px]">
            <span className="rounded-full bg-brand-soft px-2 py-0.5 font-medium text-brand">All</span>
            <span className="rounded-full px-2 py-0.5 text-ink-subtle">Mine</span>
            <span className="rounded-full px-2 py-0.5 text-ink-subtle">Unassigned</span>
          </div>
          {THREADS.map((thread) => (
            <div
              key={thread.name}
              className={`border-b border-border px-3 py-2.5 ${
                thread.active ? 'bg-brand-soft/60' : ''
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-[12px] font-medium text-ink">{thread.name}</p>
                <span className="shrink-0 text-[10px] text-ink-subtle">{thread.time}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <p className="truncate text-[11px] text-ink-subtle">{thread.preview}</p>
                {thread.unread > 0 && (
                  <span className="ml-auto grid size-4 shrink-0 place-items-center rounded-full bg-brand text-[9px] font-semibold text-ink-inverted">
                    {thread.unread}
                  </span>
                )}
              </div>
            </div>
          ))}
        </aside>

        {/* Conversation */}
        <section className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="text-[12px] font-semibold text-ink">Rowan T.</span>
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-medium text-warning">
              delivery
            </span>
            <span className="rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
              open
            </span>
            <span className="ml-auto text-[10px] text-ink-subtle">Assigned to you</span>
          </div>

          <div className="space-y-2.5 px-4 py-4">
            {MESSAGES.map((message, index) => (
              <div
                key={index}
                className={`flex ${message.from === 'agent' ? 'justify-end' : 'justify-start'}`}
              >
                <p
                  className={`max-w-[78%] rounded-2xl px-3 py-2 text-[12px] leading-snug ${
                    message.from === 'agent'
                      ? 'rounded-br-md bg-brand text-ink-inverted'
                      : 'rounded-bl-md border border-border bg-surface-raised text-ink'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            ))}

            {/* An internal note, visually distinct, because that distinction is the whole feature. */}
            <div className="rounded-lg border border-warning/30 bg-warning-soft/70 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-warning">
                Internal note · not sent to the visitor
              </p>
              <p className="mt-0.5 text-[11.5px] text-ink">
                Depot confirmed. Refunding the delivery fee too.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
            <span className="flex-1 text-[11.5px] text-ink-subtle">
              Reply, or type <span className="font-medium text-brand">/</span> for a saved reply…
            </span>
            <span className="rounded-md bg-brand px-2.5 py-1 text-[11px] font-medium text-ink-inverted">
              Send
            </span>
          </div>
        </section>

        {/* Visitor panel */}
        <aside className="hidden border-l border-border bg-surface-raised/60 px-3 py-3 lg:block">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">Visitor</p>
          <p className="mt-1.5 text-[12px] font-medium text-ink">Rowan T.</p>
          <p className="text-[11px] text-ink-subtle">rowan@example.com</p>

          <dl className="mt-3 space-y-1.5 text-[11px]">
            {[
              ['Page', '/orders/48120'],
              ['Country', 'United Kingdom'],
              ['Browser', 'Safari · iPhone'],
              ['Conversations', '3'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-ink-subtle">{label}</dt>
                <dd className="truncate font-medium text-ink">{value}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
            Pre-chat
          </p>
          <p className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-ink">
            Order number: <span className="font-medium">#48120</span>
          </p>
        </aside>
      </div>
    </div>
  );
}
