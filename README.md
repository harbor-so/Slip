# Slip

**Coordination for teams running fleets of coding agents.**

Five MCP tools that stop parallel agents doing the same work twice — and cost a
fraction of the context that polling an issue tracker does.

[Quick start](#quick-start) · [The five tools](#the-five-tools) ·
[How it works](#how-the-guarantee-actually-works) · [Connectors](#connectors) ·
[Non-goals](#non-goals)

---

## The problem

You have five background agents on one backlog — Claude Code, Codex, Conductor
worktrees, Cursor background agents. Two things go wrong, and neither is solved
by git.

**They duplicate work.** Two agents independently decide to fix the same bug.
Worktrees stop them writing the same file; nothing stops them doing the same
work, and you find out at review time.

**They burn context finding out what's happening.** Every agent that wants the
current state polls Linear or GitHub through MCP. Linear's own MCP server
exposes roughly two dozen tools over a full human-shaped object model — issues,
cycles, projects, labels, comments, states — and the model re-reads all of it on
every turn, before doing anything useful.

Slip is one small coordination layer both agents talk to. Linear and GitHub sync
*into* it, so they stay optional instead of load-bearing, and agents never have
to learn anyone's object model.

## What it costs

Measured against the seeded demo org on a running server:

| | |
|---|---|
| All five tools, full schema | 3,927 chars ≈ **~980 tokens** |
| `list_work` with 10 tasks across 3 sources | 1,302 chars ≈ **~330 tokens** |

Both use the four-characters-per-token rule of thumb, which is an estimate
rather than a tokenizer count. The number worth comparing is the *shape*: five
tools with one-paragraph descriptions versus two dozen over a nested object
model. `src/mcp/protocol.test.ts` asserts the tool surface stays under budget so
it cannot quietly grow.

## Quick start

```bash
docker compose up -d          # Postgres on :5433
npm install
npm run db:migrate
npm run db:seed               # demo org, 2 projects, 5 tasks — prints an API key

npm run mcp                   # MCP server on :8788/mcp
npm run dev                   # dashboard on :3000
```

The seed prints an API key **once**. Only its SHA-256 is stored, so it can never
be shown again — mint another from Settings if you lose it.

`DATABASE_URL` is the only thing that changes to run against hosted Postgres
(Supabase, Neon). Nothing else in the codebase constructs a client.

### See it work, with no keys at all

```bash
npm run demo                              # 10 tasks, 4 agents mid-flight, a week of history
export SLIP_API_KEY=<the key it prints>
SLIP_DEMO_MODE=1 npm run mcp              # one terminal
SLIP_DEMO_MODE=1 npm run dev              # another
npm run demo:agents                       # six simulated agents — watch the dashboard
```

`demo:agents` does **not** mock the coordination layer — that would prove nothing
about the only part that matters. Each simulated agent is a real
`@modelcontextprotocol/sdk` client speaking Streamable HTTP to the real server
against real Postgres. The only fiction is that a `setTimeout` picks the work
instead of a model. The claims are real, the collisions come from the real
database index, the expiries are swept by the real sweeper.

## Connecting your agents

**Claude Code** — `.mcp.json` at your repo root. Commit this file.

```jsonc
{
  "mcpServers": {
    "slip": {
      "type": "http",
      "url": "http://localhost:8788/mcp",
      "headers": { "Authorization": "Bearer ${SLIP_API_KEY}" }
    }
  }
}
```

`${SLIP_API_KEY}` is expanded from the environment at connect time, so the file
is safe to commit — which matters, because committing it is the point.

**Codex** — `~/.codex/config.toml`

```toml
[mcp_servers.slip]
url = "http://localhost:8788/mcp"
bearer_token_env_var = "SLIP_API_KEY"
```

**Conductor** — nothing to configure. Conductor defines no MCP format of its
own; it loads whatever Claude Code and Codex load, and a repo-root `.mcp.json`
is inherited by every workspace it spawns. Commit the block above once and all
your parallel worktrees see Slip — which is exactly the situation Slip exists
for.

Then add one line to `CLAUDE.md` / `AGENTS.md`:

> Before starting any task, call `slip.list_work()` to see what is already
> claimed, and `slip.claim(task_id, agent_id)` before beginning work. Release the
> claim when done, with a summary.

A stdio transport is available for self-hosting: `npm run mcp:stdio` with
`SLIP_API_KEY` in the environment. Same tools, same code.

## The five tools

Five, not six. Every tool an MCP server exposes is re-read by the model on every
turn, so the tool list is a cost paid forever. When something new is needed it
becomes a parameter on an existing tool.

### `list_work(project?, status?)`
What exists and who holds it. Two optional filters are the entire filtering
surface — no search, no labels, no saved views.

```
[f05b] Virtualise the task table — open — project: frontend — scope: app/components/task-table.tsx
[8fda] Backfill missing created_at — open — project: backend — linear:ACM-482
[5b7e] Add rate limiting to /api/search — claimed by claude-code:wt-2 (expires in 20m) — project: backend
```

### `claim(task_id, agent_id, lease_minutes?)`
Atomic. Exactly one winner:

```
ok claimed [b59d] Fix auth token refresh bug — expires in 30m
```

The loser gets something it can act on, not just a refusal:

```
no [b59d] Fix auth token refresh bug
held by claude-code:wt-1 — expires in 30m
Pick different work with list_work, or retry after the lease expires.
```

### `release(task_id, agent_id, completion_summary?)`
With a summary, the task is completed and the summary feeds the weekly digest.
Without one, the agent is abandoning the work and the task returns to `open`.

### `create_task(title, description?, project?, scope?)`
For work an agent discovers mid-task. The project is created on demand. `scope`
is a free-text hint about where the work lives, shown to other agents.

### `renew_claim(task_id, agent_id, lease_minutes?)`
Extend a lease for long work. Only the holder can renew.

### Intent — the *why*, on every claim
`claim` takes an `intent` (one sentence) and an optional `intent_ref` (a spec,
thread or issue). It rides on the same line other agents already read:

```
[5b7e] Add rate limiting — claimed by codex:wt-2 (expires in 20m) — why: p99 spike from Tuesday's incident
```

Attached to the *claim* rather than the task, deliberately: one task can be
claimed three times for three different reasons, and the reason belongs to the
attempt. The claim history becomes a queryable record of why work happened, not
just what changed — the question asked six months later by whoever has to decide
whether something can be reverted.

## How the guarantee actually works

One Postgres partial unique index:

```sql
create unique index one_active_claim_per_task
  on claims (task_id) where released_at is null;
```

Two agents racing both issue an INSERT; Postgres serialises them and exactly one
lands. The loser isn't an error — it's a `claim_conflict` row, and **that number
is what Slip is judged by.** Every one is a duplicated day of work that didn't
happen.

Three details that took an audit to get right:

- **`ON CONFLICT DO NOTHING`, not try/catch.** A unique violation aborts the
  entire Postgres transaction, so the obvious "catch it, then read who holds it"
  is impossible — the read is exactly the statement that cannot run.
- **Expiry is applied lazily inside `claim()` as well as by a sweeper**, because
  an index predicate cannot call `now()`. Correctness never depends on the
  background job being alive; only timeliness does.
- **`release` and `renew` take a `FOR UPDATE` row lock.** Without it, an agent
  whose lease lapsed while it was still working could complete a task another
  agent had legitimately taken — and its summary was recorded as shipped work in
  the digest. That is an ordinary lapsed lease, not an attack, and it reproduced
  in 39 of 40 runs before the fix.

## Live presence

The dashboard shows who is working right now, updating in well under a second —
not a status grid that refreshes on a timer.

**Presence is a byproduct of the five tools, not a sixth one.** Every call an
agent already makes touches its presence row, so an agent cannot forget to
report, never opts in, and spends no tokens being visible. A `heartbeat` tool was
the obvious design and would have made every agent pay, on every turn, for the
dashboard's benefit. Liveness is computed at read time from `last_seen_at` rather
than stored as an online flag — a flag needs somebody to clear it, and the agent
that crashed is exactly the one that will not.

The transport is Postgres `LISTEN/NOTIFY` over Server-Sent Events. Not Supabase
Realtime, not a socket service: it reuses the one piece of infrastructure Slip
already requires, so there is nothing extra to deploy or pay for, and it works
identically on hosted Postgres.

## Launching agents

Slip can start an agent, not just wait for one to connect. `/runs` takes a
prompt, spawns `claude -p` or `codex exec` with Slip's own MCP endpoint injected,
and streams the output back — so an agent Slip launched claims, releases and
appears in presence like any other.

> **This is not a sandbox, and the boundary is the point.** The child process gets
> the server's user, filesystem and network. That is reasonable on your own
> machine against your own repo, and unsafe anywhere multi-tenant. It is off
> unless you set `SLIP_ENABLE_RUNNER=1` and `SLIP_WORKSPACE_DIR`, the runtime must
> be one of two known binaries, and the prompt is passed as an argv element and
> never through a shell. Real multi-tenant execution needs an isolation boundary
> bought from Modal or Daytona — shipping `spawn()` and calling it a platform is
> how you ship an RCE with a dashboard on top.

## Dashboard

`/` live activity — tasks, holders, lease countdowns, collisions prevented.
`/runs` launch and watch agents. `/digest` this week and history. `/connectors` what's connected and precisely
what it may write. `/settings` API keys and ready-to-paste agent config.

Sign-in is GitHub OAuth, gated on `SLIP_ALLOWED_GITHUB_LOGINS`. An empty
allowlist refuses everybody rather than admitting everybody.

When `GITHUB_CLIENT_ID` is unset **and** `NODE_ENV` is not production, the
dashboard falls back to the first org and says so in a banner on every page —
otherwise `docker compose up && npm run dev` would show a login wall before
there is anything to log into. The bypass refuses to engage in production
regardless.

## Connectors

**Supported:** GitHub, Linear. **Planned** (interface ready, not built): Jira,
Asana, Notion, Slack digest delivery.

Inbound sync only. External issues appear as Slip tasks; agents claim and
complete them in Slip. Full two-way state sync is an explicit non-goal.

> **Not yet wired.** `syncOutbound` for Linear — posting a completion comment
> back — is implemented but nothing calls it, and it would need `sourceRef` to
> store the issue UUID rather than the `ACM-482` identifier. **Slip currently
> writes nothing to any external system.**

See [CONNECTORS.md](./CONNECTORS.md) for exactly what Slip reads and which scopes
it requests. It is written for a security reviewer.

## Weekly digest

`POST /api/digest/generate`, or the button on `/digest`. Reads the last seven
days of `completed` and `claim_conflict` events, sends a compact summary to
Claude, stores the prose.

Requires `ANTHROPIC_API_KEY`. Without it the endpoint fails with a message
naming the variable rather than returning a plausible-looking fake — nobody
re-reads a summary that looks fine. `SLIP_DEMO_MODE=1` assembles one from the
event log instead, always prefixed `[mock digest — no model was called]`. An
empty week short-circuits without calling the model at all.

## Non-goals

No knowledge graph, vector memory, trust ledger, or autonomy promotion. No
sandboxed multi-tenant execution — see the boundary above.

**No semantic conflict detection**, and that is a decision rather than a backlog
item. Slip prevents two agents taking the same *task*; it does not detect two
agents doing the same *work* under different titles. Benchmarks on adjacent
problems top out around 55–74% recall, so a naive version would either miss a
third of real conflicts or spam false positives — and an alert agents learn to
ignore is worse than no alert. If it lands it will be a non-blocking "possible
overlap" hint, never a gate. No SSO/SAML/RBAC. No bidirectional sync. No billing.

## Tests

```bash
docker compose up -d
DATABASE_URL=postgres://slip:slip@localhost:5433/slip npx vitest run
```

**52 tests against real Postgres, not mocks.** The guarantee is a database index
and how the code reacts to it; a mock would happily pass a read-then-write check
that races.

- **23 coordination** — ten agents contending for one task, plus 30 interleaved
  rounds asserting no state exists where one agent holds a task another has
  marked completed.
- **14 protocol conformance** — driven by `@modelcontextprotocol/sdk`'s own
  `Client` over `StreamableHTTPClientTransport`, the client Claude Code and Codex
  actually use, against a server on an ephemeral port. Hand-written JSON-RPC over
  curl only proves the server answers the requests you thought to write.
- **9 digest** and **6 connector** — signature verification, replay, tampering.

## Security

Found by a five-agent audit and fixed: lost updates in `release`/`renew_claim`,
a cross-tenant write through `renew_claim`, an empty `AUTH_SECRET` accepted as
an HMAC key, unrestricted first-time sign-in, and a missing OAuth `state`.

Known and open: webhook org resolution selects a connector row by type alone, so
Slip is effectively single-tenant per connector until an external-account column
lands. Do not run one instance for two orgs sharing a connector type.

## Licence

Apache-2.0.
