import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "../../../../db/index.js";
import { orgs, users } from "../../../../db/schema.js";
import { oauthConfigured, sessionCookie, signSession } from "../../../../lib/session.js";

/**
 * Exchange the code, then find or create the user.
 *
 * A first-time signer-in joins the first org rather than creating one. For a
 * single-tenant pilot that is correct and invisible; when Slip has more than one
 * customer this is the line that has to become a real invitation flow, and it is
 * called out here so it is found rather than discovered.
 */
export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json({ error: "GitHub OAuth is not configured." }, { status: 503 });
	}

	const code = new URL(request.url).searchParams.get("code");
	if (!code) return NextResponse.redirect(new URL("/", request.url));

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
	if (!profile.id) {
		return NextResponse.json({ error: "Could not read GitHub profile." }, { status: 401 });
	}

	const githubId = String(profile.id);
	let user = await db.query.users.findFirst({ where: eq(users.githubId, githubId) });

	if (!user) {
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
				name: profile.name ?? profile.login ?? null,
				email: profile.email ?? null,
			})
			.returning();
	}

	const response = NextResponse.redirect(new URL("/", request.url));
	response.cookies.set(sessionCookie.name, signSession(user!.id), sessionCookie.options);
	return response;
}
