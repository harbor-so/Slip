"use client";

/**
 * Launched agents, live.
 *
 * A run is a real process Harbor spawned, so its output arrives in a stream of
 * small writes flushed on a timer — the org change feed announces each flush
 * (`run_output`) and the finish (`run_finished`), and this view refetches the
 * list on either rather than polling on a clock. First paint is seeded by the
 * server component so the page is never empty while the first fetch is in
 * flight; after that the feed keeps it current.
 */

import { useCallback, useState } from "react";
import { Badge, Card, Empty, PresenceDot, RelTime, SectionLabel, type Tone } from "@web/design/index.js";
import { useOrgStream } from "@web/hooks/useOrgStream.js";
import { listRuns, type RunRow } from "@web/lib/api.js";
import { LaunchAgentForm } from "./LaunchAgentForm.js";

const STATUS_TONE: Record<string, Tone> = {
	starting: "claimed",
	running: "claimed",
	completed: "completed",
	failed: "conflict",
};

export function RunsView({ seed, enabled }: { seed: RunRow[]; enabled: boolean }) {
	const [runs, setRuns] = useState<RunRow[]>(seed);

	const refresh = useCallback(async () => {
		try {
			const { runs: fresh } = await listRuns();
			setRuns(fresh);
		} catch {
			// Keep the last good list; the next change re-tries.
		}
	}, []);

	const { live } = useOrgStream((change) => {
		if (change.verb === "run_output" || change.verb === "run_finished" || change.verb === undefined) {
			void refresh();
		}
	});

	const now = Date.now();

	return (
		<div className="space-y-8">
			<div className="flex items-center justify-between">
				<SectionLabel>Launch an agent</SectionLabel>
				<PresenceDot live={live} />
			</div>

			<LaunchAgentForm enabled={enabled} onLaunched={refresh} />

			<section>
				<SectionLabel>Runs</SectionLabel>
				{runs.length === 0 ? (
					<Empty
						title="Nothing launched yet"
						hint="A launched agent connects back through Harbor's own MCP endpoint, so it claims and releases like any other."
					/>
				) : (
					<div className="space-y-3">
						{runs.map((run) => (
							<Card key={run.id}>
								<div className="flex items-center gap-3">
									<Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{run.status}</Badge>
									<span className="text-sm font-medium">{run.agentId}</span>
									<span className="text-xs text-muted-foreground">{run.runtime}</span>
									<span className="ml-auto text-xs text-muted-foreground">
										<RelTime at={run.startedAt} now={now} />
									</span>
								</div>
								<p className="mt-2 text-xs text-muted-foreground">{run.prompt}</p>
								{run.output ? (
									<pre className="mt-3 max-h-64 overflow-auto rounded bg-muted/40 p-3 text-xs leading-relaxed">
										{run.output.slice(-4000)}
									</pre>
								) : null}
							</Card>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
