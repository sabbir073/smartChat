# SmartChat — Automation

Phase 6. Two features that look unrelated and are not: both exist so that a small team can answer
more people than it has hands for. Triggers start conversations nobody had time to start;
shortcuts finish the ones they did.

---

## 1. What a trigger is

A rule: *when this happens, and these things are true, do that.*

```
event        →  conditions   →  actions
visitor      →  page.url     →  send a message
arrives         contains        tag it
                /pricing        set priority
                                route to a department
```

### Events

Each one is a real moment in a visit. There is no polling loop looking for work that might have
happened.

| Event | When it is evaluated |
| --- | --- |
| `visitor_arrived` | The visitor's socket connects - the first moment we know they are on the site. |
| `page_viewed` | Each page report from the widget. |
| `time_on_site` | A timer held by their socket, `afterSeconds` from when the **session** started. |
| `conversation_started` | Their first message. Continuing an open conversation is not a start. |

### Conditions

A closed list of fields, not an open path expression - the engine reads a snapshot the gateway
assembles, and a rule that could name an arbitrary path would reach data the snapshot was never
meant to expose.

`page.url`, `page.title`, `page.referrer`, `visitor.country`, `visitor.language`,
`visitor.deviceType`, `visitor.isReturning`, `visitor.isIdentified`, `visitor.visitCount`,
`session.pageViewCount`, `session.secondsOnSite`, `agents.available`.

Operators are constrained by the field's type, on the server and in the builder, from the same
source: `GET /automation/schema` serves exactly what the engine will accept.

Strings compare case-insensitively and trimmed — `/Pricing` and `/pricing` are one page to
everyone except a computer. Numbers compare numerically; as text, `"10" < "9"`.

**A condition whose fact is unknown never matches, including a negative one.** See ADR-035.

### Actions

`send_message`, `add_tag`, `set_priority`, `route_to_department`. Each kind may appear once.

The last three need a conversation to apply to. On an event that can happen before one exists,
the rule must also send a message — which is what starts it. The API refuses the combination
rather than storing a rule that would quietly do nothing.

### How often

| Frequency | Meaning |
| --- | --- |
| `once_per_session` | Once per visit. A reload is the same visit. |
| `once_per_visitor` | Once ever, for that person. |
| `every_time` | Uncapped, bounded by `cooldownSeconds` per visitor. |

---

## 2. How a firing is made to happen exactly once

`trigger_firings` has `UNIQUE (trigger_id, dedupe_key)`. The key is `s:<sessionId>`,
`v:<visitorId>`, or null.

The row is inserted **before** the message is sent. If the insert loses the race, this process
stops and sends nothing — some other socket, possibly on another gateway instance, got there
first. If the actions then fail, the claim is deleted again, so a transient error does not consume
somebody's only greeting.

Postgres treats nulls in a unique index as distinct, so `every_time` gets no cap from the same
index that caps the other two. See ADR-038.

At most one trigger fires per event. Two proactive messages arriving together read as a
malfunction, so `position` decides and the first match wins.

---

## 3. Where it runs

In the realtime gateway, against a live visitor — never over HTTP. There is deliberately no
endpoint that fires a trigger: one would be a way to make somebody's widget say whatever the
caller liked.

Time-based rules are timers on the socket, cleared on disconnect (ADR-039). A queued job would
happily message somebody who closed the tab twenty seconds ago.

The message is delivered twice on purpose — once to the visitor's own socket directly, once
through the normal Redis fan-out — because the conversation the rule just created is a room this
socket could not have joined. The panel keys messages on their id, so the visitor sees one.

Proactive messages are stored with `senderType: 'bot'`. `firstResponseAt` is untouched: it is only
ever set by a person, or the response-time report would be measuring the automation.

---

## 4. Shortcuts

Saved replies, addressed by what an agent types after `/`. Account-wide and shared (ADR-042).

The composer opens a picker when the caret is in a `/word` that starts the message or follows
whitespace — otherwise every pasted URL would open it halfway through `https://`. Arrow keys move
the highlight, Enter or Tab inserts, Escape closes.

Placeholders are expanded **in the composer**, from the conversation on screen:
`{{visitor.name}}`, `{{visitor.email}}`, `{{agent.name}}`, `{{account.name}}`. Anything we cannot
fill is left visible rather than blanked — an agent who can see `{{visitor.email}}` in the box will
fix it before sending; one who sees "We will write to ." will not.

`usageCount` is maintained on insert, so the picker is ordered by what the team actually reaches
for.

---

## 5. The two forms

Both are rendered from the property's published widget configuration, and both are re-validated
against that same configuration server-side — the widget runs on somebody else's page and the
request can be replayed by hand.

**Pre-chat** answers travel with the visitor's first message, so the conversation is created with
them already attached; there is no window in which an agent opens a conversation whose "who is
this" panel is still empty. Missing answers do not block the conversation (ADR-036).

**Offline** submissions create a real conversation on the `offline_form` channel — the same inbox,
not a separate kind of record. Required answers *are* enforced: this is the person's only channel.
Rate limited to five per hour per IP.

Whether the offline form is shown at all comes from real presence, broadcast to the visitor as one
boolean (ADR-040). A team that says it is open but has nobody signed in is offline as far as the
person waiting is concerned.

---

## 6. Verifying it

```
pnpm e2e:automation
```

55 checks against the running stack, including the one that matters most: a real visitor socket
receiving a message nobody asked it to send.
