# Voice calls

A visitor presses **Call** in the widget. Everyone on the team who is available rings in the
dashboard; the first to answer talks. The call can be transferred to one colleague or to the AI,
and the AI answers when nobody does. Everything said on an AI call lands in the conversation's
transcript, so a call is a chat head: it belongs to the conversation the visitor was in.

Calling is included from the Growth plan, with a monthly allowance of call minutes per account.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Media server | `livekit` container (LiveKit, Apache-2.0) | Carries the audio between browsers and the AI. One room per call. Never decides who may be in a room: the API mints every key. |
| Call state machine | `packages/core/src/voice/call.service.ts` | Start, ring, answer (first claim wins), decline, transfer, timeouts, end, minutes. Used by the API, the worker (timers) and the voice agent. |
| Settings | `packages/core/src/voice/settings.service.ts` | Per website: enabled, ring time, whether the AI answers, voices, phrases. |
| API | `apps/api/src/routes/voice.routes.ts`, `widget.routes.ts` | The team's and the visitor's endpoints, and the media server's webhook. |
| Timers | `apps/worker/src/processors/voice.ts` | Ring and transfer timeouts, the stuck-call sweep. Queue `voice`. |
| Voice agent | `apps/voice` | Joins a room as the AI: listens through the speech service, thinks with the chat brain (`AiReplyService.voiceTurn`), speaks through the speech service. Queue `voice_ai`. |
| Speech service | `infrastructure/speech` (Python, sherpa-onnx) | VAD, language ID (Bengali / English), speech-to-text, text-to-speech. CPU only; GPU later by configuration. |
| Widget | `apps/widget` | The Call button, the pre-call form, the call bar. Chat keeps working during a call. |
| Dashboard | `apps/web` | Ringing card and sound, call bar in the thread, transfer, settings page, plan feature. |

## The call, step by step

1. `POST /widget/calls` — plan includes voice, website has it on, minutes left. The visitor's open
   conversation is reused or a new one opened (with the pre-chat answers). A room is created; the
   visitor gets a key (`join`) in the response; `call:updated` goes to the website's agents and to
   the visitor; a `voice.ring_timeout` job is set for the website's ring time. The conversation
   gets a `call.started` system message.
2. Agents see the ringing card. `POST /calls/:id/answer` claims the call with one Redis `SET NX`
   per ring round; the winner gets a key; everyone else gets 409 and the card says "taken".
3. The call is `connecting` until both the visitor and the answerer are in the room (the media
   webhook, or `POST .../joined` from either client), then `active`.
4. Ring timeout: the AI takes the call if the website allows it, the AI is configured and the
   plan has the AI agent; if not, the call is missed (`call.missed`, reason `no_answer`). When the
   AI is already on as many calls as its server-wide cap (`VOICE_AI_MAX_CALLS`), the caller holds
   instead: the call stays `ringing` with `queuedAt` set, the widget says "All our lines are busy
   — please hold", the team can still answer it, and a `voice.ai_retry` job asks again every 3 s.
   The AI takes holding callers oldest first; a caller still holding after 120 s is ended with
   reason `busy` ("All our lines are busy — please try again soon"). Each hand-over is decided
   under one Redis lock, counting the AI's calls from the record (handed over and not ended) as
   well as the voice agent's own count, so two calls whose ring ran out together cannot both take
   the last place. A transfer to the AI does not overtake callers who are holding.
5. Transfer: `POST /calls/:id/transfer {to:'member', memberId}` rings that one person for 20 s;
   the sender keeps the call until they answer; a decline or timeout brings it back with a
   `transfer_failed` event. `{to:'ai'}` makes the AI join first; the sender is removed from the
   room only once the AI is in.
6. The AI asks for a person (`human` decision): the team rings while the AI keeps talking; an
   answer removes the AI; no answer brings the call back to the AI, which offers a ticket.
7. End: either side hangs up, the visitor's page goes away, or the AI says goodbye. Minutes are
   counted from the answer, rounded up per call. `call.ended` carries the duration.

## Events

`call:updated` with `{ call: CallDto }` (`packages/types/src/voice.ts`) on every change, to the
property's agents (`agentsOnly`) and to the visitor (`toVisitor`). Clients render only from the
latest DTO they have. Transcript messages carry `voice: { callId }`; call milestones are system
messages with `event.kind` `call.started | call.answered | call.transferred | call.missed |
call.ended`.

## Configuration

| Variable | Meaning |
|---|---|
| `VOICE_ENABLED` | Off by default. On, the five below are required in production. |
| `LIVEKIT_PUBLIC_URL` | `wss://lk.example.com` - what browsers connect to. |
| `LIVEKIT_API_URL` | `http://livekit:7880` - what the API and the agent use. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Mint room keys. The secret must be 32+ characters. |
| `SPEECH_URL`, `SPEECH_TOKEN` | The speech service. |
| `VOICE_AI_MAX_CALLS` | How many calls the AI may be on at once, server-wide (default 1 on a CPU box). |

The AI's phrases (greeting, hold on, ticket offer, goodbye) have defaults in both languages in
`packages/core/src/voice/phrases.ts`; owners override them per website.

## Deploying it

Calling is off until `VOICE_ENABLED=true`, and the services it needs start and idle until then,
so the order is: ship the code, bring the three containers up, then switch it on.

1. **Names.** Two DNS A records at the host's address: `lk.<site>` and `turn.<site>`. Expand the
   certificate to cover them: `CERT_EXTRA_ARGS="--expand -d lk.<site> -d turn.<site>"` in `.env`,
   then `docker compose --profile certs run --rm certbot` and reload the edge.
2. **Ports.** Open 7881/tcp, 7882/udp and 3478/udp in the cloud firewall (on Oracle: the VCN
   security list *and* the instance's `/etc/iptables/rules.v4`, above the final REJECT; never
   UFW on an Oracle Ubuntu image). 443/tcp is already open.
3. **Environment.** `LIVEKIT_PUBLIC_URL=wss://lk.<site>`, `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`
   (32+ characters), `LIVEKIT_NODE_IP=<public address>`, `LIVEKIT_TURN_ENABLED=true`,
   `LIVEKIT_TURN_DOMAIN=turn.<site>`, `SPEECH_TOKEN`, and `VOICE_ENABLED=true` last.
4. **Build and start.** `docker compose build speech voice api worker web widget`, then `up -d`.
   The speech service downloads about 1.6 GB of models into its volume on first start and is
   unhealthy until it has; `docker compose logs -f speech` shows the progress.
5. **Check.** `/health` on `voice` reports `speech: ready` and the AI call cap; the first call
   from the widget rings the dashboard; a transfer to the AI greets within a few seconds. The
   end-to-end suite `node scripts/e2e-voice.mjs` runs the whole thing against a live stack.

The edge change is the one step that touches every visitor: port 443 moves from the HTTP servers
to the stream front. `docker compose config` and `nginx -t` inside the edge container before the
restart, and keep the previous image tag at hand (DEPLOYMENT.md, rollback).

## Capacity on a CPU-only host

Human-to-human calls cost the media server almost nothing. An AI call costs a few seconds of CPU
per turn - recognition, the model, synthesis - which is why `VOICE_AI_MAX_CALLS` defaults to one
on a 12-core machine shared with the chat's own model. A call that arrives when the AI is at its
cap rings the team as usual and, if nobody answers, holds for the AI (step 4 above) rather than
being dropped; the log says `voice.ai.queued`, and `voice.ai.queue_gave_up` when a caller waited
the full two minutes - the sign that the cap is too low for the traffic. A GPU
later changes two things and nothing else: the speech service's provider (`SPEECH_PROVIDER=cuda`)
and the model container, both of which can also move to another machine by changing their URLs.

## Licences of the speech models

| Model | Licence |
|---|---|
| AI4Bharat IndicConformer (Bengali speech-to-text) | MIT |
| NVIDIA Parakeet-TDT 0.6B v3 (English speech-to-text) | CC-BY-4.0 - attribution: NVIDIA NeMo |
| speechbrain VoxLingua107 ECAPA (language identification) | Apache-2.0 |
| Silero VAD | MIT |
| Coqui Bengali VITS voice | Apache-2.0 |
| Piper `bn_BD` voice | MIT model, CC-BY-SA-4.0 training data |
| Kokoro 82M (English voices) | Apache-2.0 |
| Piper `en_US-libritts_r` voice | CC-BY-4.0 |
| sherpa-onnx (runtime) | Apache-2.0 |
| LiveKit (media server) | Apache-2.0 |
