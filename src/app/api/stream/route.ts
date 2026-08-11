import { currentSession } from "../../../lib/session.js";
import postgres from "postgres";

/**
 * A live feed of changes for this org, over Server-Sent Events.
 *
 * SSE rather than websockets: the traffic is one-directional — the server tells
 * the browser something moved — and SSE reconnects on its own, needs no protocol
 * upgrade through whatever proxy sits in front, and is about twenty lines.
 *
 * Postgres LISTEN/NOTIFY rather than Supabase Realtime or a socket service,
 * because it reuses the one piece of infrastructure Slip already requires. The
 * same DATABASE_URL that runs the product runs the live layer; there is nothing
 * extra to deploy, nothing extra to pay for, and it works identically on hosted
 * Postgres.
 *
 * A dedicated connection is opened per stream, because LISTEN occupies a
 * connection for as long as it is listening — taking one from the request pool
 * would starve it. `max: 1` keeps that explicit.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const session = await currentSession();
	if (!session) return new Response("Not signed in.", { status: 401 });

	const url = process.env.DATABASE_URL ?? "postgres://slip:slip@localhost:5433/slip";
	const listener = postgres(url, { max: 1 });
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					// The client went away between the notify and the write.
				}
			};

			send("ready", { orgId: session.orgId });

			const subscription = await listener.listen("slip_changes", (payload) => {
				try {
					const change = JSON.parse(payload) as { orgId?: string; verb?: string };
					// Every org shares the one channel, so the filter happens here. A
					// channel per org would mean a LISTEN per org per connection and no
					// way to clean them up.
					if (change.orgId === session.orgId) send("change", { verb: change.verb ?? "unknown" });
				} catch {
					// A malformed payload is not worth killing the stream over.
				}
			});

			// Proxies and load balancers close a silent connection. A comment line is
			// the cheapest thing that counts as traffic and is ignored by EventSource.
			const keepAlive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					/* closed */
				}
			}, 25_000);

			request.signal.addEventListener("abort", () => {
				clearInterval(keepAlive);
				void subscription.unlisten().catch(() => {});
				void listener.end({ timeout: 1 }).catch(() => {});
				try {
					controller.close();
				} catch {
					/* already closed */
				}
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
