import { NextResponse } from "next/server";
import { joinSession, queuePrompt, sessionByKey } from "../../../../../lib/sessions.js";
import { currentSession } from "../../../../../lib/session.js";

/**
 * Add a prompt to a session's queue.
 *
 * The author comes from the signed-in viewer, never from the request body — a
 * client that can name its own author can put words in a colleague's mouth, and
 * attribution nobody can trust is worse than none.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const viewer = await currentSession();
	if (!viewer) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const { key } = await params;
	const session = await sessionByKey(viewer.orgId, key);
	if (!session) return NextResponse.json({ error: "No such session." }, { status: 404 });

	const body = (await request.json().catch(() => ({}))) as { body?: string };
	const author = viewer.userName ?? "someone";

	try {
		// Posting is also joining. Somebody who was sent the link and immediately
		// typed should appear in the room, not be invisible until they reload.
		await joinSession(session.id, viewer.orgId, author, "human");
		const prompt = await queuePrompt({
			orgId: viewer.orgId,
			sessionId: session.id,
			author,
			body: body.body ?? "",
		});
		return NextResponse.json({ ok: true, seq: prompt.seq });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Could not queue prompt." },
			{ status: 400 },
		);
	}
}
