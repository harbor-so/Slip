/**
 * The step between "the agent pushed a branch" and "there is a pull request to
 * review" — the one advertised part of the product that was written, tested,
 * and never wired to anything.
 *
 * `openPullRequest` in `src/git/provider.ts` has been the policy for a while:
 * it decides the head branch from the claim, writes the body from the claim's
 * stated intent, and refuses to open anything with the app's token. What did not
 * exist was a caller — something that knew a push had happened, could work out
 * which repository, which lease and which human it belonged to, and could turn
 * the outcome into a row. Without it `artifacts` never gained a `pull_request`
 * row, so the merge webhook matched nothing and the headline metric read zero.
 *
 * ## The author is resolved, never assumed
 *
 * A pull request is opened with the prompting human's own credentials, because
 * an author cannot approve their own pull request and that is the mechanism
 * making unreviewed agent code structurally impossible (ADR 0004). That needs a
 * `users.id`, and what a session actually carries is a prompt author string and
 * maybe an email — so the mapping has to be made, and made narrowly. It is
 * scoped by org and matched on email, then on the handle. A near-match is not a
 * match: resolving the wrong user would open the pull request as the wrong human
 * and hand the self-approval guarantee to somebody who never asked for the work.
 *
 * When no user resolves, this does NOT fall back to the app's token. It reports
 * `no_user` and `openPullRequest` degrades loudly with a compare URL — the
 * branch is pushed and a human can finish the job, which is the honest outcome.
 */

import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
	claims,
	repos,
	sessionPrompts,
	sessionRepos,
	sessions,
	users,
} from "../db/schema.js";
import { attributedIdentity, GitIdentityError } from "../contracts/agent.js";
import { prAuthorityForUser } from "../git/credentials.js";
import { createScmProvider } from "../git/github.js";
import {
	commitIdentity,
	harborBotIdentity,
	openPullRequest,
	type PrAuthority,
	type PullRequestOutcome,
} from "../git/provider.js";
import { recordPullRequestArtifact } from "./artifacts.js";
import { appendEvents } from "./session-events.js";
import { setting } from "../config.js";

/**
 * Map a prompt author onto a Harbor user, within one org.
 *
 * Email first because it is the identifier a human actually shares with their
 * source-control account; the display handle second, for deployments where the
 * connector never supplies an address. Both comparisons are exact and both are
 * org-scoped — this decides whose credentials open a pull request, so a fuzzy
 * match here is an attribution bug with a security shape.
 *
 * Returns null rather than throwing: no resolvable user is an ordinary state
 * (a Slack-originated session from somebody who never signed in), and the
 * caller degrades on it rather than failing the push.
 */
export async function resolvePromptAuthor(
	orgId: string,
	author: { handle: string | null; email: string | null },
): Promise<{ id: string; name: string | null; email: string | null } | null> {
	const email = author.email?.trim().toLowerCase();
	const handle = author.handle?.trim();

	const predicates = [];
	if (email) predicates.push(eq(users.email, email));
	if (handle) predicates.push(eq(users.githubId, handle), eq(users.name, handle));
	if (predicates.length === 0) return null;

	const [row] = await db
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(and(eq(users.orgId, orgId), or(...predicates)))
		.limit(1);
	return row ?? null;
}

/** Everything the orchestrator needs, assembled from one push report. */
interface PushContext {
	orgId: string;
	sessionId: string;
	sessionKey: string;
	sessionTitle: string;
	repoId: string;
	owner: string;
	name: string;
	/** The repository's own provider, never the deployment default. */
	provider: string;
	baseBranch: string;
	claimId: string | null;
	claimIntent: string | null;
	claimIntentRef: string | null;
	authorHandle: string | null;
	authorEmail: string | null;
}

/**
 * Session → repository → active lease → prompting human, in one read each.
 *
 * The active lease is the one the branch name encodes, and it supplies the
 * intent the pull-request body quotes verbatim. A session with no lease is
 * legal — the work still happened — so the claim is nullable throughout and the
 * body simply carries less.
 */
async function loadPushContext(
	sessionId: string,
	repoId: string,
): Promise<PushContext | null> {
	const [session] = await db
		.select({
			id: sessions.id,
			orgId: sessions.orgId,
			key: sessions.key,
			title: sessions.title,
			taskId: sessions.taskId,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!session) return null;

	const [repo] = await db
		.select({
			repoId: repos.id,
			owner: repos.owner,
			name: repos.name,
			provider: repos.provider,
			defaultBranch: repos.defaultBranch,
			baseBranch: sessionRepos.baseBranch,
		})
		.from(sessionRepos)
		.innerJoin(repos, eq(sessionRepos.repoId, repos.id))
		.where(and(eq(sessionRepos.sessionId, sessionId), eq(sessionRepos.repoId, repoId)))
		.limit(1);
	if (!repo) return null;

	// The lease the work was done under, if it is still held. Same query shape as
	// the cost path's `activeClaimForSession`.
	let claim: { id: string; intent: string | null; intentRef: string | null } | null = null;
	if (session.taskId) {
		const [row] = await db
			.select({ id: claims.id, intent: claims.intent, intentRef: claims.intentRef })
			.from(claims)
			.where(and(eq(claims.taskId, session.taskId), isNull(claims.releasedAt)))
			.limit(1);
		claim = row ? { id: row.id, intent: row.intent, intentRef: row.intentRef } : null;
	}

	// The human whose request produced this branch: the most recent human-authored
	// prompt in the room. Agent-authored prompts are excluded deliberately — an
	// automation's prompt has no human credentials behind it, and attributing the
	// pull request to the automation's handle would be the guess this file refuses.
	const [prompt] = await db
		.select({ author: sessionPrompts.author, authorEmail: sessionPrompts.authorEmail })
		.from(sessionPrompts)
		.where(and(eq(sessionPrompts.sessionId, sessionId), eq(sessionPrompts.authorKind, "human")))
		.orderBy(desc(sessionPrompts.seq))
		.limit(1);

	return {
		orgId: session.orgId,
		sessionId: session.id,
		sessionKey: session.key,
		sessionTitle: session.title,
		repoId: repo.repoId,
		owner: repo.owner,
		name: repo.name,
		provider: repo.provider,
		baseBranch: repo.baseBranch || repo.defaultBranch,
		claimId: claim?.id ?? null,
		claimIntent: claim?.intent ?? null,
		claimIntentRef: claim?.intentRef ?? null,
		authorHandle: prompt?.author ?? null,
		authorEmail: prompt?.authorEmail ?? null,
	};
}

/**
 * The pull request title.
 *
 * The lease's intent, first line, because the claimant already had to write one
 * sentence saying why this work is happening and that is exactly what a title
 * is. The session title is the fallback for leaseless work. No model is asked to
 * summarise anything: a generated title that disagrees with the body's verbatim
 * intent is worse than a plain one.
 */
export function pullRequestTitle(intent: string | null, sessionTitle: string): string {
	const line = intent?.split("\n")[0]?.trim();
	const chosen = line && line.length > 0 ? line : sessionTitle;
	const max = setting("maxPullRequestTitleChars");
	return chosen.length <= max ? chosen : `${chosen.slice(0, max - 1).trimEnd()}…`;
}

export type OpenForPushResult =
	| { kind: "opened"; url: string; number: number; artifactId: string }
	| { kind: "already_recorded"; url: string }
	| { kind: "skipped"; reason: string }
	| { kind: "not_opened"; outcome: PullRequestOutcome };

/**
 * A branch was pushed. Open the pull request for it, and record what happened.
 *
 * Every non-success path still writes something to the timeline, because the
 * failure mode this replaces — a branch pushed and nothing said — is the one
 * where a user waits for a pull request that was never coming.
 */
export async function openPullRequestForPush(input: {
	sessionId: string;
	repoId: string;
	branch: string;
	baseBranch?: string | null;
}): Promise<OpenForPushResult> {
	const context = await loadPushContext(input.sessionId, input.repoId);
	if (!context) return { kind: "skipped", reason: "session_or_repo_not_found" };

	const selection = createScmProvider();
	if (!selection.ok) return { kind: "skipped", reason: selection.reason };

	// A deployment has one source-control provider (ADR 0006), and the row carries
	// one too. They should agree; if they do not, this repository is not the one
	// this provider can open a pull request against, and opening it anyway would
	// aim at the wrong host with the wrong API. Refused rather than reconciled —
	// the mismatch is a configuration error and silently picking a side would hide
	// it behind a 404 nobody can explain.
	if (context.provider !== selection.provider.id) {
		console.warn(
			`[harbor:pr] ${context.owner}/${context.name} is a "${context.provider}" repository but `
				+ `this deployment's provider is "${selection.provider.id}". No pull request opened.`,
		);
		return { kind: "skipped", reason: "provider_mismatch" };
	}

	// Who is this being opened as? Resolved, or degraded — never the app's token.
	const author = await resolvePromptAuthor(context.orgId, {
		handle: context.authorHandle,
		email: context.authorEmail,
	});
	const authority: PrAuthority = author
		? await prAuthorityForUser(author.id)
		: {
				kind: "absent",
				reason: "no_scm_identity",
				detail:
					"No Harbor user matched the prompting author, so there are no user credentials "
					+ "to open this pull request with.",
			};

	// The commit identity in the body is descriptive, not authoritative — the
	// commits are already made. `agent-only` when the author has no name/email
	// on file, which is the same explicit choice the bridge makes.
	let identity;
	try {
		identity = attributedIdentity(author?.name, author?.email);
	} catch (error) {
		if (!(error instanceof GitIdentityError)) throw error;
		identity = { mode: "agent-only" as const };
	}

	const outcome = await openPullRequest(selection.provider, authority, {
		repo: {
			provider: selection.provider.id,
			owner: context.owner,
			name: context.name,
		},
		base: input.baseBranch || context.baseBranch,
		title: pullRequestTitle(context.claimIntent, context.sessionTitle),
		claim: {
			id: context.claimId ?? "",
			intent: context.claimIntent,
			intent_ref: context.claimIntentRef,
		},
		session: { key: context.sessionKey, url: sessionUrl(context.sessionKey) },
		agent_id: null,
		requested_by: context.authorHandle ?? "an unidentified requester",
		commit_identity: commitIdentity(identity, harborBotIdentity()),
		head: input.branch,
	});

	switch (outcome.kind) {
		case "created":
		case "adopted": {
			const recorded = await recordPullRequestArtifact({
				orgId: context.orgId,
				sessionId: context.sessionId,
				repoId: context.repoId,
				title: pullRequestTitle(context.claimIntent, context.sessionTitle),
				url: outcome.url,
				number: outcome.number,
				claimId: context.claimId,
				head: input.branch,
				base: input.baseBranch || context.baseBranch,
				authorLogin: outcome.author_login,
			});
			if (!recorded.created) return { kind: "already_recorded", url: outcome.url };
			return {
				kind: "opened",
				url: outcome.url,
				number: outcome.number,
				artifactId: recorded.artifactId,
			};
		}

		// The branch exists and no pull request does. Say so on the timeline, with
		// the compare URL, so the person waiting can finish it by hand.
		//
		// `degraded` is `policy_denied` and `deferred` is `session_error`, and the
		// split is the same one `openPullRequest` refuses to collapse: the first is
		// Harbor declining to open a bot-authored pull request because doing so
		// would void the self-approval guarantee — a policy working — and the
		// second is a source-control host that did not answer, which is Harbor
		// unable to finish. Recording both as the same thing is how a ten-second
		// outage becomes indistinguishable from a permanent misconfiguration.
		case "degraded": {
			await appendEvents({
				orgId: context.orgId,
				sessionId: context.sessionId,
				events: [
					{
						type: "policy_denied",
						actor: "harbor",
						payload: {
							code: "pull_request_degraded",
							reason: outcome.reason,
							message: outcome.warning,
							compare_url: outcome.compare_url,
							branch: input.branch,
						},
					},
				],
			});
			return { kind: "not_opened", outcome };
		}

		case "deferred": {
			await appendEvents({
				orgId: context.orgId,
				sessionId: context.sessionId,
				events: [
					{
						type: "session_error",
						actor: "harbor",
						payload: {
							code: "pull_request_deferred",
							reason: outcome.reason,
							message: outcome.message,
							compare_url: outcome.compare_url,
							branch: input.branch,
						},
					},
				],
			});
			return { kind: "not_opened", outcome };
		}

		// The pull request exists but belongs to somebody else. It is NOT recorded
		// as a Harbor artifact: the metric counts work whose review guarantee held,
		// and this one's did not.
		case "attribution_mismatch": {
			await appendEvents({
				orgId: context.orgId,
				sessionId: context.sessionId,
				events: [
					{
						type: "policy_denied",
						actor: "harbor",
						payload: {
							code: "pull_request_attribution_mismatch",
							message: outcome.message,
							url: outcome.url,
							expected_login: outcome.expected_login,
							actual_login: outcome.actual_login,
						},
					},
				],
			});
			return { kind: "not_opened", outcome };
		}

		case "failed": {
			await appendEvents({
				orgId: context.orgId,
				sessionId: context.sessionId,
				events: [
					{
						type: "session_error",
						actor: "harbor",
						payload: {
							code: "pull_request_failed",
							error_type: outcome.error_type,
							message: outcome.message,
							branch: input.branch,
						},
					},
				],
			});
			return { kind: "not_opened", outcome };
		}
	}
}

function sessionUrl(key: string): string | null {
	const base = process.env.HARBOR_PUBLIC_URL?.trim();
	if (!base) return null;
	return `${base.replace(/\/+$/, "")}/s/${key}`;
}
