import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "../../../../db/index.js";
import { orgs, users } from "../../../../db/schema.js";
import { oauthConfigured, sessionCookie, signSession } from "../../../../lib/session.js";

/**
 * Who is allowed to become a member on first sign-in.
 *
 * This gate did not exist, and its absence was the most serious hole in the
 * product: any GitHub user on the internet who reached the deployed URL was
 * inserted into the first org and could then mint a permanent MCP API key from
 * the dashboard. Completing GitHub OAuth is unauthenticated by design, so
 * nothing upstream was stopping them.
 *
 * An allowlist rather than an invitations table because a pilot has one team and
 * a table is a schema, a UI and an email flow to maintain. An empty allowlist in
 * production is a refusal, never an open door — the failure mode of getting that
 * backwards is the hole this closes.
 */
function allowedLogins(): Set<string> {
	return new Set(
		(process.env.HARBOR_ALLOWED_GITHUB_LOGINS ?? "")
			.split(",")
			.map((login) => login.trim().toLowerCase())
			.filter(Boolean),
	);
}

function statesMatch(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json({ error: "GitHub OAuth is not configured." }, { status: 503 });
	}

	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	if (!code) return NextResponse.redirect(new URL("/", request.url));

	// Reject a callback that did not start at /api/auth/login.
	const cookieHeader = request.headers.get("cookie") ?? "";
	const cookieState = /(?:^|;\s*)harbor_oauth_state=([^;]+)/.exec(cookieHeader)?.[1];
	if (!statesMatch(url.searchParams.get("state") ?? undefined, cookieState)) {
		return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
	}

	const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({
			client_id: process.env.GITHUB_CLIENT_ID,
			client_secret: process.env.GITHUB_CLIENT_SECRET,
			code,
		}),
	});
	const { access_token: accessToken } = (await tokenResponse.json()) as {
		access_token?: string;
	};
	if (!accessToken) {
		return NextResponse.json({ error: "GitHub rejected the code." }, { status: 401 });
	}

	const profileResponse = await fetch("https://api.github.com/user", {
		headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
	});
	const profile = (await profileResponse.json()) as {
		id?: number;
		login?: string;
		name?: string;
		email?: string;
	};
	if (!profile.id || !profile.login) {
		return NextResponse.json({ error: "Could not read GitHub profile." }, { status: 401 });
	}

	const githubId = String(profile.id);
	let user = await db.query.users.findFirst({ where: eq(users.githubId, githubId) });

	if (!user) {
		const allowed = allowedLogins();
		if (!allowed.has(profile.login.toLowerCase())) {
			return NextResponse.json(
				{
					error:
						"This GitHub account is not authorised for this Harbor instance. "
						+ "Ask an administrator to add it to HARBOR_ALLOWED_GITHUB_LOGINS.",
				},
				{ status: 403 },
			);
		}

		const [org] = await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1);
		if (!org) {
			return NextResponse.json(
				{ error: "No organisation exists yet. Run npm run db:seed." },
				{ status: 409 },
			);
		}
		[user] = await db
			.insert(users)
			.values({
				orgId: org.id,
				githubId,
				name: profile.name ?? profile.login,
				email: profile.email ?? null,
			})
			.returning();
	}

	const response = NextResponse.redirect(new URL("/", request.url));
	response.cookies.set(sessionCookie.name, signSession(user!.id), sessionCookie.options);
	response.cookies.delete("harbor_oauth_state");
	return response;
}
