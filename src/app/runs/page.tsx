/**
 * Launched agents.
 *
 * The server component does the privileged reads — the org's runs and whether
 * the runner is even enabled — and hands them to the `web/` client view, which
 * keeps the list live off the org change feed and owns the launch form. The
 * host-spawn runner stays gated exactly as before; this only changes how the
 * surface is rendered, not what it is allowed to do.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { runs } from "../../db/schema.js";
import { runnerEnabled } from "../../lib/runner.js";
import { currentSession } from "../../lib/session.js";
import { Empty } from "../../components/ui.js";
import { RunsView } from "@web/runs/RunsView.js";
import type { RunRow } from "@web/lib/api.js";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
	const session = await currentSession();
	if (!session) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const rows = await db
		.select()
		.from(runs)
		.where(eq(runs.orgId, session.orgId))
		.orderBy(desc(runs.startedAt))
		.limit(20);

	const seed: RunRow[] = rows.map((run) => ({
		id: run.id,
		agentId: run.agentId,
		runtime: run.runtime,
		status: run.status,
		prompt: run.prompt,
		output: run.output,
		pid: run.pid,
		exitCode: run.exitCode,
		taskId: run.taskId,
		startedAt: run.startedAt.toISOString(),
		endedAt: run.endedAt ? run.endedAt.toISOString() : null,
	}));

	return <RunsView seed={seed} enabled={runnerEnabled()} />;
}
