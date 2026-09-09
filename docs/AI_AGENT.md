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

Chosen by measuring on the production box (12 vCPU AMD EPYC, AVX-512, no GPU), with a realistic
~530-token RAG prompt and schema-constrained JSON output:

| model | per reply | verdict |
| --- | --- | --- |
| `qwen3.5:0.8b` | ~2 s | too weak (contradictory answers) |
| `gemma3:1b` | ~2–3 s | decent text, rarely cites a source |
| **`qwen3.5:2b`** | **~4 s** | correct on hours, warranty, refunds, handoff, Bangla; refused an injection |
| **`embeddinggemma`** | 43 ms / query | 768-dim, multilingual; matched a Bangla question to the English passage |

Both fit in ~5 GB resident. `think: false` is sent on every request (Qwen 3.5's reasoning pass
would otherwise cost ~20 s), and Ollama's `format` carries the JSON schema so decoding is
constrained to the contract. The model names come from `AI_CHAT_MODEL` / `AI_EMBED_MODEL`; the
`ai` container pulls exactly those on first boot. **Changing the embedding model changes the vector
space**: it needs `AI_EMBED_DIMENSIONS` and the `vector(768)` column to agree, and every website
must be re-indexed.

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

## The contract (`contract.ts`)

The model must answer `{"decision": "answer"|"chat"|"ticket"|"human", "text": string, "sources": number[]}`.

- `answer` must cite at least one passage that was in the prompt; an answer with no valid source
  becomes `ticket` ("what it does not know, it does not guess").
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
unpublish/delete, re-indexed when its content hash changes) and `notes` (the key facts, one per
website). Indexing replaces a document's
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
| `AI_CHAT_MODEL` | `qwen3.5:2b` | pulled and warmed by the `ai` container |
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
`qwen3.5:2b`.
