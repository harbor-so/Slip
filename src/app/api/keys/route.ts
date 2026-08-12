import { NextResponse } from "next/server";
import { db } from "../../../db/index.js";
import { apiKeys } from "../../../db/schema.js";
import { hashApiKey, mintApiKey } from "../../../lib/keys.js";
import { currentSession } from "../../../lib/session.js";

/**
 * Mint a key. The plaintext is returned exactly once, here, and never stored.
 */
export async function POST() {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const key = mintApiKey();
	await db.insert(apiKeys).values({
		orgId: session.orgId,
		keyHash: hashApiKey(key),
		label: "dashboard",
	});

	return NextResponse.json({ key });
}
