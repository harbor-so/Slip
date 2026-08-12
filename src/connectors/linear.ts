/**
 * Linear contributes issue metadata to Harbor and receives only completion
 * comments. Full two-way state sync is intentionally excluded: competing state
 * machines would make webhook ordering determine which system wins.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { createTask } from "../lib/work.js";
import type { Connector, WebhookResult } from "./types.js";

interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	state?: { type?: string };
}

interface LinearPayload {
	action: "create" | "update";
	type: "Issue";
	data: LinearIssue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePayload(payload: unknown): LinearPayload | null {
	if (!isRecord(payload) || payload.type !== "Issue") return null;
	if (payload.action !== "create" && payload.action !== "update") return null;
	if (!isRecord(payload.data)) return null;
	const data = payload.data;
	if (
		typeof data.id !== "string" ||
		typeof data.identifier !== "string" ||
		typeof data.title !== "string"
	) return null;
	const state = isRecord(data.state) && typeof data.state.type === "string"
		? { type: data.state.type }
		: undefined;
	return {
		action: payload.action,
		type: "Issue",
		data: {
			id: data.id,
			identifier: data.identifier,
			title: data.title,
			description:
				typeof data.description === "string" || data.description === null
					? data.description
					: undefined,
			state,
		},
	};
}

export function verifyLinearWebhook(
	rawBody: string,
	headers: Record<string, string | undefined>,
	secret: string,
): boolean {
	const supplied = headers["linear-signature"];
	if (!supplied || !/^[0-9a-f]{64}$/i.test(supplied)) return false;
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	const actual = Buffer.from(supplied, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function handleLinearWebhook(
	payload: unknown,
	orgId: string,
): Promise<WebhookResult> {
	const parsed = parsePayload(payload);
	if (!parsed) return { action: "ignored", reason: "Only Linear Issue create and update events are synced." };
	const issue = parsed.data;
	const existing = await db.query.tasks.findFirst({
		where: and(
			eq(tasks.orgId, orgId),
			eq(tasks.source, "linear"),
			eq(tasks.sourceRef, issue.identifier),
		),
	});
	const completed = issue.state?.type === "completed" || issue.state?.type === "canceled";
	if (!existing) {
		const created = await createTask(orgId, {
			title: issue.title,
			description: issue.description ?? undefined,
			source: "linear",
			sourceRef: issue.identifier,
		});
		if (completed) {
			await db.update(tasks).set({ status: "completed", updatedAt: new Date() }).where(eq(tasks.id, created.id));
		}
		return { action: "created", taskId: created.id };
	}

	// A live lease outranks upstream state: changing `claimed` here could make
	// another agent take work that is still actively held.
	await db
		.update(tasks)
		.set({
			title: issue.title,
			description: issue.description ?? null,
			status: existing.status === "claimed" ? "claimed" : completed ? "completed" : "open",
			updatedAt: new Date(),
		})
		.where(eq(tasks.id, existing.id));
	return { action: "updated", taskId: existing.id };
}

export async function syncLinearOutbound(
	taskId: string,
	orgId: string,
	summary: string,
): Promise<void> {
	const task = await db.query.tasks.findFirst({
		where: and(eq(tasks.id, taskId), eq(tasks.orgId, orgId), eq(tasks.source, "linear")),
	});
	if (!task?.sourceRef) throw new Error("Linear task not found for outbound comment.");
	const apiKey = process.env.LINEAR_API_KEY;
	if (!apiKey) throw new Error("LINEAR_API_KEY is required for outbound comments.");

	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: { Authorization: apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			query: "mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
			variables: { issueId: task.sourceRef, body: summary },
		}),
	});
	if (!response.ok) throw new Error(`Linear comment failed with HTTP ${response.status}.`);
	const result: unknown = await response.json();
	if (!isRecord(result) || "errors" in result) throw new Error("Linear rejected the completion comment.");
}

export const linearConnector: Connector = {
	type: "linear",
	verifyWebhook: verifyLinearWebhook,
	handleWebhook: handleLinearWebhook,
	syncOutbound: syncLinearOutbound,
};
