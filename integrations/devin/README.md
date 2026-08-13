# Devin → Harbor

Every other integration in this directory installs *hooks* into a tool so it
pushes activity to Harbor. Devin has no hook system and no outbound webhooks
about its own progress — the only way to learn what a Devin session did is to ask
its API. So Devin is the one runtime Harbor **pulls**: you register a session, and
a background loop polls it and writes the same `activity` rows a hook would have.

There is nothing to install into Devin. Two steps:

## 1. Give Harbor a Devin API token

Per-org (preferred — a deployment serving two orgs must not poll one org's
sessions with the other's credential): a `connectors` row of type `devin` whose
`config` holds `{ "apiToken": "<your Devin token>" }`.

Single-tenant fallback: set `DEVIN_API_TOKEN` in the environment.

## 2. Register a Devin session

```bash
# Observe a Devin session that already exists
curl -X POST "$HARBOR_URL/api/devin/sessions" \
  -H "Authorization: Bearer $HARBOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"devinSessionId":"devin-abc123","title":"Fix the flaky test"}'

# …or start one from a prompt and track it
curl -X POST "$HARBOR_URL/api/devin/sessions" \
  -H "Authorization: Bearer $HARBOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Fix the flaky payment test","taskId":"<optional harbor task id>"}'
```

The org is derived from the Harbor API key, never from the body — the same
tenancy rule as the activity hooks and the MCP server. Registration is
idempotent: registering the same Devin session twice returns the existing
mapping rather than tracking it twice.

| Var | Meaning |
|-----|---------|
| `HARBOR_URL` | Base URL of your Harbor deployment |
| `HARBOR_API_KEY` | An org API key (create one in Settings) |
| `DEVIN_API_TOKEN` | Devin API token, if not stored per-org on a connector row |
| `DEVIN_API_BASE_URL` | Override Devin's API base (a proxy, or a test double) |

## What you get

- **Activity feed.** Devin's messages and status changes become `activity` rows
  under the `devin` runtime, agent id `devin:<session id>` — so Devin appears in
  presence and the live feed like any other agent. The rows are coarser than a
  hook-based runtime's: Devin's API exposes a message log and a status, not
  per-tool arguments, so a Devin `tool_call` carries prose rather than a command
  and a file path.
- **Pull requests.** A PR the session opens is recorded as a `pull_request`
  artifact. Harbor never marks it merged from Devin's side — merged is only ever
  written from a verified source-control webhook — so once your GitHub connector
  is wired, a merged Devin PR counts toward the merged-PR metric exactly like an
  in-house one.

## Tuning

| Setting | Env | Default |
|---------|-----|---------|
| Poll interval | `HARBOR_DEVIN_POLL_INTERVAL_MS` | `30000` |
| Sessions per tick | `HARBOR_DEVIN_POLL_MAX_PER_TICK` | `100` |

The loop runs in the MCP server process (`npm run mcp`), like every other
background loop. On a dashboard-only deployment, drive `POST /api/loops/tick`
from whatever cron your platform already has.

A session leaves the poll set on its own: Devin's terminal statuses (`finished`,
`suspended`) drop it, and so does a session that stops being reachable (a deleted
session or a revoked token), which Harbor marks `expired` rather than retrying
forever.

> `POST /api/hooks/devin` also accepts a whole Devin session payload and replays
> it into the feed. That path exists for testing and manual backfill; the poller
> is the authoritative one.
