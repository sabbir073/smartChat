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
`message:new`, `conversation:created`, `conversation:updated`, `conversation:assigned`,
`conversation:closed`, `typing`, `presence:agent`, `presence:visitor`,
`presence:agents_available`

That list is exactly `ServerEvent`, and every member of it is emitted somewhere. It used to name
four more — `message:ack`, `message:updated`, `visitor:updated` and `error` — none of which the
server has ever sent, so a client written from this page would have listened for events that never
arrive.

There is no `error` **event**, and there is no `message:ack` event either. Both are the same
mechanism: every client→server event carries a Socket.IO acknowledgement callback, and the server
answers through it — `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. A send is
confirmed on that callback, and a malformed payload is refused on it. Unknown event names are
ignored. Both count toward the socket's abuse budget.

Every event name and payload is a Zod schema in `@smartchat/validation`.

## 5. Message send path

1. Client generates a ULID `clientMessageId` and renders the bubble as **pending**.
2. `message:send` is emitted with an acknowledgement callback.
3. The service looks the `clientMessageId` up first. If it already exists this is a retry after a
   lost ack: the stored message is returned and nothing else happens — no insert, no sequence
   number consumed.
4. Otherwise, in **one Postgres transaction**, the message is inserted and
   `conversations.message_seq` is incremented.
5. If the unique index on `(conversation_id, client_message_id)` rejects the insert — two retries
   racing — the violation is allowed to escape the transaction, and the existing row is read
   **after** the rollback. It has to be after: Postgres aborts a transaction on any constraint
   violation, so a read on the same connection would fail with `25P02`. The rollback also returns
   the reserved sequence number, so the counter self-repairs. See ADR-021.
6. Ack returns `{ id, seq, createdAt }`; the client promotes the bubble from pending to **sent**.
7. The message is published to Redis and broadcast to `conv:<id>` and `prop:<id>`.

Only a genuinely new message is broadcast; re-broadcasting a deduplicated retry would show it twice
in every open inbox.

The client only ever removes a pending bubble when it has an ack. If the socket drops before the
ack, the message stays pending and is resent on reconnect — idempotency makes that correct.

## 5a. Presence

Visitor presence lives in Redis with a TTL and a heartbeat, and changes are pushed to agents as
`presence:visitor`. Events alone are not enough: an agent who opens the inbox after a visitor has
already connected would never receive one. So `inbox:subscribe` answers with the gateway's current
view of every subscribed property, and the dashboard treats that answer as the complete truth for
those properties. See ADR-022.

## 6. Reconnect and resync

On reconnect the client sends `sync:since { conversationId, lastSeq }`. The server replays every
message with `seq > lastSeq` from Postgres. This is why ordering uses `seq` and not timestamps:
replay is exact, with no clock-skew ambiguity.

Presence and typing are **not** replayed, and deliberately so. Both are Redis keys with a
45-second and a 6-second TTL; anything worth knowing about either arrives on its own within one
heartbeat, and re-sending a typing indicator captured at the moment of a reconnect would show a
dot for somebody who stopped typing while the socket was down.

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

On the visitor namespace:

- A **message rate limit per visitor and per property**, both Redis sliding windows shared across
  gateway instances (`visitorMessage`, `propertyMessage` in `RATE_LIMITS`).
- A **strike counter**, in Redis, keyed by **visitor** and expiring after fifteen minutes. Ten
  strikes disconnects the socket. Keyed by visitor rather than by socket, and in Redis rather than
  in the process, because it was neither of those to begin with: the count lived in a `Map` on one
  replica under the socket id, so reconnecting reset it — and reconnecting is precisely what the
  tenth strike provokes.
- A **payload size limit**, from Socket.IO's `maxHttpBufferSize`.

Deliberately not present, and named here rather than implied: there is **no connection rate limit
per IP** on the gateway (a connection needs a single-use ticket minted by the rate-limited API,
which is the budget that actually applies), **no cap on room membership**, and a strike does not
ban — it disconnects. A ban is a separate, deliberate act by an agent, and it survives a reload;
see `SECURITY.md`.

The agent namespace has no abuse guard. Its sockets are authenticated members of an account, and
the limits that matter to them are applied where their actions are: the API and the plan.

## 9. What we explicitly do not do

- No HTTP polling as the primary transport.
- No trusting client-supplied `conversationId`, `visitorId`, `accountId` or room names.
- No acknowledging a message before it is committed.
- No storing message content only in Redis. Redis is a bus and a cache, never the source of truth.
