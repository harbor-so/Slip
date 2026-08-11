# Slip

Coordination for teams running fleets of autonomous coding agents.

If you have five background agents working one backlog — Claude Code, Codex,
Conductor worktrees, Cursor background agents — you have two problems that git
does not solve:

**Duplicate work.** Two agents independently decide to fix the same bug. Git
worktrees stop them writing the same file; nothing stops them doing the same
work and finding out at review time.

**Context cost.** Every agent that wants "what is going on right now" polls
Linear or GitHub through MCP. Linear's own MCP server exposes ~23 tools over a
full human-shaped object model — issues, cycles, projects, labels, comments,
states — and an agent pays for that schema on every turn before it does anything
useful.

Slip is the canonical, agent-facing coordination layer. A small native task model
that agents talk to directly, five MCP tools, plain-text responses. Linear and
GitHub sync *into* it, so external tools stay optional rather than load-bearing
and agents never have to understand Linear's object model at all.

## What it costs

Measured against the seeded demo org, not estimated:

| | Slip |
|---|---|
| Tool schema, all 5 tools, paid once per session | **~974 tokens** |
| `list_work` answering with 6 tasks across 3 sources | **~150 tokens** |

The comparison that matters is the tool list: Linear's MCP server exposes ~23
tools, and every one of them is read by the model on every turn.

## Setup

```bash
docker compose up -d          # Postgres on :5433
npm install
npm run db:migrate
npm run db:seed               # demo org, 2 projects, 5 tasks — prints an API key

npm run mcp                   # MCP server on :8788/mcp
npm run dev                   # dashboard on :3000
```

The seed prints an API key once. Only its SHA-256 is stored, so it cannot be
recovered — make another with the Settings page if you lose it.

`DATABASE_URL` is the only thing that changes to run against hosted Postgres
(Supabase, Neon). Nothing else in the codebase constructs a client.

## The five MCP tools

Authenticated with a per-org bearer token over Streamable HTTP.

```jsonc
// .mcp.json at your repo root — Claude Code. Commit this file.
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

`${SLIP_API_KEY}` is interpolated from the environment at connect time, so the
file is safe to commit — which matters, because committing it is the point.

```toml
# ~/.codex/config.toml — Codex
[mcp_servers.slip]
url = "http://localhost:8788/mcp"
bearer_token_env_var = "SLIP_API_KEY"
```

**Conductor needs no configuration at all.** It does not define its own MCP
format — it loads whatever Claude Code and Codex load — and a `.mcp.json` at the
repo root is inherited by every workspace it spawns. Commit the block above once
and all parallel worktrees see Slip, which is exactly the situation Slip exists
for: five Conductor worktrees on one repo with nothing coordinating them.

Then add to `CLAUDE.md` / `AGENTS.md`:

> Before starting any task, call `slip.list_work()` to see what is already
> claimed, and `slip.claim(task_id, agent_id)` before beginning work. Release the
> claim when done, with a summary.

**`list_work(project?, status?)`** — what exists and who holds it.

```
[f05b] Virtualise the task table — open — project: frontend — scope: app/components/task-table.tsx
[8fda] Backfill missing created_at — open — project: backend — linear:ACM-482
[5b7e] Add rate limiting to /api/search — claimed by claude-code:wt-2 (expires in 20m) — project: backend
```

**`claim(task_id, agent_id, lease_minutes?)`** — atomic. One winner:

```
ok claimed [b59d] Fix auth token refresh bug — expires in 30m
```

and the loser gets something it can act on:

```
no [b59d] Fix auth token refresh bug
held by claude-code:wt-1 — expires in 30m
Pick different work with list_work, or retry after the lease expires.
```

**`release(task_id, agent_id, completion_summary?)`** — with a summary marks the
task completed and feeds the weekly digest; without one it returns the task to
`open` for someone else.

**`create_task(title, description?, project?, scope?)`** — the project is created
on demand. `scope` is a free-text hint about where the work lives, shown to other
agents so they can see overlap.

**`renew_claim(task_id, agent_id, lease_minutes?)`** — extend a lease for long
work. Only the holder can renew.

A stdio transport is available for local or self-hosted use: `npm run mcp:stdio`
with `SLIP_API_KEY` in the environment. Same tools, same code.

## How the coordination actually works

The guarantee is one Postgres partial unique index:

```sql
create unique index one_active_claim_per_task
  on claims (task_id) where released_at is null;
```

Two agents racing both issue an INSERT; Postgres serialises them and exactly one
lands. The loser is not an error — it is a `claim_conflict` row, and that number
is what Slip is ultimately judged by. Every one of them is a duplicated day of
work that did not happen.

Claims expire (default 30 minutes) so a crashed agent never locks a task
forever. Expiry is applied lazily inside `claim()` as well as by a sweeper that
runs every minute, because an index predicate cannot call `now()` — correctness
does not depend on the background job being alive, only timeliness does.

## Connectors

**Supported now:** Linear, GitHub.
**Planned (interface ready, not built):** Jira, Asana, Notion, Slack (digest
delivery).

Inbound sync only by default — external issues appear as Slip tasks, agents claim
and complete them in Slip. The single outbound write is a Linear comment when a
task is completed. Full two-way state sync is an explicit non-goal.

See [CONNECTORS.md](./CONNECTORS.md) for exactly what Slip reads, what it writes,
and which scopes it asks for. It is written for a security reviewer.

## Weekly digest

`POST /api/digest/generate` (or the button on `/digest`) reads the last seven
days of `completed` and `claim_conflict` events, sends a compact summary to
Claude, and stores the prose. Requires `ANTHROPIC_API_KEY`; without it the
endpoint fails with a message naming the variable rather than returning a
plausible-looking fake, because nobody re-reads a summary that looks fine.

An empty week short-circuits without calling the model at all.

## Dashboard

`/` live activity — tasks, holders, lease countdowns, and collisions prevented.
`/digest` this week plus history. `/connectors` what is connected and precisely
what it may write. `/settings` API keys and ready-to-paste agent config.

Sign-in is GitHub OAuth. When `GITHUB_CLIENT_ID` is unset **and** `NODE_ENV` is
not production, the dashboard falls back to the first org and says so in a banner
on every page — otherwise `docker compose up && npm run dev` would show a login
wall before there is anything to log into. The bypass refuses to engage in
production regardless.

## Explicit non-goals

No knowledge graph, vector memory, trust ledger, or autonomy promotion. No
semantic conflict detection beyond the free-text `scope` field — file-level and
cross-ticket overlap detection is future work. No SSO/SAML/RBAC; one API key per
org is enough for a pilot. No bidirectional Linear/GitHub sync. No multi-region
or self-host packaging beyond a clean `DATABASE_URL`. No billing.

## Tests

```bash
docker compose up -d
DATABASE_URL=postgres://slip:slip@localhost:5433/slip npx vitest run
```

37 tests against real Postgres, not mocks — the coordination guarantee is a
database index and how the code reacts to it, and a mock would happily pass a
read-then-write check that races. Includes ten agents contending for one task.

14 of those are protocol conformance, driven by `@modelcontextprotocol/sdk`'s own
`Client` over `StreamableHTTPClientTransport` — the same client implementation
Claude Code and Codex use — against a server booted on an ephemeral port. Hand-
written JSON-RPC over curl proves only that the server answers the request you
happened to write; it cannot catch a capability that is never advertised or a
header negotiation only the real client performs, and both of those are invisible
until an agent host fails to connect in front of a customer.

## Licence

Apache-2.0.
