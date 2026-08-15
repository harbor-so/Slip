# ADR 0004 — Branch per lease, and pull requests authored by the human

**Status:** accepted
**Date:** 2026-08-11

## Context

Two questions that look like separate problems and share one answer.

**Traceability.** Six months after a change lands, somebody has to decide whether
it can be reverted. Git tells them what changed. Nothing in git tells them why
anyone started, or who asked, or what else was in flight at the time.

**Review integrity.** An agent that opens its own pull requests creates a path
for code no human read to reach the default branch, because the person who
prompted it is also the person who approves it.

## Decision

### Branch names are `harbor/lse_<claim_id>`

Load-bearing, not cosmetic. Every git artifact traces back to a ledger row with
zero inference — and that row carries the claim's `intent`, which is the one
sentence the agent's operator wrote about *why*. The pull request body reproduces
that intent verbatim.

Harbor already required an intent on every claim for a different reason. This
makes the git history and the coordination ledger one queryable record rather than
two.

The name is derived **lazily at pull-request time**, not baked into the sandbox's
spawn configuration, so a session that claims a second task mid-flight branches
correctly rather than from a name fixed at boot.

### The sandbox pushes; the control plane opens the PR with the human's token

The sandbox has short-lived brokered credentials sufficient to push a branch and
nothing else. It reports the branch name upward. The control plane then calls the
pull-request API with the **prompting user's own OAuth token**.

The consequence is the point: a pull request's author cannot approve it, so the
engineer who prompted the agent cannot rubber-stamp its output. Unreviewed agent
code becomes structurally impossible rather than policy-prohibited.

**Which half performs the push, as shipped.** The **supervisor** runs the push —
`pushWorkingBranch` in `runtime/supervisor.ts`, gated by the pure `pushDecision()`
in `runtime/boot-decisions.ts`, and it runs *before* `agent_finished`, because that
event closes the turn and hands the lease back. `branch_pushed` is emitted from
there. The agent is not relied on to push: "bring your own agent" goes down to an
argv template, so a guarantee that depends on the agent choosing to run `git push`
against the right ref is not a guarantee.

This is worth stating explicitly because an alternative was considered and *not*
adopted — leaving the push to the agent and having the supervisor merely observe
git state afterwards to infer whether a push happened. A commit in the history
carries a description of that alternative, but it landed as an empty merge and
changed no code. The shipped behaviour is the one described above; when the two
disagree, this ADR is correct and the commit message is not.

### Author and committer are separate properties, tested separately

The pull request's *author* comes from the token used to create it. The commit's
*author* and *committer* come from git metadata set inside the sandbox before the
turn runs. These are independent mechanisms and conflating them is the easy
mistake — pushing with a user's token does not make them the commit author.

Target state: `Author: <the human>`, `Committer: Harbor <bot@…>`.

### Git identity is never inferred

`GitIdentity` has exactly two members: `agent-only` and `attributed-user`. There
is no third meaning "work it out". A missing name or email raises. `agent-only` is
a real, explicit choice for work nobody is claiming authorship of — a scheduled
dependency bump — and is not the fallback for "we could not tell".

### A user with no SCM token is a loud failure, not a quiet fallback

Harbor pushes the branch, returns a compare URL, and warns — at startup if the
deployment has no SCM OAuth at all, and at the moment of use — naming the property
that no longer holds.

Silently opening as the bot is worse than useless: an organisation standardised on
non-SCM single sign-on would lose the product's central guarantee without anyone
noticing, and the documentation paragraph explaining it would be read by nobody.

## Consequences

### Positive

- Every branch, commit and pull request maps to a lease, an intent and a person.
- Self-approval of agent-written code is not possible.
- "Why was this written" is answerable from the pull request body.

### Negative — the accepted costs

- **Branch names are ugly.** `harbor/lse_9f2c1a44-…` is not a name anyone would
  choose to read. Traceability beat readability; a human-friendly slug would have
  required a lookup to be useful and would drift from the ledger the first time
  somebody renamed a task.
- **The guarantee is about approval, not merging.** Whether an unapproved pull
  request can reach the default branch depends on your branch protection rules and
  who can bypass them. Harbor cannot see those and does not claim to enforce them.
- **A user OAuth token expires in eight hours** and must be refreshed. That is a
  credential lifecycle — authorisation, callback with state validation, encrypted
  refresh storage, refresh, revocation handling — that we would not otherwise need.
- **Users authenticated by SSO with no SCM identity get a degraded path.** It is
  loud, but it is still degraded, and for some organisations it will be every user.
- **Two API calls where one would do**, and a window in which the branch exists
  and the pull request does not.
