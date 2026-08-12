import { NextResponse } from "next/server";
import { describeConfig } from "../../../../config.js";
import { currentSession } from "../../../../lib/session.js";

/**
 * What this deployment is actually running with, and why.
 *
 * Every tunable, its resolved value, whether that came from a repository
 * override, an environment variable or the default, and the prose derivation of
 * why the default is what it is. The alternative to this endpoint is an
 * archaeology exercise across a Helm chart, a Dockerfile and src/config.ts, which
 * is what an operator does at 2am when sandboxes are dying and they suspect a
 * timeout.
 *
 * Signed-in only. The values are not secret, but they are a precise description
 * of how to make the deployment misbehave.
 */
export const dynamic = "force-dynamic";

export async function GET() {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
	return NextResponse.json({ settings: describeConfig() });
}
