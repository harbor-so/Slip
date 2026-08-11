/**
 * These run against the real Postgres from docker-compose, not a mock.
 *
 * The whole coordination guarantee is a Postgres partial unique index and how
 * the code reacts to the violation it raises. A mocked database would assert
 * that the code does what the code does, and would have passed just as happily
 * with a read-then-write check that races. So: real transactions, real
 * concurrency, real index.
 */

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "../db/index.js";
import { apiKeys, claims, events, orgs, projects, tasks } from "../db/schema.js";
import { claim, createTask, listWork, release, renewClaim, sweepExpiredClaims } from "./work.js";

let orgId: string;
let taskId: string;

beforeEach(async () => {
	// TRUNCATE CASCADE rather than ordered DELETEs: immune to foreign-key
	// ordering, and it resets cleanly even if a previous test left a connection
	// in a bad state.
	await sql`truncate table events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

	const [org] = await db.insert(orgs).values({ name: "Test Org" }).returning();
	orgId = org!.id;
	const [task] = await db
		.insert(tasks)
		.values({ orgId, title: "Fix auth token refresh bug", status: "open" })
		.returning();
	taskId = task!.id;
});

afterAll(async () => {
	await sql.end();
});

describe("claim", () => {
	it("gives exactly one winner when two agents race for the same task", async () => {
		const [first, second] = await Promise.all([
			claim(orgId, taskId, "claude-code:wt-1"),
			claim(orgId, taskId, "codex:wt-2"),
		]);

		const winners = [first, second].filter((r) => r.ok);
		const losers = [first, second].filter((r) => !r.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);

		// The loser is told who holds it and until when — that is what lets it go
		// do something else instead of retrying blindly.
		const loser = losers[0]!;
		if (loser.ok) throw new Error("unreachable");
		expect(loser.heldBy).toBe(winners[0]!.ok ? "claude-code:wt-1" : "codex:wt-2");
		expect(loser.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("writes a claim_conflict event, which is the product's core metric", async () => {
		await claim(orgId, taskId, "agent-a");
		await claim(orgId, taskId, "agent-b");

		const conflicts = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_conflict")),
		});
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.agentId).toBe("agent-b");
		expect(conflicts[0]!.payload).toMatchObject({ heldBy: "agent-a" });
	});

	it("survives ten agents racing at once with exactly one winner", async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) => claim(orgId, taskId, `agent-${i}`)),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);

		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		expect(active).toHaveLength(1);
	});

	it("lets a new agent take over a task whose lease already lapsed", async () => {
		await claim(orgId, taskId, "dead-agent", 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(claims.taskId, taskId));

		// Correctness must not depend on the sweeper having run.
		const result = await claim(orgId, taskId, "fresh-agent");
		expect(result.ok).toBe(true);

		const expiredEvents = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		expect(expiredEvents.length).toBeGreaterThan(0);
	});

	it("accepts the short id an agent was shown", async () => {
		const short = taskId.replace(/-/g, "").slice(0, 4);
		expect((await claim(orgId, short, "agent-a")).ok).toBe(true);
	});
});

describe("release", () => {
	it("marks a task completed when given a summary, open when not", async () => {
		await claim(orgId, taskId, "agent-a");
		await release(orgId, taskId, "agent-a", "Serialised refresh behind a mutex.");
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe(
			"completed",
		);

		await claim(orgId, taskId, "agent-b");
		await release(orgId, taskId, "agent-b");
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe(
			"open",
		);
	});

	it("refuses to release a claim held by someone else", async () => {
		await claim(orgId, taskId, "agent-a");
		await expect(release(orgId, taskId, "agent-b")).rejects.toThrow(/held by agent-a/);
	});
});

describe("renewClaim", () => {
	it("extends the lease for the holder and refuses everyone else", async () => {
		const first = await claim(orgId, taskId, "agent-a", 5);
		if (!first.ok) throw new Error("expected claim");

		const renewed = await renewClaim(orgId, taskId, "agent-a", 60);
		expect(renewed.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
		await expect(renewClaim(orgId, taskId, "agent-b")).rejects.toThrow(/held by agent-a/);
	});
});

describe("sweepExpiredClaims", () => {
	it("returns a lapsed task to open and logs it", async () => {
		await claim(orgId, taskId, "dead-agent", 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(claims.taskId, taskId));

		expect(await sweepExpiredClaims()).toBe(1);
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe(
			"open",
		);
		const swept = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		expect(swept).toHaveLength(1);
	});

	it("leaves a live claim alone", async () => {
		await claim(orgId, taskId, "agent-a", 30);
		expect(await sweepExpiredClaims()).toBe(0);
	});
});

describe("listWork and createTask", () => {
	it("creates a project on demand rather than needing a sixth tool to ask", async () => {
		const created = await createTask(orgId, { title: "New work", project: "platform" });
		expect(created.project).toBe("platform");

		const again = await createTask(orgId, { title: "More work", project: "PLATFORM" });
		expect(again.project).toBe("platform");
		const rows = await db.query.projects.findMany({ where: eq(projects.orgId, orgId) });
		expect(rows).toHaveLength(1);
	});

	it("reports the live claim alongside each task", async () => {
		await claim(orgId, taskId, "claude-code:wt-2", 22);
		const [row] = await listWork(orgId);
		expect(row!.claim?.agentId).toBe("claude-code:wt-2");
	});

	it("filters by project and status", async () => {
		await createTask(orgId, { title: "Backend thing", project: "backend" });
		expect(await listWork(orgId, { project: "backend" })).toHaveLength(1);
		expect(await listWork(orgId, { status: "open" })).toHaveLength(2);
	});
});
