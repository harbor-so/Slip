import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { setting } from "../../../../../config.js";
import type { SandboxEvent, SandboxEventType, SessionEventType } from "../../../../../contracts/index.js";
import { SANDBOX_EVENT_TYPES } from "../../../../../contracts/index.js";
import { db } from "../../../../../db/index.js";
import { sandboxes } from "../../../../../db/schema.js";
import { assertNever } from "../../../../../sandbox/decisions.js";
import { validateFence } from "../../../../../sandbox/manager.js";
import { appendEvents } from "../../../../../lib/session-events.js";
import {
	authenticateSandbox,
	completeTurn,
	describeFenceRefusal,
	fencingTokenFrom,
} from "../../../../../lib/session-runner.js";

/**
 * The bridge's uplink: everything happening inside a sandbox, in batches.
 *
 * HTTP POST up and SSE down, rather than a WebSocket, and that is a deployment
 * decision rather than a preference — see the note on `SANDBOX_EVENT_TYPES` in
 * `src/contracts`. Every load balancer, corporate proxy and ingress controller an
 * adopter already runs handles POST without configuration; a meaningful fraction
 * of them mangle a protocol upgrade, and "works everywhere except behind your
 * customer's proxy" is not a property a self-hostable product can ship with.
 *
 * Three guards, in this order, and the order is deliberate:
 *
 *  1. **Size, from the declared length.** Cheapest, needs no database, and it is
 *     the one an unauthenticated caller can otherwise use to make the control
 *     plane buffer megabytes per request. Enforced again while reading, because
 *     `content-length` is a claim by the sender and this endpoint's whole premise
 *     is that the sender is not trusted.
 *  2. **Authentication**, against the sandbox's own token digest.
 *  3. **The fencing token.** Authentication is not enough and cannot be: a box
 *     whose lease lapsed still holds a genuine credential. Only the fence
 *     distinguishes the current box from an honest zombie, and without it two
 *     agents interleave sentences into one transcript — a failure that reads as
 *     the model being incoherent rather than as two writers.
 */
export const dynamic = "force-dynamic";

/**
 * The ceiling on one ingest body.
 *
 * Derived from two settings that already exist rather than invented here: a batch
 * may carry at most `maxSnapshotEvents` events, and each event's payload is
 * truncated at `maxEventPayloadChars` before it is stored, so anything larger than
 * their product could not survive storage even if it were accepted. Deriving it
 * means an operator who raises either limit does not discover a second, hidden one
 * halfway down this file.
 *
 * A dedicated `maxIngestBodyBytes` would be better — this product overestimates by
 * whatever JSON overhead the payloads do not use — but adding a setting is a change
 * to `src/config.ts`, which this file does not own.
 */
function ingestCeilingBytes(): number {
	return setting("maxSnapshotEvents") * setting("maxEventPayloadChars");
}

/**
 * Read the body, refusing rather than buffering past the ceiling.
 *
 * `request.text()` would be one line and would buffer whatever arrives. The point
 * of a cap that is only checked after the read is that it is not a cap: the memory
 * has already been spent by the time it fires, which is exactly what a caller
 * sending a gigabyte wants.
 */
async function readBounded(request: Request, ceiling: number): Promise<string | "too_large"> {
	const body = request.body;
	if (!body) return "";

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > ceiling) {
			// Cancel rather than drain. Reading the rest to be polite is reading the
			// rest, which is the thing being refused.
			await reader.cancel().catch(() => {});
			return "too_large";
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

/**
 * How a sandbox event becomes a timeline event, exhaustively and with no `default`.
 *
 * `null` means "not for the timeline", and every one of those is a decision rather
 * than an omission:
 *
 *  - `heartbeat` is liveness. It updates a column; putting it on the timeline
 *    would bury every session under four events a minute of nothing happening.
 *  - `log` is a log. `session_events` is a timeline, and the difference is the
 *    whole reason that table is not a log pipeline — see the note on
 *    `maxEventPayloadChars`.
 *  - `snapshot_taken` records a provider handle on the sandbox row. There is no
 *    timeline variant for it, and inventing one here would break the rule that a
 *    new event type lands in `src/contracts` first.
 *
 * `agent_failed` maps to `agent_finished` carrying `failed: true`, deliberately
 * NOT to `session_error`. The contract reserves `session_error` for Harbor itself
 * breaking; an agent that could not do the task did its job badly, which is a
 * different fact. Merging them makes "how often do agents fail" and "how often
 * does the platform fail" the same unanswerable number.
 */
function timelineTypeFor(type: SandboxEventType): SessionEventType | null {
	switch (type) {
		case "boot_started":
		case "boot_progress":
			return "sandbox_spawning";
		case "boot_ready":
			return "sandbox_ready";
		case "boot_failed":
			return "sandbox_failed";
		case "heartbeat":
			return null;
		case "agent_message":
			return "agent_message";
		case "agent_tool_call":
			return "agent_tool_call";
		case "agent_finished":
		case "agent_failed":
			return "agent_finished";
		case "branch_pushed":
			return "artifact_created";
		case "snapshot_taken":
			return null;
		case "log":
			return null;
	}
	return assertNever(type, "timelineTypeFor");
}

function isSandboxEventType(value: unknown): value is SandboxEventType {
	return typeof value === "string" && (SANDBOX_EVENT_TYPES as readonly string[]).includes(value);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ceiling = ingestCeilingBytes();

	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > ceiling) {
		return NextResponse.json(
			{
				error: `That batch is ${declared} bytes; the ceiling is ${ceiling}.`,
				reason: "body_too_large",
			},
			{ status: 413 },
		);
	}

	const auth = await authenticateSandbox(id, request.headers);
	if (!auth.ok) {
		return NextResponse.json({ error: auth.message, reason: auth.reason }, { status: 401 });
	}

	const header = fencingTokenFrom(request.headers);
	if (!header.ok) {
		return NextResponse.json({ error: header.message, reason: header.reason }, { status: 409 });
	}
	const fence = await validateFence(auth.sandbox.id, header.token);
	if (!fence.valid) {
		// 409, not 403. The request was authentic and the caller is not forbidden in
		// general — it is out of date, and the difference is what tells a bridge
		// author to stop and re-register rather than to check its credentials.
		return NextResponse.json(
			{ error: describeFenceRefusal(fence), reason: fence.reason },
			{ status: 409 },
		);
	}

	const raw = await readBounded(request, ceiling);
	if (raw === "too_large") {
		return NextResponse.json(
			{
				error:
					`That batch exceeds ${ceiling} bytes. Send fewer events per call; the bridge's `
					+ "buffer is bounded for the same reason this is.",
				reason: "body_too_large",
			},
			{ status: 413 },
		);
	}

	let parsed: unknown;
	try {
		parsed = raw.trim() === "" ? [] : JSON.parse(raw);
	} catch {
		return NextResponse.json(
			{ error: "Body is not JSON.", reason: "malformed_body" },
			{ status: 400 },
		);
	}

	const incoming: unknown[] = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { events?: unknown }).events)
			? ((parsed as { events: unknown[] }).events)
			: [];

	const countCap = setting("maxSnapshotEvents");
	if (incoming.length > countCap) {
		return NextResponse.json(
			{
				error: `That batch carries ${incoming.length} events; the cap is ${countCap}.`,
				reason: "too_many_events",
			},
			{ status: 413 },
		);
	}

	const events = incoming.filter(
		(entry): entry is SandboxEvent =>
			typeof entry === "object" && entry !== null && "type" in entry,
	);

	// A sandbox may write into exactly one session's transcript: its own. The
	// session comes from the row, never from the body — a box that could name its
	// session could write into any room in the org, which is the same class of hole
	// as a client naming its own prompt author. One mismatched event refuses the
	// whole batch rather than being dropped quietly, because a bridge that has the
	// wrong session id is broken and should be told, not partially served.
	const foreign = events.find(
		(event) => typeof event.session_id === "string" && event.session_id !== auth.sandbox.sessionId,
	);
	if (foreign) {
		return NextResponse.json(
			{
				error: "That event names a session this sandbox does not belong to.",
				reason: "session_mismatch",
			},
			{ status: 403 },
		);
	}

	const now = new Date();
	// Any authenticated, correctly fenced call proves the box is alive, so liveness
	// is a byproduct of the traffic rather than a separate message that a busy
	// bridge can starve. The same reasoning as `agent_presence` in `work.ts`.
	await db
		.update(sandboxes)
		.set({ lastHeartbeatAt: now })
		.where(eq(sandboxes.id, auth.sandbox.id));

	const appendable: Array<{
		type: SessionEventType;
		payload: Record<string, unknown> | null;
		actor: string | null;
	}> = [];
	let ignored = 0;
	const finishes: Array<{ outcome: "completed" | "failed"; payload: Record<string, unknown> }> = [];

	for (const event of events) {
		// An unrecognised type is counted and skipped rather than failing the batch.
		// A newer bridge sending one variant this build has never heard of must not
		// cost the operator the ninety-nine events around it — the whole point of
		// batching is that one bad element is not a lost turn.
		if (!isSandboxEventType(event.type)) {
			ignored += 1;
			continue;
		}

		const timelineType = timelineTypeFor(event.type);
		if (timelineType === null) {
			ignored += 1;
			continue;
		}

		const payload: Record<string, unknown> = {
			...(event.payload ?? {}),
			sandbox_event: event.type,
			sandbox_id: auth.sandbox.id,
			fencing_token: fence.token,
		};
		if (event.trace_id) payload.trace_id = event.trace_id;
		// The sandbox's own clock, carried for display and never for ordering. Order
		// is `seq`, allocated here, because two boxes with skewed clocks would
		// otherwise interleave a transcript by whichever machine was running fast.
		if (event.at) payload.sandbox_at = event.at;
		if (event.type === "agent_failed") payload.failed = true;

		appendable.push({ type: timelineType, payload, actor: "agent" });

		if (event.type === "agent_finished" || event.type === "agent_failed") {
			finishes.push({
				outcome: event.type === "agent_finished" ? "completed" : "failed",
				payload,
			});
		}
	}

	const appended = await appendEvents({
		orgId: auth.sandbox.orgId,
		sessionId: auth.sandbox.sessionId,
		events: appendable,
	});

	// The turn is closed *after* its events are on the timeline. The other order
	// puts `prompt_finished` at a lower seq than the agent's last sentence, so a
	// client that stops rendering at the finish marker loses the end of the answer.
	for (const finish of finishes) {
		await completeTurn({
			orgId: auth.sandbox.orgId,
			sessionId: auth.sandbox.sessionId,
			outcome: finish.outcome,
			detail: { sandbox_id: auth.sandbox.id, trace_id: finish.payload.trace_id ?? null },
			now,
		});
	}

	return NextResponse.json({
		ok: true,
		appended: appended.length,
		ignored,
		through_seq: appended.length > 0 ? appended[appended.length - 1]!.seq : null,
	});
}
