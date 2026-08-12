import { mintGitCredential } from "../../../../../git/credentials.js";
import { authenticateSandbox, sandboxTokenFrom } from "../../../../../lib/session-runner.js";

/**
 * The git credential broker. Called by the in-sandbox helper, per operation.
 *
 * This endpoint is the reason credentials never appear in a session snapshot, and
 * the reason a long-running session does not die at the moment the agent is
 * finally ready to push. An embedded token — in the environment, or in a remote
 * URL — expires on its own schedule, and that schedule is uncorrelated with when
 * the work finishes. A brokered one is minted for the operation about to happen.
 *
 * Three properties, and the ordering below is the design:
 *
 *  1. **Only a sandbox can call this.** Authentication is the sandbox's own
 *     session-scoped token, compared in constant time against a stored digest. A
 *     dashboard session is not sufficient — no human-facing path mints git
 *     credentials, because a credential a browser can obtain is a credential that
 *     leaks through a screen-share.
 *  2. **The token is re-resolved on every call**, never cached for the life of a
 *     connection. A sandbox whose lifecycle state has moved to stopped, stale or
 *     failed must stop being able to push, and a capability captured at connect
 *     time would let it keep going until it disconnected — which is precisely the
 *     window in which another agent has legitimately taken the work.
 *  3. **Least privilege per operation.** `mintGitCredential` gives a clone a
 *     read-only token and only a push a writable one, scoped to the single
 *     repository. Without that split, a credential leaked from a clone — the
 *     operation that runs unattended at boot, before any human is watching — can
 *     rewrite every repository the installation covers.
 *
 * The response is `no-store`. It contains a live credential, and an intermediary
 * that caches it has turned a five-second secret into a persistent one.
 */
export const dynamic = "force-dynamic";

// harbor-lint-allow-constant: not a tunable. The body shape here is fixed by the
// protocol — one repository and one operation name — so 4 KB is a bound on a
// message whose maximum size is a property of the format rather than of anybody's
// deployment. Making it configurable would offer an operator a knob whose only
// possible use is to make their own endpoint easier to abuse.
const MAX_BODY_BYTES = 4_096;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const token = sandboxTokenFrom(request.headers);
	if (!token) {
		return Response.json({ error: "Missing sandbox token." }, { status: 401 });
	}

	const raw = await request.text();
	if (raw.length > MAX_BODY_BYTES) {
		return Response.json({ error: "Payload too large." }, { status: 413 });
	}

	const { id } = await params;
	const auth = await authenticateSandbox(id, request.headers);
	if (!auth.ok) {
		// The refusal reason is logged but not returned. Telling an unauthenticated
		// caller whether a sandbox id exists, or whether it is merely stopped, is a
		// distinction that only helps somebody probing.
		console.error(`[credentials] refused sandbox ${id}: ${auth.reason}`);
		return Response.json({ error: "Not authorised." }, { status: 401 });
	}

	let body: { repo?: { owner?: string; name?: string; host?: string; protocol?: string }; operation?: string };
	try {
		body = JSON.parse(raw || "{}");
	} catch {
		return Response.json({ error: "Malformed body." }, { status: 400 });
	}

	const owner = body.repo?.owner;
	const name = body.repo?.name;
	const operation = body.operation;
	if (
		typeof owner !== "string"
		|| typeof name !== "string"
		|| (operation !== "clone" && operation !== "fetch" && operation !== "push")
	) {
		return Response.json(
			{ error: "Expected { repo: { owner, name }, operation: clone|fetch|push }." },
			{ status: 400 },
		);
	}

	const outcome = await mintGitCredential(id, {
		repo: { owner, name, host: body.repo?.host, protocol: body.repo?.protocol },
		operation,
	});

	// The three outcomes map to three statuses on purpose. A refusal is a decision
	// and the helper must not retry it; a failure is an upstream problem and the
	// helper should. Collapsing them into one error code makes a misconfigured
	// repository indistinguishable from a GitHub outage, and the helper then either
	// retries forever or gives up on something transient.
	if (outcome.kind === "refused") {
		console.error(`[credentials] refused ${owner}/${name} ${operation}: ${outcome.reason}`);
		return Response.json({ error: outcome.message, reason: outcome.reason }, { status: 403 });
	}
	if (outcome.kind === "failed") {
		console.error(`[credentials] failed ${owner}/${name}: ${outcome.message}`);
		return Response.json(
			{ error: outcome.message, error_type: outcome.error_type },
			{ status: 502 },
		);
	}

	return Response.json(outcome, {
		headers: {
			// A live credential. An intermediary that caches this has turned a
			// five-second secret into a persistent one.
			"cache-control": "no-store, no-cache, must-revalidate, private",
			pragma: "no-cache",
		},
	});
}
