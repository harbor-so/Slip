import { and, asc, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import postgres from "postgres";
import { setting } from "../../../../../config.js";
import type { SessionEvent, SessionEventType } from "../../../../../contracts/index.js";
import { db } from "../../../../../db/index.js";
import { sessionEvents } from "../../../../../db/schema.js";
import { orgIdForKey } from "../../../../../lib/auth.js";
import { currentSession } from "../../../../../lib/session.js";
import { snapshotSession } from "../../../../../lib/session-events.js";

/**
 * A session's live timeline: one snapshot, then every event after it.
 *
 * The shape is `src/app/api/stream/route.ts` — Postgres LISTEN/NOTIFY over SSE on
 * a dedicated connection, keep-alive comment lines, `x-accel-buffering: no` — for
 * the reasons argued there: it reuses the one piece of infrastructure Harbor
 * already requires, it survives whatever proxy an adopter runs, and it reconnects
 * on its own. What is added here is ordering, and the ordering is the entire
 * correctness argument.
 *
 * ---------------------------------------------------------------------------
 * WHY NOTHING CAN BE LOST, BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * Three steps, in this order, and the order is not an optimisation:
 *
 *   1. **Subscribe** to the notify channel.
 *   2. **Read** the snapshot, which carries `snapshot_through_seq`.
 *   3. **Drain** everything above that cursor, then keep draining on every wakeup.
 *
 * The proof is two cases and no third, because `appendEvents` sends its NOTIFY
 * *after* the transaction commits (never inside — a listener woken before the rows
 * are visible reads an empty table and concludes there is nothing new):
 *
 *   - An event whose NOTIFY was delivered before step 1 had already committed
 *     before step 1, therefore before step 2, therefore it is **in the snapshot**.
 *   - An event that committed after step 2 sends its NOTIFY after its commit,
 *     which is after step 1, so **this connection receives that wakeup** and step 3
 *     reads the row.
 *
 * There is no gap between those two cases: "committed before the snapshot read"
 * and "committed after the snapshot read" partition every event that will ever
 * exist. Nothing depends on how long step 2 takes, on how many `await`s are in it,
 * or on whether a future refactor adds one.
 *
 * **That last sentence is the whole reason this ordering was chosen over the
 * obvious alternative.** The natural design — read the snapshot, then register the
 * socket with an in-process broadcaster — is correct only while the rule "no await
 * between the snapshot read and the registration" holds. That rule is invisible in
 * the code, cannot be expressed to the type system, and is silently broken by the
 * first person who adds a permission check, a metric, or a log line between the two
 * statements. What follows is not a crash: it is one missing event, in one session,
 * for one client, under load. Here the equivalent mistake is impossible because
 * there is nothing to get wrong — the subscription is already live before the read
 * begins, and the correctness does not rest on what happens between them.
 *
 * The notify payload deliberately carries no event data — only an org id and a
 * verb, as `notifyChange` documents — so this stream is woken and then *reads*.
 * That is what makes a wakeup that arrives twice, late, or coalesced with another
 * one harmless: the wakeup is a hint, and Postgres is the truth.
 */
export const dynamic = "force-dynamic";

function toWireEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
	return {
		id: row.id,
		session_id: row.sessionId,
		seq: row.seq,
		type: row.type as SessionEventType,
		payload: (row.payload ?? null) as Record<string, unknown> | null,
		actor: row.actor,
		created_at: row.createdAt.toISOString(),
	};
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;

	// A presented credential is judged on its own and does NOT fall back to the
	// browser's ambient session. Falling back would mean a revoked API key keeps
	// working for as long as somebody happens to be signed in on the same browser,
	// and the revocation would appear to have worked from every angle anybody
	// checked.
	const authorization = request.headers.get("authorization");
	const orgId = authorization
		? await orgIdForKey(authorization)
		: ((await currentSession())?.orgId ?? null);
	if (!orgId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const url = process.env.DATABASE_URL ?? "postgres://harbor:harbor@localhost:5433/harbor";
	const listener = postgres(url, { max: 1 });
	const encoder = new TextEncoder();
	const pageSize = setting("maxSnapshotEvents");

	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
					);
				} catch {
					// The client went away between the notify and the write.
				}
			};
			const finish = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			/**
			 * Two cursors, and they are not the same number.
			 *
			 * `contiguousThrough` is how far the timeline is known to be *complete*, and
			 * it is where every read starts. `emittedThrough` is the highest seq already
			 * put on the wire. They differ exactly when there is a hole — seq 87 still
			 * uncommitted while 88, 89 and 90 are visible — and keeping them apart is
			 * what stops the two failures at either end of that situation:
			 *
			 *  - One cursor advanced to 90 means 87, when it finally commits, is below
			 *    the cursor and is never read again. The event is lost, silently, for
			 *    this client until it reloads the page. That is the failure this whole
			 *    file exists to prevent, reintroduced by an optimisation.
			 *  - One cursor pinned at 86 means 88-90 are re-sent on every wakeup for as
			 *    long as the hole exists.
			 *
			 * So: read from `contiguousThrough` (never miss a filled hole), emit only
			 * above `emittedThrough` or into a known gap (never spam). `pendingGaps` is
			 * recomputed from each read window, so it cannot grow without bound and
			 * cannot go stale.
			 *
			 * A hole that never fills — a transaction that allocated a seq and rolled
			 * back — pins `contiguousThrough` forever, and the cost is re-reading up to
			 * one page per wakeup. That is the direction to fail in, and it is the same
			 * one `snapshotMeta` chose for the same reason: re-reading is invisible,
			 * losing an event is not.
			 */
			let contiguousThrough = 0;
			let emittedThrough = 0;
			let pendingGaps = new Set<number>();

			/**
			 * Null until the snapshot has been read, and checked rather than assumed.
			 *
			 * The subscription is deliberately live before the snapshot is read (see the
			 * proof above), so a NOTIFY that lands during step 2 calls `drain` before
			 * the session is known. Reading a `const` declared below this point would
			 * throw a `ReferenceError` from the temporal dead zone — swallowed by the
			 * drain's own catch, so the symptom is a confusing log line today and a
			 * permanently stuck `draining` flag the moment anybody adds an `await`
			 * before the first use. Returning early is the honest behaviour: nothing is
			 * lost, because the snapshot read that follows covers everything up to its
			 * own cursor and step 3 drains the rest.
			 */
			let sessionId: string | null = null;

			let draining = false;
			let dirty = false;

			const drain = async () => {
				if (closed || sessionId === null) return;
				if (draining) {
					// A wakeup that lands mid-drain sets a flag instead of starting a
					// second one. Without it, the wakeup is dropped — and the event that
					// caused it would then wait for the *next* unrelated notify, which on
					// a session that just went quiet is forever.
					dirty = true;
					return;
				}
				draining = true;
				try {
					let more = true;
					while (more && !closed) {
						dirty = false;
						const rows = await db
							.select()
							.from(sessionEvents)
							.where(
								and(
									eq(sessionEvents.sessionId, sessionId),
									gt(sessionEvents.seq, contiguousThrough),
								),
							)
							.orderBy(asc(sessionEvents.seq))
							.limit(pageSize);

						if (rows.length > 0) {
							for (const row of rows) {
								if (row.seq > emittedThrough || pendingGaps.has(row.seq)) {
									send("event", toWireEvent(row));
									if (row.seq > emittedThrough) emittedThrough = row.seq;
								}
							}

							let run = contiguousThrough;
							for (const row of rows) {
								if (row.seq !== run + 1) break;
								run = row.seq;
							}
							contiguousThrough = run;

							const seen = new Set(rows.map((row) => row.seq));
							const highest = rows[rows.length - 1]!.seq;
							const gaps = new Set<number>();
							for (let seq = contiguousThrough + 1; seq <= highest; seq += 1) {
								if (!seen.has(seq)) gaps.add(seq);
							}
							pendingGaps = gaps;
						}

						// A full page means there is probably more behind it; keep reading
						// rather than waiting for a wakeup that may never come, because a
						// bulk append fires one NOTIFY for hundreds of events.
						more = rows.length === pageSize || dirty;
					}
				} catch (error) {
					console.error("[session-stream] drain failed:", error);
				} finally {
					draining = false;
				}
			};

			// ---- STEP 1: subscribe, before anything is read. ----------------------
			const subscription = await listener.listen("harbor_changes", (payload) => {
				try {
					const change = JSON.parse(payload) as { orgId?: string };
					// Every org shares the one channel, so the filter happens here. A
					// channel per org would mean a LISTEN per org per connection and no
					// way to clean them up.
					if (change.orgId === orgId) void drain();
				} catch {
					// A malformed payload is not worth killing the stream over.
				}
			});

			// ---- STEP 2: the snapshot. -------------------------------------------
			const snapshot = await snapshotSession(orgId, key);
			if (!snapshot) {
				// Scoped by org, so a key belonging to another tenant is indistinguishable
				// from one that was never minted — a distinct "wrong org" answer would
				// turn the key space into an oracle anyone could probe.
				send("error", { error: "No such session." });
				void subscription.unlisten().catch(() => {});
				void listener.end({ timeout: 1 }).catch(() => {});
				finish();
				return;
			}
			sessionId = snapshot.session.id;

			contiguousThrough = snapshot.snapshot_through_seq;
			// Deliberately the same number, not the highest seq in `snapshot.events`.
			// The snapshot's tail can reach above its own cursor when there is a hole
			// below, and those events are re-sent live. A duplicate is defined by the
			// contract to be a no-op on the client; a skipped event is not defined at
			// all, so the cheap mistake is the one to make.
			emittedThrough = snapshot.snapshot_through_seq;
			send("snapshot", snapshot);

			// ---- STEP 3: everything above the cursor, then live. -------------------
			await drain();

			// Proxies and load balancers close a silent connection. A comment line is
			// the cheapest thing that counts as traffic and is ignored by EventSource.
			const keepAlive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					/* closed */
				}
			}, setting("sandboxHeartbeatIntervalMs"));

			request.signal.addEventListener("abort", () => {
				clearInterval(keepAlive);
				void subscription.unlisten().catch(() => {});
				void listener.end({ timeout: 1 }).catch(() => {});
				finish();
			});
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// Nginx buffers SSE into uselessness without this.
			"x-accel-buffering": "no",
		},
	});
}
