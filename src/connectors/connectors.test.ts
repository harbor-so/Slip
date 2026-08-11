/**
 * Connector tests use the real database because idempotency depends on the
 * same partial unique index that protects production from webhook retries.
 */

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "../db/index.js";
import { orgs, tasks } from "../db/schema.js";
import { claim } from "../lib/work.js";
import {
	handleGitHubWebhook,
	verifyGitHubWebhook,
} from "./github.js";
import {
	handleLinearWebhook,
	verifyLinearWebhook,
} from "./linear.js";

let orgId: string;

beforeEach(async () => {
	await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Connector Test Org" }).returning();
	if (!org) throw new Error("Test org was not created.");
	orgId = org.id;
});

afterAll(async () => {
	await sql.end();
});

describe("webhook signatures", () => {
	const body = JSON.stringify({ action: "opened" });
	const secret = "webhook-secret";

	it("verifies GitHub signatures and rejects invalid inputs", () => {
		const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
		expect(verifyGitHubWebhook(body, { "x-hub-signature-256": signature }, secret)).toBe(true);
		expect(verifyGitHubWebhook(`${body} `, { "x-hub-signature-256": signature }, secret)).toBe(false);
		expect(verifyGitHubWebhook(body, { "x-hub-signature-256": signature }, "wrong")).toBe(false);
		expect(verifyGitHubWebhook(body, {}, secret)).toBe(false);
		expect(verifyGitHubWebhook(body, { "x-hub-signature-256": "sha256=nope" }, secret)).toBe(false);
	});

	it("verifies Linear signatures and rejects invalid inputs", () => {
		const signature = createHmac("sha256", secret).update(body).digest("hex");
		expect(verifyLinearWebhook(body, { "linear-signature": signature }, secret)).toBe(true);
		expect(verifyLinearWebhook(`${body} `, { "linear-signature": signature }, secret)).toBe(false);
		expect(verifyLinearWebhook(body, { "linear-signature": signature }, "wrong")).toBe(false);
		expect(verifyLinearWebhook(body, {}, secret)).toBe(false);
		expect(verifyLinearWebhook(body, { "linear-signature": "not-hex" }, secret)).toBe(false);
	});
});

describe("GitHub webhooks", () => {
	const opened = {
		action: "opened",
		issue: { number: 42, title: "Fix retry storm", body: "Bound webhook retries." },
	};

	it("creates one sourced task when an issue is opened", async () => {
		const result = await handleGitHubWebhook(opened, orgId);
		expect(result.action).toBe("created");
		const rows = await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			title: "Fix retry storm",
			source: "github",
			sourceRef: "42",
		});
	});

	it("updates rather than duplicates a redelivered issue", async () => {
		await handleGitHubWebhook(opened, orgId);
		const second = await handleGitHubWebhook(opened, orgId);
		expect(second.action).toBe("updated");
		expect(await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) })).toHaveLength(1);
	});

	it("marks a closed issue completed", async () => {
		await handleGitHubWebhook(opened, orgId);
		await handleGitHubWebhook({ ...opened, action: "closed" }, orgId);
		const [task] = await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) });
		expect(task?.status).toBe("completed");
	});
});

describe("Linear webhooks", () => {
	it("does not change the status of a task that is claimed", async () => {
		const base = {
			type: "Issue",
			action: "create",
			data: {
				id: "linear-uuid",
				identifier: "ACM-482",
				title: "Keep the lease",
				state: { type: "started" },
			},
		};
		const created = await handleLinearWebhook(base, orgId);
		if (!created.taskId) throw new Error("Linear task was not created.");
		await claim(orgId, created.taskId, "codex:connector-test");

		await handleLinearWebhook({
			...base,
			action: "update",
			data: { ...base.data, state: { type: "completed" } },
		}, orgId);
		const task = await db.query.tasks.findFirst({ where: eq(tasks.id, created.taskId) });
		expect(task?.status).toBe("claimed");
	});
});
