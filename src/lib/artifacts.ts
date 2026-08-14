/**
 * Artifact state that only an external system knows.
 *
 * Harbor opens a pull request and then stops being the authority on it. Whether
 * it merged, and when, is a fact that lives on the source-control host and
 * arrives here through a verified webhook — which is why this is a separate,
 * narrow entry point rather than a general artifact updater. The headline metric
 * is *sessions that resulted in a merged pull request*, and a number that can be
 * moved by anything other than a signed webhook is not measuring that.
 *
 * In particular, an agent cannot reach this. `record_artifact`'s `kind` enum
 * excludes `pull_request` for the same reason: an agent reporting that its own
 * work merged produces a metric that measures the agent's optimism.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { artifacts } from "../db/schema.js";
import { appendEvents } from "./session-events.js";

/**
 * Stamp a pull-request artifact as merged, matched on its URL.
 *
 * The URL is the join key because it is the only identifier both sides already
 * agree on: Harbor stored `html_url` when it opened the PR, and every webhook
 * about that PR carries the same string. A number-plus-repo composite would be
 * more normalised and would require a schema change plus a backfill to become
 * usable, and `artifacts_org_url_idx` already indexes exactly this lookup.
 *
 * Scoped by org even though a GitHub URL is globally unique, because the org is
 * established by webhook verification and every read in this codebase is scoped
 * to the tenant that proved it. A lookup that did not would let a webhook from a
 * repository one org connected mutate a row belonging to another.
 *
 * Idempotent by predicate, not by check-then-write: `merged_at IS NULL` is part
 * of the UPDATE, so a redelivered webhook — which GitHub does routinely — matches
 * zero rows rather than overwriting the original merge time with the retry's.
 * The first merge is the true one; a later one would silently move the row out of
 * whatever reporting window somebody was looking at.
 *
 * Returns how many rows it stamped, so a caller can tell "merged a PR Harbor
 * opened" from "merged a PR nobody here knows about" — the second is the common
 * case on a repository where humans also work, and it is not an error.
 */
/**
 * Record the pull request Harbor just opened.
 *
 * The counterpart to `markPullRequestMerged` below, and the row it will later
 * stamp. Until this existed nothing anywhere inserted a `pull_request` artifact,
 * so the merge webhook matched zero rows and the headline metric — sessions that
 * resulted in a merged pull request — read `0` however many pull requests the
 * fleet actually landed. The writer and the metric were both real; the row they
 * described was not.
 *
 * **`url` must be the canonical `html_url` GitHub returned.** It is the join key
 * `markPullRequestMerged` matches on, and the webhook will send exactly that
 * string; a normalised, lowercased or trailing-slashed variant stored here is a
 * pull request that merges and never counts.
 *
 * Actor is `harbor`, not `agent`: the control plane opened this, using the
 * prompting human's credentials. An agent cannot reach this path at all —
 * `record_artifact`'s `kind` enum excludes `pull_request` for the reason given
 * at the top of this file.
 *
 * Idempotent on `(org, url)`: the ingest path that calls this can be retried by
 * a bridge whose 200 was lost, and a second row would double-count the session
 * in the metric.
 */
export async function recordPullRequestArtifact(input: {
	orgId: string;
	sessionId: string;
	repoId: string | null;
	title: string;
	url: string;
	number: number;
	claimId: string | null;
	head: string;
	base: string;
	authorLogin: string;
}): Promise<{ artifactId: string; created: boolean }> {
	const existing = await db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(
			and(
				eq(artifacts.orgId, input.orgId),
				eq(artifacts.url, input.url),
				eq(artifacts.kind, "pull_request"),
			),
		)
		.limit(1);
	if (existing[0]) return { artifactId: existing[0].id, created: false };

	const [row] = await db
		.insert(artifacts)
		.values({
			orgId: input.orgId,
			sessionId: input.sessionId,
			repoId: input.repoId,
			kind: "pull_request",
			title: input.title,
			url: input.url,
			payload: {
				number: input.number,
				claim_id: input.claimId,
				head: input.head,
				base: input.base,
				author_login: input.authorLogin,
			},
		})
		.returning({ id: artifacts.id });

	await appendEvents({
		orgId: input.orgId,
		sessionId: input.sessionId,
		events: [
			{
				type: "artifact_created",
				actor: "harbor",
				payload: {
					kind: "pull_request",
					title: input.title,
					url: input.url,
					number: input.number,
					author_login: input.authorLogin,
				},
			},
		],
	});

	return { artifactId: row!.id, created: true };
}

export async function markPullRequestMerged(input: {
	orgId: string;
	url: string;
	mergedAt: Date;
}): Promise<number> {
	const stamped = await db
		.update(artifacts)
		.set({ mergedAt: input.mergedAt })
		.where(
			and(
				eq(artifacts.orgId, input.orgId),
				eq(artifacts.url, input.url),
				eq(artifacts.kind, "pull_request"),
				isNull(artifacts.mergedAt),
			),
		)
		.returning({ id: artifacts.id });

	return stamped.length;
}
