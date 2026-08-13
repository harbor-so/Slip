/**
 * The execution glue, against the real database — the wire that turns an isolated
 * box that boots into an isolated box that clones the repositories and runs the
 * agent. The property that matters is that the environment a provider is handed
 * carries the session's *snapshotted* repositories as clone specs and its chosen
 * runtime, with no credential baked into a URL.
 */

process.env.HARBOR_ENCRYPTION_KEY = Buffer.from(
	"0123456789abcdef0123456789abcdef",
).toString("base64");

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "../db/index.js";
import { orgs, repos, secrets, sessionRepos, sessions } from "../db/schema.js";
import { encrypt } from "../lib/crypto.js";
import { buildSandboxEnv } from "./env.js";

let orgId: string;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Env Test Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

async function seedSession(runtime: string | null) {
	const [frontend] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "web", defaultBranch: "main" })
		.returning();
	const [api] = await db
		.insert(repos)
		.values({ orgId, provider: "gitlab", owner: "acme", name: "api", defaultBranch: "trunk" })
		.returning();
	const [session] = await db
		.insert(sessions)
		.values({ orgId, key: `k-${Math.abs(runtime?.length ?? 0)}-${orgId.slice(0, 8)}`, title: "s", createdBy: "u", runtime })
		.returning();
	await db.insert(sessionRepos).values([
		{ orgId, sessionId: session!.id, repoId: frontend!.id, position: 0, baseBranch: "main", workingBranch: "harbor/lse_1" },
		{ orgId, sessionId: session!.id, repoId: api!.id, position: 1, baseBranch: "trunk" },
	]);
	return { session: session!, frontend: frontend!, api: api! };
}

describe("buildSandboxEnv", () => {
	it("emits the snapshotted repos as clone specs, in order, with no token in the URL", async () => {
		const { session } = await seedSession("codex");
		const env = await buildSandboxEnv(session);

		const specs = JSON.parse(env.HARBOR_REPOS!) as { name: string; url: string; branch?: string }[];
		expect(specs).toEqual([
			{ name: "web", url: "https://github.com/acme/web.git", branch: "harbor/lse_1" },
			{ name: "api", url: "https://gitlab.com/acme/api.git", branch: "trunk" },
		]);
		// No credential ever travels in the URL — the in-box helper brokers it.
		expect(env.HARBOR_REPOS).not.toMatch(/@|x-access-token|:.*@/);
		expect(env.HARBOR_AGENT_RUNTIME).toBe("codex");
	});

	it("defaults an absent or unknown runtime to claude-code rather than emitting an invalid one", async () => {
		const { session } = await seedSession(null);
		expect((await buildSandboxEnv(session)).HARBOR_AGENT_RUNTIME).toBe("claude-code");
	});

	it("injects the session's secrets, which HARBOR_REPOS cannot be shadowed by", async () => {
		const { session, frontend } = await seedSession("claude-code");
		await db.insert(secrets).values([
			{ orgId, scope: "repo", scopeId: frontend.id, name: "DATABASE_URL", ciphertext: encrypt("postgres://x") },
			// A secret that tries to impersonate the repo list must not win.
			{ orgId, scope: "repo", scopeId: frontend.id, name: "HARBOR_REPOS", ciphertext: encrypt("[]") },
		]);
		const env = await buildSandboxEnv(session);
		expect(env.DATABASE_URL).toBe("postgres://x");
		expect(JSON.parse(env.HARBOR_REPOS!)).toHaveLength(2); // the real list, not the secret's "[]"
	});
});
