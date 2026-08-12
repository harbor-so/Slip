# Harbor activity tracking — drop-in installers

These are the copy-paste artifacts that wire a coding tool's **hooks** to Harbor so
every tool call an agent makes (Bash, Edit, Read, shell, MCP calls, …) is recorded
as an `activity` row, tied to the agent and — when it holds one — the task it
claimed. This is the *passive* counterpart to the five MCP tools: the agent does
not have to report anything, its host does it deterministically.

All of them post to one authenticated endpoint:

```
POST ${HARBOR_URL}/api/hooks/<runtime>
Authorization: Bearer ${HARBOR_API_KEY}
```

`<runtime>` is one of `claude-code`, `codex`, `cursor`, `opencode`, `conductor`.
The org is derived from the API key, never from the payload — the same tenancy rule
as the MCP server and the connector webhooks.

Two environment variables drive every installer:

| Var | Meaning | Default |
|-----|---------|---------|
| `HARBOR_URL` | Base URL of your Harbor deployment | `http://localhost:3000` |
| `HARBOR_API_KEY` | An org API key (create one in Settings) | — (required) |
| `HARBOR_AGENT_ID` | Optional stable agent id, e.g. `claude-code:worktree-3` | derived `<runtime>:<session-id>` |

## Which tool needs which artifact

| Tool | Transport | Artifact |
|------|-----------|----------|
| **Claude Code** | Native HTTP hook — no script | [`claude-code/`](./claude-code) |
| **Conductor** | Inherits whichever underlying tool's committed config | [`claude-code/`](./claude-code) and/or [`codex/`](./codex) — see below |
| **Codex CLI** | Command hook → `curl` forwarder | [`codex/`](./codex) + [`harbor-forward.sh`](./harbor-forward.sh) |
| **Cursor** (≥1.7) | Command hook → `curl` forwarder | [`cursor/`](./cursor) + [`harbor-forward.sh`](./harbor-forward.sh) |
| **opencode** | JS plugin — `fetch()`s directly | [`opencode/`](./opencode) |

Only Claude Code and opencode can reach HTTP on their own. Codex and Cursor run
local commands only, so they share one tiny forwarder script,
[`harbor-forward.sh`](./harbor-forward.sh).

### Conductor

Conductor has no hook format of its own — it drives **Claude Code or Codex** under
the hood and inherits whatever those tools load from the repo. So you wire the
*underlying* tool and commit its config:

- Conductor running **Claude Code** → commit `.claude/settings.json` (the Claude Code
  artifact).
- Conductor running **Codex** → commit `.codex/hooks.json` + the forwarder (the Codex
  artifact).

Point either at `runtime = conductor` (instead of `claude-code`/`codex`) if you want
Conductor sessions tagged as their own runtime in the dashboard — the endpoint parses
both dialects identically, since Claude Code and Codex share one.
