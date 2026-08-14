# ADR 0003 — Fail open on liveness, fail closed on authority

**Status:** accepted
**Date:** 2026-08-11

## Context

Harbor asks two superficially similar questions about state it does not fully
control, and the right answer to an ambiguous result is opposite in each case.

**Liveness:** "is this sandbox dead?" Asked by the lifecycle manager before it
reconnects to a box, reaps it, or spawns a replacement.

**Authority:** "does this caller hold the lease?" Asked before a privileged side
effect — writing to a transcript, pushing a branch, opening a pull request.

Both can return an answer that is neither yes nor no: an unrecognised status
string, a provider that timed out, a database that is unreachable. The tempting
simplification is one boolean and one default. That simplification has two
failure modes and neither is acceptable, which is why it is not made.

## Decision

### Liveness uses a deny-list, and an unknown status reads as *live*

`DEAD_SANDBOX_STATUSES` enumerates `stopped`, `stale`, `failed`. Anything else —
including a status added in a future version — is treated as live, and callers
fall through to their own checks: heartbeat age, a provider probe.

Written the other way, as an allow-list of live statuses, a status added six
months from now defaults to *dead*. Every sandbox in that state gets abandoned,
its work discarded, with no error logged anywhere, because every caller believed
it was behaving correctly. That is a silent, total failure introduced by an
otherwise routine change.

`failed` is deliberately still **reconnectable**. A slow boot can outlive the
connecting watchdog that marked it failed and then show up with a working bridge,
and refusing it means throwing away a sandbox that is demonstrably alive.

### Authority uses the opposite rule, and an unknown lease state reads as *not held*

`evaluateSpawnDecision` takes a three-state lease value — `held`, `not_held`,
`unknown` — and `unknown` refuses with `lease_state_unknown`. Never assume
authority you cannot confirm.

The failure this prevents is the one Harbor exists to prevent: two agents holding
the same work. If a lease read fails and we admit anyway, a database blip during
a contended moment produces exactly the duplicated day of work the product is
judged on.

### "Denied" and "could not determine" are distinct types everywhere

Collapsing them is the underlying mistake that makes the above impossible to get
right. Treat "could not determine" as allowed and an upstream blip is a security
hole; treat it as denied and an upstream blip is a total outage. Keeping them
apart lets each call site choose, and the two call sites here choose differently
on purpose.

`SpawnRefusal` therefore carries `lease_not_held` and `lease_state_unknown` as
separate members, and both are separate from `policy_denied`.

## Consequences

### Positive

- A future status addition cannot silently brick running sandboxes.
- A database blip cannot produce two agents on one task.
- Every refusal carries a reason a human can act on, rather than a false.

### Negative — the accepted costs

- **A genuinely dead sandbox in an unknown status is reaped late**, not by this
  check but by the heartbeat sweep, which is up to `HARBOR_SANDBOX_STALE_HEARTBEAT_MS`
  slower. We pay latency to avoid a silent-loss failure mode.
- **Postgres being unreachable stops all new work.** Fail-closed on authority
  means an availability incident in the database is an availability incident in
  Harbor. This is correct and it is also a hard dependency worth stating out loud.
- **Three-state values are more verbose than booleans** at every call site, and
  the exhaustive switches that consume them cannot use a `default` branch, so
  adding a state is a compile error in several files at once. That is the intent,
  and it is also friction.
- The asymmetry must be re-explained to every new reader, which is why it is
  commented at both sites rather than only here.

---

## Corollary (added later): an answer we cannot prove complete is not an answer

The rule above was written about *errors* — a call that threw, a status nobody
recognised. It turns out there is a quieter way to fail open, and three providers
shipped with it: a **successful** list call that returned one page.

`findByAttemptId` and `listManaged` both ask an existential question. Answering
"no such box" from page one of an unknown number of pages is not a smaller answer
than the truth — it is the wrong one, and it is wrong in the fail-open direction
that this ADR exists to forbid. A caller reading `null` starts a second agent on
the same branch. A sweep reading `[]` leaves a box billing until someone reads the
invoice. Neither can tell a genuinely empty result from a truncated one, and the
HTTP status is 200 in both cases, so nothing upstream can either.

So the rule extends:

> **A list-backed authority answer must be provably complete, or it must throw.**

In practice:

- Where the vendor exposes a cursor, follow it. `runloop.ts` declared `has_more`
  on its response type and read it nowhere, which is how this was found.
- Where following a cursor is not something we can verify against the real API,
  throw `transient` when the page is saturated and name the variable that widens
  it. A loud retry is strictly better than a confident wrong answer, and much
  better than a guessed pagination parameter that silently pages wrong.

This does not apply to `inspect`. That is a liveness question about a box we
already have an id for, and liveness fails open — unchanged.
