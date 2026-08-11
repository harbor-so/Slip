/**
 * Five tools. Not six.
 *
 * Every tool an MCP server exposes is a tool the model reads on every single
 * turn, so the tool list itself is a recurring context cost paid forever.
 * Linear's MCP server exposes ~23 of them over a human-shaped object model —
 * issues, cycles, projects, labels, comments, states — and an agent pays for all
 * of that schema before it does anything useful. Slip's entire surface is five
 * tools whose descriptions fit on a screen.
 *
 * The discipline that keeps it at five: when something new is needed, it becomes
 * a parameter on an existing tool, not a new tool. `list_work` has two optional
 * filters and that is the whole filtering surface — deliberately no search, no
 * labels, no saved views. If an agent needs to page through results, the ordering
 * is wrong; fix the ordering rather than add a cursor.
 *
 * Descriptions are written for a model, not a human browsing docs. They say what
 * the tool decides and what to do with the answer, because a description that
 * only names the tool leaves the model to guess when to call it — and a model
 * that guesses calls it every turn.
 */

import { z } from "zod";
import { formatTask, formatTaskList, relTime, shortId } from "../lib/format.js";
import {
	claim,
	createTask,
	listWork,
	release,
	renewClaim,
	SlipError,
	touchPresence,
} from "../lib/work.js";

export interface ToolContext {
	orgId: string;
}

export interface ToolDefinition {
	name: string;
	description: string;
	schema: z.ZodRawShape;
	run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>;
}

export const tools: ToolDefinition[] = [
	{
		name: "list_work",
		description:
			"List tasks and who is currently working on them. Call this BEFORE starting any " +
			"work, so you do not duplicate something another agent has already claimed. " +
			"Returns one short line per task: [id] title — status or holder — project. " +
			"Optional filters: project name, and status (open, claimed, completed). " +
			"This is the only listing tool; there is no search.",
		schema: {
			project: z.string().max(120).optional().describe("Project name, e.g. 'backend'"),
			// A closed enum, not a free string. `in_progress` used to be advertised
			// here and is written by nothing, so an agent that filtered on it got
			// "No tasks match." — which reads as "nobody is working on anything",
			// the exact inversion of the truth, on the tool whose whole job is
			// preventing duplicate work. An enum turns a near-miss into a -32602 the
			// model self-corrects on instead of a silently empty list.
			status: z
				.enum(["open", "claimed", "completed"])
				.optional()
				.describe("Filter by status"),
		},
		run: async (ctx, args) => {
			const rows = await listWork(ctx.orgId, {
				project: args.project as string | undefined,
				status: args.status as string | undefined,
			});
			return formatTaskList(rows);
		},
	},

	{
		name: "claim",
		description:
			"Take ownership of a task before you start working on it. Atomic: if another " +
			"agent already holds it you get told who and when their lease expires, and you " +
			"should pick different work rather than proceed. Claims expire automatically " +
			"(default 30 minutes) so a crashed agent never locks a task forever — call " +
			"renew_claim if the work runs long. Always pass `intent`: one sentence on why " +
			"you are doing this. Other agents see it before they pick adjacent work, and it " +
			"is what the team reads months later when deciding whether a change can be " +
			"reverted.",
		schema: {
			task_id: z.string().max(64).describe("Task id as shown in list_work, e.g. 'a1b2'"),
			agent_id: z
				.string()
				.max(128)
				.describe("Stable identifier for you, e.g. 'claude-code:worktree-3'"),
			lease_minutes: z.number().int().positive().max(480).optional().describe("Default 30, max 480"),
			intent: z
				.string()
				.max(500)
				.optional()
				.describe("One sentence: why this work, and what outcome you are after"),
			intent_ref: z
				.string()
				.max(500)
				.optional()
				.describe("Optional link to a spec, design doc, thread or issue"),
		},
		run: async (ctx, args) => {
			const result = await claim(ctx.orgId, args.task_id as string, args.agent_id as string, {
				leaseMinutes: args.lease_minutes as number | undefined,
				intent: args.intent as string | undefined,
				intentRef: args.intent_ref as string | undefined,
			});
			const remaining = result.expiresAt.getTime() - Date.now();

			if (result.ok) {
				return `ok claimed [${shortId(result.taskId)}] ${result.title} — expires in ${relTime(remaining)}`;
			}
			// A refusal has to be actionable, not just negative. Naming the holder and
			// the expiry is what lets the agent decide between waiting and moving on.
			return [
				`no [${shortId(result.taskId)}] ${result.title}`,
				`held by ${result.heldBy} — expires in ${relTime(remaining)}`,
				"Pick different work with list_work, or retry after the lease expires.",
			].join("\n");
		},
	},

	{
		name: "release",
		description:
			"Give a task back when you are done or when you are stopping. Include " +
			"completion_summary if the work is finished — that marks the task completed and " +
			"feeds the weekly team digest. Omit it if you are abandoning the work, which " +
			"returns the task to open for another agent.",
		schema: {
			task_id: z.string().max(64).describe("Task id, e.g. 'a1b2'"),
			agent_id: z.string().max(128).describe("The same agent_id you claimed with"),
			completion_summary: z
				.string()
				.max(2000)
				.optional()
				.describe("One or two sentences on what you actually changed"),
		},
		run: async (ctx, args) => {
			const result = await release(
				ctx.orgId,
				args.task_id as string,
				args.agent_id as string,
				args.completion_summary as string | undefined,
			);
			return result.completed
				? `ok completed [${shortId(result.taskId)}] ${result.title}`
				: `ok released [${shortId(result.taskId)}] ${result.title} — back to open`;
		},
	},

	{
		name: "create_task",
		description:
			"Add a new task. Use this when you discover work that should be tracked — a bug " +
			"found while doing something else, a follow-up you are not going to do now. The " +
			"project is created if it does not exist. Set scope to where the work lives (a " +
			"path or module) so other agents can see whether it overlaps theirs.",
		schema: {
			title: z.string().min(3).max(200).describe("Short imperative title"),
			description: z.string().max(4000).optional(),
			project: z.string().optional().describe("Created on demand if new"),
			scope: z.string().max(200).optional().describe("e.g. 'src/auth/**' or 'billing service'"),
		},
		run: async (ctx, args) => {
			const created = await createTask(ctx.orgId, {
				title: args.title as string,
				description: args.description as string | undefined,
				project: args.project as string | undefined,
				scope: args.scope as string | undefined,
			});
			return formatTask({
				id: created.id,
				title: created.title,
				status: "open",
				project: created.project ?? null,
				scope: (args.scope as string | undefined) ?? null,
			});
		},
	},

	{
		name: "renew_claim",
		description:
			"Extend your lease on a task you already hold, for work that is taking longer " +
			"than expected. Call this before the lease expires; once it lapses another agent " +
			"may take the task. Only the holder can renew.",
		schema: {
			task_id: z.string().max(64),
			agent_id: z.string().max(128),
			lease_minutes: z.number().int().positive().max(480).optional().describe("Default 30, max 480"),
		},
		run: async (ctx, args) => {
			const result = await renewClaim(
				ctx.orgId,
				args.task_id as string,
				args.agent_id as string,
				args.lease_minutes as number | undefined,
			);
			const remaining = result.expiresAt.getTime() - Date.now();
			return `ok renewed [${shortId(result.taskId)}] — expires in ${relTime(remaining)}`;
		},
	},
];

/**
 * Turn a thrown error into something a model can act on.
 *
 * `SlipError` messages are written for an agent to read and are passed through.
 * Anything else is a bug in Slip, and its message could contain a connection
 * string or a query — so it is logged server-side and the agent gets a flat
 * sentence. An agent cannot fix our internal error either way.
 */
export function toToolError(error: unknown): string {
	if (error instanceof SlipError) return error.message;
	console.error("[slip] unexpected tool error:", error);
	return "Slip hit an internal error. The call was not applied; retry once, then report it.";
}
