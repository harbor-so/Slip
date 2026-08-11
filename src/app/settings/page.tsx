/**
 * Keys, and the config snippet that makes them useful.
 *
 * The snippet is the point of this page. A pilot's time-to-first-value is
 * "paste this into your agent and it works", and every step between reading a
 * key and having a working `.mcp.json` is a step where a team gives up. So the
 * page renders the real block, with the real URL, ready to copy.
 */

import { listApiKeys } from "../../lib/dashboard.js";
import { currentSession } from "../../lib/session.js";
import { Badge, Card, Empty, SectionLabel } from "../../components/ui.js";
import { CreateKeyPanel } from "./create-key.js";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
	const session = await currentSession();
	if (!session) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const keys = await listApiKeys(session.orgId);
	const mcpUrl = process.env.SLIP_MCP_URL ?? "http://localhost:8788/mcp";

	return (
		<div className="space-y-8">
			<section>
				<SectionLabel>API keys</SectionLabel>
				<CreateKeyPanel />
				{keys.length === 0 ? (
					<Empty title="No keys yet" hint="Create one to connect an agent." />
				) : (
					<Card className="mt-4 p-0">
						<table className="w-full text-sm">
							<tbody>
								{keys.map((key) => (
									<tr className="border-b border-border last:border-0" key={key.id}>
										<td className="px-4 py-2.5">{key.label ?? "unlabelled"}</td>
										<td className="px-2 py-2.5 text-xs text-muted-foreground">
											{key.createdAt.toDateString()}
										</td>
										<td className="px-4 py-2.5 text-right">
											<Badge tone={key.revokedAt ? "expired" : "completed"}>
												{key.revokedAt ? "revoked" : "active"}
											</Badge>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</Card>
				)}
			</section>

			<section>
				<SectionLabel>Claude Code — .mcp.json</SectionLabel>
				<Card>
					<pre className="overflow-x-auto text-xs leading-relaxed text-muted-foreground">
{`{
  "mcpServers": {
    "slip": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer <YOUR_SLIP_KEY>" }
    }
  }
}`}
					</pre>
				</Card>
				<p className="mt-2 text-xs text-muted-foreground">
					Add to CLAUDE.md: “Before starting any task, call slip.list_work() to see what is
					already claimed, and slip.claim(task_id, agent_id) before beginning work. Release
					the claim when done, with a summary.”
				</p>
			</section>

			<section>
				<SectionLabel>Codex — config.toml</SectionLabel>
				<Card>
					<pre className="overflow-x-auto text-xs leading-relaxed text-muted-foreground">
{`[mcp_servers.slip]
url = "${mcpUrl}"
http_headers = { Authorization = "Bearer <YOUR_SLIP_KEY>" }`}
					</pre>
				</Card>
				<p className="mt-2 text-xs text-muted-foreground">
					Put the same instruction in AGENTS.md.
				</p>
			</section>
		</div>
	);
}
