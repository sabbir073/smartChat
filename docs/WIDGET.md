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
- The message set is small and closed: `panel:ready`, `panel:resize`, `panel:close`,
  `panel:unread`, `host:open`, `host:close`, `host:identify`, `host:page`.
- Unknown message types are dropped silently.

## 5. Configuration surface

Fetched at load, cached with a short TTL, and versioned so a publish takes effect without the
customer touching their snippet.

- **Appearance** — primary/text/header/button colours, launcher icon, logo, avatar, border radius,
  size, typography, light/dark/auto.
- **Placement** — corner, horizontal offset, vertical offset, desktop/mobile visibility.
- **Behaviour** — start open/closed, show delay, sound, badge, typing indicators, offline mode.
- **Content** — title, welcome message, input placeholder, offline message, greeting, agent display
  name, business name, locale.
- **Forms** — pre-chat form fields and the offline form, both fully data-driven.

The widget builder in the dashboard renders a live preview of exactly this config object, so preview
and production cannot drift.

## 6. Domain security

Each property holds an allowed-domain list. The API validates the `Origin` header of every widget
request against it and returns 403 for a mismatch when enforcement is on.

- Exact hosts (`example.com`), wildcard subdomains (`*.example.com`), and explicit
  `localhost`/`127.0.0.1` entries for development.
- Until the customer enables enforcement, unknown origins are **recorded**, not blocked, so a
  misconfigured install shows up in the dashboard instead of silently failing.
- Installation verification works from the same signal: the first widget config request from an
  allowed origin marks the property installed and records the URL.

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
