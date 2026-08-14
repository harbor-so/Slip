# ADR 0006 — Advisory locks are taken on a reserved connection, never on the pool

**Status:** accepted
**Date:** 2026-08-11

## Context

Harbor uses Postgres advisory locks in three places, and each is load-bearing:

- `withSessionLock` — exactly one runner drives a session. This is the
  single-writer property the whole session model rests on; see
  [ADR 0001](./0001-postgres-as-the-only-dependency.md).
- `tickAutomations` — one replica runs the scheduler tick, so there is no
  singleton scheduler process to elect, monitor or restart.
- The test suite's global setup — one test run at a time against a shared database.

The obvious way to write any of them is two statements through the ordinary
connection pool:

```ts
await db.execute(sql`select pg_try_advisory_lock(...)`);
try { await body(); }
finally { await db.execute(sql`select pg_advisory_unlock(...)`); }
```

This is wrong, and it is wrong in a way that passes review, passes tests, and
fails in production weeks later.

`pg_try_advisory_lock` at session scope belongs to the **backend connection** that
executed it. A pool hands out whichever connection is free. So the lock is taken
on connection A, and the unlock is a separate statement that may be routed to
connection B — where it releases nothing and returns `false`, which nobody checks.
The lock on connection A is then held until that connection is recycled, which for
a healthy long-lived pool is never.

The symptoms are the worst available:

- **Sessions**: one session, somewhere, silently stops being driven. No error is
  logged, because nothing failed — every subsequent runner correctly observes that
  the lock is held and correctly declines. The prompt sits in the queue forever.
- **Automations**: the scheduler tick succeeds exactly once after a deploy and then
  never again, on work that by definition nobody is watching. It is discovered when
  somebody notices a nightly job has not run for a fortnight.

It reproduces only with a pool of more than one connection, so it passes every run
against `HARBOR_SINGLE_CONNECTION=1` — which is how scripts and many test setups
run.

We shipped this bug in `tickAutomations`. It was found by a flaky test suite whose
flakiness turned out to have a different cause entirely, which is a reminder that
chasing a flake is often worth it for what else you find on the way.

## Decision

**Every advisory lock is taken on a reserved connection**, pinned for the lifetime
of the critical section, and released back to the pool afterwards.

```ts
const reserved = await sql.reserve();
try {
  const [taken] = await reserved`select pg_try_advisory_lock(...) as acquired`;
  if (!taken?.acquired) return { acquired: false };
  try { return await body(); }
  finally { await reserved`select pg_advisory_unlock(...)`; }
} finally { reserved.release(); }
```

Three supporting rules:

**`try`, never a blocking acquire.** A blocking acquire turns contention into a
process that appears to hang, and "is it working or stuck?" is precisely the
ambiguity these locks exist to remove. Every caller handles "somebody else has it"
as an ordinary, non-error outcome.

**Not the transaction-scoped variant, in the session runner.**
`pg_advisory_xact_lock` is released by COMMIT or ROLLBACK — including the rollback
Postgres performs when a connection dies — which is strictly better crash
behaviour. It is unusable there because the critical section boots a sandbox: the
transaction would stay open for minutes, holding a snapshot that blocks vacuum on
the busiest tables in the system, and every write inside would be entangled such
that one failure rolls back all of it. A crashed process still releases a session
lock, because the backend dies with the socket, which covers the failure that
actually happens.

**Re-entrancy is not offered.** `pg_try_advisory_lock` is re-entrant within one
connection, but each call reserves a *fresh* connection, so a nested call for the
same session is correctly refused rather than quietly granted to code that
believes it is the only writer.

## Consequences

### Positive

- The lock and its release are provably on the same backend.
- A crashed or `SIGKILL`ed process releases its locks automatically. There is no
  stale lock file, no lease table for the lease-holders, nothing to clean up.
- No singleton process anywhere in Harbor. Any replica can run any tick.

### Negative — the accepted costs

- **A reserved connection is out of the pool for the whole critical section.** For
  the session runner that section boots a sandbox and can last minutes, so a
  deployment driving *N* sessions concurrently needs a pool of at least *N* plus
  headroom for ordinary queries. This is a real capacity coupling between an
  unrelated-looking setting and the number of sessions that can run at once, and
  it is not discoverable from a stack trace — the symptom is queries queueing.
- **It does not survive a connection pooler in transaction mode.** PgBouncer in
  transaction pooling multiplexes statements across backends, which reintroduces
  exactly the bug this ADR is about, silently. `DEPLOY.md` says to use session
  pooling; that instruction is load-bearing and is easy to get wrong because
  transaction pooling is the default advice everywhere else.
- **A paused-but-not-dead process keeps its lock.** A backend that is alive but
  wedged holds it indefinitely, and nothing times it out. Fencing tokens cover the
  consequence for privileged side effects; the session itself still stalls.
- More ceremony at three call sites than two lines of `db.execute`, and the
  ceremony looks like superstition unless the comment explaining it survives.
