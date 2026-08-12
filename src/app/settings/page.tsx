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
	const mcpUrl = process.env.HARBOR_MCP_URL ?? "http://localhost:8788/mcp";

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
				<SectionLabel>Claude Code — .mcp.json at your repo root</SectionLabel>
				<Card>
					<pre className="overflow-x-auto text-xs leading-relaxed text-muted-foreground">
{`{
  "mcpServers": {
    "harbor": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer \${HARBOR_API_KEY}" }
    }
  }
}`}
					</pre>
				</Card>
				<p className="mt-2 text-xs text-muted-foreground">
					Commit this file. Claude Code interpolates <code>{"${HARBOR_API_KEY}"}</code> from the
					environment, so the key never enters version control — and a committed
					<code> .mcp.json</code> is what every Conductor workspace inherits automatically.
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					Add to CLAUDE.md: “Before starting any task, call harbor.list_work() to see what is
					already claimed, and harbor.claim(task_id, agent_id) before beginning work. Release
					the claim when done, with a summary.”
				</p>
			</section>

			<section>
				<SectionLabel>Codex — ~/.codex/config.toml</SectionLabel>
				<Card>
					<pre className="overflow-x-auto text-xs leading-relaxed text-muted-foreground">
{`[mcp_servers.harbor]
url = "${mcpUrl}"
bearer_token_env_var = "HARBOR_API_KEY"`}
					</pre>
				</Card>
				<p className="mt-2 text-xs text-muted-foreground">
					<code>bearer_token_env_var</code> is purpose-built for this and keeps the key out of
					the file. Put the same instruction in AGENTS.md.
				</p>
			</section>

			<section>
				<SectionLabel>Conductor</SectionLabel>
				<Card>
					<p className="text-xs text-muted-foreground">
						Nothing to configure. Conductor does not define its own MCP format — it loads
						whatever Claude Code and Codex load, and a <code>.mcp.json</code> at your repo
						root is inherited by every workspace it spawns. Commit the block above once and
						all parallel worktrees see Harbor.
					</p>
				</Card>
			</section>

		</div>
	);
}
