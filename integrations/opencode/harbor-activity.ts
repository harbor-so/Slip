/**
 * Harbor activity tracking for opencode.
 *
 * Unlike Codex/Cursor, opencode plugins are JS/TS and can `fetch()` directly, so
 * there is no forwarder script — this plugin posts each event to Harbor itself.
 * It sends the opencode event name plus the fields those hooks receive; Harbor's
 * opencode normalizer maps that onto canonical activity rows.
 *
 * Install: drop this file in your opencode plugin directory (e.g.
 * `~/.config/opencode/plugin/harbor-activity.ts` or `<repo>/.opencode/plugin/`).
 * Configure via environment:
 *   HARBOR_URL       base URL (default http://localhost:3000)
 *   HARBOR_API_KEY   an org API key (required — plugin no-ops without it)
 *   HARBOR_AGENT_ID  optional stable agent id (default opencode:<session-id>)
 *
 * Posting is fire-and-forget: a slow or down Harbor never blocks a tool call.
 */

export const HarborActivity = async () => {
	const base = (process.env.HARBOR_URL ?? "http://localhost:3000").replace(/\/$/, "");
	const apiKey = process.env.HARBOR_API_KEY;
	const agentId = process.env.HARBOR_AGENT_ID;

	function send(event: string, body: Record<string, unknown>) {
		if (!apiKey) return; // Not configured — do nothing rather than throw.
		void fetch(`${base}/api/hooks/opencode`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ event, harbor_agent_id: agentId, ...body }),
		}).catch(() => {
			/* tracking must never surface as a plugin error */
		});
	}

	return {
		"tool.execute.before": async (input: { tool: string; sessionID?: string }, output: { args?: unknown }) => {
			send("tool.execute.before", { tool: input.tool, sessionID: input.sessionID, args: output?.args });
		},
		"tool.execute.after": async (
			input: { tool: string; sessionID?: string },
			output: { args?: unknown; output?: unknown },
		) => {
			send("tool.execute.after", {
				tool: input.tool,
				sessionID: input.sessionID,
				args: output?.args,
				output: output?.output,
			});
		},
		event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
			// Session lifecycle comes through the generic event stream rather than a
			// dedicated hook. Only the few we map are forwarded; the rest are ignored.
			if (["session.created", "session.idle", "session.deleted"].includes(event.type)) {
				const props = event.properties ?? {};
				send(event.type, { sessionID: props.sessionID ?? props.id });
			}
		},
	};
};
