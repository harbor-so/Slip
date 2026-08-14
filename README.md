# Harbor

**Background coding agents your company can actually deploy.**

You @-mention it in Slack, or assign it a Linear issue, or type into a shared
room. It boots an isolated sandbox, runs the coding agent you already use against
your repository, and streams what it is doing to anyone who opens the link.

(Opening the pull request is the one advertised step that is not wired up yet —
the attribution machinery is written and tested, nothing calls it. See
[Pull requests](#pull-requests-are-authored-by-the-human).)

One `docker compose up`. A Node process and a Postgres database, and nothing else.

[Quick start](#quick-start) · [Why this exists](#why-this-exists) ·
[How it works](#how-it-works) · [Deploying](./DEPLOY.md) ·
[Security](./docs/SECURITY.md) · [Non-goals](#non-goals)

---

## Why this exists

An interactive coding assistant couples the work to your presence. You type, it
responds, you watch. Everything it does happens in a window you are sitting in
front of, so the throughput of the tool is bounded by your attention.

A background agent decouples them. You send a prompt, it runs in a sandbox against
a real checkout, you read the result when you get back. The unit of work stops
being a conversation and starts being an errand — which means you can have several
in flight, and which means the interesting problems stop being about the model and
start being about coordination, cost and blast radius.

Three of those problems shape everything below.

**It has to be deployable where the code already lives.** A background agent holds
source-control credentials, model keys and a shell on a checkout of your
repository. The teams who most want one are the teams for whom that sentence
triggers a security review. Harbor is a Node process and a Postgres database. It
runs on a VM, in your VPC, on-premises, or on a laptop, and `docker compose up` is
the entire evaluation. Eleven remote sandbox backends are supported when you want
one, and none of them is a prerequisite for anything.

**It must not do the same work twice.** Harbor started as a coordination layer for
fleets of agents — a lease table with a partial unique index guaranteeing exactly
one holder per unit of work. The execution plane was built on top of it, which
means **the lease is acquired before a sandbox is booted.** Two runners that pick
up the same task produce one container and one token bill, not two, and the loser
is told who holds it and why. Every branch is named `harbor/lse_<claim_id>` and
every pull request body carries the claim's stated intent, so six months later
"why was this written" is answerable from the PR.

**Every loop needs a ceiling.** Scheduled automations, child sessions, connectors
turning each new issue into a session, retries — a background agent platform is a
collection of loops with no human in them. Spend is accounted server-side and
capped atomically with lease admission, from the first migration rather than as a
later feature.

---

## Quick start

```bash
docker compose up -d                  # Postgres on :5433
npm install
cp .env.example .env
openssl rand -base64 32               # → HARBOR_ENCRYPTION_KEY
openssl rand -base64 32               # → AUTH_SECRET

npm run db:migrate
npm run db:seed                       # demo org — prints an API key, once
npm run sandbox:build                 # the sandbox image

npm run dev                           # dashboard on :3000
npm run mcp                           # coordination MCP on :8788/mcp
```

Open `http://localhost:3000`, connect a repository, and type into a session. With
`HARBOR_SANDBOX_PROVIDER=docker` — the default — that is the whole product running
locally, sandboxes included, with no account anywhere.

### See it with no keys at all

```bash
npm run demo                          # 10 tasks, 4 agents mid-flight, a week of history
export HARBOR_API_KEY=<the key it prints>
HARBOR_DEMO_MODE=1 npm run dev
npm run demo:agents                   # six simulated agents — watch the dashboard
```

`demo:agents` does not mock the coordination layer, because that would prove
nothing about the only part that matters. Each simulated agent is a real
`@modelcontextprotocol/sdk` client speaking Streamable HTTP to the real server
against real Postgres. The only fiction is that a `setTimeout` picks the work
instead of a model.

---

## How it works

```
Clients                Control plane                     Execution
────────────────       ─────────────────────────────     ─────────────────
Slack        ─┐        session runner (advisory lock)    sandbox provider
Linear       ─┤        session_events (monotonic seq)      ├ supervisor
GitHub       ─┼──────► LISTEN/NOTIFY → SSE fan-out    ◄──► ├ bridge
Web /s/<key> ─┤        policy + budget gate                └ your coding agent
cron/webhook ─┘        git credential broker
```

Three planes, and every property the control plane needs is one Postgres already
has. Exactly-one-writer per session is `pg_try_advisory_lock`. Live fan-out to
every open tab is `LISTEN/NOTIFY` over SSE. Exactly-one-holder per unit of work is
a partial unique index. Nothing here is a queue service, a coordination service or
an actor runtime, because the database is already all three. See
[ADR 0001](./docs/adr/0001-postgres-as-the-only-dependency.md), which argues that
on its own terms and states what it costs.

### Sessions

A session is a room with work in it. Three properties, each a correction of the
design you would write first:

**No owner.** `sessions` has no owner column. Tie a session to one person and
"send it to a colleague and let them take it home" stops being retrofittable —
permission checks, queries and UI all quietly assume one identity. A test asserts
no owner column exists, because the schema is the cheapest place to catch that.

**Every prompt is attributed.** `author` is NOT NULL, and it comes from the
signed-in viewer, never from the request body — a client that can name its own
author can put words in a colleague's mouth.

**Input queues rather than interleaving.** Splicing two people's instructions into
a running agent mid-turn produces an agent following half of each, and that
failure is silent and reads as the model being stupid rather than as a race.

```
#1  @rin    delivered   Start with a failing test that reproduces the drop.
#2  @maya   queued      Also check the retry cap while you're in there.
#3  @rin    queued      Don't touch the migration in the same PR.
```

Sessions live at `/s/<key>` — 110 bits, alphabet without i/l/o/u so a key survives
being read aloud. Opening the link is joining.

**Human prompts jump the queue.** A one-word correction must not wait behind an
automation's forty-minute job.

### Reconnecting

The guarantee is **convergence**, not exactly-once delivery, and the distinction
is the difference between a promise the transport can keep and one it cannot. A
socket can drop after the server writes an event and before the client applies it;
without acknowledgements the server cannot tell those apart.

So: a snapshot *replaces* client state and carries `snapshot_through_seq`; live
events carry stable ids and are applied idempotently by sequence number; compacted
events are declared no longer individually replayable rather than silently
missing; truncation is stated in the payload with a pagination endpoint for the
rest.

The subscriber is registered *before* the snapshot is read, so an event landing
during the read arrives on the live channel and the sequence number says whether
the client already had it. Loss is impossible by construction. The obvious
alternative — read the snapshot, then subscribe — is correct only while there is
no `await` between the two, and that is a rule a future refactor silently breaks
rather than a property the code enforces.

### Chat

Where a session is a room with *work* in it, a channel is a room with a
*conversation* in it — and the two connection types Harbor most needs, human↔agent
and agent↔agent, are the same primitive as human↔human because every participant
is just a keypair. Every message is an Ed25519-signed event whose id is a hash of
its own body, verified independently of the signature, so attribution is
cryptographic rather than a server-stamped author. The full design and its known
limitations are in [`CHAT.md`](./CHAT.md); `npm run demo:chat` shows two agents
holding a signed conversation.

### Sandboxes

```ts
type SandboxProvider = EphemeralProvider | SnapshotProvider | PersistentProvider
```

A discriminated union, not capability booleans. Calling `restoreFromSnapshot` on a
persistent-resume provider is a **compile error**, not a runtime no-op. Snapshot
backends restore a *new* box from saved state; persistent backends stop and
restart *the same* box. Both are correct, they are not the same operation, and a
lowest-common-denominator interface loses the best property of each.

| Provider | Isolation | Needs |
|---|---|---|
| `docker` **(default)** | container, kernel shared with the host | nothing |
| `fly` | hardware VM | `FLY_API_TOKEN`, `FLY_APP_NAME` |
| `e2b` | container | `E2B_API_KEY` |
| `daytona` | container | `DAYTONA_API_KEY` |
| `modal` | container | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` |
| `runloop` | container | `RUNLOOP_API_KEY` |
| `morph` | microVM | `MORPH_API_KEY` |
| `blaxel` | microVM | `BL_API_KEY`, `BL_WORKSPACE` |
| `codesandbox` | microVM | `CSB_API_KEY` |
| `vercel` | microVM, ~45-minute ceiling | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` |
| `cloudflare` | container, via a Worker shim you deploy | `CLOUDFLARE_SANDBOX_WORKER_URL`, `…_TOKEN` |
| `northflank` | container | `NORTHFLANK_API_TOKEN`, `NORTHFLANK_PROJECT_ID` |
| `local` | **none** — see below | opt-in flags |

`docker` is the default because it is the one that lets somebody evaluate the
whole product without a vendor relationship. Everything between it and `local` is
a remote backend: pick the vendor you already have a contract with, set
`HARBOR_SANDBOX_PROVIDER`, and fill in that vendor's credentials. **Every remote
provider is an upgrade, never a prerequisite** — none of them is required for
anything, and the full list is `SANDBOX_PROVIDER_NAMES` in
`src/sandbox/registry.ts`, which contains no stubs.

Every one of them is `ephemeral` by choice rather than by limitation. Several
could technically stop and restart the same box — but a persistent resume with no
box left to resume has nowhere to fall back to, and the rule is to advertise the
capability you can honour on a bad day.

`local` runs the agent as the server user with no isolation. It is off unless
`HARBOR_ENABLE_RUNNER=1` and `HARBOR_WORKSPACE_DIR` are both set, the runtime must
be a known binary, and the prompt is passed as an argv element rather than through
a shell. Those guards make it usable on your own machine; they do not make it a
sandbox. Shipping `spawn()` and calling it a platform is how you ship a remote
code execution vulnerability with a dashboard on top.

Adding a provider is one file plus a registry line, and there is a **contract test
suite every provider must pass** — a better guarantee than a checklist document.

### At most one sandbox per lease

Claiming a lease before calling a provider stops ordinary concurrent duplication.
It does not survive a crash after the claim, a provider response lost in transit,
a retry before the id was persisted, or a lease expiring under a running holder —
and the middle two are indistinguishable without asking the provider what it
actually has. So Harbor promises what is achievable:

> **At most one *active* sandbox per lease, including after ambiguous failures.**

A spawn intent is persisted before the provider call and its `attempt_id` is
passed as a provider label, so an orphan is discoverable. Reconciliation adopts it
rather than creating a second. A **fencing token** is validated by every
privileged side effect, so a box whose lease lapsed cannot push a branch or write
to the transcript even though it is still running and still believes it holds the
work.

### Bring your own agent

`AgentAdapter` covers invocation, stream format, stop-versus-cancel, where model
credentials come from, who is authoritative for token counts, and crash recovery.
**Claude Code, Codex and OpenCode ship**, and `custom` takes an argv template for
anything else that can be driven from a command line.

Two runtimes are supported without being drivable. Cursor has no supported
headless mode, so it has no adapter — `runtime/adapters/index.ts` refuses it by
name rather than pretending. Devin runs on its own infrastructure and is tracked
by polling its API (`src/devin/`). Both report activity into Harbor through
`src/activity/` — you see what they are doing on the dashboard and their work
takes leases like anything else — but Harbor does not boot the sandbox or hold
the process. That distinction is the difference between a runtime Harbor *runs*
and one it *watches*, and it is worth keeping straight.

`stop` and `cancel` are different verbs because they are different things. `stop`
asks the agent to wind up and keep its work — the button a human presses on
realising they asked for the wrong thing. `cancel` kills the process — what a
timeout uses. Collapse them and either every timeout waits politely for a wedged
agent, or every human "stop" discards a half-finished edit.

Token counts come from the agent when it reports them and are marked
`unavailable` when it does not. Harbor never estimates from character counts: a
number that disagrees with the real invoice is worse than a visible gap, because
somebody makes a decision from it.

### Pull requests are authored by the human

> **Not wired up yet.** Everything in this section is implemented in
> `src/git/provider.ts` and covered by `src/git/attribution.test.ts`, and none of
> it has a production caller: the sandbox does not report its push, so
> `openPullRequest` is never invoked. The design below is what the code does when
> something calls it, not what a deployment does today.

The sandbox pushes a branch with short-lived brokered credentials and reports the
name. The control plane opens the pull request **with the prompting user's own
token**. GitHub does not let an author approve their own PR, so unreviewed agent
code becomes structurally impossible rather than policy-prohibited.

Author and committer are separate properties from separate mechanisms — the PR
author comes from the token, the commit author and committer come from git
metadata — and they are tested separately. Target state is
`Author: <the human>`, `Committer: Harbor <bot@…>`.

A user with no source-control identity does **not** silently fall back to the bot.
Harbor pushes the branch, returns a compare URL, and warns at startup and at use
naming the property that no longer holds. Burying that in documentation is how an
organisation on non-SCM SSO loses the central guarantee without noticing.

Git identity is never inferred: `agent-only` or `attributed-user`, and a missing
identity raises.

### Connectors

**Slack, Linear, GitHub, GitLab** ship. Adding one is a single file implementing
one interface, plus a line in the registry — not a separately deployed service.

GitLab is inbound-only — an issue or merge request becomes a task and nothing is
written back, so its token stays read-only. It is also the one connector that does
not HMAC: GitLab sends the configured secret verbatim in `X-Gitlab-Token`, so
verification is a constant-time comparison rather than a signature over the bytes.
Running an agent *against* a GitLab repository is not supported; the credential
broker is GitHub-only and refuses anything else by name.

Routing resolves in order: an explicit target in the message → a channel or team
mapping → operator keyword rules → *optionally* a model → **ask**. Most traffic
costs no model call, a deployment with no model key still routes, and `unknown` is
a first-class answer that produces a two-button picker. A classifier's confident
wrong answer is a stranger's repository with an agent's commits on it; being asked
is slower exactly once.

Every connector declares `outboundWrites` in code — what it can write externally,
rendered on `/connectors` and readable by a security reviewer without trusting a
paragraph somebody remembered to update.

### Cost

Server-side from the first migration, not a later feature. A background agent
platform has at least four amplification paths — scheduled automations, child
sessions, connectors turning every issue into a session, retries — and each is a
loop with no human in it. An uncapped one is a denial-of-wallet vulnerability that
does not require an attacker.

Spend is attributed to the **lease**, because "this lease cost $4.20" is a
sentence somebody can act on and "session 8fda cost $4.20" is not. The daily cap
is enforced **atomically with lease admission** — twenty concurrent claims against
a cap permitting five admit exactly five. On breach Harbor stops admitting new
claims and does not kill running work, because killing mid-turn wastes everything
already spent.

Money is integer micro-USD. Every priced row is stamped with a pricing version,
and an unknown model is priced at zero and marked unpriced rather than guessed.

### Everything is configurable, and that is enforced

Every timeout, threshold and limit resolves `repo config → environment variable →
default`, at call time. Each default carries its derivation in prose, visible at
`GET /api/health/config` on a running deployment. `validateConfig()` fails fast on
an incoherent combination — a stale-heartbeat threshold below the heartbeat
interval kills every healthy sandbox and presents as "the product is broken".

`scripts/lint-config.mjs` fails the build on a module-level tunable, and its error
message is under test, because a rule that fires with "Error: violation" gets
silenced and one that explains what to do gets obeyed. It found four real
violations the day it was written.

---

## Coordination: the five MCP tools

Harbor's original half, unchanged. Agents you run yourself — Claude Code in a
worktree, Codex, Conductor — connect over MCP and coordinate through the same
tables the background agents use.

`list_work` · `claim` · `release` · `create_task` · `renew_claim`

Five, not six. Every tool is re-read by the model on every turn, so the tool list
is a cost paid forever; when something new is needed it becomes a parameter on an
existing tool. The whole surface is ~1,130 tokens and a test caps it just above
that, so a sixth tool fails the build rather than quietly costing every agent on
every turn. Background-agent capability lives on a **separate** session-scoped
MCP endpoint injected into sandboxes, so it cannot leak into this budget.

That second surface is `harbor-agent` — `report_progress`, `record_artifact`,
`spawn_child`, `get_session_context` — served at `/agent/<sandbox_id>/mcp` on the
same MCP server, with its own budget test. It authenticates the sandbox's own
token **and** validates its fencing token on every request, so a box whose lease
lapsed mid-turn stops being able to write at that moment rather than whenever it
next disconnects. Set `HARBOR_AGENT_MCP_URL` to enable it; leave it unset and
agents simply run without Harbor tools rather than timing out against a server
you never deployed.

Injection is per-adapter, because there is no common mechanism. Claude Code takes
`--mcp-config` plus `--strict-mcp-config`; opencode has no flag at all and reads
`OPENCODE_CONFIG_CONTENT`, with a different schema (`mcp`/`remote`, not
`mcpServers`/`http`) and no strict mode, so a repository's own servers still
merge underneath. **Codex and `custom` are not wired yet** — they run, they just
get no Harbor tools.

The guarantee is one Postgres partial unique index:

```sql
create unique index one_active_lease_per_scope
  on claims (org_id, scope) where released_at is null;
```

The unit is the **scope** — a slash-delimited path like `repo/api/task/482` — not
a task row, so a lease can cover a task, a directory, a whole repository or a
subtree of one, and the same index enforces all of them. It is scoped by `org_id`
because the trust boundary is the organisation and two orgs must never contend.

Two agents racing both INSERT; Postgres serialises them and exactly one lands. The
loser is not an error — it is a `claim_conflict` row, and **that number is what
Harbor is judged by.** Every one is a duplicated day of work that did not happen.

```jsonc
// .mcp.json at your repo root. Commit it — committing it is the point.
{
  "mcpServers": {
    "harbor": {
      "type": "http",
      "url": "http://localhost:8788/mcp",
      "headers": { "Authorization": "Bearer ${HARBOR_API_KEY}" }
    }
  }
}
```

---

## Dashboard

`/` live activity · `/channels` and `/c/<key>` chat · `/sessions` and `/s/<key>`
rooms · `/runs` · `/automations` · `/connectors` · `/usage` · `/digest` ·
`/settings`

Repositories, environments and secrets are **schema and seed script only** — the
tables are there and `npm run db:seed` writes them, but there are no HTTP
endpoints and no pages yet.

The headline metric: **sessions that resulted
in a merged pull request.** Merged PRs are the only proof the agent produced
value — an agent that opens forty pull requests nobody merges has produced none,
which is why the number counts merges and not openings. `artifacts.merged_at` is
written only from a verified source-control webhook; no agent can move it.

**Known gap:** nothing opens the pull request yet. `openPullRequest` and the
attribution rules above are implemented and tested, but no production caller
reaches them — the sandbox never reports a push, so no `pull_request` artifact is
created and this metric reads `0/n` on every deployment. The plumbing behind it
is real; the trigger is not written.

---

## Tests

```bash
docker compose up -d
npm run check   # config lint + typecheck + the full suite
```

`npm run check` is the gate a contribution must pass — it runs the config
lint (no hardcoded tunables, no await in a sync-handoff region), `tsc`, and
the whole test suite. To run the tests alone:

```bash
DATABASE_URL=postgres://harbor:harbor@localhost:5433/harbor npx vitest run
```

**Hundreds of tests against real Postgres, not mocks**, because the guarantees
are database indexes and how code reacts to them — a mock happily passes a
read-then-write check that races.

Pure modules get zero-mock suites at exact boundary values: 99 cases on sandbox
decisions alone (`npx vitest run src/sandbox/decisions.test.ts`). Provider tests
run against real Docker and **skip loudly** when it is absent rather than
silently passing.

---

## Non-goals

**Not multi-tenant across untrusted organisations.** The trust boundary is the
org. [docs/SECURITY.md](./docs/SECURITY.md) states the *consequences* rather than
the property — that anyone who can start a session on a repository can read that
repository's secrets from the agent's environment, and that `.harbor/setup.sh` is
arbitrary code execution granted by merge access.

**No bidirectional issue-tracker sync.** Two state machines mean webhook ordering
decides which system wins.

**No semantic conflict detection as a gate.** Harbor prevents two agents taking
the same *task*; detecting two agents doing the same *work* under different titles
tops out at 55–74% recall on adjacent benchmarks, so a naive version either misses
a third of real conflicts or spams false positives — and an alert agents learn to
ignore is worse than no alert. Overlap surfaces as a non-blocking hint on push,
never as a block.

**No SSO/SAML/RBAC. No billing.**

## Licence

Apache-2.0.
