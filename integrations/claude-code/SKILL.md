---
name: harbor-activity-tracking
description: Wire Claude Code (or Conductor) so every tool call is recorded in Harbor. Use when a user asks to track agent activity in Harbor, install Harbor hooks, or see what agents are doing across a repo.
metadata:
  type: reference
---

# Install Harbor activity tracking

Harbor records every tool call an agent makes as an `activity` row, tied to the
agent and the task it claimed. Claude Code posts this over a native HTTP hook — no
script needed. Conductor inherits it automatically once the config is committed
(and when Conductor runs Codex instead, wire the Codex artifact the same way).

## Steps

1. **Get an API key.** In Harbor → Settings → API keys, create one. Export it:

   ```bash
   export HARBOR_API_KEY="hbr_…"
   export HARBOR_URL="https://your-harbor.example.com"   # or http://localhost:3000
   ```

2. **Add the hooks.** Merge the `hooks` block from
   [`settings.hooks.json`](./settings.hooks.json) into either:
   - `~/.claude/settings.json` — tracks every project on this machine, or
   - `<repo>/.claude/settings.json` — tracks one repo, **and is what every
     Conductor workspace inherits**. Commit it.

   Replace `http://localhost:3000` with `$HARBOR_URL`'s value. The bearer token is
   read from `HARBOR_API_KEY` at run time via `allowedEnvVars`, so the key is never
   written to the file.

3. **Verify.** Run any command in Claude Code, then check Harbor → Activity (or the
   live feed on the dashboard). A `tool_call` row should appear within a second.

## What gets recorded

`PreToolUse`/`PostToolUse` (every `Bash`, `Edit`, `Write`, `Read`, `WebFetch`,
`Task`, and `mcp__*` call), `SessionStart`/`SessionEnd`, `UserPromptSubmit`, and
`Stop`. The hooks are `async` and fire-and-forget, so tracking never slows a tool
call or blocks it — a Harbor that is down just means those rows are not recorded.

## Optional: a stable agent id

By default an agent is identified as `claude-code:<session-id>`. To use your own
convention (e.g. `claude-code:worktree-3`), see the forwarder-based tools; Claude
Code's HTTP hook posts the session id in its body and Harbor derives the id from
that.
