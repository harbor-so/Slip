import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { connectorFor } from "../../../../connectors/registry.js";
import { db } from "../../../../db/index.js";
import { connectors, events } from "../../../../db/schema.js";

/**
 * One route per connector, and the ordering inside it is the security model.
 *
 * The raw body is read as text and the signature verified against those exact
 * bytes BEFORE anything parses them. Verifying a re-serialised object is the
 * classic way to make signature checking useless: `JSON.parse` followed by
 * `JSON.stringify` does not reproduce the sender's whitespace or key order, so
 * either the check fails for valid payloads or somebody "fixes" it by trusting
 * the parse.
 *
 * The connector row is found by type before the org is known, because the org is
 * something the payload must not be allowed to assert — it is read off the row
 * whose secret verified the signature.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ connector: string }> },
) {
	const { connector: type } = await params;
	const connector = connectorFor(type);
	if (!connector) {
		return NextResponse.json({ error: `Unknown connector "${type}".` }, { status: 404 });
	}

	const raw = await request.text();
	if (raw.length > 1_000_000) {
		return NextResponse.json({ error: "Payload too large." }, { status: 413 });
	}

	const headers: Record<string, string | undefined> = {};
	request.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});

	const installed = await db.query.connectors.findFirst({
		where: and(eq(connectors.type, type), eq(connectors.status, "active")),
	});
	const secret =
		(installed?.config as { webhookSecret?: string } | null)?.webhookSecret
		?? process.env[`${type.toUpperCase()}_WEBHOOK_SECRET`];

	// A missing secret is an operator error and must be loud. Accepting unsigned
	// webhooks "until it is configured" is how an unauthenticated write endpoint
	// ends up in production.
	if (!secret) {
		return NextResponse.json(
			{ error: `No webhook secret configured for ${type}.` },
			{ status: 503 },
		);
	}
	if (!connector.verifyWebhook(raw, headers, secret)) {
		return new NextResponse(null, { status: 401 });
	}
	if (!installed) {
		return NextResponse.json({ error: `${type} is not installed.` }, { status: 404 });
	}

	const result = await connector.handleWebhook(JSON.parse(raw), installed.orgId);

	await db
		.update(connectors)
		.set({ lastSyncedAt: new Date() })
		.where(eq(connectors.id, installed.id));
	await db.insert(events).values({
		orgId: installed.orgId,
		taskId: result.taskId ?? null,
		type: "connector_synced",
		payload: { connector: type, action: result.action, reason: result.reason },
	});

	return NextResponse.json(result);
}
