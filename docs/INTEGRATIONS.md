# SmartChat — API keys and webhooks

Two ways in, and one way out. An **API key** lets somebody else's code read and write through the
same routes an agent uses, with fewer permissions. A **webhook** lets us tell somebody else's code
that something happened, so they do not have to keep asking.

---

## API keys

### A key is another kind of actor, not another API

`ActorType.api_key` was already in this schema from phase 1, and that is the shape of the answer.
A key does not get its own handlers, its own resource paths or its own authorisation rules. It
authenticates on the **same routes**, produces an ordinary `TenantContext`, and goes through the
same permission checks and the same audit log a member does.

The alternative — a parallel `/public-api/` surface with its own middleware — means two
authorisation paths, and two paths drift. The day somebody tightens a check on one, the other keeps
the old behaviour, and nobody notices until it matters.

```
Authorization: Bearer sck_a1b2c3d4e5f6_<43 characters>
                      ^ prefix          ^ secret
```

The **prefix is an id, not a secret**: it is unique and indexed, every request looks the key up by
it, and it is what the dashboard shows so a person can tell two keys apart long after the secret is
gone. Only a SHA-256 of the secret is stored.

**Why SHA-256 and not Argon2.** Argon2 is correct for passwords because passwords are low-entropy
and guessable, so the defence is making each guess expensive. An API key is 256 bits of CSPRNG
output — there is nothing to guess — and running a deliberately slow hash on **every API request**
would turn the authentication path into a denial-of-service amplifier: one attacker with a stream
of invalid keys could saturate the CPU. The same reasoning already governs session tokens here.

### Scopes

A smaller vocabulary than a member's permissions, and phrased for integrations rather than roles:

```
conversations:read   contacts:read   contacts:write
tickets:read         tickets:write   articles:read
articles:write       reports:read
```

Each expands to real `Permission` values, so a key ends up going through exactly the checks a
member does. There is no second authorisation model to keep in step.

There is **no scope that manages the team, the billing, other keys or webhooks**. A key that could
mint another key would make revocation meaningless — revoke one and its children keep working — so
the whole `/integrations` scope refuses API-key authentication outright rather than relying on
scopes never happening to be wide enough.

**A key can never grant what its creator does not have.** Creating one checks every expanded
permission against the creator's own set, otherwise "make an API key" becomes a
privilege-escalation primitive for anybody allowed to make one.

Keys can also be **restricted to specific websites**, exactly as a restricted member is.

### Revocation

`revokedAt`, not a delete. Revocation takes effect on the **next request** — there is no cache to
expire — and the row is kept, because "which key was that, who made it, and when did we turn it
off" is a question somebody asks in the middle of an incident, and a deleted row cannot answer it.

Every failure to authenticate returns the **same** 401: unknown prefix, wrong secret, revoked,
expired, suspended account. Distinguishing them is how a key space gets enumerated.

`lastUsedAt` is written at most once a minute. Knowing a key is still in use is worth a lot; a
database write on every request is worth nothing.

### No CSRF on the key path

Deliberate, not forgotten. CSRF exists because a browser attaches cookies to cross-site requests by
itself. Nothing attaches an `Authorization` header on anybody's behalf.

---

## Webhooks

### The queue is the database

This is the decision the whole feature rests on.

A delivery row is written by **the same request that caused the event**, before anything is
enqueued. The BullMQ job that carries it is an optimisation for latency. A sweeper runs every
minute and asks the *database* what is due, so anything the fast path never reached — Redis down
when the row was written, a queue flushed, a job whose retries were exhausted — still goes.

The usual design is the opposite: publish to a queue and let a consumer deliver. That loses events
whenever the queue does, and the loss is silent. For an integration somebody has built a business
process on, "we published something and hoped" is not the same claim as "we told them", and the
difference only shows up on the day it costs money.

### Signing

```
X-SmartChat-Signature: t=1730000000,v1=<hmac-sha256 of "timestamp.body">
X-SmartChat-Event:     ticket.created
X-SmartChat-Delivery:  <delivery id>
```

The timestamp is signed **with** the body, not merely sent alongside it. A bare HMAC of the body
answers "did SmartChat send this" but not "is this fresh" — so a delivery captured once could be
replayed forever and would verify perfectly. Receivers should reject anything older than five
minutes; our own reference verifier does.

The header shape is the one several well-known products use. Not because copying is a virtue, but
because an integrator has probably written this verification before, and a familiar shape is one
they are less likely to get wrong. `v1` is a version, so a future scheme can ship without breaking
every existing endpoint.

**Verify against the raw bytes.** Re-serialising parsed JSON produces a different string and a
signature that never matches. It is the most common mistake in webhook receivers, so the e2e suite
does it the right way explicitly, and its verifier is written from this documentation rather than
imported from our own code — two copies of one function only ever prove that the function agrees
with itself.

### Retry, and giving up

Six attempts, at roughly 10s, 1m, 5m, 30m, 2h, 2h. After that the delivery is `failed` and kept, so
somebody can see what was missed.

After **20 consecutive failures** the endpoint is disabled automatically, with the reason recorded.
An endpoint that has failed twenty times in a row is gone, not unlucky, and continuing forever
turns one dead integration into permanent load on both systems. Re-enabling **clears the failure
count** — otherwise an endpoint disabled at twenty would be re-disabled by its twenty-first, which
is to say by its next one, and the person who just fixed it would watch it turn itself off again
for no visible reason.

Any success resets the count.

### The events

```
conversation.started   conversation.closed
ticket.created         ticket.replied      ticket.status_changed
ping
```

That list is exactly what is emitted. It replaced an eight-entry list drafted in phase 0 that
included `message.created`, `visitor.created`, `conversation.updated` and `ticket.updated` —
**none of which anything sent**. Offering a subscription to an event that never arrives is worse
than not offering it: the integrator wires it up, tests nothing (because nothing comes), and finds
out months later that the silence was the product rather than their code.

There is **no wildcard**. `*` would silently start delivering a new event shape to an endpoint that
has never seen it, on the day we add one.

`ticket.replied` fires only for **public** replies. An internal note is not something that happened
to the customer, and an integration that mirrored notes into a shared channel would leak them by
design.

The gateway emits too. Almost every conversation starts over a socket, so a webhook service wired
only into the API would miss the event it exists for.

### Emitting never breaks the thing that happened

The conversation or ticket is already committed by the time a webhook is queued. A webhook table
that is unreachable must not turn a successful close into a 500 for the agent who clicked it — so
the emit is wrapped, and the absence of a delivery row is itself the record that nothing went.

### The endpoint has to be a real address

A webhook URL is an address this server makes outbound requests to, on a schedule the account
controls. Left open, that is a server-side request forgery primitive: point it at
`http://postgres:5432`, at a cloud metadata endpoint, at anything on the private network.

So the rule is an allow-list of shape: **https only**, a public-looking host, no RFC1918 or
loopback literal, no bare hostname without a dot, and none of the service names on this compose
network. `http://` is refused as well as private hosts — the signature proves who sent a payload,
it does not hide what is in it.

`ALLOW_PRIVATE_WEBHOOK_URLS` relaxes this for development, because a test receiver has to run
somewhere and in development that somewhere is the developer's machine. It defaults to **false**,
is set only in the development compose overlay, and is read from configuration at boot — there is
no request that can widen it.

---

## Endpoints

```
GET    /api/v1/integrations/keys
POST   /api/v1/integrations/keys                       { name, scopes[], propertyIds[], expiresAt? }
DELETE /api/v1/integrations/keys/:id

GET    /api/v1/integrations/webhooks
POST   /api/v1/integrations/webhooks                   { name, url, events[], enabled }
PATCH  /api/v1/integrations/webhooks/:id
DELETE /api/v1/integrations/webhooks/:id
GET    /api/v1/integrations/webhooks/:id/deliveries?limit=
POST   /api/v1/integrations/webhooks/:id/ping
```

Reading needs `account:view`; everything else needs `account:update`. All of it is dashboard-only —
a session, never a key.

---

## Verifying it

```
node scripts/e2e-integrations.mjs
```

Stands up a real HTTP receiver, takes the raw bytes off the wire, and verifies the signature the
way an integrator would — including rejecting a body it corrupts by one word, a wrong secret, and a
timestamp six minutes old. A verifier that accepts everything passes every positive test, which is
why the negative ones are there.
