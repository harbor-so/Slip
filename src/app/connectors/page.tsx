/**
 * What Slip is connected to, and what it is allowed to do there.
 *
 * The largest thing on each card is not a green dot — it is the list of writes
 * the connector may perform. "Is it connected?" is a question people ask once;
 * "what can it do to my Linear workspace?" is the question a security reviewer
 * asks, and answering it in the product rather than in a doc is what gets a
 * pilot approved.
 */

import { listConnectors } from "../../lib/dashboard.js";
import { currentSession } from "../../lib/session.js";
import { Badge, Card, Empty, SectionLabel } from "../../components/ui.js";

export const dynamic = "force-dynamic";

const CATALOGUE = [
	{
		type: "github",
		name: "GitHub",
		reads: "Issue and pull-request metadata: title, number, state, labels.",
		writes: "Nothing.",
		never: "Source code, diffs, and repository contents are never read.",
	},
	{
		type: "linear",
		name: "Linear",
		reads: "Issue create and update events: identifier, title, description, state.",
		writes: "One comment on an issue when an agent completes the matching task.",
		never: "No state changes, no assignee changes, no issue creation.",
	},
] as const;

const PLANNED = ["Jira", "Asana", "Notion", "Slack (digest delivery)"];

export default async function ConnectorsPage() {
	const session = await currentSession();
	if (!session) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const installed = await listConnectors(session.orgId);
	const byType = new Map(installed.map((row) => [row.type, row]));

	return (
		<div className="space-y-8">
			<section>
				<SectionLabel>Connectors</SectionLabel>
				<div className="grid gap-3 sm:grid-cols-2">
					{CATALOGUE.map((entry) => {
						const row = byType.get(entry.type);
						return (
							<Card key={entry.type}>
								<div className="flex items-center justify-between">
									<span className="font-medium">{entry.name}</span>
									<Badge tone={row ? "completed" : "neutral"}>
										{row ? row.status : "not connected"}
									</Badge>
								</div>

								<dl className="mt-3 space-y-2 text-xs">
									<div>
										<dt className="text-muted-foreground">Reads</dt>
										<dd>{entry.reads}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">Writes</dt>
										<dd>{entry.writes}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">Never</dt>
										<dd className="text-muted-foreground">{entry.never}</dd>
									</div>
								</dl>

								<p className="mt-3 text-xs text-muted-foreground">
									{row?.lastSyncedAt
										? `Last sync ${row.lastSyncedAt.toDateString()}`
										: `Point a webhook at /api/webhooks/${entry.type} to connect.`}
								</p>
							</Card>
						);
					})}
				</div>
			</section>

			<section>
				<SectionLabel>Planned</SectionLabel>
				<p className="text-xs text-muted-foreground">
					Interface ready, not built: {PLANNED.join(", ")}.
				</p>
			</section>
		</div>
	);
}
