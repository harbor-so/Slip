#!/usr/bin/env bash
#
# Forward one coding-tool hook payload to Harbor.
#
# Codex and Cursor hooks run local commands only — they cannot POST on their own —
# so this reads the event JSON on stdin and curls it to Harbor's ingest endpoint.
# One script serves both; the caller passes the runtime and the event name.
#
#   harbor-forward.sh <runtime> [event]
#
# Env: HARBOR_URL (default http://localhost:3000), HARBOR_API_KEY (required),
#      HARBOR_AGENT_ID (optional stable agent id).
#
# It always exits 0. A tracking hook must never block or fail the agent's tool
# call, so a missing key or an unreachable Harbor degrades to "not recorded",
# never to a blocked action.

runtime="${1:-}"
event="${2:-}"

if [ -z "$runtime" ]; then
	echo "harbor-forward.sh: missing <runtime>" >&2
	exit 0
fi
if [ -z "${HARBOR_API_KEY:-}" ]; then
	echo "harbor-forward.sh: HARBOR_API_KEY not set; skipping" >&2
	exit 0
fi

base="${HARBOR_URL:-http://localhost:3000}"
url="${base%/}/api/hooks/${runtime}"

query=""
[ -n "$event" ] && query="event=${event}"
if [ -n "${HARBOR_AGENT_ID:-}" ]; then
	# Minimal URL-encoding for the one character a Harbor agent id commonly holds.
	agent="${HARBOR_AGENT_ID//:/%3A}"
	query="${query:+${query}&}agent=${agent}"
fi
[ -n "$query" ] && url="${url}?${query}"

curl -sS -m 5 -X POST "$url" \
	-H "Authorization: Bearer ${HARBOR_API_KEY}" \
	-H "Content-Type: application/json" \
	--data-binary @- >/dev/null 2>&1 || true

exit 0
