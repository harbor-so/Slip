"use client";

/**
 * The launch form, and the wall in front of it.
 *
 * This is the one endpoint in Harbor that executes a program rather than writing
 * a row, so when the runner is disabled the form is not merely greyed out — the
 * reason and the exact variables are stated, and somebody turning it on reads a
 * sentence about what that means first. Enabled, it is a runtime picker, a
 * prompt, and a POST; the launched agent connects back through Harbor's own MCP
 * endpoint and claims work like any other, which is why a prompt is all it needs.
 *
 * `channel` is the Phase-4 seam: when present the launcher is scoped to a room
 * and the caller (the Room's "launch agent here") can pass the context in.
 */

import { useState } from "react";
import { Card } from "@web/design/index.js";
import { launchRun } from "@web/lib/api.js";

const RUNTIMES = ["claude-code", "codex"] as const;

export function LaunchAgentForm({
	enabled,
	channel,
	onLaunched,
}: {
	enabled: boolean;
	channel?: { key: string; title: string };
	onLaunched?: () => void;
}) {
	const [runtime, setRuntime] = useState<string>(RUNTIMES[0]);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!enabled) {
		return (
			<Card>
				<p className="text-sm">Launching agents is off.</p>
				<p className="mt-2 text-xs text-muted-foreground">
					Harbor spawns a headless agent as a child process on this host — same user, same
					filesystem, no isolation. That is fine on your own machine against your own repo, and
					unsafe anywhere multi-tenant. Set <code>HARBOR_ENABLE_RUNNER=1</code> and{" "}
					<code>HARBOR_WORKSPACE_DIR=/path/to/repo</code> to turn it on.
				</p>
			</Card>
		);
	}

	async function launch() {
		setBusy(true);
		setError(null);
		try {
			// When scoped to a room, ask the agent to join and converse there. The
			// agent still needs a chat keypair wired in to actually post — that backend
			// step is the Phase-4 follow-up; this passes the intent through regardless.
			const body = channel
				? `${prompt}\n\nJoin Harbor chat channel "${channel.key}" and report progress there.`
				: prompt;
			await launchRun({ runtime, prompt: body });
			setPrompt("");
			onLaunched?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card className="space-y-3">
			{channel ? (
				<p className="text-xs text-muted-foreground">
					Launching into <span className="text-foreground">{channel.title}</span>. The agent will
					be asked to join this room and report back.
				</p>
			) : null}
			<div className="flex gap-2">
				{RUNTIMES.map((id) => (
					<button
						className={`rounded-md px-3 py-1.5 text-sm ${
							runtime === id ? "bg-primary text-primary-foreground" : "bg-raised text-muted-foreground"
						}`}
						key={id}
						onClick={() => setRuntime(id)}
						type="button"
					>
						{id}
					</button>
				))}
			</div>
			<textarea
				className="min-h-24 w-full rounded-md border border-border bg-background p-3 text-sm"
				onChange={(event) => setPrompt(event.target.value)}
				placeholder="What should this agent do? It will claim work through Harbor before it starts."
				value={prompt}
			/>
			<div className="flex items-center gap-3">
				<button
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
					disabled={busy || prompt.trim().length < 3}
					onClick={launch}
					type="button"
				>
					{busy ? "Launching…" : "Launch"}
				</button>
				{error ? <span className="text-xs text-destructive">{error}</span> : null}
			</div>
		</Card>
	);
}
