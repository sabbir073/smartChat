# SmartChat — Widget Architecture

The widget runs on **other people's websites**. That single fact drives every decision here: it must
be tiny, isolated, asynchronous, versioned, and incapable of breaking the host page.

## 1. Installation snippet

```html
<script>
  (function (w, d, s, u) {
    w.SmartChat = w.SmartChat || function () { (w.SmartChat.q = w.SmartChat.q || []).push(arguments); };
    var e = d.createElement(s); e.async = 1; e.src = u;
    var f = d.getElementsByTagName(s)[0]; f.parentNode.insertBefore(e, f);
  })(window, document, 'script', 'https://cdn.example.com/v1/loader.js?p=prp_XXXXXXXXXXXXXXXX');
</script>
```

- The only identifier in it is the property's **public id** (`prp_…`), which is safe to expose: it
  identifies a property, it authorises nothing, and every request carrying it is origin-checked
  server side.
- No API key, no account id, no secret ever appears in the snippet.
- `w.SmartChat` is a command queue, so `SmartChat('open')` works before the bundle has loaded.
- `async` + `insertBefore` means the host page never blocks on us.

## 2. Two-stage loading

```
loader.js  (target < 4 KB gzipped, zero dependencies)
   │  fetches GET /api/v1/widget/config?p=prp_…
   │  renders the launcher button into a Shadow DOM root
   │  installs the postMessage bridge
   └─ on first open ──► creates <iframe src="{WIDGET_URL}/panel?p=prp_…">
                          │
                          └─ panel  (full React chat UI, our origin)
                               ├─ REST  → /api/v1/widget/*
                               └─ WS    → /visitor namespace
```

The panel is loaded only when it is needed. A visitor who never opens the chat downloads a few
kilobytes and nothing else.

## 3. Isolation

| Risk | Mitigation |
| --- | --- |
| Host CSS bleeding into our UI | Launcher lives in a **closed Shadow DOM**; panel lives in an **iframe** on our origin |
| Our CSS bleeding into the host | Same — nothing we inject is in the host's cascade |
| JS global collisions | One namespaced global (`window.SmartChat`). We never patch prototypes, `fetch`, `XMLHttpRequest`, `history` or event handlers |
| Host reading visitor data | Panel is a cross-origin iframe; its `localStorage` and its visitor token are unreachable from the host page |
| Our failure breaking the host | The whole loader body is wrapped in try/catch; any error is swallowed after an optional beacon, and the launcher simply does not render |
| CSP on the host site | Documented directives; the loader uses no `eval`, no inline styles injected into the host document, and no `document.write` |

## 4. postMessage bridge

The loader and the panel talk over `postMessage` with a strict contract:

- Both sides pin `targetOrigin` to the exact widget origin — never `*`.
- Both sides verify `event.origin` and a per-instance nonce before acting on a message.
- The message set is small and closed, and every name is `sc:`-prefixed so it cannot collide with
  whatever else the customer's page is posting:
  - panel → host: `sc:panel:ready`, `sc:panel:resize`, `sc:panel:close`, `sc:panel:unread`,
    `sc:panel:sound`, `sc:panel:alert` (a message arrived: chime, flash the tab, notify if away),
    `sc:panel:permission` (ask the browser for notification permission), `sc:panel:engaged`
    (the visitor wrote back after a greeting)
  - host → panel: `sc:host:init`, `sc:host:open` (with `proactive: true` when the loader opened
    the window on its own), `sc:host:close`, `sc:host:page`, `sc:host:identify`,
    `sc:host:visibility`, `sc:host:preview-config`
- `sc:host:preview-config` is the builder only: the dashboard pushes an unpublished configuration
  straight into the real panel, so the preview is the widget rather than a second implementation
  of it that could drift.
- Unknown message types are dropped silently.

## 5. Configuration surface

Fetched at load, cached with a short TTL, and versioned so a publish takes effect without the
customer touching their snippet.

- **Appearance** — primary/text/header/button colours, launcher icon, logo, avatar, border radius,
  size, typography, light/dark/auto.
- **Placement** — corner, horizontal offset, vertical offset, desktop/mobile visibility.
- **Behaviour** — start open/closed, show delay, sound, badge, typing indicators, offline mode,
  the proactive greeting (`proactiveEnabled`, `proactiveDelaySeconds`), whether a name and
  email are required first (`preChatEnabled`), browser notifications (`browserNotifications`).
- **Content** — title, welcome message, the proactive greeting text (`proactiveMessage`), input
  placeholder, offline message, agent display name, business name, locale.
- **Forms** — pre-chat form fields and the offline form, both fully data-driven.

The widget builder in the dashboard renders a live preview of exactly this config object, so preview
and production cannot drift.

## 5a. Who the visitor sees

The window's header shows a real person from the business: the member the conversation is
assigned to, or the account's owner while nobody has it. The server sends `presenter` (a name and
a picture URL, nothing else) with the session and the resume, and pushes
`conversation:presenter` on the conversation's channel whenever an assignment, transfer,
hand-back or AI handoff changes it, so the picture swaps live. A member's picture is uploaded in
Settings → Profile (`POST /auth/profile/avatar/sign` → PUT → `confirm`), verified by its bytes,
and served at a public, immutable address (`GET /avatars/:userId/:avatarId`). With no picture the
initials of the person shown stand in; `appearance.avatarUrl` is the fallback picture.

## 5b. The proactive greeting

With `behaviour.proactiveEnabled` (on by default), `proactiveDelaySeconds` after the page loads
the loader opens the window and the panel asks the server for the greeting
(`conversation:greet`). The server decides: once a day per visitor (`visitors.greeted_at`), never
over an open conversation, never for a banned visitor. When it greets, it opens a real
conversation with the configured text as a bot message from the assistant (or the team's display
name where there is no assistant), so the inbox sees a "Visitor" conversation the moment
somebody is on the site. The visitor's first words continue that conversation; when
`preChatEnabled` is on, the name-and-email form appears inside the conversation before they go
out, and the answers travel with them (`conversation:start` continues a greeting's conversation).
A greeting nobody answered is closed by the worker's ten-minute sweep after thirty minutes with a
system line, so the inbox shows people who talked. The loader remembers the greeting in
`localStorage` too, so a page navigation never pops the window twice.

## 5c. Sound and notifications

The chime is synthesised with the Web Audio API (two short notes; no audio file, nothing
copied), on both sides: the inbox plays it on every incoming visitor message (a mute toggle
beside "Live", remembered per browser) and the loader plays it on the customer's page for every
reply when `behaviour.soundEnabled`. Browsers refuse sound before a gesture, so the first click
unlocks it. While the tab is hidden, the inbox posts a desktop notification that opens the
conversation and puts the unread count in the tab title; the loader flashes the host page's
title and, if `behaviour.browserNotifications` is on and the visitor granted it (asked after
their first message), a notification that opens the window.

## 6. Domain security

Each property holds an allowed-domain list. The API validates the `Origin` header of every widget
request against it and returns 403 for a mismatch when enforcement is on.

- Exact hosts (`example.com`), wildcard subdomains (`*.example.com`), and explicit
  `localhost`/`127.0.0.1` entries for development.
- Until the customer enables enforcement, unknown origins are simply **not checked**. Nothing is
  recorded about them: there is no column, log line or metric holding an observed origin, and this
  page previously said there was.
- Installation verification works from the widget's first config request: `GET /widget/config`
  from an allowed origin marks the property installed and stamps `lastWidgetRequestAt`. The URL is
  not stored — only the timestamp. That request is the right signal because the loader makes it on
  every page it renders on, whereas a visitor may never open the panel.

## 7. Versioning

`/v1/loader.js` is a permanent URL. A customer who pasted the snippet in 2026 must still have a
working widget in 2030.

- The loader is served with a short cache TTL; the panel bundle is content-hashed and served
  immutable.
- The config endpoint is versioned and additive — new fields always have defaults, so an older
  cached loader ignores what it does not know.
- Breaking changes ship as `/v2/loader.js`, and `/v1` keeps working.

## 8. Accessibility

Keyboard-operable launcher and panel, focus trapped inside the open panel and restored on close,
`aria-live` on the message list, labelled controls, visible focus rings, and contrast checked
against the customer's chosen colours with a warning in the builder when it fails AA.

## Ending a chat

The visitor can end their own chat from "End chat" in the panel header, behind an inline
confirmation (never `confirm()` — a browser dialog inside a cross-origin iframe blocks the host
page). The panel does not mark itself closed optimistically: it waits for the server, so the
agent's screen and the visitor's always agree about whether the conversation is live.

Whoever ends it — visitor or agent — the ending is written into the transcript as a system message
and pushed to both sides live. See ADR-027. What each side sees:

| | Visitor's panel | Agent's inbox |
| --- | --- | --- |
| Visitor ends it | "You ended this chat" | "The visitor ended this chat" |
| Agent ends it | "<agent name> ended this chat" | "<agent name> ended this chat" |
| Agent reopens it | "<agent name> reopened this chat" | "<agent name> reopened this chat" |

Once ended, the panel keeps the transcript on screen — somebody who has just been helped often
wants to re-read it — and replaces the composer with "This chat has ended" and a **Start a new
chat** button. The composer is replaced rather than disabled, because a disabled text box invites
people to type into it and wonder why nothing happens.

"Start a new chat" clears the panel and forgets the conversation id, so the next message creates a
new conversation. Pre-chat is not asked again: the visitor has already said who they are, and
asking twice in one session is a tax on somebody who has just been through a support conversation.

If an agent reopens a conversation the visitor had ended, the panel un-ends itself live and the
composer returns.

The header's × is **minimise**, not end. It was labelled "Close chat" when there was nothing to
end, which made it look like it threw the conversation away.
