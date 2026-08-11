/**
 * Who is doing what, right now.
 *
 * The one screen a human opens to answer "is anything colliding?" — so the
 * conflict count is the first thing on it, above the task table, in the alarm
 * colour. Everything else on this page is context for that number.
 */

import { conflictsPrevented, recentEvents } from "../lib/dashboard.js";
import { relTime, shortId } from "../lib/format.js";
import { currentSession } from "../lib/session.js";
import { listWork } from "../lib/work.js";
import { Badge, Card, Empty, SectionLabel, Stat, type Tone } from "../components/ui.js";

export const dynamic = "force-dynamic";

const EVENT_TONE: Record<string, Tone> = {
	claim_conflict: "conflict",
	claim_expired: "expired",
	completed: "completed",
	claimed: "claimed",
	released: "released",
	task_created: "neutral",
	claim_renewed: "claimed",
	connector_synced: "neutral",
};

export default async function ActivityPage() {
	const session = await currentSession();
	if (!session) {
		return <Empty title="No organisation yet" hint="Run npm run db:seed to create one." />;
	}

	const [tasks, feed, conflicts] = await Promise.all([
		listWork(session.orgId),
		recentEvents(session.orgId, 25),
		conflictsPrevented(session.orgId),
	]);

	const now = new Date();
	const claimed = tasks.filter((t) => t.claim && t.claim.expiresAt > now);
	const open = tasks.filter((t) => !t.claim || t.claim.expiresAt <= now);

	return (
		<div className="space-y-8">
			<div className="flex gap-3">
				<Stat value={claimed.length} label="in flight" />
				<Stat value={open.length} label="available" />
				<Stat value={conflicts} label="collisions prevented (7d)" />
			</div>

			<section>
				<SectionLabel>Tasks</SectionLabel>
				{tasks.length === 0 ? (
					<Empty
						title="No tasks yet"
						hint="Agents can add them with create_task, or connect Linear or GitHub."
					/>
				) : (
					<Card className="p-0">
						<table className="w-full text-sm">
							<tbody>
								{tasks.map((task) => {
									const live = task.claim && task.claim.expiresAt > now;
									return (
										<tr className="border-b border-border last:border-0" key={task.id}>
											<td className="nums w-16 px-4 py-2.5 text-xs text-muted-foreground">
												{shortId(task.id)}
											</td>
											<td className="px-2 py-2.5">{task.title}</td>
											<td className="px-2 py-2.5 text-xs text-muted-foreground">
												{task.project ?? "—"}
											</td>
											{/* A claim that exists but has lapsed is the interesting case. The
											    row still says status "claimed" until the sweeper runs, so
											    rendering `task.status` here would show "claimed" with no holder
											    and no countdown — while the agent-facing formatter is already
											    telling agents it is claimable. Two views disagreeing about one
											    row is how people stop trusting the dashboard. */}
											<td className="px-2 py-2.5">
												{live ? (
													<Badge tone="claimed">{task.claim!.agentId}</Badge>
												) : task.claim ? (
													<Badge tone="expired">lease expired — claimable</Badge>
												) : (
													<Badge tone={task.status as Tone}>{task.status}</Badge>
												)}
											</td>
											<td className="nums w-24 px-4 py-2.5 text-right text-xs text-muted-foreground">
												{live
													? relTime(task.claim!.expiresAt.getTime() - now.getTime())
													: task.claim
														? `${relTime(now.getTime() - task.claim.expiresAt.getTime())} ago`
														: ""}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</Card>
				)}
			</section>

			<section>
				<SectionLabel>Recent activity</SectionLabel>
				{feed.length === 0 ? (
					<Empty title="Nothing has happened yet" hint="Events appear as agents claim work." />
				) : (
					<div className="space-y-1">
						{feed.map((event) => (
							<div className="flex items-baseline gap-3 text-sm" key={event.id}>
								<span className="nums w-14 shrink-0 text-right text-xs text-muted-foreground">
									{relTime(now.getTime() - event.createdAt.getTime())}
								</span>
								<Badge tone={EVENT_TONE[event.type] ?? "neutral"}>{event.type}</Badge>
								<span className="truncate text-muted-foreground">
									{event.agentId ? `${event.agentId} · ` : ""}
									{event.taskTitle ?? "—"}
								</span>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
