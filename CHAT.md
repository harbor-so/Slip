# Chat: a signed-event connection primitive

Harbor's chat lets a human, an agent, or two agents talk in the same room on the
same terms. It is built on one idea borrowed from [`block/buzz`][buzz]: **every
message is a cryptographically signed event, and an identity is a public key.** A
human and an agent are both just a keypair, so the room never has to tell them
apart, and human↔human, human↔agent and agent↔agent are one primitive rather than
three.

This document is also the study that produced it — what we took from buzz, what we
deliberately left, and the gaps we know about.

[buzz]: https://github.com/block/buzz

## What we took from buzz

- **Everything is a signed event.** One primitive gives attribution, integrity, an
  audit trail, live fan-out and a single identity model — for free and at once.
- **Agents are members, not bots.** An agent has its own keypair, its own channel
  memberships, its own signed history. There is no separate bot-permission model to
  keep in sync with the human one.
- **Verify the event id independently of the signature.** The id is a hash of the
  body; the signature is over the id. Checking the id *first* is what stops a signed
  event being replayed with its body swapped. See `verifyEvent` in
  `src/lib/crypto.ts`.
- **Check access before subscription.** A stream refuses a non-member of a private
  channel *before* it registers a listener, closing the race that leaks private
  rooms. See `src/app/api/channels/[key]/stream/route.ts`.
- **Ephemeral vs durable events.** Typing and presence fan out but are never
  stored; messages and membership are durable. Keeps the log clean.
- **Batch the backlog into one read.** A member's read cursor lets an agent pull
  everything said since it last looked in a single call, instead of one message per
  turn. See `readChannel` in `src/lib/chat.ts`.

## What we deliberately left

- **The Nostr wire protocol and its 18 custom NIPs.** buzz's own assessment admits
  "it's just Nostr" oversells portability. We keep the signed-event *shape* and drop
  the protocol lock-in; interop with the Nostr ecosystem is a non-goal.
- **Kind _integers_.** buzz names these its weak point — a global namespace with no
  compile-time coupling. Our `kind` is a closed TypeScript union an exhaustive
  switch can check (`EVENT_KINDS` in `src/lib/crypto.ts`).
- **Redis** for pub/sub, presence and typing. We reuse Postgres `LISTEN/NOTIFY`,
  the one piece of infrastructure Harbor already requires — the same choice the
  coordination dashboard already made. buzz's own Redis tenant-scoping is a
  documented gap, not an invariant.
- **secp256k1 Schnorr.** Ed25519 is native to WebCrypto, so the same module signs
  in a browser tab and verifies on the server with no dependency and no second
  implementation.
- **The formal-methods stack (TLA+/Tamarin/model checkers).** Right for buzz's
  scale, overkill here. We keep Harbor's lighter discipline: `*.test.ts` beside the
  source proving the concurrency and trust properties (`src/lib/chat.test.ts`,
  `src/lib/crypto.test.ts`).

## The primitives

| Primitive | Where | One-line |
| --- | --- | --- |
| **Signed event** | `src/lib/crypto.ts` | Ed25519 over a canonical hash; the unit everything else moves. |
| **Principal** | `principals` table | An identity is a public key; humans and agents are the same kind of row. |
| **Channel** | `channels` table | A room with no owner; `group`/`task` are key-gated, `direct` is a fixed roster. |
| **Membership** | `channel_members` | The access gate, checked before persist and before fan-out; carries a per-member read cursor. |
| **Ingest** | `ingestEvent` in `src/lib/chat.ts` | The one door: resolve org → verify → bind author → gate membership → assign seq → store. |
| **Delivery** | SSE over `LISTEN/NOTIFY` | `harbor_chat` wakes listeners; durable events announce a seq, the client fetches the body. |

## Interfaces

- **Web:** `/channels` lists rooms; `/c/<key>` is a room. The browser generates a
  keypair on first use, stores the private key non-extractable in IndexedDB, and
  signs every message locally (`src/lib/identity-browser.ts`, `src/app/c/[key]`).
- **API / agents:** the same REST endpoints (`/api/principals`,
  `/api/channels`, `/api/channels/[key]/{events,join,stream}`) plus the signing SDK
  `src/lib/chat-client.ts`. Run `npm run demo:chat` (with `npm run dev` up) to watch
  two agents hold a signed conversation and get a URL to join them as a human.

### Why chat is not an MCP tool

The coordination server is five tools "and not six" on purpose, and posting a chat
message requires signing with a key the server must never hold. A "send message"
tool would either break that (server-held keys) or push a full signed event through
a tool call an LLM has to assemble. So the chat interface is the signing SDK + REST,
and the five-tool server is left untouched.

## Does NOT

- `src/lib/crypto.ts` — does NOT store or transmit private keys; verifies the id
  independently of the signature.
- `src/lib/chat.ts` — does NOT trust the org from the event body; does NOT persist
  ephemeral (`typing`/`presence`) events; does NOT let a client author membership or
  system events.
- `ingestEvent` — does NOT admit an event whose author is not a registered principal
  in the connection's org, or who is not a member of the channel.
- The stream — does NOT register a listener before the access check.

## Known Limitations

These are verified gaps in the current implementation, not aspirations.

1. **Human keys are per-device with no recovery.** A new browser is a new identity
   until key portability/backup is built (`src/lib/identity-browser.ts`).
2. **Direct-channel read access is bounded by the org, not proven per-user.** Within
   one org, a caller presents its own pubkey to read a private channel; the org
   boundary contains this, but a per-request proof of key control is future work.
   Writes are unaffected — those always require a signature (`mayRead` in
   `src/lib/chat.ts`).
3. **No rate limiting.** An agent can post as fast as it can sign. The org API key
   bounds *who*, not *how fast*. Same gap buzz ships with.
4. **No key rotation or revocation.** A principal's pubkey is forever; a compromised
   key cannot yet be retired.
5. **Server-authored membership/system events are unsigned.** `join`, `leave`,
   `channel_create` are vouched for by the authenticated action, not an end-to-end
   signature. Only `message`/`reaction` content is client-signed.
