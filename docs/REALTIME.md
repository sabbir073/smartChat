# SmartChat — Real-time Architecture

Transport: Socket.IO 4 over WebSocket (long-polling only as an emergency fallback).
Fan-out: `@socket.io/redis-adapter`. Durability: PostgreSQL.

## 1. Why Socket.IO rather than raw `ws`

We need reconnect with backoff, heartbeat/liveness, acknowledgement callbacks, rooms and
multi-instance fan-out. Socket.IO provides all of them, battle-tested, and its acknowledgement
callback maps exactly onto our "persist before ack" requirement. Raw `ws` would mean reimplementing
that list. Recorded in DECISIONS.md.

## 2. Namespaces

| Namespace | Who connects | Credential |
| --- | --- | --- |
| `/visitor` | the widget panel iframe | single-use connection ticket minted from a visitor token |
| `/agent` | the dashboard | single-use connection ticket minted from a session |

Both are authenticated in the `connection` middleware **before** any room is joined. An
unauthenticated socket is disconnected, never left idle.

Tickets are short-lived (60 s), single-use (consumed from Redis), and bound to the connecting
identity. They exist so we never place a long-lived credential in a WebSocket query string, where it
would end up in proxy logs.

## 3. Rooms

```
conv:<conversationId>     every participant in one conversation
prop:<propertyId>         all agents watching a property (inbox live updates, visitor presence)
account:<accountId>       account-wide notifications
agent:<userId>            one agent's own devices
visitor:<visitorId>       one visitor's tabs
```

Room names are derived server-side from authenticated identity. A client can never ask to join a
room by name.

## 4. Events

Client → server (`/visitor`):
`conversation:start`, `message:send`, `typing:start`, `typing:stop`, `message:read`,
`page:view`, `sync:since`

Client → server (`/agent`):
`inbox:subscribe`, `conversation:open`, `message:send`, `note:add`, `typing:start`, `typing:stop`,
`message:read`, `presence:set`, `sync:since`

Server → client:
`message:new`, `message:ack`, `message:updated`, `conversation:created`,
`conversation:updated`, `conversation:assigned`, `conversation:closed`,
`typing`, `presence:agent`, `presence:visitor`, `visitor:updated`, `error`

Every event name and payload is a Zod schema in `@smartchat/validation`. Unknown events are ignored;
malformed payloads produce an `error` event and count toward the socket's abuse budget.

## 5. Message send path

1. Client generates a ULID `clientMessageId` and renders the bubble as **pending**.
2. `message:send` is emitted with an acknowledgement callback.
3. Gateway authorises, then in **one Postgres transaction** inserts the message and increments
   `conversations.message_seq`.
4. Unique violation on `(conversation_id, client_message_id)` → the existing row is returned. A
   retry after a lost ack is therefore safe and never duplicates.
5. Ack returns `{ id, seq, createdAt }`; the client promotes the bubble from pending to **sent**.
6. The message is published to Redis and broadcast to `conv:<id>` and `prop:<id>`.

The client only ever removes a pending bubble when it has an ack. If the socket drops before the
ack, the message stays pending and is resent on reconnect — idempotency makes that correct.

## 6. Reconnect and resync

On reconnect the client sends `sync:since { conversationId, lastSeq }`. The server replays every
message with `seq > lastSeq` from Postgres, then re-sends current presence and typing state. This is
why ordering uses `seq` and not timestamps: replay is exact, with no clock-skew ambiguity.

Backoff: 500 ms base, ×1.6, capped at 30 s, ±20 % jitter, unlimited attempts while the tab is
visible.

## 7. Presence

Redis keys with TTL, refreshed by heartbeat:
```
presence:agent:<accountId>:<userId>   → status, updatedAt   TTL 45 s
presence:visitor:<propertyId>:<id>    → url, title, updatedAt TTL 45 s
typing:<conversationId>:<actorId>     → 1                    TTL 6 s
```
Presence is deliberately not in Postgres: it is ephemeral, high-write and worthless after a restart.
Agent *availability* (the deliberate online/away choice) **is** persisted, because it is a setting.

## 8. Abuse control

Per socket: connection rate limit per IP, message rate limit per visitor and per property, maximum
payload size, maximum rooms, and a strike counter that disconnects and temporarily bans on repeated
violations. All counters live in Redis and are shared across gateway instances.

## 9. What we explicitly do not do

- No HTTP polling as the primary transport.
- No trusting client-supplied `conversationId`, `visitorId`, `accountId` or room names.
- No acknowledging a message before it is committed.
- No storing message content only in Redis. Redis is a bus and a cache, never the source of truth.
