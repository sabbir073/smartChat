# SmartChat — Tickets and email

A conversation is a moment. A ticket is a commitment.

The difference that drives every decision below is the channel. A conversation is answered in a
widget somebody has open, in seconds, with both people present. A ticket is answered by email to
somebody who closed the tab an hour ago and will read the reply on a phone tomorrow. That is why a
ticket has a number they can quote, an address captured at the moment they wrote in, and one hard
rule about what leaves the building.

---

## The rule

**A `public` ticket message is emailed to the requester. An `internal` one is not.**

That is the single most dangerous line in this product, because the failure mode is not "the email
did not arrive" — it is "the wrong email arrived", and no apology repairs an agent's private note
about a customer being delivered to that customer.

Everything about how it is written follows from that:

- `visibility` has **no default** anywhere in the contract. Not in the Zod schema, not in the
  route, not in the service. A caller has to say which it is, because a default of `public` sends
  somebody's note the day a caller forgets a field, and a default of `internal` swallows replies.
- The branch that turns a message into an email sits four lines below the insert that creates it,
  in one method of one file, so whoever changes one has to look at the other.
- The composer is a two-button choice that is always visible, never a checkbox tucked under the
  text area. An agent should be able to tell which mode they are in without hunting for a tick.
- The e2e suite counts the messages in Mailpit before and after an internal note, and greps every
  mailbox for the note's words. It asserts absence, not a flag.

---

## The model

```
Ticket        (account_id, property_id, number, contact_id?, conversation_id?,
               requester_email, requester_name?, subject, status, priority, tags,
               assigned_member_id?, department_id?, message_seq,
               first_response_at?, last_message_at, resolved_at?, closed_at?)
TicketMessage (account_id, ticket_id, seq, author_type, author_member_id?, visibility, body)
EmailDelivery (account_id?, template, to_email, subject, status, error?, attempts,
               ticket_id?, ticket_message_id?, queued_at, sent_at?)
```

### The number

Per account, gapless, and what everybody quotes. It is allocated inside the ticket's own
transaction with

```sql
UPDATE accounts SET ticket_seq = ticket_seq + 1 WHERE id = $1 RETURNING ticket_seq
```

The row lock that statement takes serialises two simultaneous creations in the same account, which
is exactly what "gapless and unique" requires. `SELECT max(number) + 1` would hand the same number
to both, and a person quoting "ticket 412" would be quoting two things.

Numbering is per **account**, not per website: an account with three websites has one queue and one
sequence, so an agent moving between them never has to ask "#12 on which site?".

### The requester address

Copied onto the ticket at creation rather than read through the contact on every send. A contact's
address can be corrected later, and an email that already went out went to the address that was
true at the time. A ticket that silently rewrote its own history would make "who did we actually
tell" unanswerable.

### `first_response_at`

The first **public** agent reply, recorded once and never overwritten. An internal note is not a
response to the person waiting, and counting it would make the response-time report a lie that
flatters us.

### Status timestamps

`resolved_at` and `closed_at` are set on the *transition*, not on every write. Re-saving a resolved
ticket after editing its tags does not move the date. Reopening clears both, because a ticket that
is open again was not resolved at any of the times it previously claimed to be.

`resolved` and `closed` are different states on purpose: resolved means we believe it is answered
and anybody can reopen it; closed means filed.

---

## Where tickets come from

**The offline form.** This is the phase's exit criterion and the reason the feature exists.
Somebody wrote in with nobody there to answer, so the answer has to reach them by email later.
`ConversationService.submitOfflineMessage` opens the ticket after the conversation and its message
are committed and the events are published — a failure to open the ticket must never lose the
message, which is safely in the inbox either way.

Two deliberate details:

- No email address means **no ticket**. There is nowhere to send an answer, and a ticket that
  cannot be answered is a row that makes a queue look busier than it is. The conversation still
  exists in the inbox, which is where that message gets handled.
- It is opened through `openFromOfflineMessage`, not through `create` with a synthetic context.
  There is no member here, no permission to check and nobody to audit as the actor; pretending a
  visitor's form submission was an agent action would put a lie in the audit log. It is recorded
  as `system`.

**An agent, by hand** — a phone call, a forwarded email. `notifyRequester` defaults to true but can
be turned off: somebody who has just been on the phone does not need a receipt for the conversation
they were in.

---

## Reply-To, and what we do not pretend

SmartChat does not receive mail. Inbound email ingestion is not in this phase and is not faked.

So a `Reply-To` is only ever written when there is a real mailbox behind it — the account's own
support address, set per website in **Websites → your site → Ticket replies**. When one is set, the
footer says "reply to this email to reach us at that address" and the reply lands in the customer's
own inbox. When one is not set, no `Reply-To` header is written at all and the footer says plainly
that the mailbox is not monitored.

A `Reply-To` pointing at an address nobody reads is worse than none: it invites somebody in trouble
to write into a void and conclude they were ignored.

**The extension point**, when inbound arrives: every ticket email carries `X-SmartChat-Ticket` and
a `[#number]` subject prefix, either of which resolves an inbound message back to its ticket
without guessing.

---

## Whose brand is on it

The recipient of a ticket email is a customer of our customer. They have never heard of SmartChat,
and a support reply arriving under an unfamiliar name reads as phishing. So ticket email carries
the **account's** name, its own layout, and its own footer.

The one exception is the assignment notification, which goes to an agent — a user of this product,
following a link into this product — and uses the product's own shell. It deliberately carries the
subject and the requester but **not** the customer's message: a notification that reproduces
customer data into a mailbox we do not control is a copy of that data somewhere nobody is auditing.

Assigning work to yourself sends nothing. You already know.

---

## Did it actually send?

Enqueuing an email is not sending one, and a provider silently rejecting every message to a domain
looks exactly like a quiet week.

`EmailDelivery` closes that gap. The row is written **before** the job is queued and carries its
id; the worker updates it to `sent` or `failed` afterwards. So the sequence is `queued` → outcome,
and a row that stays `queued` is itself the alarm: the queue is down, or the worker is not running.

Two ordering decisions inside the worker are worth stating:

- **Send first, then record.** If the process dies between the two, the result is a row that says
  `queued` for a message that was sent — a discrepancy somebody can investigate. The opposite order
  produces a row claiming `sent` for a message that never left, which is a discrepancy nobody would
  ever think to look for.
- **Recording never fails the job.** The email has already gone; throwing there would retry a
  delivered message and send it twice. A stale bookkeeping row is the cheaper mistake.

`status` only becomes `failed` on the last attempt. Before that the message is still in flight, and
a row flapping between `failed` and `queued` would make the table unreadable.

Platform mail — password resets, verification — deliberately has **no** delivery row. Those
subjects carry tokens, and a table people browse is not where tokens belong.

---

## Permissions

`ticket:view` to read, `ticket:manage` to write. Owners, administrators and managers get both;
agents get `ticket:view` only in the default role — an agent needs to see the queue, and answering
a customer in writing under the company's name is a decision an account can choose to delegate by
giving them a custom role.

Everything is property-scoped: a restricted agent's queue holds only the websites they work on, and
a ticket on another one answers **404, not 403**, exactly like every other resource here.

There is no public surface. Unlike the help centre, nothing about a ticket is safe to serve to a
stranger.

---

## Endpoints

```
GET    /api/v1/tickets?status=&priority=&propertyId=&assigned=me|unassigned&search=&cursor=&limit=
POST   /api/v1/tickets
GET    /api/v1/tickets/:id
PATCH  /api/v1/tickets/:id
DELETE /api/v1/tickets/:id
GET    /api/v1/tickets/:id/messages
POST   /api/v1/tickets/:id/messages      { body, visibility: "public" | "internal" }
```

`assigned=me` is resolved server-side from the caller's membership and is never a member id sent by
the client. Search matches the subject, the requester's address, and `#number`.

One route for replies and notes, not two. They are the same act from the agent's point of view —
writing something onto a ticket — and `/reply` and `/note` would let a client send the wrong one
without ever naming what it meant.

---

## Verifying it

```
node scripts/e2e-tickets.mjs
```

Requires the stack up including the worker and Mailpit, since it asserts on real delivered mail —
both that it arrived and, for the internal note, that it did not.
