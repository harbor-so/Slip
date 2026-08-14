/**
 * The environment a session hands its sandbox, and the wire that was missing.
 *
 * The runtime half of Harbor — the in-box supervisor — was always complete: given
 * `HARBOR_REPOS` (a JSON array of clone specs) and `HARBOR_AGENT_RUNTIME` it clones
 * the repositories side by side, resolves the agent adapter, and runs turns. What
 * the control plane never did was *fill those in*, so an isolated box booted with
 * nothing to clone and no adapter to pick — which is why the docker and Fly paths
 * could start a container but not do Inspect's work, and only the `local` runner
 * (which operates on a directory the operator already checked out) ran end to end.
 *
 * This builds that environment from the session's snapshotted repositories, its
 * chosen runtime and its resolved secrets, and `ensureSandbox` injects it into
 * every provider — so `docker`, `fly` and any future backend all inherit the full
 * clone → agent loop from one place rather than each reimplementing it.
 *
 * Two properties are load-bearing:
 *
 *  - **Secrets go in first, the Harbor control variables last** (the merge order in
 *    `ensureSandbox`), so a repository secret named `HARBOR_CONTROL_URL` cannot
 *    redirect a box at an attacker's control plane. This module keeps `HARBOR_REPOS`
 *    and `HARBOR_AGENT_RUNTIME` after the secrets for the same reason: a secret must
 *    not be able to rewrite which repositories the agent clones.
 *  - **The clone URL is host + owner + name only.** No token is ever baked into it;
 *    authentication is the in-box git credential helper fetching a short-lived
 *    brokered credential per operation, so a leaked `HARBOR_REPOS` is a list of
 *    public-looking URLs, not a set of credentials.
 */

import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { repos, sessionRepos, type sessions } from "../db/schema.js";
import { AGENT_RUNTIMES } from "../contracts/agent.js";
import { resolveSecrets } from "../lib/secrets.js";

interface RepoSpec {
	/** Directory under the workspace root and the git remote's short name. */
	name: string;
	url: string;
	/** Branch or SHA to check out; absent means the remote's default. */
	branch?: string;
}

/** The default when a session names no runtime — the one every deployment ships. */
const DEFAULT_RUNTIME = "claude-code";

/**
 * The git host for a provider. GitHub and GitLab both allow a self-managed host,
 * so both are overridable; the public host is the default nobody has to configure.
 */
function gitHost(provider: string): string {
	if (provider === "gitlab") return process.env.HARBOR_GITLAB_HOST?.trim() || "gitlab.com";
	return process.env.HARBOR_GITHUB_HOST?.trim() || "github.com";
}

function runtimeFor(value: string | null | undefined): string {
	return value && (AGENT_RUNTIMES as readonly string[]).includes(value) ? value : DEFAULT_RUNTIME;
}

/**
 * Build the injected environment for a session's sandbox.
 *
 * Reads the *snapshot* in `session_repos`, not the environment's current repos, so
 * editing an environment never changes what an in-flight session clones. Returns a
 * plain map the provider injects verbatim; the caller must never log it or put it
 * in an event — it carries decrypted secrets.
 */
export async function buildSandboxEnv(
	session: typeof sessions.$inferSelect,
): Promise<Record<string, string>> {
	const rows = await db
		.select({
			name: repos.name,
			owner: repos.owner,
			provider: repos.provider,
			defaultBranch: repos.defaultBranch,
			repoId: sessionRepos.repoId,
			baseBranch: sessionRepos.baseBranch,
			workingBranch: sessionRepos.workingBranch,
		})
		.from(sessionRepos)
		.innerJoin(repos, eq(sessionRepos.repoId, repos.id))
		.where(eq(sessionRepos.sessionId, session.id))
		.orderBy(asc(sessionRepos.position));

	const specs: RepoSpec[] = rows.map((row) => ({
		name: row.name,
		url: `https://${gitHost(row.provider)}/${row.owner}/${row.name}.git`,
		branch: row.workingBranch ?? row.baseBranch ?? row.defaultBranch,
	}));

	const secrets = await resolveSecrets({
		orgId: session.orgId,
		repoIds: rows.map((row) => row.repoId),
		environmentId: session.environmentId,
	});

	return {
		// Secrets first, so the two variables below cannot be shadowed by one.
		...secrets,
		HARBOR_REPOS: JSON.stringify(specs),
		HARBOR_AGENT_RUNTIME: runtimeFor(session.runtime),
	};
}
