/**
 * The tracking loop, end to end, against real Postgres.
 *
 * The headline metric is *sessions that resulted in a merged pull request*, and
 * before this loop existed it read zero however many pull requests the fleet
 * actually landed: `markPullRequestMerged` was real, the webhook was real, and
 * the row they described was never inserted by anything. So the assertion that
 * matters most here is the last one — a merge webhook stamps a row this code
 * wrote — because that is the join the whole metric hangs on, and it is joined
 * on a URL string that has to match exactly.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "../db/index.js";
import { artifacts, claims, orgs, repos, sessionPrompts, sessionRepos, sessions, tasks, users } from "../db/schema.js";
import { markPullRequestMerged, recordPullRequestArtifact } from "./artifacts.js";
import { pullRequestTitle, resolvePromptAuthor } from "./pull-requests.js";

let orgId: string;
let sessionId: string;
let repoId: string;

beforeEach(async () => {
	await sql`truncate table artifacts, session_prompts, session_repos, session_events, sessions, claims, tasks, repos, users, orgs cascade`;

	const [org] = await db.insert(orgs).values({ name: "Test Org" }).returning();
	orgId = org!.id;

	const [session] = await db
		.insert(sessions)
		.values({ orgId, key: "abc123", title: "Fix the rounding", createdBy: "human/priya" })
		.returning();
	sessionId = session!.id;

	const [repo] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "api", defaultBranch: "main" })
		.returning();
	repoId = repo!.id;

	await db.insert(sessionRepos).values({ orgId, sessionId, repoId, baseBranch: "main" });
});

afterAll(async () => {
	await sql.end();
});

describe("resolvePromptAuthor", () => {
	it("matches on email, case-insensitively, within the org", async () => {
		const [user] = await db
			.insert(users)
			.values({ orgId, email: "priya@acme.com", name: "Priya" })
			.returning();

		const found = await resolvePromptAuthor(orgId, { handle: null, email: "Priya@Acme.com" });
		expect(found?.id).toBe(user!.id);
	});

	it("falls back to the handle when no email is on file", async () => {
		const [user] = await db
			.insert(users)
			.values({ orgId, githubId: "priya-dev", name: "Priya" })
			.returning();

		expect((await resolvePromptAuthor(orgId, { handle: "priya-dev", email: null }))?.id).toBe(
			user!.id,
		);
	});

	it("never reaches into another org", async () => {
		// Opening a pull request as the wrong human would hand the self-approval
		// guarantee to somebody who never asked for the work, so a match must be
		// exact AND tenant-scoped.
		const [other] = await db.insert(orgs).values({ name: "Other Org" }).returning();
		await db.insert(users).values({ orgId: other!.id, email: "priya@acme.com", name: "Priya" });

		expect(await resolvePromptAuthor(orgId, { handle: null, email: "priya@acme.com" })).toBeNull();
	});

	it("returns null rather than guessing when nothing matches", async () => {
		await db.insert(users).values({ orgId, email: "someone@acme.com", name: "Someone" });
		expect(await resolvePromptAuthor(orgId, { handle: "ghost", email: "ghost@acme.com" })).toBeNull();
		expect(await resolvePromptAuthor(orgId, { handle: null, email: null })).toBeNull();
	});
});

describe("pullRequestTitle", () => {
	it("uses the lease's intent, first line only", () => {
		expect(pullRequestTitle("Fix the VAT rounding\nmore detail here", "Session")).toBe(
			"Fix the VAT rounding",
		);
	});

	it("falls back to the session title for leaseless work", () => {
		expect(pullRequestTitle(null, "Scheduled dependency bump")).toBe("Scheduled dependency bump");
		expect(pullRequestTitle("   ", "Scheduled dependency bump")).toBe("Scheduled dependency bump");
	});

	it("truncates an intent written as a paragraph", () => {
		const long = "x".repeat(500);
		const title = pullRequestTitle(long, "Session");
		expect(title.length).toBeLessThanOrEqual(120);
		expect(title.endsWith("…")).toBe(true);
	});
});

describe("recordPullRequestArtifact", () => {
	it("writes the row the merge webhook will later stamp", async () => {
		const [task] = await db.insert(tasks).values({ orgId, title: "Rounding", status: "claimed" }).returning();
		const [lease] = await db
			.insert(claims)
			.values({
				orgId,
				scope: `harbor:${task!.id}`,
				taskId: task!.id,
				agentId: "agent/one",
				intent: "Fix the VAT rounding in invoice totals.",
				expiresAt: new Date(Date.now() + 3_600_000),
			})
			.returning();

		const result = await recordPullRequestArtifact({
			orgId,
			sessionId,
			repoId,
			title: "Fix the VAT rounding",
			url: "https://github.com/acme/api/pull/482",
			number: 482,
			claimId: lease!.id,
			head: "harbor/lse_" + lease!.id,
			base: "main",
			authorLogin: "priya-dev",
		});
		expect(result.created).toBe(true);

		const [row] = await db.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
		expect(row?.kind).toBe("pull_request");
		expect(row?.url).toBe("https://github.com/acme/api/pull/482");
		// Null until a verified webhook says otherwise — never set by us.
		expect(row?.mergedAt).toBeNull();
	});

	it("is idempotent, so a retried ingest does not double-count the session", async () => {
		const input = {
			orgId,
			sessionId,
			repoId,
			title: "Fix the VAT rounding",
			url: "https://github.com/acme/api/pull/482",
			number: 482,
			claimId: null,
			head: "harbor/lse_abc",
			base: "main",
			authorLogin: "priya-dev",
		};
		const first = await recordPullRequestArtifact(input);
		const second = await recordPullRequestArtifact(input);

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.artifactId).toBe(first.artifactId);

		const rows = await db
			.select()
			.from(artifacts)
			.where(and(eq(artifacts.orgId, orgId), eq(artifacts.kind, "pull_request")));
		expect(rows).toHaveLength(1);
	});
});

describe("the metric, end to end", () => {
	it("a recorded pull request is stamped by the merge webhook and counts", async () => {
		const url = "https://github.com/acme/api/pull/482";
		await recordPullRequestArtifact({
			orgId,
			sessionId,
			repoId,
			title: "Fix the VAT rounding",
			url,
			number: 482,
			claimId: null,
			head: "harbor/lse_abc",
			base: "main",
			authorLogin: "priya-dev",
		});

		// What the GitHub connector calls when `action: closed, merged: true`.
		const mergedAt = new Date();
		expect(await markPullRequestMerged({ orgId, url, mergedAt })).toBe(1);

		// This is the /usage query: merged_at is not null.
		const merged = await db
			.select()
			.from(artifacts)
			.where(and(eq(artifacts.orgId, orgId), eq(artifacts.kind, "pull_request")));
		expect(merged[0]?.mergedAt).not.toBeNull();

		// Redelivery — which GitHub does routinely — must not move the timestamp.
		expect(await markPullRequestMerged({ orgId, url, mergedAt: new Date(Date.now() + 60_000) })).toBe(0);
	});

	it("a merge for a pull request Harbor never opened stamps nothing", async () => {
		// Humans work in these repositories too; their merges are not an error and
		// must not be counted as agent work.
		expect(
			await markPullRequestMerged({
				orgId,
				url: "https://github.com/acme/api/pull/999",
				mergedAt: new Date(),
			}),
		).toBe(0);
	});
});
