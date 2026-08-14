/**
 * Harbor ⇄ Cloudflare Sandbox control shim.
 *
 * Cloudflare Sandbox does not have a remote control-plane REST API the way Fly or
 * E2B do. Its `@cloudflare/sandbox` runtime is a Durable Object (`Sandbox`) that
 * fronts a Container, and the only supported way to drive it is from *inside* a
 * Worker via `getSandbox(env.Sandbox, id)`. Harbor's control plane is an external
 * Node server, so it cannot call that binding directly.
 *
 * This Worker is the bridge: deploy it once, and it exposes the four lifecycle
 * operations Harbor's `cloudflare` provider needs — create, inspect, stop, and
 * the two reconciliation queries — as a small HTTP API guarded by a shared
 * bearer token. Harbor's provider (`src/sandbox/providers/cloudflare.ts`) is then
 * an ordinary injected-`fetch` client pointed at this Worker's URL, identical in
 * shape to the Fly provider.
 *
 * **Why a KV index.** Durable Objects are addressed by id and are NOT
 * enumerable — there is no "list all Sandboxes" primitive. Harbor's
 * reconciliation (`findByAttemptId`, `listManaged`) depends on being able to
 * enumerate the boxes we created, so this Worker records every managed sandbox in
 * a KV namespace at create time and removes it at stop time. KV is therefore the
 * authoritative registry of managed sandboxes, and a KV read failure surfaces as
 * a 5xx so the Harbor side fails CLOSED (throws `transient`) rather than
 * concluding "no orphans".
 *
 * **Image.** A Cloudflare Container image is fixed at deploy time by this Worker's
 * `wrangler.jsonc` / `Dockerfile`, not chosen per create call. The `image` field
 * Harbor sends is recorded for provenance but does not select an image; build the
 * Harbor sandbox image into this Worker's container. This is a real constraint of
 * the platform and is documented on the Harbor provider too.
 */

import { getSandbox, Sandbox } from "@cloudflare/sandbox";

// The Sandbox Durable Object must be exported from the Worker entry so the
// `wrangler.jsonc` DO binding can find it. Re-exported unchanged.
export { Sandbox };

/**
 * The subset of the sandbox client we actually call. `getSandbox` returns a
 * proxy whose runtime surface is the container client (ping/exec/startProcess/…),
 * but the static type is the Durable Object class, which does not declare those
 * client methods — so we narrow to exactly what we use rather than reach for
 * `any`.
 */
interface SandboxStub {
	setLabels(labels: Record<string, string>): Promise<void>;
	setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;
	startProcess(command: string): Promise<unknown>;
	destroy(): Promise<void>;
	ping(): Promise<string>;
}

function stub(env: Env, externalId: string): SandboxStub {
	return getSandbox(env.Sandbox, externalId) as unknown as SandboxStub;
}

interface Env {
	/** The Sandbox Durable Object namespace, bound in wrangler.jsonc. */
	Sandbox: DurableObjectNamespace<Sandbox>;
	/** Registry of managed sandboxes; the enumerable index DOs do not provide. */
	HARBOR_SANDBOX_INDEX: KVNamespace;
	/** Shared secret Harbor presents as `Authorization: Bearer <token>`. */
	AUTH_TOKEN: string;
}

/** What we persist per managed sandbox. The labels round-trip back to Harbor. */
interface IndexRecord {
	externalId: string;
	attemptId: string;
	sessionId: string;
	sandboxId: string;
	image: string | null;
	createdAt: string;
}

interface CreateBody {
	sandboxId: string;
	attemptId: string;
	sessionId: string;
	image?: string;
	env?: Record<string, string>;
	command?: string[];
}

const LABELS = {
	managed: "harbor_managed",
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
} as const;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function unauthorized(): Response {
	return json({ error: "missing or invalid bearer token" }, 401);
}

function authorized(request: Request, env: Env): boolean {
	const header = request.headers.get("Authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	return Boolean(env.AUTH_TOKEN) && token === env.AUTH_TOKEN;
}

/** Record keys are the external id (`harbor-<sandboxId>`); the attempt index is separate. */
const RECORD_PREFIX = "harbor-";

/** `harbor-<sandboxId>` is the DO name and the external id Harbor tracks. */
function externalIdFor(sandboxId: string): string {
	return `${RECORD_PREFIX}${sandboxId}`;
}

/**
 * The direct attempt→externalId index key. Reconciliation asks "does a box for
 * this attempt exist?" on the hot path, so it must be a keyed lookup, not a scan
 * of every managed box. Namespaced away from the `harbor-` record keys so
 * `listManaged`'s prefix scan never trips over it.
 */
function attemptKey(attemptId: string): string {
	return `attempt:${attemptId}`;
}

async function readRecord(env: Env, externalId: string): Promise<IndexRecord | null> {
	const raw = await env.HARBOR_SANDBOX_INDEX.get(externalId);
	return raw ? (JSON.parse(raw) as IndexRecord) : null;
}

function inspectionFrom(record: IndexRecord, state: string) {
	return {
		externalId: record.externalId,
		state,
		attemptId: record.attemptId,
		sessionId: record.sessionId,
		sandboxId: record.sandboxId,
		createdAt: record.createdAt,
	};
}

/**
 * Liveness probe. `ping()` succeeds only when the container is up, so a success
 * is `running`. A failure is reported as `unknown` rather than `exited`: Harbor's
 * liveness rule fails OPEN (an indeterminate box is treated as live), and a box
 * that is merely mid-boot would otherwise be reaped. The stop path, not this
 * probe, is what declares a box gone.
 */
async function probeState(env: Env, externalId: string): Promise<string> {
	try {
		await stub(env, externalId).ping();
		return "running";
	} catch {
		return "unknown";
	}
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
	const body = (await request.json()) as CreateBody;
	if (!body?.sandboxId || !body?.attemptId) {
		return json({ error: "sandboxId and attemptId are required" }, 422);
	}
	const externalId = externalIdFor(body.sandboxId);
	const sandbox = stub(env, externalId);

	// Labels live on the DO for observability; the KV record is the enumerable
	// copy reconciliation reads. Both carry the attempt id — the idempotency key.
	await sandbox.setLabels({
		[LABELS.managed]: "true",
		[LABELS.attempt]: body.attemptId,
		[LABELS.session]: body.sessionId,
		[LABELS.sandbox]: body.sandboxId,
	});
	if (body.env && Object.keys(body.env).length > 0) {
		await sandbox.setEnvVars(body.env);
	}
	// Start the agent. Absent a command we start the image's Harbor entrypoint;
	// the container's control server is PID 1, so the agent runs as a process.
	const command = body.command && body.command.length > 0 ? body.command.join(" ") : "/harbor/boot";
	await sandbox.startProcess(command);

	const record: IndexRecord = {
		externalId,
		attemptId: body.attemptId,
		sessionId: body.sessionId,
		sandboxId: body.sandboxId,
		image: body.image ?? null,
		createdAt: new Date().toISOString(),
	};
	// Written AFTER the box is starting, so a record always corresponds to a box
	// that was at least asked to boot — never a phantom the sweep would chase.
	await env.HARBOR_SANDBOX_INDEX.put(externalId, JSON.stringify(record));
	// The direct attempt index, so findByAttemptId is a single keyed get. Written
	// last; if a create dies before this, the box is still discoverable via the
	// record (listManaged) even if not via the attempt index.
	await env.HARBOR_SANDBOX_INDEX.put(attemptKey(body.attemptId), externalId);

	return json(inspectionFrom(record, "starting"), 201);
}

async function handleInspect(env: Env, externalId: string): Promise<Response> {
	const record = await readRecord(env, externalId);
	// 404 is a definitive answer: no such managed box. Harbor's `inspect` maps
	// this to `null`.
	if (!record) return json({ error: "not found" }, 404);
	const state = await probeState(env, externalId);
	return json(inspectionFrom(record, state));
}

async function handleStop(env: Env, externalId: string): Promise<Response> {
	const record = await readRecord(env, externalId);
	if (!record) return json({ outcome: "absent" });
	try {
		await stub(env, externalId).destroy();
	} catch (error) {
		// Destroy is best-effort and idempotent from Harbor's side; a container
		// already gone still means the box is reclaimed. Record the reason but do
		// not fail the stop, which is called from retrying paths.
		console.warn(`[cloudflare-shim] destroy(${externalId}) failed: ${(error as Error).message}`);
		await forget(env, record);
		return json({ outcome: "already_stopped" });
	}
	await forget(env, record);
	return json({ outcome: "stopped" });
}

/** Remove both the record and its attempt index so no dangling key survives a stop. */
async function forget(env: Env, record: IndexRecord): Promise<void> {
	await env.HARBOR_SANDBOX_INDEX.delete(record.externalId);
	await env.HARBOR_SANDBOX_INDEX.delete(attemptKey(record.attemptId));
}

async function listRecords(env: Env): Promise<IndexRecord[]> {
	const records: IndexRecord[] = [];
	let cursor: string | undefined;
	// KV list is paginated; walk every page so a large fleet is fully enumerated.
	// Scoped to the record prefix so the `attempt:` index keys are never parsed as
	// records.
	do {
		const page = await env.HARBOR_SANDBOX_INDEX.list({ prefix: RECORD_PREFIX, cursor });
		for (const key of page.keys) {
			const record = await readRecord(env, key.name);
			if (record) records.push(record);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return records;
}

async function handleFindByAttempt(env: Env, attemptId: string): Promise<Response> {
	// A direct keyed lookup, not a scan: the attempt index maps straight to the
	// external id. A KV failure throws and becomes a 5xx, so the Harbor side fails
	// CLOSED (throws `transient`) rather than reading a miss as "no such box".
	const externalId = await env.HARBOR_SANDBOX_INDEX.get(attemptKey(attemptId));
	if (!externalId) return json({ sandbox: null });
	const record = await readRecord(env, externalId);
	// A dangling attempt index whose record is already gone reads as absent.
	if (!record) return json({ sandbox: null });
	const state = await probeState(env, externalId);
	return json({ sandbox: inspectionFrom(record, state) });
}

async function handleListManaged(env: Env): Promise<Response> {
	const records = await listRecords(env);
	const sandboxes = await Promise.all(
		records.map(async (record) => inspectionFrom(record, await probeState(env, record.externalId))),
	);
	return json({ sandboxes });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!authorized(request, env)) return unauthorized();

		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean); // ["sandboxes", ":id?"]

		try {
			if (parts[0] !== "sandboxes") return json({ error: "not found" }, 404);

			// Collection routes: /sandboxes
			if (parts.length === 1) {
				if (request.method === "POST") return await handleCreate(request, env);
				if (request.method === "GET") {
					const attempt = url.searchParams.get("attempt");
					if (attempt) return await handleFindByAttempt(env, attempt);
					if (url.searchParams.get("managed") === "true") return await handleListManaged(env);
					return json({ error: "specify ?attempt= or ?managed=true" }, 400);
				}
				return json({ error: "method not allowed" }, 405);
			}

			// Item routes: /sandboxes/:id
			const externalId = decodeURIComponent(parts[1]!);
			if (request.method === "GET") return await handleInspect(env, externalId);
			if (request.method === "DELETE") return await handleStop(env, externalId);
			return json({ error: "method not allowed" }, 405);
		} catch (error) {
			// Any unexpected failure (a KV outage, a DO error) is a 5xx, so the
			// Harbor side fails CLOSED and throws `transient` instead of reading an
			// empty list as "no orphans".
			console.error(`[cloudflare-shim] ${(error as Error).stack ?? error}`);
			return json({ error: `internal error: ${(error as Error).message}` }, 500);
		}
	},
};
