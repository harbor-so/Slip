# Harbor

**Background coding agents your company can actually deploy.**

You @-mention it in Slack, or assign it a Linear issue, or type into a shared
room. It boots an isolated sandbox, runs the coding agent you already use against
your repository, streams what it is doing to anyone who opens the link, and opens
a pull request authored by the person who asked.

One `docker compose up`. No Cloudflare account, no Terraform, no sandbox vendor.

[Quick start](#quick-start) · [Why this exists](#why-this-exists) ·
[How it works](#how-it-works) · [Deploying](./DEPLOY.md) ·
[Security](./docs/SECURITY.md) · [Non-goals](#non-goals)

---

## Why this exists

Ramp published [an account][ramp] of the background agent they built internally.
The thesis is right and worth restating: interactive coding assistants couple the
work to your presence — you type, it responds, you watch. A background agent
decouples them. You send a prompt, it runs in the cloud, you check later. Within a
couple of months roughly 30% of merged pull requests in their frontend and backend
repos came from it, with no mandate.

There is one faithful open reimplementation, [`ColeMurray/background-agents`][oi],
and it is a good piece of work. Several of its decisions are copied here more or
less verbatim and credited where they appear. But it is built on Cloudflare
Workers, Durable Objects, D1, KV, R2 and Queues, provisioned by Terraform, with
Modal for sandboxes and Vercel for the web tier. You cannot run it on a VM, in
your VPC, on-premises, or on a laptop. Evaluating it means four vendor accounts
before the first prompt — which, for a company whose security review is the
reason they wanted a self-hosted option, is not a deployment story.

Harbor is the version any company can adopt.

| | Open-Inspect | Harbor |
|---|---|---|
| Runs on | Cloudflare + Modal + Vercel + Terraform | Node + Postgres |
| Evaluate it | four vendor accounts | `docker compose up` |
| Sandbox | Modal (and four other paid providers) | **Docker by default**, Fly and Modal optional |
| Coding agent | OpenCode only | Claude Code, Codex, OpenCode, Cursor, or your own |
| Tenancy | single-tenant, one shared App install, no per-user repo check | org-scoped schema, per-user repo access check, tenant resolved from verified webhook payload |
| Adding a connector | write and deploy another Worker | one file, one registry line |
| Spend control | none | server-side accounting, atomic daily cap |
| Timeouts | module constants | every one env-configurable and per-repo overridable, enforced by lint |
| Duplicate work | nothing | claim-before-spawn: a duplicate never costs a container |

That last row is the thing Harbor has that nothing else does, and it is worth a
paragraph. Harbor started as a coordination layer for fleets of agents — a lease
table with a partial unique index guaranteeing exactly one holder per unit of
work. The execution plane was built on top of it, which means **the lease is
acquired before a sandbox is booted.** Two runners that pick up the same task
produce one container and one token bill, not two, and the loser gets told who
holds it and why. Every branch is named `harbor/lse_<claim_id>` and every pull
request body carries the claim's stated intent, so six months later "why was this
written" is answerable from the PR.

[ramp]: https://builders.ramp.com/post/why-we-built-our-background-agent
[oi]: https://github.com/ColeMurray/background-agents

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

Three planes, and every Cloudflare primitive the reference design needs has a
Postgres equivalent that was already here. A Durable Object's single-writer
property is `pg_try_advisory_lock`. Its WebSocket hub is `LISTEN/NOTIFY` over SSE.
Its per-session SQLite is a table with an index. See
[ADR 0001](./docs/adr/0001-postgres-not-durable-objects.md), which answers the
three real arguments for Durable Objects on their own terms and states what we
give up.

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
the client already had it. Loss is impossible by construction. The alternative
design — the one the reference implementation uses — depends on there being no
`await` between the snapshot read and the socket registration, which is a rule a
future refactor silently breaks.

### Chat

Where a session is a room with *work* in it, a channel is a room with a
*conversation* in it — and the two connection types Harbor most needs, human↔agent
and agent↔agent, are the same primitive as human↔human because every participant
is just a keypair. Every message is an Ed25519-signed event whose id is a hash of
its own body, verified independently of the signature, so attribution is
cryptographic rather than a server-stamped author. The full design, the study of
`block/buzz` it came from, and its known limitations are in [`CHAT.md`](./CHAT.md);
`npm run demo:chat` shows two agents holding a signed conversation.

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
| `docker` **(default)** | container | nothing |
| `fly` | hardware-virtualised VM | a Fly account |
| `local` | **none** — see below | opt-in flags |

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
Claude Code, Codex, OpenCode and Cursor ship; `custom` takes an argv template.

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

**Slack, Linear, GitHub** ship. Adding one is a single file implementing one
interface, plus a line in the registry — not a separately deployed service.

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
existing tool. The whole surface is ~980 tokens and a test asserts it cannot
quietly grow. Background-agent capability lives on a **separate** session-scoped
MCP endpoint injected into sandboxes, so it cannot leak into this budget.

The guarantee is one Postgres partial unique index:

```sql
create unique index one_active_claim_per_task
  on claims (task_id) where released_at is null;
```

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

`/` live activity · `/sessions` and `/s/<key>` rooms · `/repos` `/environments`
`/secrets` · `/automations` · `/connectors` · `/usage` · `/digest` · `/settings`

The headline metric is Ramp's, and it is the right one: **sessions that resulted
in a merged pull request.** Merged PRs are the only proof the agent produced
value.

---

## Tests

```bash
docker compose up -d
DATABASE_URL=postgres://harbor:harbor@localhost:5433/harbor npx vitest run
```

**579 tests against real Postgres, not mocks**, because the guarantees are
database indexes and how code reacts to them — a mock happily passes a
read-then-write check that races.

Pure modules get zero-mock suites at exact boundary values: 93 tests on sandbox
decisions alone. Provider tests run against real Docker and **skip loudly** when
it is absent rather than silently passing.

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
