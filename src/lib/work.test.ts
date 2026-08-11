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
import {
	claim,
	createTask,
	listWork,
	presentAgents,
	release,
	renewClaim,
	sweepExpiredClaims,
	touchPresence,
} from "./work.js";

let orgId: string;
let taskId: string;

beforeEach(async () => {
	// TRUNCATE CASCADE rather than ordered DELETEs: immune to foreign-key
	// ordering, and it resets cleanly even if a previous test left a connection
	// in a bad state.
	await sql`truncate table runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

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

/**
 * The races that a five-agent review reproduced 39 times out of 40.
 *
 * These are regression tests for lost updates in `release` and `renewClaim`. The
 * shape is always the same: agent A's lease has lapsed but A is still working;
 * agent B claims the task legitimately; A then finishes and reports. Before the
 * `FOR UPDATE` lock, A's write landed anyway — so the task read as completed,
 * A's summary went into the weekly digest as shipped work, and B was left holding
 * a live claim on a task the product had already declared done.
 *
 * The precondition is ordinary, not adversarial: a thirty-minute lease running
 * out on a job that took longer.
 */
describe("lost updates against a concurrent claim", () => {
	async function lapsedClaimHeldBy(agentId: string) {
		await claim(orgId, taskId, agentId, 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(and(eq(claims.taskId, taskId), isNull(claims.releasedAt)));
	}

	it("refuses a release once another agent has taken the lapsed lease", async () => {
		await lapsedClaimHeldBy("agent-a");

		const [, releaseOutcome] = await Promise.allSettled([
			claim(orgId, taskId, "agent-b"),
			release(orgId, taskId, "agent-a", "I finished it, honest."),
		]);

		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });

		// The invariant is order-independent, which matters because both orderings
		// are legitimate: if A releases before B claims, A's release is valid and B
		// simply takes an open task. What must never happen is B holding a live
		// claim while the task reads `completed` from A's summary — that is the
		// state where the digest reports abandoned work as shipped and B is working
		// on something the product has already declared done.
		const corrupted =
			active.length === 1 && active[0]!.agentId === "agent-b" && task!.status === "completed";
		expect(corrupted, "B holds the task but A's release marked it completed").toBe(false);
		expect(active.length).toBeLessThanOrEqual(1);
		if (releaseOutcome.status === "rejected") {
			expect(String(releaseOutcome.reason)).toMatch(/taken by another agent|not currently claimed/);
		}
	});

	it("refuses a renew once another agent has taken the lapsed lease", async () => {
		await lapsedClaimHeldBy("agent-a");

		const [, renewOutcome] = await Promise.allSettled([
			claim(orgId, taskId, "agent-b"),
			renewClaim(orgId, taskId, "agent-a", 480),
		]);

		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		expect(active).toHaveLength(1);
		// A's renew must never extend a lease that now belongs to B. An 8-hour
		// expiry on B's claim is the fingerprint of the lost update.
		if (active[0]!.agentId === "agent-b") {
			expect(
				active[0]!.expiresAt.getTime(),
				"A's renew extended B's lease",
			).toBeLessThan(Date.now() + 60 * 60_000);
		}
		if (renewOutcome.status === "rejected") {
			expect(String(renewOutcome.reason)).toMatch(/taken by another agent|held by|No task matching|no active claim/);
		}
	});

	it("never lets two agents hold one task across 30 interleaved rounds", async () => {
		for (let round = 0; round < 30; round += 1) {
			await sql`truncate table runs, agent_presence, events, claims cascade`;
			await db.update(tasks).set({ status: "open" }).where(eq(tasks.id, taskId));
			await lapsedClaimHeldBy("agent-a");

			await Promise.allSettled([
				claim(orgId, taskId, "agent-b"),
				release(orgId, taskId, "agent-a", "done"),
				renewClaim(orgId, taskId, "agent-a", 60),
			]);

			const active = await db.query.claims.findMany({
				where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
			});
			const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
			expect(active.length, `round ${round}: two live claims`).toBeLessThanOrEqual(1);
			const corrupted =
				active.length === 1 && active[0]!.agentId === "agent-b" && task!.status === "completed";
			expect(corrupted, `round ${round}: B holds a task marked completed by A`).toBe(false);
		}
	});
});

describe("resolveTaskId hardening", () => {
	it("refuses LIKE wildcards and the empty string instead of matching everything", async () => {
		for (const bad of ["", "%", "_", "____", "%%", "zzzz!"]) {
			await expect(claim(orgId, bad, "agent-a"), `input ${JSON.stringify(bad)}`).rejects.toThrow(
				/not a task id|No task matching/,
			);
		}
	});

	it("still accepts a real short id and a full uuid", async () => {
		expect((await claim(orgId, taskId.replace(/-/g, "").slice(0, 4), "agent-a")).ok).toBe(true);
		await release(orgId, taskId, "agent-a");
		expect((await claim(orgId, taskId, "agent-b")).ok).toBe(true);
	});
});

describe("cross-tenant writes", () => {
	it("refuses to renew another org's claim even with its exact task uuid", async () => {
		const [other] = await db.insert(orgs).values({ name: "Victim Org" }).returning();
		const [victimTask] = await db
			.insert(tasks)
			.values({ orgId: other!.id, title: "Rotate production keys", status: "open" })
			.returning();
		await claim(other!.id, victimTask!.id, "victim-agent", 5);

		// The attacker holds a valid key for their own org and the victim's task id.
		await expect(renewClaim(orgId, victimTask!.id, "victim-agent", 480)).rejects.toThrow(
			/No task matching/,
		);

		const held = await db.query.claims.findFirst({
			where: and(eq(claims.taskId, victimTask!.id), isNull(claims.releasedAt)),
		});
		expect(held!.expiresAt.getTime()).toBeLessThan(Date.now() + 30 * 60_000);
	});
});

describe("intent", () => {
	it("records why the work is happening and shows it to the next agent", async () => {
		await claim(orgId, taskId, "agent-a", {
			intent: "Blocking three support tickets; fix before Friday.",
			intentRef: "https://linear.app/acme/issue/ACM-482",
		});

		const [row] = await listWork(orgId);
		expect(row!.claim?.intent).toBe("Blocking three support tickets; fix before Friday.");
		// The reason belongs to the attempt, so it must survive on the claim row
		// even after the work is finished — that is the whole point of putting it
		// there rather than on the task.
		await release(orgId, taskId, "agent-a", "Fixed.");
		const stored = await db.query.claims.findFirst({ where: eq(claims.taskId, taskId) });
		expect(stored!.intent).toContain("support tickets");
		expect(stored!.intentRef).toContain("linear.app");
	});

	it("keeps the numeric lease argument working for existing callers", async () => {
		const result = await claim(orgId, taskId, "agent-a", 5);
		if (!result.ok) throw new Error("expected claim");
		expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 6 * 60_000);
	});
});

describe("presence", () => {
	it("reports an agent as present after any tool call and drops it when stale", async () => {
		await touchPresence(orgId, "claude-code:wt-9", "claim");
		const present = await presentAgents(orgId);
		expect(present.map((a) => a.agentId)).toContain("claude-code:wt-9");

		await sql`update agent_presence set last_seen_at = now() - interval '10 minutes'`;
		expect((await presentAgents(orgId)).map((a) => a.agentId)).not.toContain("claude-code:wt-9");
	});

	it("keeps presence scoped to one org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		await touchPresence(other!.id, "someone-elses-agent", "claim");
		await touchPresence(orgId, "my-agent", "claim");
		expect((await presentAgents(orgId)).map((a) => a.agentId)).toEqual(["my-agent"]);
	});
})
