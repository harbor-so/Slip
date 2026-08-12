# ADR 0001 — Postgres and a plain Node process, not Durable Objects

**Status:** accepted
**Date:** 2026-08-11

## Context

The reference architecture for a background coding agent — Ramp's Inspect, and
its open reimplementation `ColeMurray/background-agents` — puts session state in
one Cloudflare Durable Object per session, with a private SQLite database, and
coordination state in D1, KV, R2 and Queues alongside. It is a good design and
the reasoning behind it is sound.

We are building the version any company can adopt. That constraint is not a
preference; it is the product. So the question is not "is a Durable Object a good
place for session state" — it is — but "what does requiring one cost us in
adoption."

It costs everything. A Cloudflare-native control plane cannot run on a VM, in a
VPC, on-premises, in an air-gapped environment, or on a laptop. Evaluating it
requires a Cloudflare account, a sandbox provider account, a Vercel account and
Terraform before the first prompt. For a company whose security review is the
reason they are looking at a self-hosted option in the first place, that is not a
deployment story.

## Decision

The control plane is a plain Node process (Next.js) and Postgres. Nothing else is
required to run the entire product.

Each Cloudflare primitive is replaced by one we already had:

| Their primitive | Ours |
|---|---|
| Durable Object, single-threaded per session | `pg_try_advisory_lock(hashtext(session_id))` |
| DO SQLite, per session | Postgres tables carrying `orgId` and `sessionId` |
| WebSocket hub with Hibernation | Postgres `LISTEN/NOTIFY` → SSE, POST upward |
| D1 | the same Postgres |
| KV | the same Postgres |
| R2 | the filesystem, or S3-compatible storage, configured |
| Queues | a table with a deadline and an advisory-locked sweeper |
| A global singleton scheduler DO | expiry-driven reclamation; a lapsed lease is reclaimable by any runner, which needs no coordinator |

### Answering the three arguments for Durable Objects on their own terms

**WebSocket Hibernation, because sessions idle for hours.** We hold no socket. The
bridge posts upward and reads an SSE stream downward, and an idle session has its
sandbox stopped on inactivity — which is the behaviour we want anyway, for cost
reasons, and which means there is nothing to keep warm. Hibernation solves a
problem created by holding a socket open through the idle period; not holding one
solves it more cheaply.

**Per-session isolation, because one hot session must not degrade another.** This
is the strongest of the three and we do not get it for free. What we do instead is
bound the thing that creates the problem: per-session event ingest is batched
rather than one transaction per token, payloads are truncated at ingest, and old
events are compacted rather than accumulated. That work is necessary in the DO
design too — their implementation has no retention policy at all, which is a
latent production failure — so we are paying a cost they also owe but have not
yet paid.

**Single-threaded execution, because it makes the sync model correct with one
invariant.** Their invariant is: complete all async work, then read the snapshot,
then register the socket, *with no `await` in between*. It is elegant and it is
fragile — the ADR itself has to instruct future readers not to add asynchronous
work in that window, and a single well-intentioned `await` inserted to fetch a
display name silently reintroduces a lost-event race.

We do not need the invariant. Subscribing to the notify channel **first**, then
reading the snapshot, then filtering replayed events by `seq > snapshot_through_seq`
makes loss impossible by construction: an event that lands during the read arrives
on the live channel, and the sequence number tells the client whether it already
had it. No ordering discipline has to be maintained by hand, so no refactor can
break it.

## Consequences

### Positive

- `docker compose up` runs the whole product, including sandboxes, with no vendor
  account of any kind.
- One store rather than six. No dual-write between a per-session store and a
  shared index — which is a defect the reference implementation has, with no
  reconciliation path.
- Real transactions. Claim admission, budget reservation and event append can be
  atomic with each other, which is not available when the lease lives in D1 and
  the transcript lives in a DO.
- Deployable into a VPC, on-premises, or air-gapped.

### Negative — the accepted costs

- **We inherit a noisy-neighbour problem.** One session streaming hundreds of
  events per second shares a connection pool with every other. Batching, payload
  caps and compaction mitigate it; they do not make it structurally impossible the
  way a Durable Object does. At a scale we have not reached, this will need
  partitioning, and partitioning Postgres is more work than the DO design's
  equivalent, which is nothing.
- **Advisory locks are weaker than single-threaded execution.** A lock held by a
  process that is paused but not dead is still held, and a lock is released if the
  connection drops mid-operation. We handle the second case with fencing tokens on
  every privileged side effect; the first is a real, accepted exposure.
- **We must operate Postgres.** Connection limits, vacuum, backups, and a
  `LISTEN` connection per open stream are now our problem. The DO design has no
  equivalent operational surface.
- **SSE plus POST is chattier than a duplex socket** for the rare downward
  message, and reconnection is our code rather than the platform's.
- **No free global consistency for the circuit breaker.** It is a Postgres table
  with a unique index, which is correct but is a write on a hot path.

### Neutral

- Losing Cloudflare's edge means a session's control plane is in one region.
  Sandboxes were never at the edge, so the latency that matters is unchanged.
