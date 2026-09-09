# SmartChat — The AI agent

An assistant that answers website visitors from the site's own published content, and hands
everything else to people. It runs as a separate container, answers locally first, and falls back
to a hosted model the operator configures in the console.

## The rules it is built on

1. **No backend access.** The model is never given a tool, a database handle, an API, or a
   callback. Its inputs are text — the system prompt, the passages retrieved for this website, the
   last few messages, the visitor's question — and its output is text that the worker validates
   before anything is written. A hijacked prompt has nothing to reach.
2. **Public content only.** It answers from the website itself (crawled and indexed), the
   published help-centre articles and the "key facts" its owner typed in. Nothing from the inbox,
   contacts, tickets or other conversations is ever in the prompt.
3. **Anything about the business that needs the backend, or that it does not know, becomes a
   ticket.** It says so in one sentence and shows *Create a ticket* / *Ask something else*. Never
   a guess. Greetings, thanks, small talk and general questions that are not about the business
   are answered in the model's own words (`chat`) - "Hello" gets "Hello", not a ticket form.
4. **The owner chooses the mode** per website: *Team* (today's behaviour), *AI when the team is
   offline*, or *AI answers first*. A person replying or being assigned always takes a
   conversation over; the AI never speaks in it again.
5. **Local first, hosted fallback.** The local model (`ai` container) has priority. The fallback
   (OpenAI or DeepSeek, key in the console) is used when the local model fails, times out, is busy,
   or has failed repeatedly.

## Architecture

```
owner saves key facts / publishes an article        visitor sends a message
              │                                                │
              ▼                                                ▼
   API: knowledge_documents row ──► queue ai.index_document   realtime: AiDispatchService.decideAiReply
              │                                                │  (mode, plan, status, paused, agents online)
              ▼                                                ▼
   worker: chunk (≈400 tokens) → embed (local) →       queue ai.reply(messageId)   [one attempt, deduped by id]
           replace knowledge_chunks (one transaction)          │
                                                               ▼
                                              worker AiReplyService:
                                                1. re-check the rules (a person may have taken over)
                                                2. retrieve: hybrid vector + full-text, this website only
                                                3. build prompt (rules · numbered passages · history · question)
                                                4. AiGateway.complete → local, else fallback
                                                5. parseReply: contract, citations, links, length
                                                6. act: answer | ticket offer | handoff(assign)
                                                7. ai_turns row (decision, provider, tokens, latency, chunks)
```

Processes: the **API** serves settings and indexes key facts; the **realtime** server decides and
enqueues; the **worker** owns the `ai` queue and is the only process that calls a model; the
**`ai` container** (Ollama) serves the local models on the internal network and nothing else.

## The models

Chosen by measuring on the production box (12 vCPU AMD EPYC, AVX-512, no GPU) with the real
prompt - rules, practice turns, three or four passages, a question - and schema-constrained JSON
output. Twelve cases: greetings, four answers (one in Bangla, one with history), tickets, a
handoff, a general-knowledge question, an injection, and a question whose answer the passages did
not contain.

| model | right | per reply | notes |
| --- | --- | --- | --- |
| `qwen3.5:0.8b` | - | ~2 s | too weak (contradictory answers) |
| `gemma3:1b` | - | ~2–3 s | decent text, rarely cites a source |
| `qwen3.5:2b` (Q8) | 9/12 | ~4 s, 7–11 s live | good answers, but see below |
| **`qwen3:1.7b`** (Q4_K_M) | **11/12** | **~2.5 s** | the one in production |
| `qwen3:1.7b-q8_0` | 10/12 | ~5 s | slower than Q4 on this CPU, no better |
| `qwen3:4b` | 8/9 | ~6 s | same answers, twice the wait |
| **`embeddinggemma`** | - | 43 ms / query | 768-dim, multilingual; matched a Bangla question to the English passage |

Why not the newer Qwen 3.5: it is a hybrid (linear-attention) architecture, and on a CPU the
model server cannot reuse the cached state of a prompt's shared beginning the way it can for a
plain transformer. Every reply re-read the rules and the practice, and a reply that took 2.5 s
in the benchmark took 7–11 s on the live site once the passages varied. With `qwen3:1.7b` the
rules and practice are processed once per property and stay cached; a reply costs the passages
and the question, about five milliseconds a token, which is what the prompt budget in
`prompt.ts` is sized around.

Both models fit in ~4 GB resident. `think: false` is sent on every request (the reasoning pass
would otherwise cost ~20 s), and Ollama's `format` carries the JSON schema so decoding is
constrained to the contract. The model names come from `AI_CHAT_MODEL` / `AI_EMBED_MODEL`; the
`ai` container pulls exactly those on first boot. **Changing the embedding model changes the vector
space**: it needs `AI_EMBED_DIMENSIONS` and the `vector(768)` column to agree, and every website
must be re-indexed.

Every model on the list, asked for opening hours that the passages did not contain, answered
with the practice shop's "Monday to Friday, 9 to 5" and cited passage 1. That is why the
contract checks the answer, not only the citation: a number that appears in no passage (nor in
the question or the owner's instructions) turns the answer into the ticket offer, and so does any
phrase from the practice example.

## Hosted providers and bring-your-own-key (`hosted.ts`, `anthropic.ts`, `account-ai.service.ts`)

Three hosted providers: OpenAI and DeepSeek through the OpenAI-compatible adapter, and
Anthropic through the Messages API (`anthropic.ts`: the system prompt is a field, the reply is a
tool whose input schema is the contract, and the model is forced to call it - the tool never
runs anywhere, its input is the JSON). `hostedProvider()` is the one place that maps a name to a
class and a default model (`gpt-4o-mini`, `deepseek-chat`, `claude-haiku-4-5`). The operator's
fallback in the console may be any of the three.

An account on a plan with `aiOwnKey` (the Custom plan) can store its own key under Settings →
"Your own AI provider": provider, model, key, and whether the local model still goes first
(`local_first`, the default) or its provider answers everything (`own_only`). The key is checked
against the provider before it is kept, sealed with the settings key, and shown again only by
its last four characters. `AiGateway.complete(request, { accountId })` asks
`AccountAiService.routeFor` (cached thirty seconds per account): with a route, the account's
provider replaces the platform fallback for that account - its key, its bill - and with
`own_only` it replaces the local model too. A plan that no longer includes the feature silently
stops the key being used. Turns record the provider that answered (`anthropic`, …).

## The gateway (`packages/core/src/ai/gateway.ts`)

- Local first. The request goes to the local model with the console's timeout (default 30 s).
- **Fails or times out** → the same request goes to the fallback; the turn records `fell_back` and
  the reason.
- **Three consecutive local failures** → the breaker opens for 60 s and the fallback takes every
  request without waiting.
- **Busy** (more than `AI_LOCAL_PARALLEL` local replies in flight, matching
  `OLLAMA_NUM_PARALLEL`) → overflow goes to the fallback instead of queueing.
- No fallback configured → the local model is waited for; only a hard failure surfaces as
  `AI_UNAVAILABLE`, which the reply service turns into the ticket offer and a `failed` turn.
- **Embeddings are always local** — an index built with one model cannot be queried with another.
  If the local model is down at query time, retrieval degrades to full-text only.

Routing `fallback_only` exists for an operator whose local box is down for maintenance.

## The prompt (`prompt.ts`)

Rules first and short (a 2B model keeps the beginning of a prompt best), then six *practice
turns* about a shop that does not exist - an answer that cites its passage, a fact applied with a
little geography, two tickets, a handoff - then "the practice is over" and the real passages,
numbered so the model can cite them, then the last ten messages and the question. The practice
turns are not decoration: measured on the production model with rules alone, it answered
"ticket" to a helmet return the passage plainly covered and to delivery to a city inside the
country it ships to; with the practice turns it got seven of eight right. Budget: ~3,000
estimated tokens, of which passages take at most 1,600 and history 500.

## The website crawler (`crawler.ts`, `extract.ts`, `crawl.service.ts`)

"Sync website" (and the first switch to an AI mode, and a weekly job) crawls the property's
`websiteUrl`: `robots.txt` first (honoured, and its `Sitemap:` lines), then the sitemap(s), then
links found on pages already read, breadth first, until `crawlMaxPages` (default 200, ceiling
1,000). Each page is reduced to markdown-ish text (Readability for the main content, a
chrome-stripped body for short pages; `<h1>`…`<h6>` become `#` headings so passages keep their
section) and stored as a `page` document keyed by URL; unchanged content (same hash) is only
stamped as seen, so a weekly re-read of an unchanged site embeds nothing. Pages a completed crawl
did not see are removed. A crawl that reads nothing removes nothing and leaves a sentence in
`ai_settings.crawl_error` that the settings page shows.

It is an SSRF target and is built as one: only the property's own host and its `www.` twin, over
http(s) on default ports; every connection resolves the name itself and refuses private,
loopback, link-local, CGNAT and metadata ranges *at connect time* (undici `connect.lookup`), so a
rebinding name gets nothing; redirects followed by hand, three at most, each re-checked; only
`text/html`, 2 MB and 20 s per page, one request a second; the agent names itself
(`GetChatBot/1.0`). `AI_CRAWL_ALLOW_PRIVATE=true` (development only) lifts the private-range
refusal for a test site on localhost.

Hosts that answer every non-browser request with a challenge (LiteSpeed "Bot Verification",
Cloudflare "Just a moment…") are recognised and the crawl stops with an explanation rather than
indexing the challenge page. The crawler does not attempt to pass such challenges; the owner asks
the host to allow the agent, or types the content into Key facts.

**JavaScript-only pages** (`renderer.ts`, `infrastructure/renderer`). A page whose HTML is an
application shell - a `<div id="root">` and a script, a "you need to enable JavaScript" notice,
a body with no words - is sent to the `renderer` container: Chromium behind one endpoint
(`POST /render {url}`), reached only by the worker with a shared secret (`AI_RENDERER_TOKEN`).
The browser fetches no images, media or fonts, waits for the network to go quiet, and returns
the HTML as rendered, which then goes through the same extraction as any page. It applies the
crawler's address rules on its own side, per request, sub-requests included, so a page cannot
make the browser reach anything on the private network. Two renders at once, capped at 1.5 GB
and two cores in production. With `AI_RENDERER_URL` empty such pages are skipped, as before.

**Pages to skip** (`ai_settings.crawl_exclude`, the "Pages to skip" box): path patterns with `*`
wildcards. `/blog` is anchored and covers everything beneath it; `/docs/*/draft` is anchored with
a wildcard; `*.pdf` and `?add-to-cart` match anywhere in the path. The start page is always read.
An excluded page that was indexed earlier is pruned on the next completed crawl, like any page
the crawl no longer sees.

## Product feeds (`feed.ts`, `feed.service.ts`)

A Google Merchant feed (RSS 2.0 or Atom with the `g:` fields) or a CSV/TSV with a header row
using the same names, up to 5,000 products, 20 MB. Read after every website crawl in the same
job (so "Sync website" and the weekly re-read cover it) and straight away when the address is
saved. Each product becomes a `product` document: a `#` title, then price (with the sale price
and the old one), availability, brand, category, condition, model number, then the description
as text - so the price and the stock sit in the same passage as the name. Keyed by the product
link, and a product wins over a crawled page of the same URL (the feed knows the price; the page
may not). Unchanged products (same hash) cost nothing; products the feed no longer lists are
removed when a read completes; a read that fails removes nothing and leaves the reason on the
settings row. Removing the address removes the products.

## Files (`files.service.ts`, `extract-file.ts`)

A PDF price list, a DOCX prospectus, a text or Markdown file - up to 10 MB each, fifty a
website. The upload is the attachment flow: `POST …/ai/files/sign` returns a key the API chose
and a five-minute PUT URL, the browser PUTs the bytes to the store, `POST …/ai/files/:fileId/confirm`
reads them back and identifies them by their bytes (not their name). Anything but PDF, DOCX,
plain text, CSV or Markdown is deleted from the store and refused. A readable file is marked
`processing` and the worker's `ai.extract_file` job extracts the text (pdf.js for PDFs, page by
page; mammoth → the crawler's HTML walk for DOCX, so headings and lists survive), makes a `file`
knowledge document titled with the file name, and indexes it inline. `ready` with the passage
count, or `failed` with the reason on the row - a scanned PDF says so. Delete removes the
document, its chunks and the object together.

## The contract (`contract.ts`)

The model must answer `{"decision": "answer"|"chat"|"ticket"|"human", "text": string, "sources": number[]}`.

- `answer` must cite at least one passage that was in the prompt; an answer with no valid source
  becomes `ticket` ("what it does not know, it does not guess").
- An answer must be **grounded**: every number in it (price, hour, date, phone number - written
  in any numeral system, with or without thousands separators) must appear in a passage the
  model saw, in the visitor's question or in the owner's instructions. One that does not was
  invented, and the answer becomes `ticket`, with the numbers recorded on the turn.
- Nothing from the **practice example** may come through: a reply, answer or chat, that repeats
  one of the practice shop's facts (its hours, its country, its currency) without a real passage
  saying the same becomes `ticket`. Small models do this when asked something the passages do not
  cover - measured on every model tried.
- `chat` is the model's own words, uncited: greetings, thanks, small talk, general questions that
  are not about the business. The prompt forbids stating a fact about the business in a chat
  reply. An empty chat becomes `ticket`.
- For `ticket` and `human` the model's words are dropped; the owner's configured sentences are
  used.
- Text is stripped of markup and control characters, capped at 1,200 characters at a sentence
  boundary, and **links are kept only if their host is the website's own** (its URL or one of its
  allowed domains) — a tampered passage cannot send visitors elsewhere.
- Anything unparseable → `failed` turn, ticket offer posted, nothing retried.

## Retrieval (`knowledge.service.ts`)

`knowledge_chunks` holds ~400-token passages (50-token overlap, heading path carried) with a
pgvector embedding (HNSW, cosine) and a generated `tsvector` (`'simple'` configuration, GIN).
A query runs both — top 20 by vector distance, top 20 by `ts_rank_cd` — and fuses them by
reciprocal rank; key-facts chunks get a small boost. **Every query starts with
`account_id = … AND property_id = …`**: isolation is the SQL, not the model.

Documents: `page` (one per crawled URL), `article` (one per published article, removed on
unpublish/delete, re-indexed when its content hash changes), `notes` (the key facts, one per
website) and `file` (one per uploaded file). Indexing replaces a document's
chunks in one transaction, so a failure leaves the previous passages answering.

## Modes and takeover (`dispatch.ts`)

`decideAiReply` is called by the realtime server (to enqueue) and again by the worker (before it
posts), with the same facts: mode, plan, conversation status/channel/assignee, `ai_paused_at`,
reply count, agents online. It says no for: mode `team`, plan without `ai_agent`, closed
conversation, non-widget channel, paused, assigned, `ai_when_offline` with someone online, or the
per-conversation loop guard (default 50 replies — a guard, not a cap; AI replies are not capped).

`ai_paused_at` is set by the first agent reply (`sendAgentMessage`), by assignment (`assign`), by a
ticket opened from the chat, and by a handoff. It is never cleared by the system.

**Handoff** (`decision: human` with someone online): the conversation is assigned immediately to
the online member with the fewest open conversations — restricted to members who can see that
website — and `ai_handoff_at` is stamped. With nobody online, the visitor gets the ticket offer.

**Hand back and pause.** A person who took over can give the conversation back: `POST
/conversations/:id/ai/resume` clears the pause and the assignment (an assigned conversation is a
person's, by the rules above) and the next visitor message goes to the assistant. `POST
/conversations/:id/ai/pause` stops the assistant in one conversation without anyone replying.
Both are in the conversation header ("Let the AI continue", "Pause AI"), audited, and travel to
every open inbox on the usual events.

**Feedback.** Under every answer the assistant wrote in its own words the widget shows a thumbs
up and down (`POST /widget/messages/:id/feedback {rating}`; `null` withdraws). The rating is
written on the turn (`ai_turns.rating`, for analytics) and into the message's metadata (so the
widget shows it after a reload and the inbox shows it next to the reply). Only the visitor whose
conversation it is can rate, and only a bot message the AI wrote.

## Drafts for agents (`AiReplyService.draft`, `POST /conversations/:id/ai/draft`)

"Suggest a reply" in the composer. The same retrieval, prompt and contract as a visitor-facing
reply, run in the API against the latest visitor message, and the text comes back to the agent
instead of being posted: they read it, edit it, send it - or not. When the model would have
offered a ticket there is no draft and the agent is told the content does not cover it (with a
nudge to add it to Key facts after replying); when the visitor asked for a person, the draft
says so. Needs a plan with the AI agent and the reply permission; twenty a minute per person.
Recorded as a `draft` turn (never counted as a reply) so the report shows how much the team
leans on it.

## The report (`analytics.service.ts`, `/reports/ai`, Reports → AI assistant)

Read live from `ai_turns` for a range of days in the account's timezone, per website or all:
replies by decision, conversations the assistant took part in, **deflected** (of those, the
ones where no person replied, nothing was handed off and no ticket was opened - the number that
says whether the assistant is worth having), average reply latency, how many replies the
fallback provider made, thumbs up and down, and drafts written for agents. A by-day series
(answers, ticket offers, handoffs) for the chart. Then the two lists that change what the owner
does next: **what it could not answer** - the visitor questions that ended in a ticket offer or a
failure, grouped with case, punctuation and spacing flattened, most-asked first - and **rated
not helpful** - the replies visitors gave a thumbs down, with a link to the conversation.

A handoff the assistant makes reaches the assignee as a toast in the inbox and, when the tab is
in the background and the browser allows it, a desktop notification (`by: 'ai'` on the
`conversation:assigned` event; permission is asked for on the first click in the inbox).

## The ticket flow

The offer is a bot message with `metadata.offer = 'ticket'`; the widget renders two buttons under
it. *Create a ticket* opens the offline form pre-filled with the visitor's question and known
details, and posts `POST /widget/offline-message` with `conversationId`. The message and the
ticket attach to that conversation (no new conversation), `ai_paused_at` is set, and the assistant
posts "ticket #N is open…" into the chat. The offline-form switch does not gate this path.

## Data

| table | purpose |
| --- | --- |
| `ai_settings` | per website: `mode`, assistant name, instructions, key facts, offer/handoff texts, loop guard, `crawl_max_pages`, crawl state (`crawl_started_at`, `last_crawled_at`, pages found/indexed, `crawl_error`) |
| `knowledge_documents` | page / article / notes: title, url (unique per website), text, content hash, `indexed_at`, `last_seen_at`, `error` |
| `knowledge_chunks` | passages: `embedding vector(768)`, generated `search tsvector` |
| `ai_turns` | every turn: decision, provider, model, `fell_back`, tokens, latency, retrieved and cited chunk ids, error |
| `conversations` | `ai_reply_count`, `ai_last_reply_at`, `ai_paused_at`, `ai_handoff_at` |
| `plans.ai_replies_per_month` | NULL everywhere (unlimited, by the operator's decision); a cap can be set per plan later |
| `platform_settings` | `ai.fallback_provider`, `ai.fallback_api_key` (sealed), `ai.fallback_model`, `ai.local_timeout_ms`, `ai.routing` |

Messages the AI writes are `sender_type = bot` with `metadata.source = 'ai'`, `senderName`,
`sources[]` and optionally `offer`. `toMessageDto` whitelists these into `message.ai`.

## Permissions

- Tenant `ai:manage` — mode, persona, key facts, re-index. Granted to owner, admin and manager by
  the migration and the role defaults. Viewing needs `property:view`.
- Platform `platform:ai:manage` — the console's AI tab.
- The plan flag `ai_agent` gates switching the mode away from `team`; everything else can be set up
  on any plan.

## Endpoints

Tenant (`authenticateTenant`):

- `GET /properties/:id/ai` — settings, plan, knowledge status, this month's usage.
- `PATCH /properties/:id/ai` — any of `mode`, `assistantName`, `instructions`, `keyFacts`,
  `ticketOfferText`, `handoffText`, `maxRepliesPerConversation`. Changing `keyFacts` re-indexes them.
- `POST /properties/:id/ai/reindex` — "Sync website": crawl the site (one queued job per
  website, de-duplicated) and re-index every article and the key facts (3/hour).

Widget: `POST /widget/offline-message` accepts an optional `conversationId` (see the ticket flow).

Console (`platform:ai:manage`): `GET/PATCH /platform/ai/settings`, `POST /platform/ai/settings/test`
(one tiny completion against the fallback), `GET /platform/ai/health` (local reachability, models
present, this process's breaker), `GET /platform/ai/usage` (this month by decision/provider,
top accounts, recent failures).

## Configuration

Environment (every Node service; the `ai` container reads the model names too):

| variable | default | meaning |
| --- | --- | --- |
| `AI_LOCAL_URL` | `http://ai:11434` | the local Ollama; empty disables local (fallback only) |
| `AI_CHAT_MODEL` | `qwen3:1.7b` | pulled and warmed by the `ai` container |
| `AI_RENDERER_URL` / `AI_RENDERER_TOKEN` | `http://renderer:3000` / — | the page renderer; the token is a shared secret, any long random string |
| `AI_EMBED_MODEL` | `embeddinggemma` | must match `AI_EMBED_DIMENSIONS` and the column |
| `AI_EMBED_DIMENSIONS` | `768` | |
| `AI_LOCAL_PARALLEL` | `2` | `OLLAMA_NUM_PARALLEL`, and the gateway's overflow threshold |
| `AI_FALLBACK_BASE_URL` | empty | route the fallback through an OpenAI-compatible gateway of your own |
| `AI_CRAWL_ALLOW_PRIVATE` | `false` | development only: let the crawler read private addresses |

Console → AI: fallback provider and key, model (`gpt-4o-mini` / `deepseek-chat` by default), local
timeout, routing. Picked up by the worker within thirty seconds; no restart.

The `ai` service in `docker-compose.yml`: `ollama/ollama:0.33.3`, models on the `ollama_models`
volume, `OLLAMA_KEEP_ALIVE=-1` (models stay resident), no published port. The entrypoint
(`infrastructure/ai/entrypoint.sh`) pulls missing models and warms the chat model; the worker warms
the embedding model on boot. Production limits: 7 GB memory, 8 CPUs.

Postgres is built from `infrastructure/docker/postgres.Dockerfile`: the official Alpine image with
pgvector compiled in (not the upstream Debian pgvector image — see the Dockerfile for the collation
reason).

## Privacy

When the fallback answers, the visitor's recent messages in that chat and the retrieved public
passages go to the provider; nothing else about the visitor does. The marketing site's privacy and
terms pages say so, and every AI reply is labelled *AI* in the widget and the inbox.

## Verifying it

Unit tests: `packages/core/src/ai/*.test.ts` — the contract (citations, downgrades, link
stripping, length), the chunker, the prompt budget, the dispatch rules, and the gateway (local
first, fallback on failure and timeout, breaker, overflow, fallback-only).

End to end (`/tmp/e2e/ai.mjs` against a local API + realtime + worker with an Ollama/OpenAI stub):
plan gate on Free; sealed fallback key and test; key facts and articles indexed, unpublished,
re-indexed; an answer with its source and a foreign link stripped; the ticket offer, a ticket
attached to the chat with the confirmation, AI silent afterwards; handoff assigning an online
member; mixed mode silent while online; agent takeover; local failure → fallback, local timeout
(5 s) → fallback, garbage → `failed` + offer; re-index.

Live: the same sequence driven through the real widget on getchat.site against the real
local model.
