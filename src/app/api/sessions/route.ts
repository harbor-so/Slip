import { NextResponse } from "next/server";
import { createSession, listSessions } from "../../../lib/sessions.js";
import { currentSession } from "../../../lib/session.js";

export async function GET() {
	const viewer = await currentSession();
	if (!viewer) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
	return NextResponse.json({ sessions: await listSessions(viewer.orgId) });
}

export async function POST(request: Request) {
	const viewer = await currentSession();
	if (!viewer) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as { title?: string; taskId?: string };
	const title = body.title?.trim();
	if (!title) return NextResponse.json({ error: "title is required." }, { status: 400 });

	const created = await createSession({
		orgId: viewer.orgId,
		title,
		createdBy: viewer.userName ?? "someone",
		taskId: body.taskId,
	});
	return NextResponse.json({ ok: true, key: created.key });
}
